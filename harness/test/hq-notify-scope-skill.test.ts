// Issue #772：hq がすぐ知らせる範囲と fleet の印の文を確かめる。hq の skill の手順7は、すぐ伝えるのを Human Merge の ready と
// 人の判断が要る notice だけにし、自動 Merge の ready は手順12の一覧にためる（人の判断は要らない notice は intel、印の無い notice は notice-unmarked）。
// fleet の skill の worker の手順8は、ready の本文の1行目の印（Human Merge・自動 Merge）と notice の人の判断の印を書く。
// 表は2つを1つの test() で確かめ、足りないものを全部一度に示す。語は要点だけに絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

/** hq の skill の手順7：すぐ知らせる範囲 */
const HQ_NOTIFY_SPEC: SkillSpec = {
  path: '.claude/skills/hq/SKILL.md',
  parts: [
    {
      step: 7,
      words: ['Human Merge', '自動 Merge', '人の判断が要る', '人の判断は要らない', 'intel', 'notice-unmarked'],
      order: ['すぐ伝える', 'Human Merge', '手順12の一覧にためる', '自動 Merge'],
    },
  ],
};

/** fleet の skill の worker の手順8：ready と notice の印 */
const FLEET_MARK_SPEC: SkillSpec = {
  path: '.claude/skills/fleet/SKILL.md',
  parts: [
    {
      section: '## Orca の worker として動くとき',
      step: 8,
      words: ['1行目', 'Human Merge', '自動 Merge', '人の判断が要る', '人の判断は要らない'],
    },
  ],
};

test('hq の手順7はすぐ知らせるのを Human Merge の ready と人の判断が要る notice だけにし、fleet の手順8は印を書く', () => {
  assert.deepEqual([...skillProblems(HQ_NOTIFY_SPEC), ...skillProblems(FLEET_MARK_SPEC)], []);
});
