/**
 * 決定の記録（```agent-decision）の proceed（`agent:plan-review` で止まった計画を人が「進める」と決めた記録）の書式と対象の判断を確かめる（Issue #365、harness/lib/decision.ts）。
 * parseDecision：proceed があれば answers のキーは書けず、quote は空でなく at は ISO 8601、value.answers は []。proceed が無ければ今までどおり answers が1件以上。
 * proceedEligibility：停止の後の決定で、計画コメントが編集されておらず、AC の変更提案が無く、今の印がどれかの計画の窓（計画の投稿 − LABEL_GRACE_MS から計画ゲートの記録まで）で付いたものだけが対象。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL_GRACE_MS, parseDecision, proceedEligibility } from '../lib/decision.ts';
import type { Plan } from '../lib/plan.ts';
import { CRITIQUE } from './support/gate-fixtures.ts';

type Input = Parameters<typeof proceedEligibility>[0];

const P = Date.parse('2026-09-27T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** 計画コメント（id 80）と、その計画ゲートの記録（id 90）の作成時刻 */
const PLAN_AT = P;
const GATE_AT = P + 20_000;
/** 前に出した計画（id 70）と、その記録（id 71）の作成時刻 */
const PREV_PLAN_AT = P - 7_200_000;
const PREV_GATE_AT = P - 7_180_000;
const PLAN_SHA = 'a'.repeat(64);

const plan: Plan = {
  version: 1, issue: 3, risk: 'low', needsHuman: true, needsHumanReasons: ['既定値を決める'], acChangeProposed: false,
  openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE,
};

const PROCEED = { choice: '進める', quote: 'このまま進めてください', at: '2026-09-27T10:00:00+09:00' };

const labeled = (at: number, login = 'me') => ({ event: 'labeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });
const unlabeled = (at: number, login = 'me') => ({ event: 'unlabeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });

const WINDOW = { planCreatedAt: iso(PLAN_AT), gateCreatedAt: iso(GATE_AT) };
const PREV_WINDOW = { planCreatedAt: iso(PREV_PLAN_AT), gateCreatedAt: iso(PREV_GATE_AT) };

/** 対象になる既定の入力（post-plan が投稿の直前に印を付けた、Planner の申告の停止） */
function input(patch: Partial<Input> = {}): Input {
  return {
    issue: { number: 3, state: 'open', labels: [{ name: 'agent:ready' }, { name: 'agent:plan-review' }] },
    decision: { version: 1, issue: 3, planCommentId: 80, answers: [], proceed: PROCEED },
    decisionCommentId: 100,
    latest: {
      commentId: 90,
      createdAt: iso(GATE_AT),
      value: { version: 1, planCommentId: 80, pass: false, reasons: ['Planner が人間の判断が必要と申告しています'], planReviewOrigin: 'planner', plan, planBodySha256: PLAN_SHA },
    },
    planComment: { id: 80, createdAt: iso(PLAN_AT), bodySha256: PLAN_SHA },
    windows: [WINDOW],
    events: [labeled(PLAN_AT - 30_000)],
    priorProceedIds: [],
    ...patch,
  };
}

const latestWith = (value: Record<string, unknown>): Input['latest'] => {
  const base = input().latest!;
  return { ...base, value: { ...base.value, ...value } as NonNullable<Input['latest']>['value'] };
};

// ---- parseDecision ----

test('parseDecision：proceed の記録を読み、value.answers は [] で proceed をそのまま返す', () => {
  const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, proceed: PROCEED });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.deepEqual(r.value.answers, []);
  assert.deepEqual(r.value.proceed, PROCEED);
  assert.equal(r.value.issue, 3);
  assert.equal(r.value.planCommentId, 80);
});

test('parseDecision：proceed の choice は任意', () => {
  const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, proceed: { quote: '進めて', at: '2026-09-27T01:00:00Z' } });
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.deepEqual(r.value.proceed, { quote: '進めて', at: '2026-09-27T01:00:00Z' });
});

test('parseDecision：proceed と answers のキーを両方書くと誤り（空の配列でも）。エラー文に proceed と answers を含む', () => {
  for (const answers of [[], [{ to: 'reason:0', quote: '答え', at: '2026-09-27T01:00:00Z' }]]) {
    const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, proceed: PROCEED, answers });
    assert.equal(r.ok, false, JSON.stringify(answers));
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes('proceed') && e.includes('answers')), r.errors.join('\n'));
    }
  }
});

test('parseDecision：proceed.quote が空・at が ISO 8601 でない・proceed が object でなければ誤り', () => {
  const cases: [string, unknown][] = [
    ['quote が空', { ...PROCEED, quote: '' }],
    ['quote が無い', { choice: '進める', at: PROCEED.at }],
    ['at が日時でない', { ...PROCEED, at: '昨日' }],
    ['at が日付だけ', { ...PROCEED, at: '2026-09-27' }],
    ['at が無い', { quote: '進めて' }],
    ['proceed が文字列', 'yes'],
  ];
  for (const [name, proceed] of cases) {
    const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, proceed });
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('proceed')), `${name}: ${r.errors.join('\n')}`);
  }
});

test('parseDecision：proceed が無ければ今までどおり answers が1件以上必要', () => {
  assert.equal(parseDecision({ version: 1, issue: 3, planCommentId: 80, answers: [] }).ok, false);
  assert.equal(parseDecision({ version: 1, issue: 3, planCommentId: 80 }).ok, false);
  const r = parseDecision({ version: 1, issue: 3, planCommentId: 80, answers: [{ to: 'reason:0', quote: '答え', at: '2026-09-27T01:00:00Z' }] });
  assert.ok(r.ok);
  assert.equal(r.value.proceed, undefined, 'answers の記録には proceed が無い');
});

// ---- proceedEligibility：対象 ----

test('proceedEligibility：停止の後の決定で、計画が編集されておらず、印が計画の窓で付いていれば対象', () => {
  const r = proceedEligibility(input());
  assert.deepEqual(r, { eligible: true, reasons: [] });
});

test('proceedEligibility：App が停止で付けた印（計画ゲートの記録の直前）も対象', () => {
  assert.equal(proceedEligibility(input({ events: [labeled(GATE_AT - 1000, 'agent-harness[bot]')] })).eligible, true);
});

test('proceedEligibility：前の計画の窓で付いた印が残ったまま計画を出し直した場合も対象', () => {
  const r = proceedEligibility(input({ windows: [PREV_WINDOW, WINDOW], events: [labeled(PREV_PLAN_AT - 10_000)] }));
  assert.deepEqual(r, { eligible: true, reasons: [] });
});

test('proceedEligibility：窓の端（計画の投稿 − LABEL_GRACE_MS と、計画ゲートの記録の時刻）は窓に入る', () => {
  assert.equal(proceedEligibility(input({ events: [labeled(PLAN_AT - LABEL_GRACE_MS)] })).eligible, true);
  assert.equal(proceedEligibility(input({ events: [labeled(GATE_AT)] })).eligible, true);
  assert.equal(proceedEligibility(input({ events: [labeled(PLAN_AT - LABEL_GRACE_MS - 1)] })).eligible, false);
  assert.equal(proceedEligibility(input({ events: [labeled(GATE_AT + 1)] })).eligible, false);
});

// ---- proceedEligibility：対象外 ----

const ineligible: [string, Partial<Input>][] = [
  ['窓の外で人が付けた印（計画の投稿よりずっと前）', { events: [labeled(PLAN_AT - 600_000)] }],
  ['窓の外で人が付けた印（前の計画の窓と今の計画の窓の間）', { windows: [PREV_WINDOW, WINDOW], events: [labeled(PREV_GATE_AT + 600_000)] }],
  ['計画ゲートの記録の後に人が外して付け直した印', { events: [labeled(PLAN_AT - 30_000), unlabeled(GATE_AT + 60_000), labeled(GATE_AT + 120_000)] }],
  ['印が外されている（最後が unlabeled）', { events: [labeled(PLAN_AT - 30_000), unlabeled(GATE_AT + 60_000)] }],
  ['印の labeled が無い', { events: [] }],
  ['窓が無い', { windows: [] }],
  ['計画コメントがゲートの後に編集された', { planComment: { id: 80, createdAt: iso(PLAN_AT), bodySha256: 'b'.repeat(64) } }],
  ['計画ゲートの記録より前の決定', { decisionCommentId: 85 }],
  ['計画ゲートの記録と同じ id の決定', { decisionCommentId: 90 }],
  ['AC の変更提案（acChangeProposed）', { latest: latestWith({ plan: { ...plan, acChangeProposed: true } }) }],
  ['最新の記録が通過（pass: true）', { latest: latestWith({ pass: true, reasons: [] }) }],
  ['記録に計画の写しが無い', { latest: latestWith({ plan: undefined }) }],
  ['記録に planBodySha256 が無い', { latest: latestWith({ planBodySha256: undefined }) }],
  ['計画ゲートの記録が無い', { latest: null }],
  ['決定の planCommentId が記録と違う', { decision: { version: 1, issue: 3, planCommentId: 81, answers: [], proceed: PROCEED } }],
  ['計画コメントの id が記録と違う', { planComment: { id: 81, createdAt: iso(PLAN_AT), bodySha256: PLAN_SHA } }],
  ['計画コメントが無い', { planComment: null }],
  ['決定の issue 番号が違う', { decision: { version: 1, issue: 4, planCommentId: 80, answers: [], proceed: PROCEED } }],
  ['Issue が閉じている', { issue: { number: 3, state: 'closed', labels: [{ name: 'agent:plan-review' }] } }],
  ['agent:plan-review が付いていない', { issue: { number: 3, state: 'open', labels: [{ name: 'agent:ready' }] } }],
  ['確かめ済み（priorProceedIds に決定の id がある）', { priorProceedIds: [100] }],
];

for (const [name, patch] of ineligible) {
  test(`proceedEligibility：対象外：${name}`, () => {
    const r = proceedEligibility(input(patch));
    assert.equal(r.eligible, false);
    assert.ok(r.reasons.length > 0, '理由を1件以上返す');
  });
}
