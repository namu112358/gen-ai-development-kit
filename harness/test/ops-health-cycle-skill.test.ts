// Issue #692：運用の健康の知らせと、また起きそうなことを観測に足す振り分けの skill の文を、support/skill-text.ts の構造の表で確かめる。
// patrol の手順6で alerts を回の要約の先頭（観測の差より前）に出すこと、intel の手順と qa-retro の出力に「patrol の観測に足す」の振り分けがあること。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

const SPECS: SkillSpec[] = [
  { path: '.claude/skills/patrol/SKILL.md', parts: [{ section: '## 手順', step: 6, order: ['alerts', '観測の差'] }] },
  { path: '.claude/skills/intel/SKILL.md', parts: [{ section: '## 手順', words: ['patrol の観測に足す'] }] },
  { path: '.claude/skills/qa-retro/SKILL.md', parts: [{ section: '## 出力', words: ['patrol の観測に足す'] }] },
];

test('patrol の手順6の alerts と、intel・qa-retro の「patrol の観測に足す」の振り分け', () => {
  assert.deepEqual(SPECS.flatMap((s) => skillProblems(s).map((p) => `${s.path}：${p}`)), []);
});
