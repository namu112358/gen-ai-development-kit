// Issue #827：patrol が auto mode の間に自動で Issue にする数の上限（config.ts の patrolAutoSupplyConfig と limitErrors の patrolAutoSupply.dailyLimit）。
// 無ければ既定値 1、0 以上の整数だけを受け付け（0 は自動にしない）、それ以外は throw・検査の誤りになる。実物の harness.config.json は既定と同じ 1。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { limitErrors, loadConfig, PATROL_AUTO_SUPPLY_DEFAULTS, patrolAutoSupplyConfig, type HarnessConfig } from '../lib/config.ts';

const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const cfg = (patrolAutoSupply: unknown): Pick<HarnessConfig, 'patrolAutoSupply'> => ({ patrolAutoSupply } as Pick<HarnessConfig, 'patrolAutoSupply'>);
/** 実物の設定の写しの patrolAutoSupply.dailyLimit を置く（undefined なら patrolAutoSupply ごと消す） */
const withDailyLimit = (value: unknown): Record<string, unknown> => {
  const copy = JSON.parse(readFileSync(REAL_PATH, 'utf8')) as Record<string, unknown>;
  if (value === undefined) delete copy.patrolAutoSupply;
  else copy.patrolAutoSupply = { dailyLimit: value };
  return copy;
};

test('既定値：patrolAutoSupply が無い・dailyLimit が無い → 1', () => {
  assert.equal(PATROL_AUTO_SUPPLY_DEFAULTS.dailyLimit, 1);
  for (const c of [{}, cfg(undefined), cfg({})]) assert.deepEqual(patrolAutoSupplyConfig(c), { dailyLimit: 1 });
});

test('0 以上の整数を受け付ける（0 は自動にしない）', () => {
  for (const dailyLimit of [0, 1, 5]) assert.deepEqual(patrolAutoSupplyConfig(cfg({ dailyLimit })), { dailyLimit });
});

test('dailyLimit が負・小数・文字列・null・NaN・Infinity、patrolAutoSupply がオブジェクトでないなら throw', () => {
  for (const dailyLimit of [-1, 1.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => patrolAutoSupplyConfig(cfg({ dailyLimit })), /patrolAutoSupply\.dailyLimit/, JSON.stringify(dailyLimit));
  }
  for (const v of [null, [], [{ dailyLimit: 1 }], 1, '1']) {
    assert.throws(() => patrolAutoSupplyConfig(cfg(v)), /patrolAutoSupply/, JSON.stringify(v));
  }
});

test('limitErrors：不正な dailyLimit はキーと値つきの誤り、0 と省略は誤りにしない', () => {
  for (const v of [-1, 1.5, '1']) {
    const errors = limitErrors(withDailyLimit(v));
    assert.ok(errors.some((e) => e.includes('patrolAutoSupply.dailyLimit') && e.includes(JSON.stringify(v))), `${JSON.stringify(v)}：${JSON.stringify(errors)}`);
  }
  assert.deepEqual(limitErrors(withDailyLimit(0)), []);
  assert.deepEqual(limitErrors(withDailyLimit(undefined)), []);
});

test('実物の harness.config.json：dailyLimit が書かれていて既定と同じ 1', () => {
  const real = JSON.parse(readFileSync(REAL_PATH, 'utf8')) as { patrolAutoSupply?: { dailyLimit?: unknown } };
  assert.equal(real.patrolAutoSupply?.dailyLimit, 1);
  assert.deepEqual(patrolAutoSupplyConfig(loadConfig()), { dailyLimit: 1 });
});
