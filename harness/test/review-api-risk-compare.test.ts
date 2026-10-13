// review-api の Risk の比べる問い（review-api/src/pipeline.ts の risk-compare の段階）を確かめる（Issue #995）。
// Reviewer と Risk のモデルが違い claude.riskCompare が無いとき Risk を Reviewer のモデルでも問い、KV と投稿の記録に役ごとの使用量（usageByRole）と
// 比べた Risk の level・answers・usd（riskCompare）が並び、合計の usage・usd・月の累計が比べる分を含むこと、
// 同じモデル・riskCompare: false では比べる問いを呼ばず記録に riskCompare を置かないこと、loadReviewConfig が riskCompare 無しで欄を置かず真偽値でない値を誤りにすること、
// 比べる分を足すと 1 レビューの上限・月の上限を超えるときは比べる問いだけ飛ばして（skipped: 'budget'）posted のままであること、
// 比べる問いの失敗（JSON でない・検査に落ちる・API が投げる）でも verdict と outcome が変わらず、Reviewer の出力が検査に落ちたときは比べる問いを呼ばない（skipped: 'not-validated'）ことを見る
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message } from '../../review-api/src/claude.ts';
import { loadReviewConfig, type ReviewConfig } from '../../review-api/src/config.ts';
import type { Usage } from '../../review-api/src/cost.ts';
import { estimateLoopUsd } from '../../review-api/src/pipeline.ts';
import { parseShadowComment, type ShadowRecord } from '../../review-api/src/record.ts';
import { RISK_QUESTIONS, type RiskOutput } from '../../review-api/src/verdict.ts';
import { answer, baseConfig, CALL_USD, COST_KEY, MODEL, msg, REVIEW_KEY, REVIEW_OK, RISK_OK, run } from './support/review-api-pipeline.ts';

// Risk のモデル（比べる相手は Reviewer のモデル MODEL）。1回の問い（入力 1000・出力 100）の料金は 0.003 + 0.0015
const RISK_MODEL = 'claude-sonnet-5-5';
const RISK_CALL_USD = 0.0045;
const ONE_CALL: Usage = { input: 1000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
const twice = (u: Usage): Usage => ({ input: u.input * 2, output: u.output * 2, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
// 比べる問いの答え（riskModel の答え RISK_OK と level・answers を変える）
const RISK_COMPARED: RiskOutput = { ...RISK_OK, level: 'medium', answers: { ...RISK_OK.answers, q4_tested: 'unsure' } };

const compareConfig = (f: (c: ReviewConfig) => void = () => {}): ReviewConfig => {
  const c = baseConfig();
  c.claude.riskModel = RISK_MODEL;
  c.pricing[RISK_MODEL] = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
  f(c);
  return c;
};
const RESPONSES = (): (Message | Error)[] => [answer(REVIEW_OK, MODEL), answer(RISK_OK, RISK_MODEL), answer(RISK_COMPARED, MODEL)];
const near = (actual: unknown, expected: number, label: string) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${label}: ${String(actual)} ≠ ${expected}`);

// 投稿の記録と KV の review: の記録（どちらも ShadowRecord の欄を持つ）
type Recorded = Partial<ShadowRecord> & { outcome?: string };
const records = (r: Awaited<ReturnType<typeof run>>): [string, Recorded][] => {
  const out: [string, Recorded][] = [['KV', (r.record ?? {}) as Recorded]];
  if (r.posted[0] !== undefined) out.push(['投稿', parseShadowComment(r.posted[0])?.record ?? {}]);
  return out;
};

test('Reviewer と Risk のモデルが違い riskCompare が無いと、Risk を Reviewer のモデルでも問い、記録に役ごとの使用量と比べた Risk が並ぶ', async () => {
  const r = await run({ config: compareConfig(), responses: RESPONSES() });

  assert.equal(r.result.outcome, 'posted');
  assert.deepEqual(r.claudeCalls.map((c) => c.model), [MODEL, RISK_MODEL, MODEL], 'Claude の問いのモデル');
  // 比べる問いは Risk の問いとモデルだけが違う（同じ材料・同じ出力の形・同じツール）
  assert.deepEqual({ ...r.claudeCalls[2], model: RISK_MODEL }, r.claudeCalls[1], '比べる問いの中身');

  const totalUsd = 2 * CALL_USD + RISK_CALL_USD;
  near(r.result.usd, totalUsd, '戻り値の usd');
  near(Number(r.kv.get(COST_KEY)), totalUsd, '月の累計');
  const recs = records(r);
  assert.equal(recs.length, 2, '投稿が1件');
  for (const [where, rec] of recs) {
    // verdict.risk は今までどおり riskModel の Risk
    assert.equal(rec.verdict?.risk.level ?? (rec as { summary?: { riskLevel?: string } }).summary?.riskLevel, RISK_OK.level, `${where}: verdict の Risk`);
    assert.deepEqual(rec.usage, { [MODEL]: twice(ONE_CALL), [RISK_MODEL]: ONE_CALL }, `${where}: usage`);
    near(rec.usd, totalUsd, `${where}: usd`);
    assert.deepEqual(rec.usageByRole, {
      review: { usage: { [MODEL]: ONE_CALL }, usd: CALL_USD },
      risk: { usage: { [RISK_MODEL]: ONE_CALL }, usd: RISK_CALL_USD },
      riskCompare: { usage: { [MODEL]: ONE_CALL }, usd: CALL_USD },
    }, `${where}: usageByRole`);
    assert.deepEqual(rec.riskCompare, { model: MODEL, level: RISK_COMPARED.level, answers: RISK_COMPARED.answers, usd: CALL_USD }, `${where}: riskCompare`);
    const answers = (rec.riskCompare as { answers?: Record<string, unknown> } | undefined)?.answers ?? {};
    assert.equal(Object.keys(answers).length, RISK_QUESTIONS.length, `${where}: 8 問`);
  }
});

test('Reviewer と Risk のモデルが同じとき・riskCompare が false のときは比べる問いを呼ばず、記録に riskCompare を置かない', async () => {
  const cases: [string, ReviewConfig, (Message | Error)[]][] = [
    ['同じモデル', baseConfig(), [answer(REVIEW_OK), answer(RISK_OK)]],
    ['riskCompare: false', compareConfig((c) => (c.claude.riskCompare = false)), [answer(REVIEW_OK, MODEL), answer(RISK_OK, RISK_MODEL)]],
  ];
  for (const [name, config, responses] of cases) {
    const r = await run({ config, responses });
    assert.equal(r.result.outcome, 'posted', name);
    assert.equal(r.claudeCalls.length, 2, `${name}: Claude の呼び出し`);
    for (const [where, rec] of records(r)) {
      assert.equal(Object.hasOwn(rec, 'riskCompare'), false, `${name}: ${where} の riskCompare`);
      assert.equal(Object.hasOwn(rec.usageByRole ?? {}, 'riskCompare'), false, `${name}: ${where} の usageByRole.riskCompare`);
    }
  }
});

test('loadReviewConfig は riskCompare 無しで欄を置かず、真偽値を読み、真偽値でない値を誤りにする', () => {
  const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
  const raw = (riskCompare?: unknown): Record<string, any> => {
    const r = JSON.parse(readFileSync(configPath, 'utf8'));
    delete r.claude.riskCompare;
    if (riskCompare !== undefined) r.claude.riskCompare = riskCompare;
    return r;
  };
  assert.equal(Object.hasOwn(loadReviewConfig(raw()).claude, 'riskCompare'), false, 'riskCompare 無し');
  assert.equal(loadReviewConfig(raw(false)).claude.riskCompare, false, 'false');
  assert.equal(loadReviewConfig(raw(true)).claude.riskCompare, true, 'true');
  for (const value of ['false', 0, null]) {
    assert.throws(() => loadReviewConfig(raw(value)), /claude\.riskCompare: 真偽値/, String(value));
  }
});

test('比べる分を足すと 1 レビューの上限・月の上限を超えるときは比べる問いだけ飛ばし（budget）、outcome は posted のまま', async () => {
  // 境は材料の大きさに依らずに決める：上限を大きくして1回回し、偽の Claude が受けた3つの問いから見積もり a・b・c を求める
  const wide = compareConfig((c) => {
    c.budget.monthlyUsd = 1000;
    c.budget.perReviewUsd = 1000;
  });
  const probe = await run({ config: wide, responses: RESPONSES() });
  assert.equal(probe.claudeCalls.length, 3, '上限が大きいときは比べる問いを呼ぶ');
  const limits = { maxToolCalls: wide.claude.maxToolCalls, maxFileChars: wide.claude.maxFileChars };
  const [a, b, c] = probe.claudeCalls.map((p) => estimateLoopUsd(p, limits, wide.pricing)!);
  assert.ok(a !== undefined && b !== undefined && c !== undefined && c > 0, '見積もり');

  const cases: [string, ReviewConfig, Record<string, string>][] = [
    ['1 レビューの上限', compareConfig((x) => (x.budget.perReviewUsd = a + b + c / 2)), {}],
    ['月の上限', compareConfig((x) => (x.budget.monthlyUsd = 10)), { [COST_KEY]: String(10 - (a + b) - c / 2) }],
  ];
  for (const [name, config, kv] of cases) {
    const r = await run({ config, kv, responses: RESPONSES() });
    assert.equal(r.result.outcome, 'posted', name);
    assert.deepEqual(r.claudeCalls.map((p) => p.model), [MODEL, RISK_MODEL], `${name}: Claude の問い`);
    for (const [where, rec] of records(r)) {
      assert.deepEqual(rec.riskCompare, { model: MODEL, skipped: 'budget' }, `${name}: ${where} の riskCompare`);
    }
  }
});

test('比べる問いが失敗しても verdict と outcome は比べないときと同じで、Reviewer の出力が検査に落ちたときは比べる問いを呼ばない', async () => {
  const baseline = await run({ config: compareConfig((c) => (c.claude.riskCompare = false)), responses: [answer(REVIEW_OK, MODEL), answer(RISK_OK, RISK_MODEL)] });
  assert.equal(baseline.result.outcome, 'posted');
  const baseVerdict = parseShadowComment(baseline.posted[0]!)?.record.verdict;
  assert.ok(baseVerdict !== undefined);

  const cases: [string, Message | Error, string][] = [
    ['JSON でない出力', msg([{ type: 'text', text: 'not json' }], 'end_turn', MODEL), 'invalid-json'],
    ['検査に落ちる出力', answer({ ...RISK_OK, level: 'huge' }, MODEL), 'invalid(1)'],
    ['偽の Claude が投げる', new Error('Claude API の誤り'), 'api-error'],
  ];
  for (const [name, third, error] of cases) {
    const r = await run({ config: compareConfig(), responses: [answer(REVIEW_OK, MODEL), answer(RISK_OK, RISK_MODEL), third] });
    assert.equal(r.result.outcome, baseline.result.outcome, `${name}: outcome`);
    assert.equal(r.claudeCalls.length, 3, `${name}: Claude の呼び出し`);
    const recs = records(r);
    assert.equal(recs.length, 2, `${name}: 投稿`);
    assert.deepEqual(recs[1]![1].verdict, baseVerdict, `${name}: verdict`);
    for (const [where, rec] of recs) {
      assert.equal(rec.outcome ?? 'posted', 'posted', `${name}: ${where} の outcome`);
      assert.deepEqual(rec.riskCompare, { model: MODEL, error }, `${name}: ${where} の riskCompare`);
    }
  }

  const invalidReview = { pass: true, blocking: [{ kind: 'bug', detail: 'x' }], nonBlocking: [] };
  const r = await run({ config: compareConfig(), responses: [answer(invalidReview, MODEL), answer(RISK_OK, RISK_MODEL), answer(RISK_COMPARED, MODEL)] });
  assert.equal(r.result.outcome, 'verdict-invalid');
  assert.equal(r.claudeCalls.length, 2, 'Reviewer の検査で落ちたら比べる問いを呼ばない');
  assert.equal(r.kv.has(REVIEW_KEY), true);
  assert.deepEqual((r.record as Recorded).riskCompare, { model: MODEL, skipped: 'not-validated' }, 'verdict-invalid の記録');
});
