// Issue #216：定期の照合（onSchedule）で、遅れている Agent PR（既定ブランチ宛て）を追従させる。判定中（着手宣言の段階が judge）は除く
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onSchedule } from '../gates/stale.ts';
import { claimComment, pr, ctxFor, verdictComment, type FakeGitHub } from './support/gate-fixtures.ts';
import { scheduleStackFake, stackedPr } from './support/stack-fixtures.ts';

const OTHER_SHA = 'e'.repeat(40);
const pr6 = (patch: Record<string, unknown> = {}) => pr({ number: 6, node_id: 'PR_6', head: { ref: 'claude/issue-9', sha: OTHER_SHA, repo: { full_name: 'o/r' } }, ...patch });

/**
 * 定期実行の偽の GitHub。PR #5（target）が遅れている（compare は behind_by: 1）。
 * others：一覧に足す PR（/pulls/{n} と /issues/{n}/comments（空）にも応答する）。compareFails：この sha の compare を失敗させる
 */
function followFake(state: { target: ReturnType<typeof pr>; prComments?: unknown[]; others?: ReturnType<typeof pr>[]; compareFails?: string }): FakeGitHub {
  const others = state.others ?? [];
  const fake = scheduleStackFake({ pr: state.target, prComments: state.prComments, list: [state.target, ...others] })
    .on('GET', /\/compare\/([^?]+)/, (m, _b, o) => {
      if (state.compareFails && m[1]!.includes(state.compareFails)) throw new Error('compare boom');
      return o.raw ? '' : { behind_by: 1 };
    })
    .on('PUT', /\/pulls\/\d+\/update-branch/, () => ({}));
  for (const p of others) {
    fake.on('GET', new RegExp(`/pulls/${p.number}$`), () => p).on('GET', new RegExp(`/issues/${p.number}/comments`), () => []);
  }
  return fake;
}
const run = async (fake: FakeGitHub) => {
  const logs: string[] = [];
  await onSchedule(ctxFor(fake, 'schedule', {}, { log: (m: string) => logs.push(m) }), new Date());
  return logs;
};
const updated = (fake: FakeGitHub, n = 5) => fake.calls.some((c) => c.method === 'PUT' && c.path.endsWith(`/pulls/${n}/update-branch`));
const dashboardWritten = (fake: FakeGitHub) => fake.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));

test('定期実行：宣言の無い遅れた Agent PR（既定ブランチ宛て）は update-branch する', async () => {
  const fake = followFake({ target: pr({ mergeable_state: 'behind' }) });
  await run(fake);
  assert.equal(updated(fake), true);
  assert.ok(dashboardWritten(fake));
});

test('定期実行：判定中（段階 judge）の宣言が残る遅れた Agent PR は update-branch しない', async () => {
  const fake = followFake({ target: pr({ mergeable_state: 'behind' }), prComments: [claimComment({ stage: 'judge' })] });
  await run(fake);
  assert.equal(updated(fake), false);
  assert.ok(dashboardWritten(fake));
});

test('定期実行：判定コメントで宣言が終わった遅れた Agent PR は update-branch する（main への push が来ない間の戻り道）', async () => {
  const fake = followFake({ target: pr({ mergeable_state: 'behind' }), prComments: [claimComment({ stage: 'judge' }), verdictComment()] });
  await run(fake);
  assert.equal(updated(fake), true);
});

test('定期実行：コンフリクトしている（mergeable_state: dirty）PR は update-branch しない', async () => {
  const fake = followFake({ target: pr({ mergeable_state: 'dirty' }) });
  await run(fake);
  assert.equal(updated(fake), false);
});

test('定期実行：base が既定ブランチでない Stacked PR の層は、遅れていても update-branch しない', async () => {
  const fake = followFake({ target: stackedPr({ mergeable_state: 'behind' }) });
  await run(fake);
  assert.equal(updated(fake), false);
});

test('定期実行：compare が失敗する PR があっても、ほかの PR の追従とダッシュボードの書き換えは行う', async () => {
  const fake = followFake({ target: pr({ mergeable_state: 'behind' }), others: [pr6({ mergeable_state: 'behind' })], compareFails: 'a'.repeat(40) });
  const logs = await run(fake);
  assert.equal(updated(fake, 5), false);
  assert.equal(updated(fake, 6), true, '#6 の追従は止めない');
  assert.ok(dashboardWritten(fake), 'ダッシュボードの書き換えは止めない');
  assert.ok(logs.some((l) => l.includes('compare boom')), `失敗はログに残す: ${logs.join('\n')}`);
});
