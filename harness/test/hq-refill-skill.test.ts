// hq の空きの補充（Issue #663）の文を確かめる。動いている fleet が hq.maxFleets より少なければ、
// 15分ごとの見回し（手順8）と Epic の Close の片付けの直後（手順11）に、人の承認を待たずに fleet のいない開いた Epic から次の fleet を起こす。
// hq の skill と docs/operations.md を support/skill-text.ts の構造の表で見る。語句は要点だけに絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems } from './support/skill-text.ts';

test('hq の skill：手順8・11で空きの補充を行い、手順12の一覧で知らせる', () => {
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/hq/SKILL.md',
      parts: [
        // 手順8：空きの補充の項があり、人が止めた Epic を控えに置き、人の承認を待たずに起こす。「入らないもの」を案にとどめない
        {
          step: 8,
          words: ['空きの補充', 'hq.maxFleets', 'stoppedEpics', '人の承認を待たずに'],
          absent: ['今までどおり手順3の人の承認の後', '新しい fleet（テーマ）の案にする'],
        },
        // 手順11：片付けの直後に空きの補充を行う
        { step: 11, words: ['空きの補充'] },
        // 手順12：起こした fleet を一覧で知らせる
        { step: 12, words: ['空きの補充で起こした fleet'] },
      ],
    }),
    [],
  );
});

test('docs/operations.md：hq の見回しの行が空きの補充で次の fleet を起こす', () => {
  assert.deepEqual(
    skillProblems({
      path: 'docs/operations.md',
      parts: [{ words: ['空きの補充', '人の承認を待たずに'], absent: ['空きがあれば新しい fleet の案にする'] }],
    }),
    [],
  );
});
