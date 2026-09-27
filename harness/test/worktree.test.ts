import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worktreePath } from '../lib/worktree.ts';

test('worktree はリポジトリの外に、ブランチ名を安全な名前にして置く', () => {
  assert.equal(worktreePath('/home/u/repo', 'claude/issue-5-x'), '/home/u/repo.worktrees/claude-issue-5-x');
  assert.equal(worktreePath('/home/u/repo', 'a'.repeat(40)), `/home/u/repo.worktrees/${'a'.repeat(40)}`);
  assert.ok(!worktreePath('/home/u/repo', '../../etc').includes('..'.concat('/etc')));
});

test('`..` などで置き場所の外に出ない', () => {
  assert.equal(worktreePath('/home/u/repo', '..'), '/home/u/repo.worktrees/_.');
  assert.equal(worktreePath('/home/u/repo', '.hidden'), '/home/u/repo.worktrees/_hidden');
});
