import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { ensureNodeModules, worktreePath } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

const agentScript = join(import.meta.dirname, '..', 'scripts', 'agent.ts');

/** 空の一時ディレクトリ。指定に応じて package-lock.json と node_modules を作る */
function tempDir(t: { after: (fn: () => void) => void }, entries: { lockfile?: boolean; nodeModules?: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-deps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (entries.lockfile) writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  if (entries.nodeModules) mkdirSync(join(dir, 'node_modules'));
  return dir;
}

/** 呼ばれた cwd を記録し、決めた結果を返す偽の npm ci */
function fakeNpmCi(result: { status: number | null; error?: Error } = { status: 0 }) {
  const calls: string[] = [];
  const run = (cwd: string) => {
    calls.push(cwd);
    return result;
  };
  return { calls, run };
}

test('ensureNodeModules：lockfile があり node_modules が無ければ npm ci をそのパスで1回呼び、installed', (t) => {
  const dir = tempDir(t, { lockfile: true });
  const npm = fakeNpmCi();
  assert.equal(ensureNodeModules(dir, npm.run), 'installed');
  assert.deepEqual(npm.calls, [dir]);
});

test('ensureNodeModules：node_modules があれば npm ci を呼ばず present', (t) => {
  const dir = tempDir(t, { lockfile: true, nodeModules: true });
  const npm = fakeNpmCi();
  assert.equal(ensureNodeModules(dir, npm.run), 'present');
  assert.deepEqual(npm.calls, []);
});

test('ensureNodeModules：package-lock.json が無ければ npm ci を呼ばず skipped', (t) => {
  const dir = tempDir(t, {});
  const npm = fakeNpmCi();
  assert.equal(ensureNodeModules(dir, npm.run), 'skipped');
  assert.deepEqual(npm.calls, []);
});

test('ensureNodeModules：npm ci が 0 以外で終われば、パス付きの理由で投げる', (t) => {
  const dir = tempDir(t, { lockfile: true });
  const npm = fakeNpmCi({ status: 1 });
  assert.throws(
    () => ensureNodeModules(dir, npm.run),
    (e: Error) => e.message.includes('npm ci が失敗しました') && e.message.includes(dir),
  );
  assert.equal(npm.calls.length, 1);
});

test('ensureNodeModules：npm ci を起動できなければ、元の理由を含めて投げる', (t) => {
  const dir = tempDir(t, { lockfile: true });
  const npm = fakeNpmCi({ status: null, error: new Error('spawnSync npm ENOENT') });
  assert.throws(
    () => ensureNodeModules(dir, npm.run),
    (e: Error) => e.message.includes('npm ci を起動できませんでした') && e.message.includes(dir) && e.message.includes('spawnSync npm ENOENT'),
  );
});

/**
 * PATH の先頭に置く偽の npm。呼ばれた cwd と引数を記録し、標準出力に数行書き、
 * FAKE_NPM_EXIT が 0 なら node_modules を作ってその値で終わる。
 */
function fakeNpmBin(dir: string): { bin: string; log: string } {
  const bin = join(dir, 'fake-bin');
  const log = join(dir, 'npm-calls.log');
  mkdirSync(bin);
  const script = join(bin, 'npm');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'echo "$PWD $*" >> "$FAKE_NPM_LOG"',
      'echo "added 2 packages in 1s"',
      'echo ""',
      'echo "found 0 vulnerabilities"',
      'code="${FAKE_NPM_EXIT:-0}"',
      'if [ "$code" = "0" ]; then mkdir -p node_modules; fi',
      'exit "$code"',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
  return { bin, log };
}

const calls = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '') : []);
const lastLine = (out: string): string | undefined => out.split('\n').filter((l) => l.trim() !== '').at(-1);

test('agent.ts worktree：node_modules が無ければ npm ci を行い、標準出力の最終行は worktree のパスのまま', { skip: process.platform === 'win32' ? '偽の npm が POSIX のシェルスクリプトのため' : false }, (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.commit(s.seed, 'package-lock.json');
  s.git(s.seed, 'push', '-q', 'origin', 'main');
  const { bin, log } = fakeNpmBin(s.dir);

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE_NPM_LOG: log, FAKE_NPM_EXIT: '0' };
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  const run = (exit = '0') =>
    spawnSync(process.execPath, ['--no-warnings', agentScript, 'worktree', 'claude/x'], { cwd: s.root, encoding: 'utf8', env: { ...env, FAKE_NPM_EXIT: exit } });
  const path = worktreePath(s.root, 'claude/x');

  // 1回目：作ったばかりの worktree には node_modules が無いので npm ci が走る
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(calls(log), [`${path} ci`]);
  assert.equal(lastLine(first.stdout), path);
  assert.ok(!first.stdout.includes('added 2 packages'), 'npm の出力は標準出力に混ぜない');
  assert.ok(existsSync(join(path, 'node_modules')));

  // 2回目：既にある worktree で node_modules もあるので npm ci は走らない
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(calls(log).length, 1);
  assert.equal(lastLine(second.stdout), path);

  // 3回目：node_modules を消すと、既にある worktree でも npm ci が走る
  rmSync(join(path, 'node_modules'), { recursive: true, force: true });
  const third = run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(calls(log).length, 2);
  assert.equal(lastLine(third.stdout), path);

  // npm ci が失敗すれば終了コード 1、理由を標準エラーに出し、パスは出さない
  rmSync(join(path, 'node_modules'), { recursive: true, force: true });
  const failed = run('1');
  assert.equal(failed.status, 1);
  assert.equal(calls(log).length, 3);
  assert.match(failed.stderr, /npm ci が失敗しました/);
  assert.ok(!failed.stdout.includes(path), failed.stdout);
});
