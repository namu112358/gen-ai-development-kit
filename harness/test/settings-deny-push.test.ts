// permissions.deny の main への push の規則が、Claude Code の書き方（途中の * と末尾の :* を混ぜない）に合い、別名の refspec（<src>:main）の push に当たることを確かめる（Issue #404）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denyOf, hits, matchesRule, SETTINGS, TEMPLATE } from './support/settings-deny.ts';

/** main へ push するコマンド（deny のどれかの規則に当たるべき） */
const PUSH_TO_MAIN = ['git push origin HEAD:main', 'git push origin feature:main'];

/** main へ push しないコマンド（git push の規則に当たるべきでない） */
const NOT_TO_MAIN = ['git push origin feature:main-x', 'git push -u origin claude/issue-404-x'];

for (const p of [SETTINGS, TEMPLATE]) {
  test(`${p}: 途中の * と末尾の :* を混ぜた Bash の規則が無い`, () => {
    const mixed = denyOf(p).filter((r) => r.startsWith('Bash(') && r.endsWith(':*)') && r.slice(0, -':*)'.length).includes('*'));
    assert.deepEqual(mixed, [], `${p} に途中の * と末尾の :* を混ぜた規則がある`);
  });

  test(`${p}: main へ push するコマンドはどれかの規則に当たる`, () => {
    const deny = denyOf(p);
    for (const cmd of PUSH_TO_MAIN) assert.ok(deny.some((r) => matchesRule(r, cmd)), `当たるべき: ${cmd}`);
  });

  test(`${p}: main へ push しないコマンドは git push の規則に当たらない`, () => {
    const deny = denyOf(p);
    for (const cmd of NOT_TO_MAIN) {
      assert.deepEqual(hits(deny, cmd).filter((r) => r.startsWith('Bash(git push')), [], `当たるべきでない: ${cmd}`);
    }
  });
}
