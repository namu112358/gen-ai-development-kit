// Issue #284：ペイン表示の設定（fleet.shipMode・hq.maxFleets・panes.collectIntervalSeconds）の既定値と不正な値を確かめる。
// 雛形には既定の値、harness.config.json にはこのリポジトリの値（hq.maxFleets は 5。Issue #522）が入り、新しい関数で読めることも確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HQ_DEFAULTS, PANES_DEFAULTS, SHIP_MODE_DEFAULTS, fleetConfig, hqConfig, panesConfig, shipModeConfig, type HarnessConfig,
} from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const readJson = (path: string): HarnessConfig => JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;

// ---- shipModeConfig ----

test('shipModeConfig：fleet・shipMode が無ければ既定の subagent で stopReason は null', () => {
  assert.deepEqual(SHIP_MODE_DEFAULTS, { shipMode: 'subagent' });
  assert.deepEqual(shipModeConfig({}), { shipMode: 'subagent', stopReason: null });
  assert.deepEqual(shipModeConfig({ fleet: {} }), { shipMode: 'subagent', stopReason: null });
  assert.deepEqual(shipModeConfig({ fleet: { shipMode: 'subagent' } } as unknown as Pick<HarnessConfig, 'fleet'>), { shipMode: 'subagent', stopReason: null });
});

test('shipModeConfig：worker なら止めずに shipMode worker・stopReason null を返す（Issue #197）', () => {
  const r = shipModeConfig({ fleet: { shipMode: 'worker' } } as unknown as Pick<HarnessConfig, 'fleet'>);
  assert.deepEqual(r, { shipMode: 'worker', stopReason: null });
});

test('shipModeConfig：subagent・worker 以外（文字列・数値・null）は throw する', () => {
  for (const shipMode of ['x', 'SUBAGENT', '', 1, null]) {
    const c = { fleet: { shipMode } } as unknown as Pick<HarnessConfig, 'fleet'>;
    assert.throws(() => shipModeConfig(c), Error, String(shipMode));
  }
});

test('fleetConfig：shipMode を書いても戻り値の鍵は nesting・maxParallelShips のまま', () => {
  const c = { fleet: { shipMode: 'worker', nesting: 'flat', maxParallelShips: 2 } } as unknown as Pick<HarnessConfig, 'fleet'>;
  assert.deepEqual(fleetConfig(c), { nesting: 'flat', maxParallelShips: 2 });
  assert.deepEqual(Object.keys(fleetConfig(c)).sort(), ['maxParallelShips', 'nesting']);
});

// ---- hqConfig ----

test('hqConfig：hq・maxFleets が無ければ既定の 2', () => {
  assert.deepEqual(HQ_DEFAULTS, { maxFleets: 2 });
  assert.deepEqual(hqConfig({}), { maxFleets: 2 });
  assert.deepEqual(hqConfig({ hq: {} } as unknown as Pick<HarnessConfig, 'hq'>), { maxFleets: 2 });
  assert.deepEqual(hqConfig({ hq: { maxFleets: 4 } } as unknown as Pick<HarnessConfig, 'hq'>), { maxFleets: 4 });
});

test('hqConfig：maxFleets が正の整数でなければ throw する', () => {
  for (const maxFleets of [0, -1, 1.5, '2', null]) {
    const c = { hq: { maxFleets } } as unknown as Pick<HarnessConfig, 'hq'>;
    assert.throws(() => hqConfig(c), Error, String(maxFleets));
  }
});

test('hqConfig：hq がオブジェクトでなければ throw する', () => {
  for (const hq of [1, 'x', true, null]) {
    const c = { hq } as unknown as Pick<HarnessConfig, 'hq'>;
    assert.throws(() => hqConfig(c), Error, String(hq));
  }
});

// ---- panesConfig ----

test('panesConfig：panes・collectIntervalSeconds が無ければ既定の 180 秒', () => {
  assert.deepEqual(PANES_DEFAULTS, { collectIntervalSeconds: 180 });
  assert.deepEqual(panesConfig({}), { collectIntervalSeconds: 180 });
  assert.deepEqual(panesConfig({ panes: {} } as unknown as Pick<HarnessConfig, 'panes'>), { collectIntervalSeconds: 180 });
  assert.deepEqual(panesConfig({ panes: { collectIntervalSeconds: 60 } } as unknown as Pick<HarnessConfig, 'panes'>), { collectIntervalSeconds: 60 });
  assert.deepEqual(panesConfig({ panes: { collectIntervalSeconds: 600 } } as unknown as Pick<HarnessConfig, 'panes'>), { collectIntervalSeconds: 600 });
});

test('panesConfig：60 以上の整数でなければ throw する', () => {
  for (const collectIntervalSeconds of [59, 0, -60, 90.5, '180', null]) {
    const c = { panes: { collectIntervalSeconds } } as unknown as Pick<HarnessConfig, 'panes'>;
    assert.throws(() => panesConfig(c), Error, String(collectIntervalSeconds));
  }
});

// ---- 設定ファイル ----

for (const [name, path, maxFleets] of [
  ['harness.config.json', join(root, 'harness.config.json'), 5],
  ['雛形（harness/templates/harness.config.json）', join(root, 'harness', 'templates', 'harness.config.json'), 2],
] as const) {
  test(`${name}：fleet.shipMode subagent・hq.maxFleets ${maxFleets}・panes.collectIntervalSeconds 180 が入り、読める`, () => {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { fleet?: { shipMode?: unknown }; hq?: { maxFleets?: unknown }; panes?: { collectIntervalSeconds?: unknown } };
    assert.equal(raw.fleet?.shipMode, 'subagent');
    assert.equal(raw.hq?.maxFleets, maxFleets);
    assert.equal(raw.panes?.collectIntervalSeconds, 180);
    const config = readJson(path);
    assert.deepEqual(shipModeConfig(config), { shipMode: 'subagent', stopReason: null });
    assert.deepEqual(hqConfig(config), { maxFleets });
    assert.deepEqual(panesConfig(config), { collectIntervalSeconds: 180 });
    assert.deepEqual(Object.keys(fleetConfig(config)).sort(), ['maxParallelShips', 'nesting']);
  });
}
