// Merge 後の main の CI の失敗（harness/gates/post-merge-revert.ts の postMergeRevert。Issue #802）：自動 Merge した PR なら revert の PR を出して停止スイッチを入れ、人が Merge した PR では停止だけ。同じ sha では2回動かない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postMergeRevert } from '../gates/post-merge-revert.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';
import { revertBranchName, type PostMergeStopRecord } from '../lib/post-merge-revert.ts';
import { HttpError } from '../lib/github.ts';
import { appRecords } from '../lib/state.ts';
import {
  APP, config, ctxFor, delegateWorldFake, mainChecks, pr, MAIN_HEAD, MAIN_PARENT_TREE,
  type DelegateWorld, type FakeGitHub, type MainCheckResult,
} from './support/gate-fixtures.ts';

const STOP = config.autoMergeStopLabel;
const REVERT_SHA = '9'.repeat(40);
const REVERT_PR = 50;

/** 先頭 H を Merge の commit に持つ、Merge 済みの PR #7（既定は App が自動 Merge した Agent PR） */
function mergedPr(patch: Record<string, unknown> = {}) {
  return pr({
    number: 7, node_id: 'PR_7', state: 'closed', title: 'feat: 壊す変更', body: 'Closes #6', draft: false,
    merged_at: '2026-10-01T00:00:00Z', merge_commit_sha: MAIN_HEAD, merged_by: { login: APP },
    head: { ref: 'claude/issue-6-x', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } }, ...patch,
  });
}

interface Scenario {
  head?: MainCheckResult;
  parent?: MainCheckResult;
  merged?: ReturnType<typeof mergedPr>;
  /** POST /git/refs を 422 で失敗させる（ブランチが既にある） */
  refExists?: boolean;
}

/** 世界（w）を残したまま、同じ場面の偽の GitHub を作り直せる（2回目の実行で前回の書き込みを読む） */
function scenario(s: Scenario = {}) {
  const merged = s.merged ?? mergedPr();
  const w: DelegateWorld = {
    // auto-merge 待ちの Agent PR。停止スイッチで auto-merge が外れる
    prs: [pr({ number: 5, draft: false, auto_merge: { enabled: true } })],
    closedPrs: [merged],
    dashboardLabels: [],
  };
  const fake = (): FakeGitHub => mainChecks(delegateWorldFake(w), { head: s.head === undefined ? 'failure' : s.head, parent: s.parent ?? 'success' })
    .on('GET', new RegExp(`/commits/${MAIN_HEAD}/pulls`), () => [{ ...merged, merged_by: undefined }])
    .on('POST', /\/git\/commits$/, () => ({ sha: REVERT_SHA }))
    .on('POST', /\/git\/refs$/, (_m, body) => {
      if (s.refExists) throw new HttpError(422, 'POST /git/refs -> 422: Reference already exists');
      return { ref: body.ref, object: { sha: body.sha } };
    })
    .on('POST', /\/pulls$/, (_m, body) => ({ number: REVERT_PR, html_url: `p${REVERT_PR}`, draft: body.draft }));
  return { w, fake };
}

const posts = (fake: FakeGitHub, re: RegExp) => fake.calls.filter((c) => c.method === 'POST' && re.test(c.path));
const stopRecords = (w: DelegateWorld) => appRecords<PostMergeStopRecord>(config, (w.comments?.[1] ?? []) as any, 'auto-merge-stopped');
const labelDeletes = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'DELETE' && c.path.includes('/labels/'));

test('自動 Merge の後に main の CI が落ちたら、revert の commit・ブランチ・Draft の PR を出し、停止スイッチを入れて理由を書き、auto-merge を外す', async () => {
  const { w, fake } = scenario();
  const gh = fake();
  await postMergeRevert(ctxFor(gh, 'schedule', {}));

  const [commit] = posts(gh, /\/git\/commits$/);
  assert.ok(commit, 'revert の commit を作っていません');
  assert.equal(commit.body.tree, MAIN_PARENT_TREE, '木は第1親の木にする');
  assert.deepEqual(commit.body.parents, [MAIN_HEAD], '親は先頭の commit にする');
  assert.deepEqual(revertedPrNumbers(commit.body.message), [7]);
  assert.deepEqual(revertedShas(commit.body.message), [MAIN_HEAD]);

  const [ref] = posts(gh, /\/git\/refs$/);
  assert.ok(ref, 'revert のブランチを作っていません');
  assert.equal(ref.body.ref, `refs/heads/${revertBranchName(7)}`);
  assert.equal(ref.body.sha, REVERT_SHA);
  assert.ok(!revertBranchName(7).startsWith(config.agentBranchPrefix), 'revert の PR は Agent PR にしない');

  const [pull] = posts(gh, /\/pulls$/);
  assert.ok(pull, 'revert の PR を出していません');
  assert.equal(pull.body.draft, true);
  assert.equal(pull.body.base, config.defaultBranch);
  assert.equal(pull.body.head, revertBranchName(7));

  assert.ok(w.dashboardLabels.includes(STOP), '停止スイッチが入っていません');
  const records = stopRecords(w);
  assert.equal(records.length, 1, 'ダッシュボードに理由のコメントが1件ありません');
  assert.equal(records[0]!.value.cause, 'main-ci-failed');
  assert.equal(records[0]!.value.sha, MAIN_HEAD);
  assert.equal(records[0]!.value.pr, 7);
  assert.equal(records[0]!.value.revertPr, REVERT_PR);
  assert.equal(w.prs[0]!.auto_merge, null, 'auto-merge 待ちの PR の auto-merge が外れていません');

  // 守り：Merge・停止スイッチを外す処理をしない
  assert.deepEqual(labelDeletes(gh), []);
  assert.ok(!gh.calls.some((c) => /\/merge$/.test(c.path)), 'Merge を呼んでいます');
});

test('人が Merge した PR では revert の commit・ブランチ・PR を作らず、停止スイッチと理由だけを入れる', async () => {
  const { w, fake } = scenario({ merged: mergedPr({ merged_by: { login: 'me' } }) });
  const gh = fake();
  await postMergeRevert(ctxFor(gh, 'schedule', {}));
  assert.deepEqual(posts(gh, /\/git\/commits$/), []);
  assert.deepEqual(posts(gh, /\/git\/refs$/), []);
  assert.deepEqual(posts(gh, /\/pulls$/), []);
  assert.ok(w.dashboardLabels.includes(STOP), '停止スイッチが入っていません');
  const records = stopRecords(w);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.value.sha, MAIN_HEAD);
  assert.equal(records[0]!.value.revertPr, null);
  assert.deepEqual(labelDeletes(gh), []);
});

test('revert のブランチを作れない（既にある）ときは PR を出さず、停止スイッチと理由だけを入れる', async () => {
  const { w, fake } = scenario({ refExists: true });
  const gh = fake();
  await postMergeRevert(ctxFor(gh, 'schedule', {}));
  assert.deepEqual(posts(gh, /\/pulls$/), []);
  assert.ok(w.dashboardLabels.includes(STOP), '停止スイッチが入っていません');
  const records = stopRecords(w);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.value.revertPr, null);
});

test('同じ先頭の sha で2回目に流しても、revert の PR・コメント・ラベルは増えない', async () => {
  const { w, fake } = scenario();
  await postMergeRevert(ctxFor(fake(), 'schedule', {}));
  const second = fake();
  await postMergeRevert(ctxFor(second, 'schedule', {}));
  assert.deepEqual(second.writes(), []);
  assert.equal(stopRecords(w).length, 1);
});

test('main の先頭の CI が成功・終わっていない・チェックが無いときは何もしない', async () => {
  for (const head of ['success', null, 'missing'] as const) {
    const { w, fake } = scenario({ head });
    const gh = fake();
    await postMergeRevert(ctxFor(gh, 'schedule', {}));
    assert.deepEqual(gh.writes(), [], String(head));
    assert.ok(!w.dashboardLabels.includes(STOP), String(head));
  }
});
