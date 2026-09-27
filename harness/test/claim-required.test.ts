// Issue #157：このセッションの着手宣言が無いと critic-input・post-plan・worktree が止まり、claim はほかのセッションの宣言の上に宣言しない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import { claimOf } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import { claimBlocker, requireOwnClaim, worktreeClaimIssue, type Claim } from '../lib/queue.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const ROUTINE_URL = 'https://claude.ai/code/session_01ABCDEFGHxyz';

const now = new Date('2026-09-26T12:00:00Z');
const opts = (takeover = false) => ({ takeover, now, humanClaimStaleHours: 6 });
const manual = (patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', ...patch });
const routine = (at = '2026-09-26T11:50:00Z'): Claim => ({ by: 'routine', session: ROUTINE_URL, at });

// ---- claimBlocker（claim コマンド）----

test('claimBlocker：宣言が無い・解除済みなら宣言してよい', () => {
  assert.equal(claimBlocker(null, SESSION, opts()), null);
  assert.equal(claimBlocker(manual({ session: OTHER, released: true }), SESSION, opts()), null);
});

test('claimBlocker：このセッションの宣言なら段階を更新してよい', () => {
  assert.equal(claimBlocker(manual({ session: SESSION, stage: 'plan' }), SESSION, opts()), null);
});

test('claimBlocker：ほかのセッションの有効な手動の宣言があれば理由を返す（期限を過ぎていても止める）', () => {
  for (const [label, claim, current] of [
    ['別のセッション', manual({ session: OTHER, stage: 'plan-critique' }), SESSION],
    ['session の無い古い宣言', manual(), SESSION],
    ['今のセッションが分からない', manual({ session: OTHER }), null],
    ['期限を過ぎた宣言', manual({ session: OTHER, at: '2026-09-25T00:00:00Z' }), SESSION],
  ] as const) {
    const r = claimBlocker(claim, current, opts());
    assert.ok(typeof r === 'string' && r.length > 0, `止めるべき: ${label}`);
  }
});

test('claimBlocker：--takeover ならほかのセッションの宣言の上に宣言してよい', () => {
  assert.equal(claimBlocker(manual({ session: OTHER }), SESSION, opts(true)), null);
  assert.equal(claimBlocker(manual(), SESSION, opts(true)), null);
});

test('claimBlocker：Routine の宣言の上に手動で宣言するのは今までどおり止めない', () => {
  assert.equal(claimBlocker(routine(), SESSION, opts()), null);
  assert.equal(claimBlocker(routine(), null, opts()), null);
});

// ---- requireOwnClaim（critic-input・post-plan・worktree）----

test('requireOwnClaim：宣言が無い（null・解除済み）と失敗する', () => {
  for (const current of [SESSION, null]) {
    assert.ok(requireOwnClaim(null, current).error, `null / ${current}`);
    assert.ok(requireOwnClaim(manual({ session: SESSION, released: true }), current).error, `解除済み / ${current}`);
  }
});

test('requireOwnClaim：ほかのセッションの宣言があると失敗する', () => {
  assert.ok(requireOwnClaim(manual({ session: OTHER }), SESSION).error, '別のセッション');
  assert.ok(requireOwnClaim(manual(), SESSION).error, 'session の無い手動の宣言');
  assert.ok(requireOwnClaim(routine(), SESSION).error, 'Routine の宣言');
});

test('requireOwnClaim：このセッションの宣言なら error も warning も無い', () => {
  assert.deepEqual(requireOwnClaim(manual({ session: SESSION, stage: 'plan-critique' }), SESSION), { error: null, warning: null });
});

test('requireOwnClaim：今のセッション ID が分からないときは、宣言があれば警告だけにする', () => {
  const r = requireOwnClaim(manual({ session: OTHER }), null);
  assert.equal(r.error, null);
  assert.ok(r.warning, 'ID で見分けられないことを警告する');
  const old = requireOwnClaim(manual(), null);
  assert.equal(old.error, null);
  assert.ok(old.warning);
});

// ---- worktreeClaimIssue ----

test('worktreeClaimIssue：claude/issue-<番号>-… のブランチだけ、宣言を確かめる番号を返す', () => {
  assert.equal(worktreeClaimIssue('claude/issue-157-claim-stage-session', false, false), 157);
  assert.equal(worktreeClaimIssue('claude/issue-7-x', false, false), 7);
  assert.equal(worktreeClaimIssue('claude/issue-157-claim-stage-session', true, false), null, '--detach は確かめない');
  assert.equal(worktreeClaimIssue('claude/issue-157-claim-stage-session', false, true), null, 'Routine は確かめない');
  for (const branch of ['feature/x', 'claude/106-x', 'claude/issue-abc-x', 'main', 'agent/harness-architecture-config-272b82']) {
    assert.equal(worktreeClaimIssue(branch, false, false), null, branch);
  }
});

// ---- post-plan の後も宣言が有効なまま残る ----

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:00:${String(id).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
const claimComment = (value: Record<string, unknown>) => comment(`${claudeMark(SESSION)}\n着手しました。\n\n${renderBlock('agent-claim', value)}`);
const planComment = () => comment(`${claudeMark(SESSION)}\n## 計画\n\n${renderBlock('agent-plan', plan)}`);

test('claimOf：計画コメントの後に plan-gate の宣言があれば、その宣言が有効（post-plan の後も残る）', () => {
  const gateClaim = { by: 'manual', at: '2026-09-26T11:00:00Z', session: SESSION, stage: 'plan-gate' };
  const comments = [
    claimComment({ by: 'manual', at: '2026-09-26T10:00:00Z', session: SESSION, stage: 'plan-critique' }),
    planComment(),
    claimComment(gateClaim),
  ];
  const c = claimOf(comments);
  assert.deepEqual(c, gateClaim);
  assert.deepEqual(requireOwnClaim(c, SESSION), { error: null, warning: null }, 'このセッションの宣言として通る');
});

test('claimOf：計画コメントの後に宣言が無ければ null（宣言は終わっている）', () => {
  const comments = [claimComment({ by: 'manual', at: '2026-09-26T10:00:00Z', session: SESSION, stage: 'plan-critique' }), planComment()];
  assert.equal(claimOf(comments), null);
});
