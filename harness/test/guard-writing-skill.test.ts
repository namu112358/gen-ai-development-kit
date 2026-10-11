// ガードレールに触れる計画・PR の書き方の案内を、support/skill-text.ts の構造の表で確かめる（Issue #617）。
// plan の skill の手順3：ガードレールに触れる計画では、触れる守り・緩めないこと・それを確かめるテストを書き、Jev を説得する文を書かない。
// implement の skill の手順3：守りが効き続けることを確かめるテスト（今までどおり止まる）を差分に入れる。
// implement の skill の手順4：守りに触れない変更を同じ PR に混ぜず、説得する文を書かない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems } from './support/skill-text.ts';

test('plan と implement の skill に、守りに触れる計画・変更の書き方の案内がある', () => {
  const problems = [
    ...skillProblems({
      path: '.claude/skills/plan/SKILL.md',
      parts: [{ step: 3, words: ['ガードレールに触れる計画', '触れる守り', '緩めないこと', '確かめるテスト', '説得する文'] }],
    }),
    ...skillProblems({
      path: '.claude/skills/implement/SKILL.md',
      parts: [
        { step: 3, words: ['守りが効き続けることを確かめるテスト', '今までどおり止まる'] },
        { step: 4, words: ['同じ PR に混ぜない', '説得する文'] },
      ],
    }),
  ];
  assert.deepEqual(problems, []);
});
