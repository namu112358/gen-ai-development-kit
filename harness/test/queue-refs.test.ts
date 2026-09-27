import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeQueue } from '../lib/facts.ts';
import { GitHub } from '../lib/github.ts';
import { DIFF, FakeGitHub, HEAD, config, planGateComment, pr } from './support/gate-fixtures.ts';
import { FEATURE_BASE, STACK, countCalls, stackedPr } from './support/stack-fixtures.ts';

/**
 * queue（facts.ts の computeQueue・prFacts）が、Stacked PR の層の Refs #N で Issue と PR を紐付けるか。
 * スタックでない PR の Refs #N は紐付けない。
 */

const now = new Date('2026-09-27T12:00:00Z');
const agentHead = { ref: 'claude/issue-3-x', sha: HEAD, repo: { full_name: 'o/r' } };
const humanHead = { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } };

/**
 * computeQueue に必要な応答を揃えた偽の GitHub。
 * list は GET /pulls?state=open の応答、detail は GET /pulls/5 の応答、closing は closingIssuesReferences の番号。
 */
function queueFake(state: { list: unknown[]; detail: unknown; closing?: number[]; issue3Comments?: unknown[] }): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&labels=/, () => [{ number: 3, title: 't', labels: [{ name: 'agent:ready' }] }])
    .on('GET', /\/pulls\?state=open/, () => state.list)
    .on('GET', /\/pulls\/5$/, () => state.detail)
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/issues\/3\/timeline/, () => [])
    .on('GET', /\/issues\/3\/comments/, () => state.issue3Comments ?? [])
    .on('GET', /\/issues\/5\/comments/, () => [])
    .on('GET', /\/commits\/a+$/, () => ({ commit: { committer: { date: '2026-09-27T00:00:00Z' } } }))
    .on('GET', /\/commits\/a+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /\/compare\//, () => DIFF)
    .on('POST', /\/graphql/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('closingIssuesReferences')) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: (state.closing ?? []).map((number) => ({ number, repository: { nameWithOwner: 'o/r' } })) } } } } };
      }
      if (q.includes('blockedBy')) return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
      return { data: {} };
    });
}

const run = (fake: FakeGitHub) => computeQueue(new GitHub(fake, 'o/r'), config, null, now);
type Queue = Awaited<ReturnType<typeof computeQueue>>;
/** Issue #3 を飛ばした理由（飛ばしていなければ undefined） */
const issueSkipReason = (q: Queue) => q.skipped.flatMap((a) => (a.kind === 'skip' && a.target === '#3' ? [a.reason] : []))[0];
/** PR #5 の judge の issue（judge が無ければ undefined） */
const judgeIssue = (q: Queue) => q.actions.flatMap((a) => (a.kind === 'judge' && a.pr === 5 ? [a.issue] : []))[0];

test('queue：Refs #N のスタックの層（Agent PR）が Issue #N の openPr になり、PR の issue が N になる', async () => {
  const layer = stackedPr({ body: 'Refs #3', head: agentHead });
  const q = await run(queueFake({ list: [layer], detail: layer, closing: [] }));
  assert.equal(issueSkipReason(q), 'PR #5 の段階です', JSON.stringify(q));
  assert.equal(judgeIssue(q), 3, JSON.stringify(q));
});

test('queue：一覧の要素に stack が無くても、取り直した PR が層なら Refs #N で紐付く', async () => {
  const listed = pr({ base: FEATURE_BASE, body: 'Refs #3', head: agentHead });
  const detail = stackedPr({ body: 'Refs #3', head: agentHead });
  const q = await run(queueFake({ list: [listed], detail, closing: [] }));
  assert.equal(issueSkipReason(q), 'PR #5 の段階です', JSON.stringify(q));
  assert.equal(judgeIssue(q), 3, JSON.stringify(q));
});

test('queue：人の PR のスタックの層も、Refs #N の Issue に計画があれば判定の対象になる', async () => {
  const layer = stackedPr({ body: 'Refs #3', head: humanHead });
  const q = await run(queueFake({ list: [layer], detail: layer, closing: [], issue3Comments: [planGateComment] }));
  assert.equal(judgeIssue(q), 3, JSON.stringify(q));
  assert.equal(issueSkipReason(q), 'PR #5 の段階です');
});

test('queue：スタックでない PR の Refs #N は Issue に紐付かない', async () => {
  const plain = pr({ body: 'Refs #3', head: agentHead });
  const q = await run(queueFake({ list: [plain], detail: plain, closing: [] }));
  assert.deepEqual(q.actions.find((a) => 'issue' in a && a.issue === 3 && a.kind === 'plan'), { kind: 'plan', issue: 3 }, 'Issue は PR の段階にならない');
  assert.equal(judgeIssue(q), null);
});

test('queue：既定ブランチ宛てで Closes #N だけの PR は取り直さない（/pulls/{n} は prFacts の1回のまま）', async () => {
  const plain = pr({ body: 'Closes #3', head: agentHead });
  const fake = queueFake({ list: [plain], detail: plain, closing: [3] });
  const q = await run(fake);
  assert.equal(judgeIssue(q), 3);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls/5'), 1);
});

test('queue：スタックの層は closingIssuesReferences に別の番号があっても本文の Refs #N を使う', async () => {
  const layer = stackedPr({ body: 'Refs #3', head: agentHead, stack: { ...STACK, position: 1 } });
  const q = await run(queueFake({ list: [layer], detail: layer, closing: [99] }));
  assert.equal(judgeIssue(q), 3, JSON.stringify(q));
});
