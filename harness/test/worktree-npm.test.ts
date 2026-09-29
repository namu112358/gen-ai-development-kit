// Issue #250：worktree の npm ci の起動の仕方。Windows は npm.cmd を起動するため shell を通し、それ以外は npm を直接起動する
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { npmCiCommand } from '../lib/worktree.ts';

test('npmCiCommand：Windows では shell を通して npm ci を起動する（spawnSync npm ENOENT を避ける）', () => {
  assert.deepEqual(npmCiCommand('win32'), { command: 'npm ci', args: [], shell: true });
});

test('npmCiCommand：Linux・macOS では shell を通さず npm に ci を渡す', () => {
  assert.deepEqual(npmCiCommand('linux'), { command: 'npm', args: ['ci'], shell: false });
  assert.deepEqual(npmCiCommand('darwin'), { command: 'npm', args: ['ci'], shell: false });
});
