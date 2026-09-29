import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onMainPush } from '../gates/on-main-push.ts';
import { FakeGitHub, HEAD, ctxFor, pr } from './support/gate-fixtures.ts';
import { STACK, appRecordComment, countCalls, postedBodies } from './support/stack-fixtures.ts';

/**
 * 既定ブランチへの push で、Merge された Stacked PR の層の App の stack-link の記録の Issue を閉じる。
 * 閉じ済みの Issue・記録の無い PR・App 以外の記録・Merge されていない PR・本文から消えた Issue・PR の番号は飛ばす。
 */

const MERGED_AT = '2026-09-27T10:00:00Z';

/** Merge された層（/commits/{sha}/pulls の要素） */
const mergedLayer = (patch: Record<string, unknown> = {}) => pr({ state: 'closed', merged_at: MERGED_AT, body: 'Refs #3', stack: STACK, ...patch });
const stackLink = (issues: number[], login?: string) => {
  const c = appRecordComment(95, 'stack-link', 'Issue に紐付けました。', { version: 1, issues, stack: STACK.number });
  return login ? { ...c, author_association: 'OWNER', user: { login, type: 'User' } } : c;
};

/**
 * pulls：コミットの sha ごとの /commits/{sha}/pulls の応答（Error なら失敗させる）。
 * issues：/issues/{n} の応答。prComments：PR #5 のコメント。open：開いた PR の一覧（追従の対象）
 */
function pushFake(state: { pulls: Record<string, unknown[] | Error>; issues?: Record<number, unknown>; prComments?: unknown[]; open?: unknown[] }): FakeGitHub {
  const fake = new FakeGitHub()
    .on('GET', /\/commits\/(\w+)\/pulls/, (m) => {
      const r = state.pulls[m[1]!];
      if (r instanceof Error) throw r;
      return r ?? [];
    })
    .on('GET', /\/pulls\/5$/, () => (state.pulls.s1 instanceof Error ? mergedLayer() : (state.pulls.s1?.[0] ?? mergedLayer())))
    // PR #5 は prComments。ほかの番号（追従の前に判定中かを確かめる PR など）はコメントなし
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => (m[1] === '5' ? (state.prComments ?? []) : []))
    .on('GET', /\/issues\/(\d+)$/, (m) => state.issues?.[Number(m[1])] ?? { number: Number(m[1]), state: 'open' })
    .on('PATCH', /\/issues\/\d+$/, () => ({}))
    .on('POST', /\/issues\/\d+\/comments/, () => ({ id: 1, html_url: 'u' }))
    .on('GET', /\/pulls\?state=open/, () => state.open ?? []);
  return fake;
}
const push = (fake: FakeGitHub, shas = ['s1']) => onMainPush(ctxFor(fake, 'push', { commits: shas.map((id) => ({ id, message: `feat: 層 (#5)` })) }));
const closes = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'PATCH' && /\/issues\/\d+$/.test(c.path));
const closedIssues = (fake: FakeGitHub) => closes(fake).map((c) => Number(c.path.split('/').at(-1)));

test('push：Merge された層の stack-link の記録の Issue を閉じ（completed）、Issue に stack-closed の記録を残す', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()] }, prComments: [stackLink([3])] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), [3]);
  assert.deepEqual(closes(fake)[0]!.body, { state: 'closed', state_reason: 'completed' });
  const bodies = postedBodies(fake, 'stack-closed');
  assert.equal(bodies.length, 1);
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments')), '記録は閉じた Issue に残す');
  assert.ok(bodies[0]!.includes('#5') && bodies[0]!.includes(`#${STACK.number}`), bodies[0]);
});

test('push：一番上の層の Closes #N の記録も同じく閉じる', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer({ body: 'Closes #3' })] }, prComments: [stackLink([3])] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), [3]);
});

test('push：同じ PR が複数のコミットで引かれても1度だけ処理する', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()], s2: [mergedLayer()] }, prComments: [stackLink([3])] });
  await push(fake, ['s1', 's2']);
  assert.deepEqual(closedIssues(fake), [3]);
  assert.equal(postedBodies(fake, 'stack-closed').length, 1);
});

test('push：閉じ済みの Issue は閉じ直さず、記録も残さない（GitHub が Closes で先に閉じた場合）', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()] }, prComments: [stackLink([3])], issues: { 3: { number: 3, state: 'closed' } } });
  await push(fake);
  assert.deepEqual(closedIssues(fake), []);
  assert.equal(postedBodies(fake, 'stack-closed').length, 0);
});

test('push：stack-link の記録の無い PR は飛ばす（Issue を読みもしない）', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()] }, prComments: [] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), []);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/3'), 0);
  assert.equal(postedBodies(fake, 'stack-closed').length, 0);
});

test('push：App 以外が書いた stack-link の記録は読まない', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()] }, prComments: [stackLink([3], 'me')] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), []);
});

test('push：Merge されていない PR（merged_at が無い）は飛ばす', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer({ state: 'open', merged_at: null })] }, prComments: [stackLink([3])] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), []);
});

test('push：記録の後に本文から消えた Issue は閉じない', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer({ body: 'Refs #4' })] }, prComments: [stackLink([3])] });
  await push(fake);
  assert.deepEqual(closedIssues(fake), [], '古い記録の #3 も、記録に無い #4 も閉じない');
});

test('push：記録の番号が PR（pull_request がある）なら閉じない', async () => {
  const fake = pushFake({ pulls: { s1: [mergedLayer()] }, prComments: [stackLink([3])], issues: { 3: { number: 3, state: 'open', pull_request: {} } } });
  await push(fake);
  assert.deepEqual(closedIssues(fake), []);
});

test('push：/commits/{sha}/pulls が失敗しても、そのコミットを飛ばして他のコミットと main への追従を続ける', async () => {
  let updated = false;
  const fake = pushFake({
    pulls: { s0: new Error('boom'), s1: [mergedLayer()] },
    prComments: [stackLink([3])],
    open: [pr({ number: 6, head: { ref: 'claude/issue-9', sha: HEAD, repo: { full_name: 'o/r' } } })],
  })
    .on('GET', /\/pulls\/6$/, () => pr({ number: 6, head: { ref: 'claude/issue-9', sha: HEAD, repo: { full_name: 'o/r' } } }))
    .on('GET', /\/compare\//, () => ({ behind_by: 1 }))
    .on('PUT', /\/pulls\/6\/update-branch/, () => (updated = true));
  await push(fake, ['s0', 's1']);
  assert.deepEqual(closedIssues(fake), [3]);
  assert.equal(updated, true, '追従は止めない');
});
