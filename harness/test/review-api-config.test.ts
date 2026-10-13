// review-api の設定（review-api/review.config.json）を読み取る loadReviewConfig（review-api/src/config.ts）が、
// 設定ファイルをそのまま読めることと、鍵の欠け・型違い・負の数・空の actions・pricing の数でない値を鍵のパスつきの1つの Error にまとめることを確かめる（Issue #877）。
// あわせて trigger.issueLink の受け付けと誤りを確かめる（Issue #1048）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadReviewConfig } from '../../review-api/src/config.ts';

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
