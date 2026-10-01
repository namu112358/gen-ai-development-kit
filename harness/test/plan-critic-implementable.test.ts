// Issue #471：plan-critic に「この計画だけで実装できるか」の観点がある（support/skill-text.ts の構造の表で確かめる）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems } from './support/skill-text.ts';

test('plan-critic の観点7に、計画と steps だけで実装できるかを見て、曖昧・判断が実装に残っていれば revise にすると書いてある', () => {
  const problems = skillProblems({
    path: '.claude/agents/plan-critic.md',
    parts: [{ section: '## 観点', step: 7, words: ['この計画だけで実装できるか', 'steps', '曖昧', '判断が実装に残っている', 'revise'] }],
  });
  assert.deepEqual(problems, []);
});
