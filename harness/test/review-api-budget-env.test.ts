// review-api の費用の上限を Cloudflare の変数（BUDGET_MONTHLY_USD・BUDGET_PER_REVIEW_USD）で上書きする applyBudgetEnv（review-api/src/config.ts）が、
// 無い・空なら review.config.json の値のまま、正の有限の数ならその値、それ以外ならその上限を NaN にして名前を invalid に入れ、元の設定を変えないことを確かめる（Issue #989）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyBudgetEnv, loadReviewConfig, type BudgetEnv } from '../../review-api/src/config.ts';

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readConfig = () => loadReviewConfig(JSON.parse(readFileSync(configPath, 'utf8')));

test('applyBudgetEnv は変数があれば上限をその値にし、無い・空なら review.config.json の値のまま、正の数でなければ NaN にして名前を返す', () => {
  const base = readConfig();
  const { monthlyUsd: m, perReviewUsd: p } = base.budget;
  // [名前, 変数, 期待の monthlyUsd, 期待の perReviewUsd, 期待の invalid]
  const cases: [string, BudgetEnv, number, number, string[]][] = [
    ['無い', {}, m, p, []],
    ['空', { BUDGET_MONTHLY_USD: '', BUDGET_PER_REVIEW_USD: '' }, m, p, []],
    ['空白だけ', { BUDGET_MONTHLY_USD: '   ', BUDGET_PER_REVIEW_USD: ' ' }, m, p, []],
    ['正の数（両方）', { BUDGET_MONTHLY_USD: '120', BUDGET_PER_REVIEW_USD: '2.5' }, 120, 2.5, []],
    ['正の数（月だけ）', { BUDGET_MONTHLY_USD: '30' }, 30, p, []],
    ['正の数（1レビューだけ）', { BUDGET_PER_REVIEW_USD: '0.75' }, m, 0.75, []],
    ['前後の空白', { BUDGET_MONTHLY_USD: ' 5 ' }, 5, p, []],
    ['数でない', { BUDGET_MONTHLY_USD: 'abc' }, NaN, p, ['BUDGET_MONTHLY_USD']],
    ['0', { BUDGET_PER_REVIEW_USD: '0' }, m, NaN, ['BUDGET_PER_REVIEW_USD']],
    ['負', { BUDGET_MONTHLY_USD: '-1' }, NaN, p, ['BUDGET_MONTHLY_USD']],
    ['Infinity', { BUDGET_PER_REVIEW_USD: 'Infinity' }, m, NaN, ['BUDGET_PER_REVIEW_USD']],
    ['両方とも正の数でない', { BUDGET_MONTHLY_USD: 'abc', BUDGET_PER_REVIEW_USD: '-2' }, NaN, NaN, ['BUDGET_MONTHLY_USD', 'BUDGET_PER_REVIEW_USD']],
  ];
  for (const [name, env, monthly, perReview, invalid] of cases) {
    const { config, invalid: got } = applyBudgetEnv(base, env);
    assert.ok(Object.is(config.budget.monthlyUsd, monthly), `${name}: monthlyUsd ${config.budget.monthlyUsd}`);
    assert.ok(Object.is(config.budget.perReviewUsd, perReview), `${name}: perReviewUsd ${config.budget.perReviewUsd}`);
    assert.deepEqual([...got].sort(), invalid, `${name}: invalid`);
    // budget のほかは元の設定と同じ
    assert.deepEqual({ ...config, budget: base.budget }, base, `${name}: budget のほか`);
  }
});

test('applyBudgetEnv は元の設定を変えない', () => {
  const base = readConfig();
  const before = structuredClone(base);
  applyBudgetEnv(base, { BUDGET_MONTHLY_USD: '999', BUDGET_PER_REVIEW_USD: 'abc' });
  assert.deepEqual(base, before);
});
