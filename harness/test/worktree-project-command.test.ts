// Issue #640：worktree の取り込みのコマンドの起動の仕方（projectCommand）と、設定の取り込みのコマンドを使う ensureNodeModules。
// projectCommand はどの OS でも設定の文字列を shell で起動する。ensureNodeModules は null なら何も動かさず、npm ci でないコマンドは package-lock.json が無くても動かす。
// 既定（npm ci）で package-lock.json が無ければ skipped・失敗の文は worktree-deps.test.ts が確かめる。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureNodeModules, projectCommand } from '../lib/worktree.ts';

test('projectCommand：どの platform でも設定の文字列を shell で起動する（args は空）', () => {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const command of ['npm ci', 'npm run check', 'pip install -e .']) {
      assert.deepEqual(projectCommand(platform, command), { command, args: [], shell: true }, `${platform} ${command}`);
    }
  }
});

/** package-lock.json も node_modules も無い一時ディレクトリ */
function emptyDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-project-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 呼ばれた cwd とコマンドを記録する偽の run */
function fakeRun() {
  const calls: [string, string][] = [];
  const run = (cwd: string, command: string) => {
    calls.push([cwd, command]);
    return { status: 0 };
  };
  return { calls, run };
}

test('ensureNodeModules：取り込みのコマンドが null なら run を呼ばず skipped', (t) => {
  const dir = emptyDir(t);
  const r = fakeRun();
  assert.equal(ensureNodeModules(dir, null, r.run), 'skipped');
  assert.deepEqual(r.calls, []);
});

test('ensureNodeModules：npm ci でないコマンドは package-lock.json が無くてもそのコマンドで1回 run し、installed', (t) => {
  const dir = emptyDir(t);
  const r = fakeRun();
  assert.equal(ensureNodeModules(dir, 'pip install -e .', r.run), 'installed');
  assert.deepEqual(r.calls, [[dir, 'pip install -e .']]);
});
