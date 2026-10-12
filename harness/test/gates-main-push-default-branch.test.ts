// push のハンドラー（harness/gates/on-main-push.ts の onMainPush。Issue #867）：イベントの既定ブランチへの push だけを処理し、harness.config.json の defaultBranch の未設定・食い違いは守りを走らせた後で失敗にする
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultBranchProblem, onMainPush } from '../gates/on-main-push.ts';
import type { HarnessConfig } from '../lib/config.ts';
import {
  APP, acceptanceFake, config, ctxFor, delegateWorldFake, pr, pushEvent,
  type DelegateWorld, type FakeGitHub,
} from './support/gate-fixtures.ts';

const STOP = config.autoMergeStopLabel;
const withBranch = (defaultBranch: string): HarnessConfig => ({ ...config, defaultBranch });

/** App が自動 Merge した PR #7 を revert するコミット */
const REVERT_COMMITS = [{ id: 'r1', message: 'Revert "feat: 壊す変更"\n\nReverts o/r#7' }];

/** 自動 Merge 済みの #7 と、auto-merge 待ちの Agent PR #5 がある世界（停止スイッチのラベルと auto-merge の解除が w に残る） */
function revertWorld(): { w: DelegateWorld; fake: FakeGitHub } {
  const w: DelegateWorld = {
    prs: [pr({ number: 5, draft: false, auto_merge: { enabled: true } })],
    closedPrs: [pr({ number: 7, node_id: 'PR_7', state: 'closed', draft: false, merged_at: '2026-10-01T00:00:00Z', merged_by: { login: APP } })],
    dashboardLabels: [],
  };
  const fake = delegateWorldFake(w).on('GET', /\/commits\/\w+\/pulls/, () => []);
  return { w, fake };
}

/** 停止スイッチが入り、auto-merge 待ちの PR の auto-merge が外れた */
function assertStopped(w: DelegateWorld, label: string): void {
  assert.ok(w.dashboardLabels.includes(STOP), `${label}: 停止スイッチが入っていません`);
  assert.equal(w.prs[0]!.auto_merge, null, `${label}: auto-merge 待ちの PR の auto-merge が外れていません`);
}

test('defaultBranch が develop の設定で、develop への push は開いた PR を読み、Agent PR を追従させる（失敗にしない）', async () => {
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], behindBy: 2 });
  fake.on('GET', /\/pulls\?state=open/, () => [pr()]);
  let updated = false;
  fake.on('PUT', /\/pulls\/5\/update-branch/, () => (updated = true));
  await onMainPush(ctxFor(fake, 'push', pushEvent([{ id: 'x', message: 'docs: 何か' }], { defaultBranch: 'develop' }), { config: withBranch('develop') }));
  assert.ok(fake.calls.some((c) => c.method === 'GET' && /\/pulls\?state=open/.test(c.path)), '開いた PR の一覧を読んでいません');
  assert.equal(updated, true);
});

test('既定ブランチ以外（ブランチ・タグ）への push では、revert のコミットを含んでも GitHub を1回も呼ばず、失敗にしない', async () => {
  // タグ（refs/tags/*）は refs/heads/<既定ブランチ> と一致しないので、ブランチと同じく何もしない
  for (const ref of ['refs/heads/claude/issue-1-x', 'refs/tags/v1.0.0']) {
    const { w, fake } = revertWorld();
    const logs: string[] = [];
    await onMainPush(ctxFor(fake, 'push', pushEvent(REVERT_COMMITS, { ref, defaultBranch: 'develop' }), { config: withBranch('develop'), log: (m: string) => logs.push(m) }));
    assert.deepEqual(fake.calls, [], ref);
    assert.ok(!w.dashboardLabels.includes(STOP), ref);
    assert.ok(logs.some((l) => l.includes('既定ブランチ')), `${ref}: 既定ブランチ以外と log に書いていません: ${logs.join(' / ')}`);
  }
});

test('defaultBranch が GitHub の既定ブランチと食い違う・未設定でも、既定ブランチへの push で自動 Merge を止め、その後で両方の値を含むエラーで失敗する', async () => {
  for (const [configured, shown] of [['main', 'main'], ['', '未設定']] as const) {
    const { w, fake } = revertWorld();
    await assert.rejects(
      onMainPush(ctxFor(fake, 'push', pushEvent(REVERT_COMMITS, { defaultBranch: 'develop' }), { config: withBranch(configured) })),
      (e: Error) => e.message.includes(shown) && e.message.includes('develop'),
      `defaultBranch=${JSON.stringify(configured)}`,
    );
    assertStopped(w, `defaultBranch=${JSON.stringify(configured)}`);
  }
});

test('ref・repository.default_branch が欠けた push でも何もせずに戻らず自動 Merge を止め、既定ブランチが分からなければその後で失敗する', async () => {
  const cases: { name: string; opts: { ref?: string | null; defaultBranch?: string | null }; rejects: boolean }[] = [
    { name: '両方とも無い', opts: { ref: null, defaultBranch: null }, rejects: true },
    { name: 'ref だけ無い', opts: { ref: null, defaultBranch: 'develop' }, rejects: false },
    { name: 'repository.default_branch だけ無い', opts: { ref: 'refs/heads/develop', defaultBranch: null }, rejects: true },
  ];
  for (const c of cases) {
    const { w, fake } = revertWorld();
    const run = onMainPush(ctxFor(fake, 'push', pushEvent(REVERT_COMMITS, c.opts), { config: withBranch('develop') }));
    if (c.rejects) await assert.rejects(run, (e: Error) => e.message.includes('develop') && e.message.includes('不明'), c.name);
    else await run;
    assertStopped(w, c.name);
  }
});

test('defaultBranchProblem：同じなら null、設定が空・未設定なら「未設定」、イベントの値が無い・空なら「不明」を、両方の値と一緒に書く', () => {
  assert.equal(defaultBranchProblem('develop', 'develop'), null);
  const cases: [configured: string | undefined, eventDefault: string | undefined, words: string[]][] = [
    ['', 'develop', ['未設定', 'develop']],
    [undefined, 'develop', ['未設定', 'develop']],
    ['develop', undefined, ['develop', '不明']],
    ['develop', '', ['develop', '不明']],
  ];
  for (const [configured, eventDefault, words] of cases) {
    const problem = defaultBranchProblem(configured, eventDefault);
    const label = `${JSON.stringify(configured)} / ${JSON.stringify(eventDefault)}`;
    assert.ok(problem, label);
    for (const w of words) assert.ok(problem.includes(w), `${label}: ${w} がありません: ${problem}`);
  }
});
