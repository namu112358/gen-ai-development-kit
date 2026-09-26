import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQueue, decideIssue, decidePr, type IssueFacts, type PrFacts } from '../lib/queue.ts';

const now = new Date('2026-09-26T12:00:00Z');
const opts = { currentSession: 'https://claude.ai/code/session_now', now, routineClaimTakeoverMinutes: 90 };

const issue = (patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: 1, title: 't', labels: ['agent:ready'], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const pr = (patch: Partial<PrFacts> = {}): PrFacts => ({
  number: 10, issue: 1, readyAt: '2026-09-26T00:00:00Z', labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});

test('Issue：計画 → ゲート待ち → 実装', () => {
  assert.equal(decideIssue(issue(), opts).kind, 'plan');
  assert.equal(decideIssue(issue({ latestPlanAt: '2026-09-26T01:00:00Z' }), opts).kind, 'skip', 'ゲート待ち');
  const passed = issue({ latestPlanAt: '2026-09-26T01:00:00Z', gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, labels: ['agent:ready', 'agent:plan-ok'], planOkByApp: true });
  assert.deepEqual(decideIssue(passed, opts), { kind: 'implement', issue: 1, planCommentId: 5 });
  assert.equal(decideIssue({ ...passed, planOkByApp: false }, opts).kind, 'skip', '本人名義で付けた plan-ok は信頼しない');
  assert.equal(decideIssue({ ...passed, gate: { pass: false, planCommentId: 5, at: '2026-09-26T01:01:00Z' } }, opts).kind, 'skip');
  assert.equal(decideIssue({ ...passed, openPr: 10 }, opts).kind, 'skip', 'PR 段階');
});

test('Issue：停止ラベル・依存・着手宣言', () => {
  for (const l of ['agent:hold', 'agent:blocked', 'agent:plan-review', 'agent:waiting']) {
    assert.equal(decideIssue(issue({ labels: ['agent:ready', l] }), opts).kind, 'skip', l);
  }
  assert.equal(decideIssue(issue({ labels: [] }), opts).kind, 'skip');
  assert.deepEqual(decideIssue(issue({ openBlockers: [3] }), opts), { kind: 'wait-dependency', issue: 1, blockers: [3] });
  const working = ['agent:ready', 'agent:working'];
  assert.equal(decideIssue(issue({ labels: working, claim: { by: 'manual', at: '2026-09-20T00:00:00Z' } }), opts).kind, 'skip', '人の着手は奪わない');
  assert.equal(decideIssue(issue({ labels: working, claim: { by: 'routine', session: 'other', at: '2026-09-26T11:30:00Z' } }), opts).kind, 'skip', '別の実行が着手中');
  assert.equal(decideIssue(issue({ labels: working, claim: { by: 'routine', session: 'other', at: '2026-09-26T10:00:00Z' } }), opts).kind, 'plan', '終了した実行の claim は引き継ぐ');
  assert.equal(decideIssue(issue({ labels: working, claim: { by: 'routine', session: opts.currentSession, at: '2026-09-26T11:59:00Z' } }), opts).kind, 'plan', '自分の claim');
});

test('PR：判定 → 受け付け待ち → 修正 / Merge 待ち', () => {
  assert.equal(decidePr(pr()).kind, 'judge');
  assert.equal(decidePr(pr({ verdictAwaitingGate: true })).kind, 'skip');
  assert.equal(decidePr(pr({ acceptance: { reviewPass: false, at: 'x' } })).kind, 'fix');
  assert.equal(decidePr(pr({ acceptance: { reviewPass: true, at: 'x' } })).kind, 'skip');
  assert.deepEqual(decidePr(pr({ acceptance: { reviewPass: true, at: 'x' }, humanFeedbackSincePush: 1 })), { kind: 'fix', pr: 10, issue: 1, reason: 'human' });
  assert.equal(decidePr(pr({ labels: ['agent:hold'], humanFeedbackSincePush: 1 })).kind, 'skip');
});

test('キュー：先着順・上限・skip は数えない', () => {
  const q = buildQueue(
    [issue({ number: 2, readyAt: '2026-09-26T03:00:00Z' }), issue({ number: 1, readyAt: '2026-09-26T01:00:00Z' }), issue({ number: 9, labels: ['agent:ready', 'agent:hold'] })],
    [pr({ number: 10, readyAt: '2026-09-26T02:00:00Z' })],
    opts,
    2,
  );
  assert.deepEqual(q.actions.map((a) => ('issue' in a && a.kind !== 'judge' ? a.issue : 'pr' in a ? `pr${a.pr}` : '')), [1, 'pr10']);
  assert.equal(q.skipped.length, 1);
});
