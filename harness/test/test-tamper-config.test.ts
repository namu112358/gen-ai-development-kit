// jev.testTamper が実物の設定で enforce、雛形で shadow のままで、下限 testTamperProbability が 0.9 のままかを確かめる（Issue #364）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';

const template = JSON.parse(readFileSync(new URL('../templates/harness.config.json', import.meta.url), 'utf8')) as HarnessConfig;
const actual = loadConfig();

test('harness.config.json：jev.testTamper が enforce', () => {
  assert.equal(actual.jev.testTamper, 'enforce');
});

test('雛形：jev.testTamper は shadow のまま', () => {
  assert.equal(template.jev.testTamper, 'shadow');
});

for (const [name, c] of [['harness.config.json', actual], ['雛形', template]] as const) {
  test(`${name}：jev.thresholds.testTamperProbability は 0.9 のまま`, () => {
    assert.equal(c.jev.thresholds.testTamperProbability, 0.9);
  });
}
