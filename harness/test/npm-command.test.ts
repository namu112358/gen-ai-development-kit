// Issue #256：npm の起動の仕方（npm ci と npm run check）を1か所で決める。Windows は shell を通してコマンド行で起動し、それ以外は npm を直接起動する
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { npmCiCommand, npmCommand } from '../lib/worktree.ts';

test('npmCommand：Windows では shell を通して npm ci を起動する', () => {
  assert.deepEqual(npmCommand('win32', 'ci'), { command: 'npm ci', args: [], shell: true });
});

test('npmCommand：Windows では shell を通して npm run check を起動する', () => {
  assert.deepEqual(npmCommand('win32', 'check'), { command: 'npm run check', args: [], shell: true });
});

test('npmCommand：Linux・macOS では shell を通さず npm に ci を渡す', () => {
  assert.deepEqual(npmCommand('linux', 'ci'), { command: 'npm', args: ['ci'], shell: false });
  assert.deepEqual(npmCommand('darwin', 'ci'), { command: 'npm', args: ['ci'], shell: false });
});

test('npmCommand：Linux・macOS では shell を通さず npm に run check を渡す', () => {
  assert.deepEqual(npmCommand('linux', 'check'), { command: 'npm', args: ['run', 'check'], shell: false });
  assert.deepEqual(npmCommand('darwin', 'check'), { command: 'npm', args: ['run', 'check'], shell: false });
});

test('npmCiCommand は npmCommand(platform, "ci") と同じ値を返す（分岐は1か所）', () => {
  for (const p of ['win32', 'linux', 'darwin'] as const) {
    assert.deepEqual(npmCiCommand(p), npmCommand(p, 'ci'), p);
  }
});
