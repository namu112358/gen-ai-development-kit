// review-api の料金の見積もりと上限（review-api/src/cost.ts）が、単価の完全一致と最も長い前方一致・無いモデルは null、
// review.config.json の単価での USD の計算と丸め、UTC の月の鍵、上限の判定（ちょうど上限は通す）を外部 API を呼ばずに満たし、
// cost.ts が cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しないことを確かめる（Issue #896）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadReviewConfig, type ModelPricing } from '../../review-api/src/config.ts';
import { checkBudget, estimateUsd, findPricing, monthKey, type Usage } from '../../review-api/src/cost.ts';

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const costPath = fileURLToPath(new URL('../../review-api/src/cost.ts', import.meta.url));
const pricing = loadReviewConfig(JSON.parse(readFileSync(configPath, 'utf8'))).pricing;

const p = (input: number): ModelPricing => ({ input, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });

test('findPricing は完全一致、最も長い前方一致の順に当て、無いモデルは null', () => {
  const table = { 'claude-opus': p(1), 'claude-opus-5-5': p(2) };
  const cases: [string, Record<string, ModelPricing>, ModelPricing | null][] = [
    ['claude-opus-5-5', pricing, pricing['claude-opus-5-5']!],
    ['claude-opus-5-5-20261001', pricing, pricing['claude-opus-5-5']!],
    ['claude-opus-5-5-20261001', table, table['claude-opus-5-5']],
    ['gpt-x', pricing, null],
  ];
  for (const [model, t, expected] of cases) assert.equal(findPricing(model, t), expected, model);
});

test('estimateUsd は review.config.json の単価で USD を計算して丸め、単価の無いモデルは null', () => {
  const zero: Usage = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  const opus: Usage = { input: 100000, output: 20000, cacheWrite5m: 10000, cacheWrite1h: 0, cacheRead: 50000 };
  assert.equal(estimateUsd(opus, 'claude-opus-5-5', pricing), 0.86);
  assert.equal(estimateUsd({ ...zero, cacheRead: 1 }, 'claude-haiku-5-5', pricing), 0);
  assert.equal(estimateUsd(opus, 'gpt-x', pricing), null);
});

test('monthKey は UTC の YYYY-MM を返す（月の境目）', () => {
  const cases: [string, string][] = [
    ['2026-01-31T23:59:59.999Z', '2026-01'],
    ['2026-02-01T00:00:00.000Z', '2026-02'],
    ['2026-12-31T23:59:59Z', '2026-12'],
  ];
  for (const [iso, expected] of cases) assert.equal(monthKey(new Date(iso)), expected, iso);
});

test('checkBudget は月の上限を先に、次に1レビューの上限を見て、ちょうど上限は通す', () => {
  const budget = { monthlyUsd: 50, perReviewUsd: 3 };
  const cases: [string, number, number, { ok: boolean; reason: string | null }][] = [
    ['通る', 10, 1, { ok: true, reason: null }],
    ['月を超える', 49, 2, { ok: false, reason: 'budget-exceeded' }],
    ['1レビューを超える', 10, 3.5, { ok: false, reason: 'too-large' }],
    ['両方超える', 48, 4, { ok: false, reason: 'budget-exceeded' }],
    ['ちょうど上限', 47, 3, { ok: true, reason: null }],
  ];
  for (const [name, monthUsd, estimatedUsd, expected] of cases) {
    assert.deepEqual(checkBudget({ monthUsd, estimatedUsd, budget }), expected, name);
  }
});

test('cost.ts は cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しない', () => {
  const source = readFileSync(costPath, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^cloudflare:workers$|^@anthropic-ai\/sdk|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
