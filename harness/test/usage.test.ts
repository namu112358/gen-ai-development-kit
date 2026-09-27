import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { estimateCost, findPricing, findSessionTranscripts, summarizeUsage, totalTokens, type PricingTable } from '../lib/usage.ts';

const line = (id: string, model: string, usage: object, type = 'assistant'): string => JSON.stringify({ type, message: { id, model, usage } });

const pricing: PricingTable = {
  $comment: '無視される',
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
};

test('同じ message.id は1回だけ数え、モデル別に合計する', () => {
  const u1 = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } };
  const s = summarizeUsage([
    line('m1', 'claude-opus-5-5', u1),
    line('m1', 'claude-opus-5-5', u1),
    line('m1', 'claude-opus-5-5', { ...u1, output_tokens: 7 }),
    line('m2', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 30, cache_read_input_tokens: 4 }),
    line('m3', 'claude-haiku-4-5', { input_tokens: 3, output_tokens: 3 }),
    line('u1', 'claude-opus-5-5', { input_tokens: 999 }, 'user'),
    'not json',
    '',
  ]);
  assert.deepEqual(s['claude-opus-5-5'], { input: 11, output: 9, cacheWrite5m: 70, cacheWrite1h: 60, cacheRead: 1004 });
  assert.deepEqual(s['claude-haiku-4-5'], { input: 3, output: 3, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
  assert.deepEqual(totalTokens(s), { input: 14, output: 12, cacheWrite5m: 70, cacheWrite1h: 60, cacheRead: 1004 });
});

test('料金計算：入力・出力・キャッシュ書込 5 分／1 時間・キャッシュ読込', () => {
  const s = { 'claude-opus-5-5': { input: 1_000_000, output: 100_000, cacheWrite5m: 200_000, cacheWrite1h: 500_000, cacheRead: 2_000_000 } };
  // 4 + 2 + 1 + 4 + 0.4
  assert.deepEqual(estimateCost(s, pricing), { totalUsd: 11.4, perModel: { 'claude-opus-5-5': 11.4 } });
});

test('単価の無いモデルは不明（null）、トークン 0 のモデルは数えない', () => {
  const s = {
    'claude-opus-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    'other-model': { input: 10, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    '<synthetic>': { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  };
  assert.deepEqual(estimateCost(s, pricing), { totalUsd: null, perModel: { 'claude-opus-5': 5, 'other-model': null } });
  assert.equal(estimateCost({ '<synthetic>': s['<synthetic>'] }, pricing).totalUsd, 0);
});

test('単価は完全一致を優先し、無ければ最長の前方一致', () => {
  assert.equal(findPricing('claude-opus-5', pricing)?.input, 5);
  assert.equal(findPricing('claude-opus-5-5', pricing)?.input, 4);
  assert.equal(findPricing('claude-opus-5-5-20260901', pricing)?.input, 4);
  assert.equal(findPricing('claude-opus-5-20260101', pricing)?.input, 5);
  assert.equal(findPricing('claude-sonnet-5', pricing), null);
  assert.equal(findPricing('$comment', pricing), null);
});

test('harness.config.json の単価が読める', () => {
  const p = loadConfig().pricing!;
  for (const m of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5']) assert.ok(findPricing(m, p), m);
});

test('セッション記録：本体とサブエージェント。無ければ []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'));
  const main = join(dir, 'abc.jsonl');
  writeFileSync(main, '');
  mkdirSync(join(dir, 'abc', 'subagents'), { recursive: true });
  writeFileSync(join(dir, 'abc', 'subagents', 'agent-1.jsonl'), '');
  writeFileSync(join(dir, 'abc', 'subagents', 'note.txt'), '');
  assert.deepEqual(findSessionTranscripts('/unused', main), [main, join(dir, 'abc', 'subagents', 'agent-1.jsonl')]);
  assert.deepEqual(findSessionTranscripts('/unused', join(dir, 'missing.jsonl')), []);
  assert.deepEqual(findSessionTranscripts(join(dir, 'no-such-project')), []);
});
