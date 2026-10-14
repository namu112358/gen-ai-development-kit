// review-api の Reviewer と Risk の問いが、tools・system・output_config・材料の breakpoint まで同じ接頭辞になること（Issue #1086）を確かめる。
// buildAskRequests の review・risk（モデルが違う設定では riskCompare も）の model・system・tools・output_config が同じこと、
// sharedPrefixTokens が同じ問いどうしで 0 より大きく、output_config.format の schema だけ違うか、モデルが違うと 0 になること（Risk が自分で書き込む今のまま）、
// askRole が役の基準で Reviewer・Risk を見分け、見分けられない問いで null になること、OUTPUT_SCHEMA が両役の schema の anyOf であることを見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessagesParams } from '../../review-api/src/claude.ts';
import { collectMaterial } from '../../review-api/src/collect.ts';
import { buildAskRequests, sharedPrefixTokens } from '../../review-api/src/pipeline.ts';
import { askRole, OUTPUT_SCHEMA, REVIEWER_OUTPUT_SCHEMA, RISK_OUTPUT_SCHEMA } from '../../review-api/src/prompts.ts';
import { baseConfig, fakeGitHub, GATE, HEAD, REVIEWER } from './support/review-api-pipeline.ts';

async function asksFor(mutate?: (c: ReturnType<typeof baseConfig>) => void) {
  const config = baseConfig();
  mutate?.(config);
  const { gh } = fakeGitHub({ pr: { state: 'open', head: HEAD }, comments: [] });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE, reviewLogin: REVIEWER });
  return buildAskRequests(material, config);
}

const prefixKeys = ['model', 'system', 'tools', 'output_config'] as const;

test('review・risk（と riskCompare）の model・system・tools・output_config は同じ', async () => {
  const cases: [string, (c: ReturnType<typeof baseConfig>) => void, boolean][] = [
    ['同じモデル', () => {}, false],
    ['モデルが違い riskCompare を組む', (c) => (c.claude.riskModel = 'other-model'), true],
  ];
  for (const [name, mutate, compare] of cases) {
    const asks = await asksFor(mutate);
    // riskCompare はモデルだけ Reviewer のものなので Reviewer と比べる。モデルの違う risk は model 以外を比べる
    const pairs: [string, MessagesParams, MessagesParams, readonly string[]][] = [
      ['review/risk', asks.review, asks.risk, compare ? prefixKeys.filter((k) => k !== 'model') : prefixKeys],
    ];
    if (compare) {
      assert.ok(asks.riskCompare !== null, `${name}: riskCompare がある`);
      pairs.push(['review/riskCompare', asks.review, asks.riskCompare, prefixKeys]);
    }
    for (const [label, a, b, keys] of pairs) {
      for (const k of keys) assert.deepEqual(a[k], b[k], `${name} ${label}: ${k}`);
    }
  }
});

test('sharedPrefixTokens は同じ問いどうしで 0 より大きく、output_config.format の schema だけ違うか、モデルが違うと 0', async () => {
  const same = await asksFor();
  assert.ok(sharedPrefixTokens(same.review, same.risk) > 0, '同じ問いどうし');

  const otherSchema: MessagesParams = {
    ...same.risk,
    output_config: { ...(same.risk['output_config'] as object), format:{ type: 'json_schema', schema: REVIEWER_OUTPUT_SCHEMA } },
  };
  assert.equal(sharedPrefixTokens(same.review, otherSchema), 0, 'schema だけ違う');

  const diff = await asksFor((c) => (c.claude.riskModel = 'other-model'));
  assert.equal(sharedPrefixTokens(diff.review, diff.risk), 0, 'reviewModel と riskModel が違う');
  assert.ok(sharedPrefixTokens(diff.review, diff.riskCompare!) > 0, 'riskCompare は Reviewer と同じモデルなので共有する');
});

test('askRole は Reviewer の問いで review、Risk の問いで risk、役を見分けられない問いで null', async () => {
  const asks = await asksFor();
  assert.equal(askRole(asks.review), 'review');
  assert.equal(askRole(asks.risk), 'risk');
  assert.equal(askRole({ messages: [{ role: 'user', content: 'text' }] }), null, 'content が文字列');
  assert.equal(askRole({ messages: [] }), null, '空 messages');
});

test('OUTPUT_SCHEMA は Reviewer と Risk の schema の anyOf', () => {
  assert.deepEqual(OUTPUT_SCHEMA.anyOf, [REVIEWER_OUTPUT_SCHEMA, RISK_OUTPUT_SCHEMA]);
});
