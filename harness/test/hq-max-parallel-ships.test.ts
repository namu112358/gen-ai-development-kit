// Issue #673：全体で同時に動かす ship の上限 hq.maxParallelShips の既定値・不正な値・実物と雛形の値・上限の検査
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HQ_DEFAULTS, hqConfig, limitErrors, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const REAL_PATH = join(root, 'harness.config.json');
const TEMPLATE_PATH = join(root, 'harness', 'templates', 'harness.config.json');
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const asHq = (hq: unknown): Pick<HarnessConfig, 'hq'> => ({ hq }) as unknown as Pick<HarnessConfig, 'hq'>;

test('hqConfig：hq・maxParallelShips が無ければ既定の 6', () => {
  assert.equal(HQ_DEFAULTS.maxParallelShips, 6);
  assert.equal(hqConfig({}).maxParallelShips, 6);
  assert.equal(hqConfig(asHq({})).maxParallelShips, 6);
});

test('hqConfig：maxParallelShips を書けばその値で、maxFleets は既定の 2 のまま', () => {
  assert.deepEqual(hqConfig(asHq({ maxParallelShips: 10 })), { maxFleets: 2, maxParallelShips: 10 });
});

test('hqConfig：maxParallelShips が正の整数でなければ throw する', () => {
  for (const maxParallelShips of [0, -1, 1.5, '10', null]) {
    assert.throws(() => hqConfig(asHq({ maxParallelShips })), /hq\.maxParallelShips は正の整数で書いてください/, String(maxParallelShips));
  }
});

for (const [name, path, value] of [
  ['harness.config.json', REAL_PATH, 10],
  ['雛形（harness/templates/harness.config.json）', TEMPLATE_PATH, 6],
] as const) {
  test(`${name}：hq.maxParallelShips が ${value} で書かれ、読める`, () => {
    const raw = readJson(path) as { hq?: { maxParallelShips?: unknown } };
    assert.equal(raw.hq?.maxParallelShips, value);
    assert.equal(hqConfig(raw as Pick<HarnessConfig, 'hq'>).maxParallelShips, value);
  });
}

test('limitErrors：hq.maxParallelShips の 0・1.5 は、キーと値を含む誤り', () => {
  for (const bad of [0, 1.5]) {
    const config = structuredClone(readJson(REAL_PATH));
    config.hq = { ...(config.hq as Record<string, unknown>), maxParallelShips: bad };
    const errors = limitErrors(config);
    assert.ok(
      errors.some((e) => e.includes('hq.maxParallelShips') && e.includes(JSON.stringify(bad))),
      `hq.maxParallelShips=${bad} の誤りが無い：${JSON.stringify(errors)}`,
    );
  }
});

test('limitErrors：hq.maxParallelShips が無い設定では、その誤りを出さない（必須ではない）', () => {
  const config = structuredClone(readJson(REAL_PATH));
  const hq = { ...(config.hq as Record<string, unknown>) };
  delete hq.maxParallelShips;
  config.hq = hq;
  assert.deepEqual(limitErrors(config).filter((e) => e.includes('hq.maxParallelShips')), []);
  const noHq = structuredClone(readJson(REAL_PATH));
  delete noHq.hq;
  assert.deepEqual(limitErrors(noHq).filter((e) => e.includes('hq.maxParallelShips')), []);
});
