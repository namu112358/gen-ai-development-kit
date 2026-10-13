// リポジトリの表の行の上書きを設定に重ねる applyRepoOverrides（review-api/src/config.ts）が、上限を 行 → BUDGET_* → review.config.json の順に決め、
// 行の正の数でない値を NaN にして名前を invalid に入れ、trigger は行にある鍵だけを重ね、元の config を変えないことを確かめる（Issue #1048）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyRepoOverrides, loadReviewConfig, type BudgetEnv, type RepoOverrides } from '../../review-api/src/config.ts';

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readRaw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

test('applyRepoOverrides の上限は 行 → BUDGET_* → review.config.json の順に決まり、行の正の数でない値は NaN にして名前を invalid に入れる', () => {
  const base = loadReviewConfig(readRaw());
  const { monthlyUsd: m, perReviewUsd: p } = base.budget;
  // [名前, 行の上書き, 変数, 期待の monthlyUsd, 期待の perReviewUsd, 期待の invalid]
  const cases: [string, RepoOverrides, BudgetEnv, number, number, string[]][] = [
    ['どちらも無い', {}, {}, m, p, []],
    ['行に budget が無く変数がある', {}, { BUDGET_MONTHLY_USD: '70', BUDGET_PER_REVIEW_USD: '3' }, 70, 3, []],
    ['行だけ', { budget: { monthlyUsd: 20, perReviewUsd: 0.5 } }, {}, 20, 0.5, []],
    ['行と変数の両方なら行', { budget: { monthlyUsd: 20, perReviewUsd: 0.5 } }, { BUDGET_MONTHLY_USD: '70', BUDGET_PER_REVIEW_USD: '3' }, 20, 0.5, []],
    ['行は月だけ、1レビューは変数', { budget: { monthlyUsd: 20 } }, { BUDGET_PER_REVIEW_USD: '3' }, 20, 3, []],
    ['行は1レビューだけ、月は設定ファイル', { budget: { perReviewUsd: 0.5 } }, {}, m, 0.5, []],
    ['行の空の budget は変数へ', { budget: {} }, { BUDGET_MONTHLY_USD: '70' }, 70, p, []],
    ['行の 0', { budget: { monthlyUsd: 0 } }, {}, NaN, p, ['repo.budget.monthlyUsd']],
    ['行の負', { budget: { perReviewUsd: -1 } }, {}, m, NaN, ['repo.budget.perReviewUsd']],
    ['行の NaN', { budget: { monthlyUsd: NaN } }, {}, NaN, p, ['repo.budget.monthlyUsd']],
    ['行の Infinity は変数があっても NaN', { budget: { perReviewUsd: Infinity } }, { BUDGET_PER_REVIEW_USD: '3' }, m, NaN, ['repo.budget.perReviewUsd']],
    ['行の両方が不正', { budget: { monthlyUsd: -5, perReviewUsd: 0 } }, {}, NaN, NaN, ['repo.budget.monthlyUsd', 'repo.budget.perReviewUsd']],
    ['行が無く変数が不正なら今の applyBudgetEnv と同じ', {}, { BUDGET_MONTHLY_USD: 'abc' }, NaN, p, ['BUDGET_MONTHLY_USD']],
  ];
  for (const [name, overrides, env, monthly, perReview, invalid] of cases) {
    const { config, invalid: got } = applyRepoOverrides(base, overrides, env);
    assert.ok(Object.is(config.budget.monthlyUsd, monthly), `${name}: monthlyUsd ${config.budget.monthlyUsd}`);
    assert.ok(Object.is(config.budget.perReviewUsd, perReview), `${name}: perReviewUsd ${config.budget.perReviewUsd}`);
    assert.deepEqual([...got].sort(), invalid, `${name}: invalid`);
    assert.deepEqual({ ...config, budget: base.budget }, base, `${name}: budget のほかは元のまま`);
  }
});

test('applyRepoOverrides は行の trigger を重ね（空の branchPrefix も上書き）、無い鍵は元のまま、元の config を変えない', () => {
  const base = loadReviewConfig(readRaw());
  const before = structuredClone(base);
  // [名前, 行の trigger, 期待の trigger の差分]
  const cases: [string, RepoOverrides['trigger'], Record<string, unknown>][] = [
    ['無い', undefined, {}],
    ['全部', { branchPrefix: 'feat/', requireClosesIssue: false, issueLink: 'closes-or-refs' }, { branchPrefix: 'feat/', requireClosesIssue: false, issueLink: 'closes-or-refs' }],
    ['branchPrefix だけ', { branchPrefix: 'feat/' }, { branchPrefix: 'feat/' }],
    ['空の branchPrefix', { branchPrefix: '' }, { branchPrefix: '' }],
    ['requireClosesIssue だけ', { requireClosesIssue: false }, { requireClosesIssue: false }],
    ['issueLink だけ', { issueLink: 'closes' }, { issueLink: 'closes' }],
  ];
  for (const [name, trigger, diff] of cases) {
    const overrides: RepoOverrides = trigger === undefined ? {} : { trigger };
    const { config, invalid } = applyRepoOverrides(base, overrides, {});
    assert.deepEqual(invalid, [], name);
    assert.deepEqual(config.trigger, { ...base.trigger, ...diff }, name);
    assert.deepEqual({ ...config, trigger: base.trigger }, base, `${name}: trigger のほかは元のまま`);
  }
  applyRepoOverrides(base, { budget: { monthlyUsd: 1, perReviewUsd: -1 }, trigger: { branchPrefix: 'x/', issueLink: 'closes-or-refs' } }, { BUDGET_MONTHLY_USD: '9' });
  assert.deepEqual(base, before);
});
