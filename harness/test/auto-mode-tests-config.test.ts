// auto mode でテストを弱める変更を Jev が妥当と答えたとみなす下限（jev.thresholds.autoModeTestsProbability）と、
// 判定の中身（harness/lib/auto-mode-tests.ts）を委任で緩めない設定が、harness.config.json と雛形の両方にあるかを確かめる（Issue #349）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8'));

for (const rel of ['harness.config.json', 'harness/templates/harness.config.json']) {
  test(`${rel}：jev.thresholds.autoModeTestsProbability が 0.9`, () => {
    assert.equal(read(rel).jev?.thresholds?.autoModeTestsProbability, 0.9);
  });

  test(`${rel}：delegateMergeExclude に harness/lib/auto-mode-tests.ts がある（委任承認で緩めない）`, () => {
    const exclude = read(rel).delegateMergeExclude;
    assert.ok(Array.isArray(exclude), 'delegateMergeExclude がある');
    assert.ok(exclude.includes('harness/lib/auto-mode-tests.ts'), JSON.stringify(exclude));
  });
}
