// 委任承認の間も、計画ゲートの批評の関所（critique・plan-critique の着手宣言）は飛ばさないことを、偽の GitHub で確かめる（Issue #241 と #204 の両立）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark } from '../lib/config.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment, reviewDelegatedPlans } from '../gates/on-comment.ts';
import { APP, CRITIQUE, DELEGATE, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment } from './support/stack-fixtures.ts';

/** ガードレールに当たり、delegateMergeExclude に当たらない files（委任なら飛ばせる停止） */
const GUARDED = 'harness/lib/plan.ts';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
let nextId = 7000;

const planOf = (patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue: 21, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE, ...patch,
});

function planComment(plan: Plan) {
  const id = nextId++;
  return { id, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
}

function world(comments: unknown[]): DelegateWorld {
  return {
    prs: [],
    dashboardLabels: [DELEGATE.planLabel],
    dashboardEvents: [delegateLabeled(DELEGATE.planLabel, new Date(Date.now() - 600_000).toISOString(), 'me')],
    issues: { 21: [LABELS.ready] },
    comments: { 21: comments },
  };
}

function gatePosts(fake: FakeGitHub): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/issues/21/comments') && String(c.body.body).includes(appMark('plan-gate')))
    .map((c) => String(c.body.body));
}

async function post(comments: unknown[], plan: Plan): Promise<{ fake: FakeGitHub; w: DelegateWorld }> {
  const w = world(comments);
  const fake = delegateWorldFake(w);
  await onComment(ctxFor(fake, 'issue_comment', { action: 'created', issue: { number: 21, labels: [{ name: LABELS.ready }], state: 'open' }, comment: planComment(plan) }));
  return { fake, w };
}

function lastRecord(fake: FakeGitHub): { body: string; value: Record<string, any> } {
  const body = gatePosts(fake).at(-1);
  assert.ok(body, 'plan-gate を投稿していません');
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok);
  return { body, value: block.value as Record<string, any> };
}

test('委任承認の間でも、critique の無い計画は批評の関所（no-critique）で止まり、delegated を残さない', async () => {
  const { fake, w } = await post([critiqueClaim()], planOf({ critique: undefined }));
  const { body, value } = lastRecord(fake);
  assert.equal(value.pass, false);
  assert.equal(value.delegated, undefined);
  assert.ok(body.includes(reasonMark('no-critique')), body);
  assert.ok(w.issues![21]!.includes(LABELS.planReview));
  assert.ok(!w.issues![21]!.includes(LABELS.planOk));
});

test('委任承認の間でも、計画より前に plan-critique の着手宣言が無い計画は止まる', async () => {
  const { fake, w } = await post([], planOf());
  const { value } = lastRecord(fake);
  assert.equal(value.pass, false);
  assert.equal(value.delegated, undefined);
  assert.ok(!w.issues![21]!.includes(LABELS.planOk));
});

test('委任承認で通すときも、批評で必須の指摘を残して進めた計画は critiqueProceeded を記録とコメントに残す', async () => {
  const { fake, w } = await post([critiqueClaim()], planOf({ critique: { verdict: 'revise', rounds: 3, mustRemaining: 2 } }));
  const { body, value } = lastRecord(fake);
  assert.equal(value.pass, true);
  assert.ok(value.delegated);
  assert.deepEqual(value.critiqueProceeded, { verdict: 'revise', mustRemaining: 2 });
  assert.ok(body.includes('必須の指摘が 2 件残ったまま'), body);
  assert.ok(w.issues![21]!.includes(LABELS.planOk));
});

test('reviewDelegatedPlans：批評の関所に当たる停止中の計画は判定し直さない（停止のコメントを増やさない）', async () => {
  for (const [label, comments, plan] of [
    ['critique が無い', [critiqueClaim()], planOf({ critique: undefined })],
    ['着手宣言が無い', [], planOf()],
  ] as const) {
    const c = planComment(plan);
    const record = { version: 1, planCommentId: c.id, planBodySha256: sha256(c.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'gate', plan };
    const w = world([...comments, c, appRecordComment(nextId++, 'plan-gate', `${reasonMark('no-critique')}\n計画ゲートで停止しました。`, record)]);
    w.issues = { 21: [LABELS.ready, LABELS.planReview] };
    w.issueEvents = { 21: [{ event: 'labeled', created_at: '2026-09-28T00:01:00Z', actor: { login: APP }, label: { name: LABELS.planReview } }] };
    const fake = delegateWorldFake(w);
    await reviewDelegatedPlans(ctxFor(fake, 'schedule', {}), new Date());
    assert.deepEqual(gatePosts(fake), [], `${label}: 停止のコメントを増やした`);
    assert.ok(w.issues[21]!.includes(LABELS.planReview), `${label}: plan-review が外れた`);
  }
});
