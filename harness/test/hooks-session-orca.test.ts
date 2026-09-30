// Issue #195：SessionStart の hook（.claude/hooks/session-env.ts）が、Orca の CLI（ORCA_CLI_COMMAND・PATH の orca-ide）が無いときだけ知らせるか。
// あるとき・startup でないとき・Routine では知らせず、どの場合も exit 0 で AGENT_HARNESS_SESSION は今までどおり書き、
// 偽の orca・orca-ide を実行せず、HOME などの設定ファイルを書き換えないことを確かめる。
// Issue #311 で環境（Windows・WSL・Linux）を見分けるようにしたので、hook を動かすテストは実行する環境の正しい CLI の名前
// （win32 は orca.cmd、それ以外は orca-ide）で確かめる。環境を差し替える確かめは hooks-session-orca-platform.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import * as hook from '../../.claude/hooks/session-env.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');

/** docs/setup.md の Orca の節の番号（人の判断待ち。変えるときはここだけ直す） */
const ORCA_SECTION_NO = 11;
const NOTICE_REF = `docs/setup.md の節${ORCA_SECTION_NO}`;

/** 実行する環境で hook が探す CLI の名前（win32 は PATHEXT=.CMD を渡すので orca.cmd、それ以外は orca-ide） */
const IS_WIN = process.platform === 'win32';
const RIGHT_CLI = IS_WIN ? 'orca.cmd' : 'orca-ide';

const SESSION_ID = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const input = (source?: string): string =>
  JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'SessionStart', ...(source === undefined ? {} : { source }) });

interface Sandbox {
  dir: string;
  home: string;
  bin: string;
  envFile: string;
  marker: string;
}

/** 一時ディレクトリに HOME（CLAUDE_ENV_FILE を含む）と PATH にするディレクトリを作る */
function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'session-orca-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
  mkdirSync(bin);
  const envFile = join(home, 'env.sh');
  writeFileSync(envFile, '');
  return { dir, home, bin, envFile, marker: join(dir, 'ran') };
}

/** 実行されたら印のファイルを書く偽の実行ファイルを PATH のディレクトリに置く */
function putFake(sb: Sandbox, name: string): void {
  const file = join(sb.bin, name);
  if (name.endsWith('.cmd')) {
    writeFileSync(file, `@echo off\r\necho ${name}>> "${sb.marker}"\r\n`);
    return;
  }
  writeFileSync(file, `#!/bin/sh\necho ${name} >> '${sb.marker.replace(/\\/g, '/')}'\n`);
  chmodSync(file, 0o755);
}

/** 実行する環境（Orca の中・Claude Code のセッション・CI）で結果が変わらないように、関係する変数を消してから渡す */
function hookEnv(sb: Sandbox, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k)) continue;
    if (k.startsWith('ORCA_')) continue;
    // CLAUDE_PROJECT_DIR があると hook が読み込みの記録を書くので、実物のリポジトリに書かないように消す（#199）
    if (k === 'CLAUDE_CODE_REMOTE_SESSION_ID' || k === 'AGENT_HARNESS_SESSION' || k === 'CLAUDE_ENV_FILE' || k === 'CLAUDE_PROJECT_DIR') continue;
    if (k === 'WSL_DISTRO_NAME' || k === 'WSL_INTEROP' || /^pathext$/i.test(k)) continue;
    env[k] = v;
  }
  if (IS_WIN) env.PATHEXT = '.CMD';
  env.PATH = sb.bin;
  env.HOME = sb.home;
  env.USERPROFILE = sb.home;
  env.APPDATA = sb.home;
  env.CLAUDE_ENV_FILE = sb.envFile;
  return { ...env, ...extra };
}

/** ディレクトリの下のファイルの、相対パス → 大きさ・更新時刻・中身 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }).map(String)) {
    const abs = join(dir, rel);
    const st = statSync(abs);
    if (!st.isFile()) continue;
    out.set(relative(dir, abs).replace(/\\/g, '/'), `${st.size}:${st.mtimeMs}:${readFileSync(abs, 'utf8')}`);
  }
  return out;
}

function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  envContent: string;
  ran: boolean;
  changed: string[];
}

function runHook(opts: { source?: string; raw?: string; extra?: Record<string, string>; fakes?: string[] }): Run {
  const sb = makeSandbox();
  try {
    for (const f of opts.fakes ?? []) putFake(sb, f);
    const before = snapshot(sb.home);
    const r = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      input: opts.raw ?? input(opts.source),
      encoding: 'utf8',
      env: hookEnv(sb, opts.extra),
    });
    const after = snapshot(sb.home);
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      envContent: readFileSync(sb.envFile, 'utf8'),
      ran: existsSync(sb.marker),
      changed: changedFiles(before, after),
    };
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
}

const exportLine = new RegExp(`^export AGENT_HARNESS_SESSION=(['"]?)${SESSION_ID}\\1$`, 'm');

/** どの場合も守ること：exit 0、ID を書く、偽の CLI を実行しない、CLAUDE_ENV_FILE のほかは書き換えない */
function assertCommon(r: Run, label: string): void {
  assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  assert.match(r.envContent, exportLine, `${label}: AGENT_HARNESS_SESSION が書かれていない`);
  assert.equal(r.ran, false, `${label}: 偽の orca・orca-ide が実行された`);
  assert.deepEqual(r.changed, ['env.sh'], `${label}: CLAUDE_ENV_FILE のほかに変わったファイルがある`);
}

function assertNotice(r: Run, label: string): void {
  let out: { systemMessage?: unknown; hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown } };
  try {
    out = JSON.parse(r.stdout) as typeof out;
  } catch {
    assert.fail(`${label}: 標準出力が JSON でない: ${JSON.stringify(r.stdout)}`);
  }
  assert.equal(typeof out.systemMessage, 'string', `${label}: systemMessage が無い`);
  assert.ok(String(out.systemMessage).includes(NOTICE_REF), `${label}: systemMessage に「${NOTICE_REF}」が無い`);
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.equal(typeof out.hookSpecificOutput?.additionalContext, 'string', `${label}: additionalContext が無い`);
  assert.ok(String(out.hookSpecificOutput?.additionalContext).includes(NOTICE_REF), `${label}: additionalContext に「${NOTICE_REF}」が無い`);
}

// ---- hook を動かす ----

test('ORCA_CLI_COMMAND も orca-ide も無く source が startup なら、節への案内を JSON で知らせる', () => {
  const r = runHook({ source: 'startup' });
  assertCommon(r, 'Orca なし');
  assertNotice(r, 'Orca なし');
});

test('PATH に素の orca だけがあっても知らせる（orca は探さず、実行もしない）', { skip: IS_WIN ? 'Windows では素の orca が正しい CLI' : false }, () => {
  const r = runHook({ source: 'startup', fakes: ['orca'] });
  assertCommon(r, 'orca だけ');
  assertNotice(r, 'orca だけ');
});

test('ORCA_CLI_COMMAND があるときは何も出さない', () => {
  const r = runHook({ source: 'startup', extra: { ORCA_CLI_COMMAND: 'orca-ide' }, fakes: ['orca', RIGHT_CLI] });
  assertCommon(r, 'ORCA_CLI_COMMAND');
  assert.equal(r.stdout.trim(), '');
});

test(`PATH に実行できる ${RIGHT_CLI} があるときは何も出さない（実行はしない）`, () => {
  const r = runHook({ source: 'startup', fakes: ['orca', RIGHT_CLI] });
  assertCommon(r, RIGHT_CLI);
  assert.equal(r.stdout.trim(), '');
});

test('source が resume・clear・compact・無いときは何も出さない', () => {
  for (const source of ['resume', 'clear', 'compact', undefined]) {
    const r = runHook({ source, fakes: ['orca'] });
    assertCommon(r, `source=${String(source)}`);
    assert.equal(r.stdout.trim(), '', `source=${String(source)}`);
  }
});

test('Routine（CLAUDE_CODE_REMOTE_SESSION_ID がある）では何も出さない', () => {
  const r = runHook({ source: 'startup', extra: { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc' }, fakes: ['orca'] });
  assertCommon(r, 'Routine');
  assert.equal(r.stdout.trim(), '');
});

test('JSON が壊れているときは何も出さず終了コード 0', () => {
  const r = runHook({ raw: '{not json', fakes: ['orca', RIGHT_CLI] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.equal(r.ran, false);
});

// ---- orcaNotice を直接呼ぶ ----

const noEnv: Record<string, string | undefined> = { PATH: '/nowhere/a:/nowhere/b' };
const never = (): boolean => false;

test('orcaNotice：JSON が壊れている・source が無い・startup でないときは null', () => {
  for (const raw of ['{not json', '', JSON.stringify({ session_id: SESSION_ID }), input('resume'), input('fork')]) {
    assert.equal(hook.orcaNotice(raw, noEnv, never, 'linux'), null, raw);
  }
});

test('orcaNotice：Orca が無い startup で、systemMessage と additionalContext に節への案内がある', () => {
  const n = hook.orcaNotice(input('startup'), noEnv, never, 'linux');
  assert.ok(n, 'null が返った');
  assert.ok(n.systemMessage.includes(NOTICE_REF));
  assert.equal(n.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(n.hookSpecificOutput.additionalContext.includes(NOTICE_REF));
});

test('orcaNotice：Routine・ORCA_CLI_COMMAND・orca-ide があるときは null', () => {
  assert.equal(hook.orcaNotice(input('startup'), { ...noEnv, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_x' }, never, 'linux'), null);
  assert.equal(hook.orcaNotice(input('startup'), { ...noEnv, ORCA_CLI_COMMAND: 'wsl orca' }, never, 'linux'), null);
  assert.equal(
    hook.orcaNotice(input('startup'), noEnv, (p) => p.replace(/\\/g, '/') === '/nowhere/b/orca-ide', 'linux'),
    null,
  );
});

test('orcaNotice：isExecutable に渡るのは PATH の各ディレクトリの orca-ide だけ', () => {
  const seen: string[] = [];
  hook.orcaNotice(input('startup'), noEnv, (p) => {
    seen.push(p);
    return false;
  }, 'linux');
  assert.ok(seen.length >= 2, `PATH の2つのディレクトリを探していない: ${JSON.stringify(seen)}`);
  for (const p of seen) assert.ok(/[/\\]orca-ide$/.test(p), `orca-ide でないパスが渡った: ${p}`);
  assert.deepEqual(
    seen.map((p) => p.replace(/\\/g, '/')),
    ['/nowhere/a/orca-ide', '/nowhere/b/orca-ide'],
  );
});
