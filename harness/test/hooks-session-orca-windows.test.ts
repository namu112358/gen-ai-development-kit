// Issue #320：Windows（platform 'win32'）で Orca の CLI が見つからないとき、SessionStart の hook（.claude/hooks/session-env.ts）の
// 知らせに ORCA_CLI_COMMAND が入り、Windows では探さない orca-ide の名前が入らないことを orcaNotice を直接呼んで確かめる。
// あわせて Windows で hook を動かし、PATH に偽の orca-ide（sh と .cmd）だけがあるときは知らせを出し、偽の CLI を実行しないことを確かめる
// （Windows 以外では skip）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as hook from '../../.claude/hooks/session-env.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');

const NOTICE_REF = 'docs/setup.md の節11';
const SESSION_ID = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const STARTUP = JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'SessionStart', source: 'startup' });

// ---- orcaNotice を直接呼ぶ ----

test('orcaNotice：Windows で CLI が無いとき、systemMessage と additionalContext に ORCA_CLI_COMMAND が入り、orca-ide は入らない', () => {
  const n = hook.orcaNotice(STARTUP, { PATH: 'C:\\nowhere' }, () => false, 'win32');
  assert.ok(n, 'null が返った');
  assert.ok(n.systemMessage.includes('ORCA_CLI_COMMAND'), `systemMessage に ORCA_CLI_COMMAND が無い: ${n.systemMessage}`);
  assert.ok(
    n.hookSpecificOutput.additionalContext.includes('ORCA_CLI_COMMAND'),
    `additionalContext に ORCA_CLI_COMMAND が無い: ${n.hookSpecificOutput.additionalContext}`,
  );
  assert.ok(!n.systemMessage.includes('orca-ide'), `systemMessage に orca-ide が入っている: ${n.systemMessage}`);
  assert.ok(
    !n.hookSpecificOutput.additionalContext.includes('orca-ide'),
    `additionalContext に orca-ide が入っている: ${n.hookSpecificOutput.additionalContext}`,
  );
});

// ---- hook を動かす（Windows だけ） ----

interface Sandbox {
  dir: string;
  home: string;
  bin: string;
  envFile: string;
  marker: string;
}

/** 一時ディレクトリに HOME（CLAUDE_ENV_FILE を含む）と PATH にするディレクトリを作る */
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'session-orca-win-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(bin);
  const envFile = join(home, 'env.sh');
  writeFileSync(envFile, '');
  return { dir, home, bin, envFile, marker: join(dir, 'ran') };
}

/** 実行されたら印のファイルを書く偽の orca-ide（sh）と orca-ide.cmd（バッチ）を置く */
function putFakeOrcaIde(sb: Sandbox): void {
  const sh = join(sb.bin, 'orca-ide');
  writeFileSync(sh, `#!/bin/sh\necho orca-ide >> '${sb.marker.replace(/\\/g, '/')}'\n`);
  chmodSync(sh, 0o755);
  writeFileSync(join(sb.bin, 'orca-ide.cmd'), `@echo off\r\necho orca-ide>> "${sb.marker}"\r\n`);
}

/** 実行する環境で結果が変わらないように、関係する変数を消してから渡す */
function hookEnv(sb: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k) || /^pathext$/i.test(k)) continue;
    if (k.startsWith('ORCA_')) continue;
    if (k === 'WSL_DISTRO_NAME' || k === 'WSL_INTEROP') continue;
    // CLAUDE_PROJECT_DIR があると hook が読み込みの記録を書くので、実物のリポジトリに書かないように消す（#199）
    if (k === 'CLAUDE_CODE_REMOTE_SESSION_ID' || k === 'AGENT_HARNESS_SESSION' || k === 'CLAUDE_ENV_FILE' || k === 'CLAUDE_PROJECT_DIR') continue;
    env[k] = v;
  }
  env.PATH = sb.bin;
  env.PATHEXT = '.CMD';
  env.HOME = sb.home;
  env.USERPROFILE = sb.home;
  env.APPDATA = sb.home;
  env.CLAUDE_ENV_FILE = sb.envFile;
  return env;
}

test(
  'Windows で PATH に orca-ide だけがあるときは知らせ、偽の CLI を実行しない',
  { skip: process.platform !== 'win32' ? 'Windows の PATH・PATHEXT での探し方を確かめるので、Windows 以外では動かさない' : false },
  () => {
    const sb = makeSandbox();
    try {
      putFakeOrcaIde(sb);
      const r = spawnSync(process.execPath, [HOOK], { cwd: root, input: STARTUP, encoding: 'utf8', env: hookEnv(sb) });
      assert.equal(r.status, 0, r.stderr);
      let out: { systemMessage?: unknown };
      try {
        out = JSON.parse(r.stdout) as typeof out;
      } catch {
        assert.fail(`標準出力が JSON でない: ${JSON.stringify(r.stdout)}`);
      }
      assert.equal(typeof out.systemMessage, 'string', 'systemMessage が無い');
      const msg = String(out.systemMessage);
      assert.ok(msg.includes('Windows'), `systemMessage に「Windows」が無い: ${msg}`);
      assert.ok(msg.includes(NOTICE_REF), `systemMessage に「${NOTICE_REF}」が無い: ${msg}`);
      assert.equal(existsSync(sb.marker), false, '偽の orca-ide が実行された');
    } finally {
      rmSync(sb.dir, { recursive: true, force: true });
    }
  },
);
