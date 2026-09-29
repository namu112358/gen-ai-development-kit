// Issue #171：claimOf は「最初の宣言が持ち主」。後から書いた --takeover でない宣言は持ち主にならず、同じセッションの宣言し直しは段階の更新になる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import { claimOf } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Claim } from '../lib/queue.ts';

const A = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const B = '9b8c7d6e-1111-2222-3333-444455556666';
const ROUTINE_1 = 'https://claude.ai/code/session_01ABCDEFGHxyz';
const ROUTINE_2 = 'https://claude.ai/code/session_02ZYXWVUTSabc';

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
/** 宣言のコメント。Claude の目印は宣言したセッションのもの */
const claimComment = (value: Claim) => comment(`${claudeMark(value.session ?? null)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`);
const plan = { version: 1, issue: 171, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
const planComment = () => comment(`${claudeMark(A)}\n## 計画\n\n${renderBlock('agent-plan', plan)}`);
const verdictComment = () => comment(`${claudeMark(A)}\n## 判定\n\n${renderBlock('agent-verdict', { version: 1, pr: 1, verdict: 'pass' })}`);

const manual = (session: string | undefined, patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Extract<Claim, { by: 'manual' }> => ({
  by: 'manual',
  at: '2026-09-26T11:00:00Z',
  ...(session ? { session } : {}),
  ...patch,
});
const routine = (session: string, at = '2026-09-26T11:00:00Z'): Claim => ({ by: 'routine', session, at });

// ---- AC1：後から書いた --takeover でない宣言は持ち主にならない ----

test('claimOf：2つのセッションの宣言が続いたら、最初の宣言が持ち主のまま（後の側は持ち主にならない）', () => {
  const first = manual(A, { stage: 'plan', at: '2026-09-26T11:00:00Z' });
  const second = manual(B, { stage: 'plan', at: '2026-09-26T11:00:01Z' });
  assert.deepEqual(claimOf([claimComment(first), claimComment(second)]), first);
});

test('claimOf：後の側が段階を変えて何度宣言しても、持ち主は最初のセッションのまま', () => {
  const first = manual(A, { stage: 'plan' });
  const comments = [claimComment(first), claimComment(manual(B, { stage: 'plan' })), claimComment(manual(B, { stage: 'plan-critique' })), claimComment(manual(B, { stage: 'implement' }))];
  assert.deepEqual(claimOf(comments), first);
});

test('claimOf：session のある宣言の後の、session の無い宣言は別のセッションとみなし、持ち主にならない', () => {
  const first = manual(A, { stage: 'plan' });
  assert.deepEqual(claimOf([claimComment(first), claimComment(manual(undefined, { stage: 'implement' }))]), first);
});

test('claimOf：session の無い宣言の後の、session のある宣言（takeover なし）は持ち主にならない', () => {
  const first = manual(undefined, { stage: 'plan' });
  assert.deepEqual(claimOf([claimComment(first), claimComment(manual(B, { stage: 'plan' }))]), first);
});

// ---- AC2：--takeover の宣言は後でも持ち主になる ----

test('claimOf：takeover: true の宣言は、それまでの持ち主より後でも持ち主になる', () => {
  const taken = manual(B, { stage: 'implement', takeover: true, at: '2026-09-26T12:00:00Z' });
  assert.deepEqual(claimOf([claimComment(manual(A, { stage: 'plan' })), claimComment(taken)]), taken);
});

test('claimOf：引き継いだ後は、元の持ち主の宣言（takeover なし）で持ち主は戻らず、引き継いだ側の段階の更新は効く', () => {
  const taken = manual(B, { stage: 'implement', takeover: true });
  const updated = manual(B, { stage: 'judge', at: '2026-09-26T13:00:00Z' });
  const comments = [claimComment(manual(A, { stage: 'plan' })), claimComment(taken), claimComment(manual(A, { stage: 'fix' })), claimComment(updated)];
  assert.deepEqual(claimOf(comments), updated);
});

// ---- AC3：同じセッションの宣言し直しは段階の更新 ----

test('claimOf：持ち主と同じセッションが段階を変えて宣言し直すと、持ち主は同じで段階が新しくなる', () => {
  const later = manual(A, { stage: 'plan-critique', at: '2026-09-26T11:10:00Z' });
  const c = claimOf([claimComment(manual(A, { stage: 'plan' })), claimComment(later)]);
  assert.deepEqual(c, later);
  assert.equal(c?.session, A);
  assert.equal(c?.stage, 'plan-critique');
});

test('claimOf：間にほかのセッションの宣言が挟まっても、持ち主の宣言し直しで段階が新しくなる', () => {
  const later = manual(A, { stage: 'plan-critique' });
  const comments = [claimComment(manual(A, { stage: 'plan' })), claimComment(manual(B, { stage: 'plan' })), claimComment(later)];
  assert.deepEqual(claimOf(comments), later);
});

// ---- 解除・計画・判定の後 ----

test('claimOf：ほかのセッションの解除は持ち主を消さない（負けた側の取り下げで勝った側の宣言が消えない）', () => {
  const first = manual(A, { stage: 'plan' });
  const comments = [claimComment(first), claimComment(manual(B, { stage: 'plan' })), claimComment(manual(B, { released: true }))];
  assert.deepEqual(claimOf(comments), first);
});

test('claimOf：session のある持ち主の宣言は、session の無い解除では消えない', () => {
  const first = manual(A, { stage: 'plan' });
  assert.deepEqual(claimOf([claimComment(first), claimComment(manual(undefined, { released: true }))]), first);
});

test('claimOf：持ち主の解除の後は null、その後の新しい宣言が持ち主になる', () => {
  const released = [claimComment(manual(A, { stage: 'plan' })), claimComment(manual(A, { released: true }))];
  assert.equal(claimOf(released), null);
  const next = manual(B, { stage: 'implement' });
  const comments = [...released, claimComment(next), claimComment(manual(A, { stage: 'implement' }))];
  assert.deepEqual(claimOf(comments), next, '解除の後に最初に宣言した B が持ち主（その後の A は持ち主にならない）');
});

test('claimOf：計画コメント・判定コメントの後は持ち主がなくなり、その後の新しい宣言が持ち主になる', () => {
  for (const [label, end] of [['計画', planComment], ['判定', verdictComment]] as const) {
    const before = [claimComment(manual(A, { stage: 'plan-critique' })), end()];
    assert.equal(claimOf(before), null, `${label}の後は null`);
    const next = manual(B, { stage: 'implement' });
    assert.deepEqual(claimOf([...before, claimComment(next), claimComment(manual(A, { stage: 'implement' }))]), next, `${label}の後の最初の宣言が持ち主`);
  }
});

// ---- Routine の宣言（今の動きを保つ）----

test('claimOf：持ち主が Routine の宣言なら、手動の宣言（takeover なし）で持ち主が移る', () => {
  const m = manual(A, { stage: 'plan' });
  assert.deepEqual(claimOf([claimComment(routine(ROUTINE_1)), claimComment(m)]), m);
});

test('claimOf：持ち主が Routine の宣言なら、別の Routine の宣言でも持ち主が移る（期限の判断は queue が着手の前に行う）', () => {
  const r2 = routine(ROUTINE_2, '2026-09-26T12:00:00Z');
  assert.deepEqual(claimOf([claimComment(routine(ROUTINE_1)), claimComment(r2)]), r2);
});

test('claimOf：持ち主が手動の宣言なら、Routine の宣言では持ち主が移らない', () => {
  const first = manual(A, { stage: 'plan' });
  assert.deepEqual(claimOf([claimComment(first), claimComment(routine(ROUTINE_1))]), first);
});

// ---- session の無い古い書式（今の動きを保つ）----

test('claimOf：session の無い手動の宣言の後の、session の無い解除で持ち主がなくなる', () => {
  assert.equal(claimOf([claimComment(manual(undefined)), claimComment(manual(undefined, { released: true }))]), null);
});

test('claimOf：session の無い宣言が続くときは最後の宣言が使われる', () => {
  const last = manual(undefined, { stage: 'implement', at: '2026-09-26T12:00:00Z' });
  assert.deepEqual(claimOf([claimComment(manual(undefined, { stage: 'plan' })), claimComment(last)]), last);
});
