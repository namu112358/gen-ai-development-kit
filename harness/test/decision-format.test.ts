/**
 * 決定の記録（```agent-decision）の純粋関数のテスト（Issue #151）。
 * 書式の検査（parseDecision）、計画の申告から答えるべき項目を作る（decisionTargets）、答えの無い項目・範囲外の答え（uncoveredTargets）、
 * 答え済みの計画の写し（answeredPlan）、外してよい停止か（decisionEligibility。人が付けた印を見分ける時刻の窓の境界を含む）、
 * Jev への要求（buildDecisionRequest）と答えの評価（evaluateDecisionAnswers）を確かめる。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import {
  answeredPlan,
  buildDecisionRequest,
  DECISION_QUESTION_SET,
  decisionEligibility,
  decisionTargets,
  evaluateDecisionAnswers,
  LABEL_GRACE_MS,
  parseDecision,
  uncoveredTargets,
  type Decision,
} from '../lib/decision.ts';
import type { Plan } from '../lib/plan.ts';
import { APP, config } from './support/gate-fixtures.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 申告付きの計画（理由1件・質問2件） */
const plan: Plan = {
  version: 1, issue: 3, risk: 'low', needsHuman: true, needsHumanReasons: ['設定の既定値を決める'], acChangeProposed: false,
  openQuestions: ['shadow から始めるか', 'Routine を hook で止めるか'], files: ['docs/a.md'],
};

const validRaw = () => ({
  version: 1,
  issue: 3,
  planCommentId: 80,
  answers: [
    { to: 'reason:0', quote: '既定は shadow で', at: '2026-09-27T10:00:00+09:00' },
    { to: 'question:0', choice: 'shadow から始める', quote: '一致率を見てから決める', at: '2026-09-27T10:01:00+09:00' },
    { to: 'question:1', quote: 'hook は使わず禁止だけ', at: '2026-09-27T01:02:00Z' },
  ],
});

const decisionOf = (raw: unknown): Decision => {
  const r = parseDecision(raw);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const withJevConfig = (jev: Omit<Partial<HarnessConfig['jev']>, 'thresholds'> & { thresholds?: Partial<HarnessConfig['jev']['thresholds']> }): HarnessConfig => ({
  ...config,
  jev: { ...config.jev, ...jev, thresholds: { ...config.jev.thresholds, ...(jev.thresholds ?? {}) } },
});

// ---- parseDecision ----

test('parseDecision：正しい書式を読む（choice は任意）', () => {
  const d = decisionOf(validRaw());
  assert.equal(d.version, 1);
  assert.equal(d.issue, 3);
  assert.equal(d.planCommentId, 80);
  assert.equal(d.answers.length, 3);
  assert.deepEqual(d.answers[1], { to: 'question:0', choice: 'shadow から始める', quote: '一致率を見てから決める', at: '2026-09-27T10:01:00+09:00' });
  assert.equal(d.answers[0]!.choice, undefined);
});

test('parseDecision：書式の誤りをそれぞれエラーにする', () => {
  const base = validRaw();
  const answer = (patch: Record<string, unknown>) => ({ ...base, answers: [{ ...base.answers[0], ...patch }] });
  const cases: [string, unknown][] = [
    ['オブジェクトでない', 'text'],
    ['版が 1 でない', { ...base, version: 2 }],
    ['issue が整数でない', { ...base, issue: '3' }],
    ['planCommentId が整数でない', { ...base, planCommentId: 1.5 }],
    ['answers が無い', { ...base, answers: undefined }],
    ['answers が空', { ...base, answers: [] }],
    ['to の形が違う（接頭辞）', answer({ to: 'reasons:0' })],
    ['to の形が違う（添字が無い）', answer({ to: 'question:' })],
    ['to の形が違う（負の添字）', answer({ to: 'question:-1' })],
    ['to が文字列でない', answer({ to: 0 })],
    ['quote が空', answer({ quote: '' })],
    ['quote が空白だけ', answer({ quote: '   ' })],
    ['quote が無い', answer({ quote: undefined })],
    ['choice が空', answer({ choice: '' })],
    ['choice が文字列でない', answer({ choice: 1 })],
    ['at が日時でない', answer({ at: '昨日' })],
    ['at が日付だけ', answer({ at: '2026-09-27' })],
    ['at が無い', answer({ at: undefined })],
  ];
  for (const [name, raw] of cases) {
    const r = parseDecision(raw);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.length > 0, name);
  }
});

// ---- decisionTargets ----

test('decisionTargets：needsHumanReasons を reason:<添字>、openQuestions を question:<添字> にする', () => {
  assert.deepEqual(decisionTargets(plan), [
    { id: 'reason:0', kind: 'reason', text: '設定の既定値を決める' },
    { id: 'question:0', kind: 'question', text: 'shadow から始めるか' },
    { id: 'question:1', kind: 'question', text: 'Routine を hook で止めるか' },
  ]);
});

test('decisionTargets：needsHuman が true で理由が空なら reason:0 を1件にする。申告が無ければ空', () => {
  const targets = decisionTargets({ ...plan, needsHumanReasons: [], openQuestions: [] });
  assert.equal(targets.length, 1);
  assert.equal(targets[0]!.id, 'reason:0');
  assert.equal(targets[0]!.kind, 'reason');
  assert.ok(targets[0]!.text.length > 0, '「人の判断が必要と申告した」旨の文');
  assert.deepEqual(decisionTargets({ ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] }), []);
  assert.deepEqual(decisionTargets({ ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: ['?'] }).map((t) => t.id), ['question:0']);
});

// ---- uncoveredTargets ----

test('uncoveredTargets：すべてに答えていれば空', () => {
  assert.deepEqual(uncoveredTargets(decisionTargets(plan), decisionOf(validRaw())), { missing: [], unknown: [] });
});

test('uncoveredTargets：答えの無い項目と、存在しない添字を指す答えを返す', () => {
  const raw = validRaw();
  raw.answers = [raw.answers[0]!, { to: 'question:5', quote: 'x', at: '2026-09-27T01:02:00Z' }, { to: 'reason:1', quote: 'y', at: '2026-09-27T01:02:00Z' }];
  const out = uncoveredTargets(decisionTargets(plan), decisionOf(raw));
  assert.deepEqual(out.missing.map((t) => t.id), ['question:0', 'question:1'], '答えの無い項目（項目の本文つき）');
  assert.equal(out.missing[0]!.text, 'shadow から始めるか');
  assert.deepEqual(out.unknown, ['question:5', 'reason:1'], '存在しない添字を指す答えの to');
});

test('uncoveredTargets：同じ項目への答えが複数でもよい', () => {
  const raw = validRaw();
  raw.answers.push({ to: 'question:0', quote: '補足', at: '2026-09-27T01:03:00Z' });
  assert.deepEqual(uncoveredTargets(decisionTargets(plan), decisionOf(raw)), { missing: [], unknown: [] });
});

// ---- answeredPlan ----

test('answeredPlan：申告を消した写しを返し、元の計画と acChangeProposed・ほかの項目は変えない', () => {
  const original = structuredClone(plan);
  const answered = answeredPlan(plan);
  assert.deepEqual(answered, { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] });
  assert.deepEqual(plan, original, '元の計画を書き換えない');
  assert.equal(answeredPlan({ ...plan, acChangeProposed: true }).acChangeProposed, true);
});

// ---- decisionEligibility ----

const P = Date.parse('2026-09-27T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** 計画コメントの created_at、計画ゲートの記録の created_at */
const PLAN_AT = P;
const GATE_AT = P + 20_000;

const planBody = `${CLAUDE_MARK}\n## 計画\n\n${renderBlock('agent-plan', plan)}`;

/** 最新の計画ゲートの記録（コメントの作成時刻つき） */
function gateOf(value: Record<string, unknown>, createdAt = GATE_AT) {
  const v = { version: 1, planCommentId: 80, pass: false, reasons: ['申告'], planReviewOrigin: 'planner', plan, planBodySha256: sha256(planBody), ...value };
  return { createdAt: iso(createdAt), value: v as any };
}

/** 記録の計画コメント（本文の sha256 と作成時刻） */
const planCommentOf = (body = planBody, id = 80) => ({ id, createdAt: iso(PLAN_AT), bodySha256: sha256(body) });

const labeled = (at: number, login = 'me') => ({ event: 'labeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });
const unlabeled = (at: number, login = 'me') => ({ event: 'unlabeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });

function input(patch: Record<string, unknown> = {}) {
  return {
    config,
    issue: { number: 3, state: 'open', labels: [{ name: 'agent:ready' }, { name: 'agent:plan-review' }] },
    decision: decisionOf(validRaw()),
    decisionCommentId: 100,
    latest: gateOf({}),
    planComment: planCommentOf(),
    events: [labeled(PLAN_AT - 30_000)],
    priorDecisionIds: [] as number[],
    ...patch,
  } as Parameters<typeof decisionEligibility>[0];
}

const eligible = (patch: Record<string, unknown> = {}) => decisionEligibility(input(patch));

test('decisionEligibility：Planner の申告で止まり、post-plan が付けた印なら対象（既定の shadow でも）', () => {
  const r = eligible();
  assert.equal(r.eligible, true, JSON.stringify(r));
  assert.deepEqual(r.reasons, []);
  assert.equal(eligible({ config: withJevConfig({ decisionRelease: 'enforce' }) }).eligible, true);
  assert.equal(eligible({ config: withJevConfig({ decisionRelease: 'shadow' }) }).eligible, true);
});

test('decisionEligibility：定数（問いの版・猶予）', () => {
  assert.equal(DECISION_QUESTION_SET, 1);
  assert.equal(LABEL_GRACE_MS, 60_000);
});

test('decisionEligibility：対象外の条件ごとに false と理由を返す', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['decisionRelease が off', { config: withJevConfig({ decisionRelease: 'off' }) }],
    ['Issue が閉じている', { issue: { number: 3, state: 'closed', labels: [{ name: 'agent:plan-review' }] } }],
    ['agent:plan-review が付いていない', { issue: { number: 3, state: 'open', labels: [{ name: 'agent:ready' }] } }],
    ['計画ゲートの記録が無い', { latest: null }],
    ['最新の記録が通過（pass: true）', { latest: gateOf({ pass: true, planReviewOrigin: undefined }) }],
    ['App のゲートの停止（planReviewOrigin: gate）', { latest: gateOf({ planReviewOrigin: 'gate' }) }],
    ['出どころの無い古い記録', { latest: gateOf({ planReviewOrigin: undefined }) }],
    ['記録に計画の写しが無い', { latest: gateOf({ plan: undefined }) }],
    ['計画が申告していない', { latest: gateOf({ plan: { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] } }) }],
    ['AC の変更提案（acChangeProposed）', { latest: gateOf({ plan: { ...plan, acChangeProposed: true } }) }],
    ['決定の issue が違う', { decision: decisionOf({ ...validRaw(), issue: 4 }) }],
    ['決定の planCommentId が記録と違う', { decision: decisionOf({ ...validRaw(), planCommentId: 81 }) }],
    ['計画コメントがゲートの後に編集された', { planComment: planCommentOf(`${planBody}\n追記`) }],
    ['計画コメントが記録の計画と違う', { planComment: planCommentOf(planBody, 81) }],
    ['計画コメントが見つからない', { planComment: null }],
    ['同じ決定のコメントに plan-decision の記録がある', { priorDecisionIds: [100] }],
    ['印の labeled イベントが無い', { events: [] }],
    ['最後に印が外された', { events: [labeled(PLAN_AT - 30_000), unlabeled(GATE_AT + 1000)] }],
  ];
  for (const [name, patch] of cases) {
    const r = eligible(patch);
    assert.equal(r.eligible, false, name);
    assert.ok(r.reasons.length > 0, `${name}：理由を返す`);
  }
});

test('decisionEligibility：人が付けた印（時刻の窓の外）は対象外', () => {
  // 最初の計画より前から人が付けていた印が残ったまま Planner が申告した
  assert.equal(eligible({ events: [labeled(PLAN_AT - 86_400_000)] }).eligible, false);
  // 通過の後に人が印を付け、申告付きの計画を出し直した（印は今の計画コメントより前）
  assert.equal(eligible({ events: [labeled(PLAN_AT - 3_600_000, APP), unlabeled(PLAN_AT - 3_000_000, APP), labeled(PLAN_AT - 600_000)] }).eligible, false);
  // 計画ゲートの記録の後に人が外して付け直した
  assert.equal(eligible({ events: [labeled(PLAN_AT - 30_000), unlabeled(GATE_AT + 60_000), labeled(GATE_AT + 120_000)] }).eligible, false);
});

test('decisionEligibility：post-plan を使わず App が停止で付けた印（記録の直前）も対象', () => {
  assert.equal(eligible({ events: [labeled(GATE_AT - 1000, APP)] }).eligible, true);
});

test('decisionEligibility：窓の境界（計画コメントの 60 秒前ちょうど・記録の時刻ちょうどは対象、外は対象外）', () => {
  assert.equal(eligible({ events: [labeled(PLAN_AT - LABEL_GRACE_MS)] }).eligible, true, '60 秒前ちょうど');
  assert.equal(eligible({ events: [labeled(PLAN_AT - LABEL_GRACE_MS - 1)] }).eligible, false, '60 秒前より 1ms 前');
  assert.equal(eligible({ events: [labeled(GATE_AT, APP)] }).eligible, true, '記録の時刻ちょうど');
  assert.equal(eligible({ events: [labeled(GATE_AT + 1, APP)] }).eligible, false, '記録の 1ms 後');
});

// ---- buildDecisionRequest ----

test('buildDecisionRequest：state は items と answers だけで、at と本文を渡さない。問いは全体＋項目ごとの Noul', () => {
  const targets = decisionTargets(plan);
  const decision = decisionOf(validRaw());
  const req = buildDecisionRequest(config, targets, decision);
  assert.ok(req, '大きすぎなければ要求を返す');
  assert.equal(req.model, config.jev.model);
  const state = req.state as { items: unknown[]; answers: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(state).sort(), ['answers', 'items']);
  assert.deepEqual(state.items, targets.map((t) => ({ id: t.id, kind: t.kind, text: t.text })));
  assert.deepEqual(state.answers, [
    { to: 'reason:0', quote: '既定は shadow で' },
    { to: 'question:0', choice: 'shadow から始める', quote: '一致率を見てから決める' },
    { to: 'question:1', quote: 'hook は使わず禁止だけ' },
  ]);
  assert.ok(!JSON.stringify(req.state).includes('2026-09-27'), 'at を渡さない');
  assert.deepEqual(Object.keys(req.questions).sort(), ['all_answered', 'item_question_0', 'item_question_1', 'item_reason_0']);
  for (const [key, q] of Object.entries(req.questions) as [string, { type: string; instructions: string; criteria?: { true: string; false: string } }][]) {
    assert.equal(q.type, 'noul', key);
    assert.ok(!key.includes(':'), '問いのキーに : を使わない');
    assert.ok(q.instructions.length > 0);
    assert.ok(q.criteria?.true && q.criteria.false, `${key} に criteria`);
    assert.doesNotMatch(q.instructions, /[぀-ヿ一-鿿]/, '問いは英語');
  }
  assert.match((req.questions.item_question_1 as { instructions: string }).instructions, /"question:1"/, '項目ごとの問いは id で絞る');
});

test('buildDecisionRequest：項目が 20 件、答えの quote・choice の合計が 20000 文字を超えれば null（問わない）', () => {
  const at = '2026-09-27T01:00:00Z';
  const manyPlan = { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: Array.from({ length: 21 }, (_, i) => `q${i}`) };
  const manyTargets = decisionTargets(manyPlan);
  const manyDecision = decisionOf({ ...validRaw(), answers: manyTargets.map((t) => ({ to: t.id, quote: 'ok', at })) });
  assert.equal(buildDecisionRequest(config, manyTargets, manyDecision), null, '21 件');
  const twenty = decisionTargets({ ...manyPlan, openQuestions: manyPlan.openQuestions.slice(0, 20) });
  assert.ok(buildDecisionRequest(config, twenty, decisionOf({ ...validRaw(), answers: twenty.map((t) => ({ to: t.id, quote: 'ok', at })) })), '20 件は問う');
  const t3 = decisionTargets(plan);
  const long = (quote: string, choice?: string) => decisionOf({ ...validRaw(), answers: t3.map((t, i) => ({ to: t.id, quote: i === 0 ? quote : 'x', ...(choice && i === 0 ? { choice } : {}), at })) });
  assert.ok(buildDecisionRequest(config, t3, long('あ'.repeat(19_998))), '合計 20000 文字ちょうどは問う');
  assert.equal(buildDecisionRequest(config, t3, long('あ'.repeat(19_998), 'い')), null, 'choice も数えて 20001 文字');
});

// ---- evaluateDecisionAnswers ----

const targets = decisionTargets(plan);
/** 全体の問い（all_answered）が落ちたときの missing の id */
const OVERALL = 'all';
const ids = (missing: { id: string }[]) => missing.map((m) => m.id);
const itemIds = (missing: { id: string }[]) => ids(missing).filter((id) => id !== OVERALL);
const answers = (p: Record<string, number>) => ({
  all_answered: { yes: p.all ?? 0.95 },
  item_reason_0: { yes: p.r0 ?? 0.95 },
  item_question_0: { yes: p.q0 ?? 0.95 },
  item_question_1: { yes: p.q1 ?? 0.95 },
});

test('evaluateDecisionAnswers：全体とすべての項目がしきい値以上なら pass（境界はしきい値ちょうどで pass）', () => {
  assert.deepEqual(evaluateDecisionAnswers(config, targets, answers({})), { pass: true, missing: [] });
  const t = config.jev.thresholds.decisionProbability ?? 0.9;
  assert.equal(evaluateDecisionAnswers(config, targets, answers({ all: t, r0: t, q0: t, q1: t })).pass, true, 'しきい値ちょうど');
  const r = evaluateDecisionAnswers(config, targets, answers({ q1: t - 0.01 }));
  assert.equal(r.pass, false);
  assert.deepEqual(ids(r.missing), ['question:1']);
  assert.deepEqual(r.missing[0], { id: 'question:1', text: 'Routine を hook で止めるか', probability: t - 0.01 }, '足りない項目の本文と確率');
});

test('evaluateDecisionAnswers：しきい値は設定（無ければ 0.9）', () => {
  const noThreshold = withJevConfig({});
  delete (noThreshold.jev.thresholds as { decisionProbability?: number }).decisionProbability;
  assert.equal(evaluateDecisionAnswers(noThreshold, targets, answers({ q0: 0.9 })).pass, true);
  assert.equal(evaluateDecisionAnswers(noThreshold, targets, answers({ q0: 0.89 })).pass, false);
  const strict = withJevConfig({ thresholds: { decisionProbability: 0.99 } });
  assert.deepEqual(itemIds(evaluateDecisionAnswers(strict, targets, answers({})).missing).sort(), ['question:0', 'question:1', 'reason:0']);
});

test('evaluateDecisionAnswers：値が無い・NaN の項目は未満として missing に入れる', () => {
  const nan = evaluateDecisionAnswers(config, targets, answers({ r0: NaN }));
  assert.equal(nan.pass, false);
  assert.deepEqual(ids(nan.missing), ['reason:0']);
  assert.equal(nan.missing[0]!.probability, null, 'NaN は確率なし');
  const partial = answers({});
  delete (partial as Record<string, unknown>).item_question_0;
  const absent = evaluateDecisionAnswers(config, targets, partial);
  assert.equal(absent.pass, false);
  assert.deepEqual(ids(absent.missing), ['question:0']);
});

test('evaluateDecisionAnswers：全体だけが未満なら missing に「全体」を入れる。項目も未満ならその項目を入れる', () => {
  const overall = evaluateDecisionAnswers(config, targets, answers({ all: 0.5 }));
  assert.equal(overall.pass, false);
  assert.deepEqual(ids(overall.missing), [OVERALL]);
  assert.match(overall.missing[0]!.text, /全体/);
  assert.equal(overall.missing[0]!.probability, 0.5);
  const both = evaluateDecisionAnswers(config, targets, answers({ all: 0.5, q0: 0.2 }));
  assert.equal(both.pass, false);
  assert.deepEqual(itemIds(both.missing), ['question:0']);
});
