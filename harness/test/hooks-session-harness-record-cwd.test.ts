// Issue #843：SessionStart の hook（.claude/hooks/session-env.ts）の読み込みの記録が、入力（stdin の JSON）の cwd を読み先にするか。
// desktop アプリの worktree のセッションでは CLAUDE_PROJECT_DIR が本体の checkout を、入力の cwd が worktree を指す。cwd が CLAUDE_PROJECT_DIR と
// 同じ共通ディレクトリのリポジトリ（worktree とその下のディレクトリ）なら、記録の head と files はそこのものにする。cwd が無い・存在しない・
// 別のリポジトリ・git の外なら今のとおり CLAUDE_PROJECT_DIR のものにする。記録の置き場所はどの場合も CLAUDE_PROJECT_DIR の共通ディレクトリ。
// 読み先を決める recordSource（例外を投げない）も直接確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import * as hook from '../../.claude/hooks/session-env.ts';
import { contentVersion, loadedRecordPath, readLoadedRecord } from '../lib/harness-drift.ts';
import { sandbox } from './support/git-sandbox.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');
const SESSION = '5d1e2f3a-843a-4b2c-9d00-abcdef012345';
const SHIP = '.claude/skills/ship/SKILL.md';
const SHIP_MAIN = 'ship v1\n';
const SHIP_WT = 'ship v2 (worktree)\n';

type Sb = ReturnType<typeof sandbox>;
type Fixture = Sb & { envFile: string; commonDir: string; wt: string; mainHead: string; wtHead: string };

/** 本体（CLAUDE_PROJECT_DIR）にハーネスのファイルを commit し、git worktree add で作った worktree で SHIP を書き換えて commit した砂場 */
function worktreeSandbox(t: { after: (fn: () => void) => void }): Fixture {
  const sb = sandbox();
  t.after(sb.cleanup);
  for (const [file, body] of Object.entries({ 'CLAUDE.md': 'claude\n', [SHIP]: SHIP_MAIN })) {
    mkdirSync(dirname(join(sb.root, file)), { recursive: true });
    writeFileSync(join(sb.root, file), body);
    sb.git(sb.root, 'add', file);
  }
  sb.git(sb.root, 'commit', '-qm', 'harness');
  const wt = join(sb.dir, 'wt');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', 'claude/issue-843-x', wt);
  writeFileSync(join(wt, SHIP), SHIP_WT);
  sb.git(wt, 'add', SHIP);
  sb.git(wt, 'commit', '-qm', 'ship v2');
  const envFile = join(sb.dir, 'env.sh');
  writeFileSync(envFile, '');
  const commonDir = sb.git(sb.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const mainHead = sb.git(sb.root, 'rev-parse', 'HEAD');
  const wtHead = sb.git(wt, 'rev-parse', 'HEAD');
  assert.notEqual(mainHead, wtHead, '前提：worktree の HEAD は本体と違う');
  return { ...sb, envFile, commonDir, wt, mainHead, wtHead };
}

/** 実行する環境で結果が変わらないように、関係する変数を消してから必要なものだけを入れる（前提の確かめは止める） */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete env.CLAUDE_ENV_FILE;
  return { ...env, AGENT_HARNESS_SESSION_DOCTOR: '0', ...extra };
}

function runHook(input: string, extra: Record<string, string>) {
  return spawnSync(process.execPath, [HOOK], { cwd: root, input, encoding: 'utf8', env: hookEnv(extra) });
}

/** SessionStart の入力。cwd を渡したときだけ入れる */
const start = (id: string, source = 'startup', cwd?: string): string =>
  JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', source, ...(cwd === undefined ? {} : { cwd }) });
const loadedDir = (commonDir: string): string => join(commonDir, 'agent-harness', 'loaded');

/** パスの表記の違い（区切り・8.3 形式・大文字小文字）で落ちないようにそろえる */
function norm(path: string): string {
  let p = resolve(path);
  try {
    p = realpathSync.native(p);
  } catch {
    // 無いパスはそのまま
  }
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** hook を起動し、CLAUDE_PROJECT_DIR（本体）の共通ディレクトリの下の記録を返す。同じ砂場で場合を回すので、場合ごとに ID を変える */
function recordFor(fx: Fixture, cwd: string | undefined, session = SESSION) {
  const r = runHook(start(session, 'startup', cwd), { CLAUDE_PROJECT_DIR: fx.root, CLAUDE_ENV_FILE: fx.envFile });
  assert.equal(r.status, 0, r.stderr);
  const rec = readLoadedRecord(loadedRecordPath(fx.commonDir, session)!);
  assert.ok(rec, 'CLAUDE_PROJECT_DIR の共通ディレクトリの下に記録がある');
  return rec;
}

test('入力の cwd が worktree（またはその下）なら、記録の head と files は worktree のもの（CLAUDE_PROJECT_DIR は本体）', (t) => {
  const fx = worktreeSandbox(t);
  for (const [i, sub] of ['', join('.claude', 'skills')].entries()) {
    const rec = recordFor(fx, join(fx.wt, sub), `${SESSION}-${i}`);
    assert.equal(rec.head, fx.wtHead, `cwd=wt/${sub}：head は worktree の HEAD`);
    assert.deepEqual(
      rec.files,
      { 'CLAUDE.md': contentVersion('claude\n'), [SHIP]: contentVersion(SHIP_WT) },
      `cwd=wt/${sub}：files は worktree の中身の版`,
    );
  }
});

test('入力に cwd が無い・存在しないパスなら、今のとおり CLAUDE_PROJECT_DIR の head と files で書く', (t) => {
  const fx = worktreeSandbox(t);
  for (const [i, cwd] of [undefined, 'no-such-dir'].entries()) {
    const rec = recordFor(fx, cwd === undefined ? undefined : join(fx.dir, cwd), `${SESSION}-${i}`);
    assert.equal(rec.head, fx.mainHead, `cwd=${cwd}：head は本体の HEAD`);
    assert.equal(rec.files[SHIP], contentVersion(SHIP_MAIN), `cwd=${cwd}：files は本体の中身の版`);
  }
});

test('入力の cwd が別のリポジトリなら、本体の head と files で書き、別のリポジトリには記録を書かない', (t) => {
  const fx = worktreeSandbox(t);
  const other = sandbox();
  t.after(other.cleanup);
  const otherCommon = other.git(other.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const rec = recordFor(fx, other.root);
  assert.equal(rec.head, fx.mainHead);
  assert.equal(rec.files[SHIP], contentVersion(SHIP_MAIN));
  assert.equal(existsSync(loadedDir(otherCommon)), false, '別のリポジトリの共通ディレクトリの下に記録を書かない');
});

test('recordSource：同じ共通ディレクトリの worktree（とその下）なら show-toplevel、別のリポジトリ・git の外・cwd が無いなら projectDir（例外を投げない）', (t) => {
  const fx = worktreeSandbox(t);
  const other = sandbox();
  t.after(other.cleanup);
  const outside = mkdtempSync(join(tmpdir(), 'record-source-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const wtTop = fx.git(fx.wt, 'rev-parse', '--show-toplevel');
  const cases: [string, unknown, string][] = [
    ['worktree', fx.wt, wtTop],
    ['worktree の下', join(fx.wt, '.claude', 'skills'), wtTop],
    ['本体', fx.root, fx.root],
    ['別のリポジトリ', other.root, fx.root],
    ['git の外', outside, fx.root],
    ['存在しないパス', join(fx.dir, 'no-such-dir'), fx.root],
    ['undefined', undefined, fx.root],
    ['空の文字列', '', fx.root],
    ['文字列でない', 42, fx.root],
  ];
  for (const [name, cwd, expected] of cases) {
    const got = hook.recordSource(cwd, fx.root, fx.commonDir);
    assert.equal(norm(got), norm(expected), name);
  }
});
