import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { patchId } from '../lib/patch-id.ts';

/** Phase 0 検証項目：main 追従（merge / rebase）後も PR 自身の差分の patch-id が変わらないこと */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** GitHub の compare API（base...head）と同じ3点比較の diff */
const threeDot = (cwd: string, base: string, head: string) => git(cwd, 'diff', `${base}...${head}`);

test('main 追従後も PR 自身の差分の patch-id は同じ、変更すれば変わる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patchid-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  git(dir, 'checkout', '-qb', 'claude/x');
  writeFileSync(join(dir, 'a.txt'), 'a\nfeature\n');
  git(dir, 'commit', '-qam', 'feature');
  const judged = patchId(threeDot(dir, 'main', 'claude/x'));

  git(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'b.txt'), 'b\nmain moved\n');
  git(dir, 'commit', '-qam', 'main moves');
  git(dir, 'checkout', '-q', 'claude/x');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  assert.equal(patchId(threeDot(dir, 'main', 'claude/x')), judged, 'merge で追従');

  git(dir, 'checkout', '-qb', 'claude/rebased', 'HEAD~1');
  git(dir, 'rebase', '-q', 'main');
  assert.equal(patchId(threeDot(dir, 'main', 'claude/rebased')), judged, 'rebase で追従');

  writeFileSync(join(dir, 'a.txt'), 'a\nfeature changed\n');
  git(dir, 'commit', '-qam', 'fix');
  assert.notEqual(patchId(threeDot(dir, 'main', 'claude/rebased')), judged, '差分が変われば別の値');
  assert.equal(patchId(''), 'empty');
});

test('空白だけの違いも別の差分として扱う', () => {
  const diff = (line: string) => `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+${line}\n`;
  assert.notEqual(patchId(diff('rm -rf /tmp/build')), patchId(diff('rm -rf / tmp/build')));
  assert.notEqual(patchId(diff('  if x:')), patchId(diff('    if x:')), 'Python / YAML のインデント');
});
