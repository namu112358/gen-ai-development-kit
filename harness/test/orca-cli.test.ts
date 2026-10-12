// Issue #757：hq・fleet が env・printenv を使わずに Orca の CLI を得る入口（harness/scripts/orca-cli.ts）。
// PATH の探し方（linux・WSL は orca-ide、win32 は PATHEXT を付けた orca）、command の優先順が orcaCliCommand と同じこと、
// スクリプトの出力が command・found だけで環境変数の値（ORCA_CLI_COMMAND 以外）を出さないことを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { orcaCliCommand } from '../lib/worktree.ts';
import { onPath, orcaCliInfo } from '../scripts/orca-cli.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const SCRIPT = join(KIT, 'harness', 'scripts', 'orca-cli.ts');
const files = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

test('orcaCliInfo：WSL・linux（ORCA_CLI_COMMAND なし）は PATH のディレクトリの orca-ide を探す', () => {
  const env = { PATH: '/usr/bin::/home/u/.local/bin/' };
  assert.deepEqual(orcaCliInfo('linux', env, files('/home/u/.local/bin/orca-ide')), { command: 'orca-ide', found: true });
  assert.deepEqual(orcaCliInfo('linux', env, files('/usr/bin/orca')), { command: 'orca-ide', found: false }, '素の orca は orca-ide の代わりにしない');
  assert.deepEqual(orcaCliInfo('linux', {}, files('/usr/bin/orca-ide')), { command: 'orca-ide', found: false }, 'PATH が無い');
  assert.deepEqual(orcaCliInfo('linux', { PATH: '' }, files('/orca-ide')), { command: 'orca-ide', found: false }, 'PATH が空');
});

test('orcaCliInfo：command は orcaCliCommand と同じ優先順（ORCA_CLI_COMMAND → ORCA_DEV_REPO_ROOT → 既定）', () => {
  const cases: [NodeJS.Platform, Record<string, string | undefined>][] = [
    ['linux', { ORCA_CLI_COMMAND: 'my-orca', ORCA_DEV_REPO_ROOT: '/src/orca', PATH: '/bin' }],
    ['linux', { ORCA_CLI_COMMAND: '/opt/my-orca', PATH: '/bin' }],
    ['win32', { ORCA_CLI_COMMAND: 'C:\\tools\\orca.exe', ORCA_DEV_REPO_ROOT: '/x', PATH: 'C:\\bin' }],
    ['linux', { ORCA_DEV_REPO_ROOT: '/src/orca', PATH: '/bin' }],
    ['darwin', { ORCA_DEV_REPO_ROOT: '/src/orca', PATH: '/bin' }],
    ['linux', { PATH: '/bin' }],
    ['darwin', { PATH: '/bin' }],
    ['win32', { PATH: 'C:\\bin' }],
  ];
  for (const [platform, env] of cases) {
    assert.equal(orcaCliInfo(platform, env, () => false).command, orcaCliCommand(platform, env), `${platform} ${JSON.stringify(env)}`);
  }
});

test('onPath：区切りのある command は PATH を探さずにそのパスを見る', () => {
  assert.equal(onPath('/opt/my-orca', 'linux', { PATH: '/bin' }, files('/opt/my-orca')), true);
  assert.equal(onPath('/opt/my-orca', 'linux', { PATH: '/bin' }, files('/bin/my-orca')), false);
  assert.equal(onPath('my-orca', 'linux', { PATH: '/bin' }, files('/bin/my-orca')), true);
  assert.equal(onPath('C:\\tools\\orca', 'win32', { PATH: 'C:\\bin', PATHEXT: '.EXE' }, files('C:\\tools\\orca.EXE')), true);
});

test('onPath：win32 は PATH の orca に PATHEXT の拡張子を付けて探す（無い・空なら既定の拡張子）', () => {
  const env = { PATH: 'C:\\bin;;"C:\\Program Files\\Orca\\"', PATHEXT: '.EXE;.CMD' };
  assert.equal(onPath('orca', 'win32', env, files('C:\\Program Files\\Orca\\orca.CMD')), true);
  assert.equal(onPath('orca', 'win32', env, files('C:\\bin\\orca.EXE')), true);
  assert.equal(onPath('orca', 'win32', env, files('C:\\bin\\orca')), false, '拡張子なしは見ない');
  assert.equal(onPath('orca', 'win32', env, files('C:\\bin\\orca.BAT')), false, 'PATHEXT に無い拡張子');
  for (const PATHEXT of [undefined, '']) {
    assert.equal(onPath('orca', 'win32', { PATH: 'C:\\bin', PATHEXT }, files('C:\\bin\\orca.BAT')), true, `PATHEXT=${PATHEXT}`);
  }
  assert.equal(onPath('orca.exe', 'win32', { PATH: 'C:\\bin', PATHEXT: '.EXE' }, files('C:\\bin\\orca.exe')), true, '拡張子付きはそのまま');
});

test('onPath：isExecutable が投げたら偽', () => {
  const boom = () => {
    throw new Error('EACCES');
  };
  assert.equal(onPath('orca-ide', 'linux', { PATH: '/bin' }, boom), false);
});

function runScript(env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
}

test('スクリプト：command・found だけを1行の JSON で出し、環境変数の値（ORCA_CLI_COMMAND 以外）を出さない', { skip: process.platform === 'win32' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cli-PATHMARK-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'orca-ide');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);

  const found = runScript({ PATH: dir });
  assert.equal(found.status, 0, found.stderr);
  const lines = found.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { command: 'orca-ide', found: true });
  assert.ok(!found.stdout.includes(dir), 'PATH の値を出さない');

  const dev = runScript({ PATH: dir, ORCA_DEV_REPO_ROOT: '/secret/DEVROOTMARK' });
  assert.equal(dev.status, 0, dev.stderr);
  assert.deepEqual(JSON.parse(dev.stdout), { command: 'orca-dev', found: false }, '見つからなくても終了コード 0');
  assert.ok(!dev.stdout.includes('DEVROOTMARK'), 'ORCA_DEV_REPO_ROOT の値を出さない');
  assert.ok(!dev.stdout.includes('PATHMARK'), 'PATH の値を出さない');

  const custom = runScript({ PATH: dir, ORCA_CLI_COMMAND: '/opt/custom-orca' });
  assert.deepEqual(JSON.parse(custom.stdout), { command: '/opt/custom-orca', found: false });
});

test('スクリプト：引数を渡されたら使い方を標準エラーに出して終了コード 2', () => {
  const r = runScript({ PATH: '' }, ['--json']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.notEqual(r.stderr.trim(), '');
});
