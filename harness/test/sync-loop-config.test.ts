// Issue #306：sync ⇄ judge のループの上限（config.ts の syncLoopConfig）。無ければ既定値 3、正の整数だけを受け付け、それ以外は throw する。
// 実物の harness.config.json も検査を通ること。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, SYNC_LOOP_DEFAULTS, syncLoopConfig, type HarnessConfig } from '../lib/config.ts';

const cfg = (syncLoop: unknown): Pick<HarnessConfig, 'syncLoop'> => ({ syncLoop } as Pick<HarnessConfig, 'syncLoop'>);

test('既定値：syncLoop が無い・limit が無い → 3', () => {
  assert.equal(SYNC_LOOP_DEFAULTS.limit, 3);
  assert.deepEqual(syncLoopConfig({}), { limit: 3 });
  assert.deepEqual(syncLoopConfig(cfg(undefined)), { limit: 3 });
  assert.deepEqual(syncLoopConfig(cfg({})), { limit: 3 });
});

test('正の整数を受け付ける', () => {
  for (const limit of [1, 2, 5, 100]) assert.deepEqual(syncLoopConfig(cfg({ limit })), { limit });
});

test('limit が 0・負・小数・文字列・null・配列なら throw', () => {
  for (const limit of [0, -1, 1.5, '3', null, [3], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => syncLoopConfig(cfg({ limit })), /syncLoop\.limit/, JSON.stringify(limit));
  }
});

test('syncLoop がオブジェクトでない（null・配列・文字列・数値）なら throw', () => {
  for (const v of [null, [], [{ limit: 3 }], '3', 3]) {
    assert.throws(() => syncLoopConfig(cfg(v)), /syncLoop/, JSON.stringify(v));
  }
});

test('実物の harness.config.json：検査を通り、limit が正の整数', () => {
  const { limit } = syncLoopConfig(loadConfig());
  assert.ok(Number.isInteger(limit) && limit > 0, String(limit));
});
