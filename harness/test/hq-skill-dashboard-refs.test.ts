// hq の skill がダッシュボードの節を harness/gates/stale.ts が書く題で指し、消した承認（手順3の承認）を参照しないことを確かめる（Issue #740）。
// 語句は要点だけに絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readText, skillProblems } from './support/skill-text.ts';

test('hq の skill：消した承認を参照しない', () => {
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/hq/SKILL.md',
      parts: [{ absent: ['手順3の承認', '止まった着手宣言の節', 'まだ無ければ読まない'] }],
    }),
    [],
  );
});

test('hq の skill：ダッシュボードの節を stale.ts の題で指す', () => {
  const titles = ['止まっていそうな着手宣言', '担当のいない判定待ちの PR', 'Epic に入っていない Issue'];
  const stale = readText('harness/gates/stale.ts');
  assert.deepEqual(
    titles.filter((t) => !stale.includes(t)),
    [],
  );
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/hq/SKILL.md',
      parts: [{ step: 8, words: ['止まっていそうな着手宣言', '担当のいない判定待ちの PR'] }],
    }),
    [],
  );
});
