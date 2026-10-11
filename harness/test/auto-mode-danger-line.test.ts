// auto mode の危険の保留の線（dangerSafe 0.8）で、危険の確率 15% は保留しない・25% は保留することを、このリポジトリの設定・雛形・既定で確かめる（計画ゲートと PR の受け付けが同じ autoModeDanger を使う。Issue #597）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { autoModeDanger, type AutoModeJevRecord } from '../lib/auto-mode.ts';

const jevOk = (yes: number): AutoModeJevRecord => ({ status: 'ok', detail: 'm', yes, questionSet: 1 });
const template = JSON.parse(readFileSync(new URL('../templates/harness.config.json', import.meta.url), 'utf8')) as HarnessConfig;

const CONFIGS: [string, Pick<HarnessConfig, 'autoMode'>][] = [
  ['harness.config.json', loadConfig()],
  ['雛形', template],
  ['既定（{}）', {}],
];

for (const [name, c] of CONFIGS) {
  test(`${name}：危険の確率 15% は保留しない、25% は保留する`, () => {
    assert.equal(autoModeDanger(c, { jev: jevOk(0.15) }).hold, false, '15% が保留になった');
    assert.equal(autoModeDanger(c, { jev: jevOk(0.25) }).hold, true, '25% が保留にならない');
  });
}
