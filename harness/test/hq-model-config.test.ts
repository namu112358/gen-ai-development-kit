// Issue #781：hq のモデルの設定（harness/scripts/hq-decide.ts の hqModelConfig）を確かめる。
// 既定（hq・hq.model が無い）は inherit で起こし方は /hq、haiku・sonnet・opus は claude --model <model> --name hq /hq、誤った値は throw。
// リポジトリの harness.config.json は hq.model を書かないので inherit になる（既定が今のまま）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { HQ_MODELS, hqModelConfig } from '../scripts/hq-decide.ts';

test('hqModelConfig：hq・hq.model が無ければ inherit で、launch は /hq', () => {
  for (const config of [{}, { hq: {} }, { hq: { maxFleets: 2 } }]) {
    assert.deepEqual(hqModelConfig(config), { model: 'inherit', launch: '/hq' }, JSON.stringify(config));
  }
  assert.deepEqual(hqModelConfig({ hq: { model: 'inherit' } }), { model: 'inherit', launch: '/hq' });
});

test('hqModelConfig：haiku・sonnet・opus は claude --model <model> --name hq /hq で起こす', () => {
  for (const model of ['haiku', 'sonnet', 'opus'] as const) {
    assert.deepEqual(hqModelConfig({ hq: { model } }), { model, launch: `claude --model ${model} --name hq /hq` });
  }
  assert.deepEqual([...HQ_MODELS].sort(), ['haiku', 'inherit', 'opus', 'sonnet']);
});

test('hqModelConfig：誤った値は throw', () => {
  const bad: unknown[] = [
    { hq: { model: 'gpt' } }, { hq: { model: 'Opus' } }, { hq: { model: '' } },
    { hq: { model: 1 } }, { hq: { model: null } }, { hq: { model: ['opus'] } },
    { hq: null }, { hq: 'opus' }, { hq: [] },
  ];
  for (const config of bad) assert.throws(() => hqModelConfig(config as { hq?: unknown }), Error, JSON.stringify(config));
});

test('hqModelConfig：リポジトリの harness.config.json では inherit', () => {
  assert.equal(hqModelConfig(loadConfig()).model, 'inherit');
});
