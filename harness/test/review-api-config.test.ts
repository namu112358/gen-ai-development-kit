// review-api の設定（review-api/review.config.json）を読み取る loadReviewConfig（review-api/src/config.ts）が、
// 設定ファイルをそのまま読めることと、鍵の欠け・型違い・負の数・空の actions・pricing の数でない値を鍵のパスつきの1つの Error にまとめることを確かめる（Issue #877）。
// あわせて trigger.issueLink の受け付けと、リポジトリの表の行の上書きを重ねる applyRepoOverrides の上限の優先順位（行 → BUDGET_* → review.config.json）・trigger の上書き・不正な値の扱いを確かめる（Issue #1048）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyRepoOverrides, loadReviewConfig, type BudgetEnv, type RepoOverrides } from '../../review-api/src/config.ts';

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readRaw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

// message に鍵のパスがすべて入る Error かを見る検証関数（文言全体は固定しない）
const errorWith = (...paths: string[]) => (error: unknown) => {
  assert.ok(error instanceof Error, 'Error を投げる');
  for (const p of paths) assert.ok(error.message.includes(p), `message に ${p} がない: ${error.message}`);
  return true;
};

test('review.config.json をそのまま読め、値が取れ、pricing に $comment が残らない', () => {
  const config = loadReviewConfig(readRaw());
  assert.deepEqual(config.trigger.actions, ['opened', 'synchronize', 'reopened', 'converted_to_draft']);
  assert.equal(config.trigger.skipBotSenders, true);
  assert.equal(config.trigger.branchPrefix, 'claude/');
  assert.equal(config.claude.reviewModel, 'claude-opus-5-5');
  assert.equal(config.claude.maxTokens, 16000);
  assert.equal(config.budget.monthlyUsd, 50);
  assert.equal(config.pricing['claude-opus-5-5']?.input, 4);
  assert.equal(config.pricing['claude-haiku-5-5']?.cacheRead, 0.01);
  assert.ok(!('$comment' in config.pricing), Object.keys(config.pricing).join(','));
});

// 1か所ずつ壊した入力と、message に入るべき鍵のパス
const broken: { name: string; path: string; mutate: (raw: Record<string, any>) => void }[] = [
  { name: '鍵の欠け', path: 'claude.maxTokens', mutate: (r) => { delete r.claude.maxTokens; } },
  { name: '型違い（真偽値に文字列）', path: 'trigger.skipBotSenders', mutate: (r) => { r.trigger.skipBotSenders = 'true'; } },
  { name: '負の数', path: 'budget.monthlyUsd', mutate: (r) => { r.budget.monthlyUsd = -1; } },
  { name: '正の整数でない数', path: 'claude.maxToolCalls', mutate: (r) => { r.claude.maxToolCalls = 1.5; } },
  { name: '空の actions', path: 'trigger.actions', mutate: (r) => { r.trigger.actions = []; } },
  { name: 'pricing の数でない値', path: 'pricing.claude-opus-5-5.input', mutate: (r) => { r.pricing['claude-opus-5-5'].input = '4'; } },
  { name: '下のオブジェクトが null', path: 'budget', mutate: (r) => { r.budget = null; } },
  { name: '下のオブジェクトが配列', path: 'trigger', mutate: (r) => { r.trigger = []; } },
  { name: 'trigger.issueLink が規則外', path: 'trigger.issueLink', mutate: (r) => { r.trigger.issueLink = 'refs'; } },
  { name: 'trigger.issueLink が文字列でない', path: 'trigger.issueLink', mutate: (r) => { r.trigger.issueLink = true; } },
];

for (const { name, path, mutate } of broken) {
  test(`${name}は ${path} を含む誤りになる`, () => {
    const raw = structuredClone(readRaw());
    mutate(raw);
    assert.throws(() => loadReviewConfig(raw), errorWith(path));
  });
}

test('trigger.issueLink は closes・closes-or-refs を受け付け、無ければ鍵を置かない', () => {
  for (const link of ['closes', 'closes-or-refs'] as const) {
    const raw = structuredClone(readRaw());
    raw.trigger.issueLink = link;
    assert.equal(loadReviewConfig(raw).trigger.issueLink, link);
  }
  const raw = structuredClone(readRaw());
  delete raw.trigger.issueLink;
  assert.ok(!Object.hasOwn(loadReviewConfig(raw).trigger, 'issueLink'));
});

for (const [name, raw] of [['null', null], ['配列', []]] as const) {
  test(`入力が${name}なら誤りになる`, () => {
    assert.throws(() => loadReviewConfig(raw), (error: unknown) => error instanceof Error);
  });
}

test('複数の誤りは1つの Error にまとまり、message にすべての鍵のパスが入る', () => {
  const raw = structuredClone(readRaw());
  delete raw.claude.maxTokens;
  raw.trigger.skipBotSenders = 'yes';
  raw.budget.monthlyUsd = -1;
  raw.trigger.actions = [];
  raw.pricing['claude-opus-5-5'].input = '4';
  let thrown = 0;
  let caught: unknown;
  try {
    loadReviewConfig(raw);
  } catch (error) {
    thrown += 1;
    caught = error;
  }
  assert.equal(thrown, 1);
  errorWith('claude.maxTokens', 'trigger.skipBotSenders', 'budget.monthlyUsd', 'trigger.actions', 'pricing.claude-opus-5-5.input')(caught);
});

test('知らない鍵（最上位と trigger の中）は誤りにならない', () => {
  const raw = structuredClone(readRaw());
  raw.extra = { anything: 1 };
  raw.trigger.unknownKey = 'x';
  const config = loadReviewConfig(raw);
  assert.equal(config.trigger.branchPrefix, 'claude/');
});

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
