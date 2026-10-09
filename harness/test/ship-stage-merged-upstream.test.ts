// Issue #405：ship の skill（.claude/skills/ship/SKILL.md）の手順1に、upstream（@{u}）が無いときの Merge 後の確かめ方
// （PR の headRefOid から HEAD までの差分を見て、残る commit があれば worktree を消さずに人に返す）が書かれていることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

const SHIP_MERGED_UPSTREAM_SPEC: SkillSpec = {
  path: '.claude/skills/ship/SKILL.md',
  parts: [{ section: '## 手順', step: 1, words: ['@{u}', 'upstream が無い', 'headRefOid', 'log <headRefOid>..HEAD', '消さずに人に返す'] }],
};

test('ship の手順1に、upstream が無いときの Merge 後の確かめ方がある', () => {
  assert.deepEqual(skillProblems(SHIP_MERGED_UPSTREAM_SPEC), []);
});
