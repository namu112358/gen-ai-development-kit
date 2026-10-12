/**
 * 決定の記録の acChangeAccepted（AC の変更の提案を人が受け入れたことの明示）を確かめる（Issue #870、harness/lib/decision.ts）。
 * parseDecision：proceed のある記録にだけ書け、quote は空でなく at は ISO 8601、choice は任意。
 * proceedPostErrors（post-decision の投稿の前の守り）：acChangeProposed の計画は acChangeAccepted のある記録だけ通し、明示しない proceed は今どおり拒む。
 * acChangeProposed でない計画に書いた記録・止まっていない記録・agent:plan-review の無い Issue も拒む。
 * proceedEligibility（App の側）：acChangeAccepted があっても acChangeProposed の計画は今どおり対象外（App はこの記録でラベルを外さない）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDecision, proceedEligibility, proceedPostErrors } from '../lib/decision.ts';
import type { Plan } from '../lib/plan.ts';
import { CRITIQUE } from './support/gate-fixtures.ts';

const PROCEED = { choice: '進める', quote: 'このまま進めてください', at: '2026-09-27T10:00:00+09:00' };
const ACCEPTED = { choice: '受け入れる', quote: 'AC の変更はこの提案どおりでよいです', at: '2026-09-27T10:05:00+09:00' };

// ---- parseDecision ----

test('parseDecision：proceed と acChangeAccepted を読む（choice は任意）', () => {
  for (const acChangeAccepted of [ACCEPTED, { quote: ACCEPTED.quote, at: ACCEPTED.at }]) {
    const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, proceed: PROCEED, acChangeAccepted });
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.deepEqual(r.value.proceed, PROCEED);
    assert.deepEqual(r.value.acChangeAccepted, acChangeAccepted);
  }
});

test('parseDecision：acChangeAccepted の誤り（quote が空・無い、at が ISO 8601 でない、オブジェクトでない、answers の記録に書いた）', () => {
  const answers = [{ to: 'reason:0', quote: '答え', at: '2026-09-27T01:00:00Z' }];
  const cases: [string, Record<string, unknown>][] = [
    ['quote が空', { proceed: PROCEED, acChangeAccepted: { ...ACCEPTED, quote: '' } }],
    ['quote が無い', { proceed: PROCEED, acChangeAccepted: { choice: ACCEPTED.choice, at: ACCEPTED.at } }],
    ['at が日時でない', { proceed: PROCEED, acChangeAccepted: { ...ACCEPTED, at: '昨日' } }],
    ['at が日付だけ', { proceed: PROCEED, acChangeAccepted: { ...ACCEPTED, at: '2026-09-27' } }],
    ['オブジェクトでない（文字列）', { proceed: PROCEED, acChangeAccepted: 'yes' }],
    ['オブジェクトでない（true）', { proceed: PROCEED, acChangeAccepted: true }],
    ['answers の記録（proceed が無い）に書いた', { answers, acChangeAccepted: ACCEPTED }],
  ];
  for (const [name, patch] of cases) {
    const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, ...patch });
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('acChangeAccepted')), `${name}: ${r.errors.join('\n')}`);
  }
});

// ---- proceedPostErrors（post-decision の守り） ----

type PostInput = Parameters<typeof proceedPostErrors>[0];
const STOPPED = [{ name: 'agent:ready' }, { name: 'agent:plan-review' }];

function post(acChangeProposed: boolean, accepted: boolean, patch: Partial<PostInput> = {}): PostInput {
  return {
    issueNumber: 3,
    labels: STOPPED,
    record: { pass: false, plan: { acChangeProposed } },
    decision: accepted ? { acChangeAccepted: ACCEPTED } : {},
    ...patch,
  };
}

test('proceedPostErrors：acChangeProposed の計画で acChangeAccepted のある記録はエラーが空', () => {
  assert.deepEqual(proceedPostErrors(post(true, true)), []);
});

test('proceedPostErrors：acChangeProposed の計画で acChangeAccepted の無い proceed は今どおり拒み、acChangeAccepted を書く案内を添える', () => {
  const errors = proceedPostErrors(post(true, false));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0]!, /AC の変更提案/);
  assert.match(errors[0]!, /acChangeAccepted/);
});

test('proceedPostErrors：acChangeProposed でない計画は、acChangeAccepted が無ければ通し、書いてあれば拒む', () => {
  assert.deepEqual(proceedPostErrors(post(false, false)), []);
  const errors = proceedPostErrors(post(false, true));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0]!, /acChangeAccepted/);
});

test('proceedPostErrors：acChangeAccepted があっても、止まっていない記録・agent:plan-review の無い Issue は拒む', () => {
  const cases: [string, Partial<PostInput>][] = [
    ['通過した記録（pass: true）', { record: { pass: true, plan: { acChangeProposed: true } } }],
    ['pass の無い記録', { record: { plan: { acChangeProposed: true } } }],
    ['agent:plan-review が無い', { labels: [{ name: 'agent:ready' }] }],
    ['ラベルが無い', { labels: [] }],
  ];
  for (const [name, patch] of cases) {
    const errors = proceedPostErrors(post(true, true, patch));
    assert.ok(errors.length > 0, name);
  }
  // 両方が当たれば両方を返す
  assert.equal(proceedPostErrors(post(true, true, { labels: [], record: { pass: true, plan: { acChangeProposed: true } } })).length, 2);
});

// ---- proceedEligibility（App はこの記録でラベルを外さない） ----

test('proceedEligibility：acChangeProposed の計画は acChangeAccepted のある記録でも今どおり対象外', () => {
  const P = Date.parse('2026-09-27T00:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const sha = 'a'.repeat(64);
  const plan: Plan = {
    version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: true,
    openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE,
  };
  const r = proceedEligibility({
    issue: { number: 3, state: 'open', labels: STOPPED },
    decision: { version: 1, issue: 3, planCommentId: 80, answers: [], proceed: PROCEED, acChangeAccepted: ACCEPTED },
    decisionCommentId: 100,
    latest: {
      commentId: 90,
      createdAt: iso(P + 20_000),
      value: { version: 1, planCommentId: 80, pass: false, reasons: ['Planner が要件・AC の変更を提案しています'], planReviewOrigin: 'planner', plan, planBodySha256: sha },
    },
    planComment: { id: 80, createdAt: iso(P), bodySha256: sha },
    windows: [{ planCreatedAt: iso(P), gateCreatedAt: iso(P + 20_000) }],
    events: [{ event: 'labeled', created_at: iso(P - 30_000), label: { name: 'agent:plan-review' }, actor: { login: 'me' } }],
    priorProceedIds: [],
  });
  assert.equal(r.eligible, false);
  assert.ok(r.reasons.some((e) => /AC の変更提案/.test(e)), r.reasons.join('\n'));
});
