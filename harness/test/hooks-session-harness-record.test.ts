// Issue #199：SessionStart の hook（.claude/hooks/session-env.ts）が、CLAUDE_PROJECT_DIR のリポジトリの git の共通ディレクトリの下に
// 読み込みの記録（agent-harness/loaded/<セッション ID>.json。対象のファイルだけの版と始めたときの HEAD）を書くか。同じ ID の2回目（resume・compact）では
// 上書きしない。ID が不正・git の外・CLAUDE_PROJECT_DIR が無いときは書かない。どの場合も exit 0 で、AGENT_HARNESS_SESSION の行は今までどおり書く。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as hook from '../../.claude/hooks/session-env.ts';
import { contentVersion, loadedRecordPath, readLoadedRecord } from '../lib/harness-drift.ts';
import { sandbox } from './support/git-sandbox.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const SHIP = '.claude/skills/ship/SKILL.md';

type Sb = ReturnType<typeof sandbox>;

/** ハーネスのファイルと対象の外のファイルを commit した砂場（本体は repo） */
function harnessSandbox(t: { after: (fn: () => void) => void }): Sb & { envFile: string; commonDir: string } {
  const sb = sandbox();
  t.after(sb.cleanup);
  const files: Record<string, string> = { 'CLAUDE.md': 'claude\n', [SHIP]: 'ship v1\n', 'harness/lib/x.ts': 'x\n' };
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(dirname(join(sb.root, file)), { recursive: true });
    writeFileSync(join(sb.root, file), body);
    sb.git(sb.root, 'add', file);
  }
  sb.git(sb.root, 'commit', '-qm', 'harness');
  const envFile = join(sb.dir, 'env.sh');
  writeFileSync(envFile, '');
  const commonDir = sb.git(sb.root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  return { ...sb, envFile, commonDir };
}

/** 実行する環境で結果が変わらないように、関係する変数を消してから必要なものだけを入れる */
function hookEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  delete env.CLAUDE_ENV_FILE;
  return { ...env, ...extra };
}

function runHook(input: string, extra: Record<string, string>, cwd = root) {
  return spawnSync(process.execPath, [HOOK], { cwd, input, encoding: 'utf8', env: hookEnv(extra) });
}

const start = (id: string, source = 'startup'): string => JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', source });
const loadedDir = (commonDir: string): string => join(commonDir, 'agent-harness', 'loaded');

test('CLAUDE_PROJECT_DIR の共通ディレクトリの下に、対象のファイルだけの版と HEAD の記録を書く。AGENT_HARNESS_SESSION の行も書く', (t) => {
  const sb = harnessSandbox(t);
  const r = runHook(start(SESSION), { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(sb.envFile, 'utf8'), new RegExp(`^export AGENT_HARNESS_SESSION=${SESSION}$`, 'm'));
  const path = loadedRecordPath(sb.commonDir, SESSION)!;
  const rec = readLoadedRecord(path);
  assert.ok(rec, `記録がありません: ${path}`);
  assert.equal(rec.version, 1);
  assert.equal(rec.session, SESSION);
  assert.equal(rec.head, sb.git(sb.root, 'rev-parse', 'HEAD'));
  assert.deepEqual(Object.keys(rec.files).sort(), [SHIP, 'CLAUDE.md'].sort(), '対象の外（harness/lib）は入らない');
  assert.equal(rec.files[SHIP], contentVersion('ship v1\n'));
  assert.ok(!Number.isNaN(Date.parse(rec.at)), 'at は時刻');
});

test('同じ ID の2回目（resume・compact）は上書きしない（ディスクが変わっていても最初の記録のまま）', (t) => {
  const sb = harnessSandbox(t);
  assert.equal(runHook(start(SESSION), { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile }).status, 0);
  const path = loadedRecordPath(sb.commonDir, SESSION)!;
  const first = readFileSync(path, 'utf8');
  writeFileSync(join(sb.root, SHIP), 'ship v2\n');
  for (const source of ['resume', 'compact']) {
    const r = runHook(start(SESSION, source), { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(path, 'utf8'), first, `${source} で上書きした`);
  }
});

test('/clear で ID が変われば、新しい ID の記録を別に書く', (t) => {
  const sb = harnessSandbox(t);
  const other = '9b8c7d6e-1111-2222-3333-444455556666';
  runHook(start(SESSION), { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile });
  writeFileSync(join(sb.root, SHIP), 'ship v2\n');
  const r = runHook(start(other, 'clear'), { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readLoadedRecord(loadedRecordPath(sb.commonDir, other)!)!.files[SHIP], contentVersion('ship v2\n'));
  assert.equal(readLoadedRecord(loadedRecordPath(sb.commonDir, SESSION)!)!.files[SHIP], contentVersion('ship v1\n'));
});

test('ID が不正・無い・JSON が壊れているときは記録を書かず exit 0', (t) => {
  const sb = harnessSandbox(t);
  for (const input of [start('../escape'), start('a b'), JSON.stringify({ hook_event_name: 'SessionStart' }), '{not json', '']) {
    const r = runHook(input, { CLAUDE_PROJECT_DIR: sb.root, CLAUDE_ENV_FILE: sb.envFile });
    assert.equal(r.status, 0, `${input}: ${r.stderr}`);
  }
  assert.equal(existsSync(loadedDir(sb.commonDir)) ? readdirSync(loadedDir(sb.commonDir)).length : 0, 0, '記録を書かない');
});

test('CLAUDE_PROJECT_DIR が git の外なら記録を書かず exit 0、AGENT_HARNESS_SESSION の行は書く', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, 'env.sh');
  writeFileSync(envFile, '');
  const r = runHook(start(SESSION), { CLAUDE_PROJECT_DIR: dir, CLAUDE_ENV_FILE: envFile, GIT_CEILING_DIRECTORIES: dirname(dir) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(envFile, 'utf8'), /AGENT_HARNESS_SESSION=/);
  assert.deepEqual(readdirSync(dir).sort(), ['env.sh'], 'ほかに何も作らない');
});

test('CLAUDE_PROJECT_DIR が無いときは、cwd が git のリポジトリでも記録を書かず exit 0', (t) => {
  const sb = harnessSandbox(t);
  const r = runHook(start(SESSION), { CLAUDE_ENV_FILE: sb.envFile }, sb.root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(sb.envFile, 'utf8'), /AGENT_HARNESS_SESSION=/);
  assert.equal(existsSync(loadedDir(sb.commonDir)), false, '記録を書かない');
});

test('recordLoaded：書いたパスを返し、CLAUDE_PROJECT_DIR が無い・ID が不正・git の外なら null（例外を投げない）', (t) => {
  const sb = harnessSandbox(t);
  const now = new Date('2026-09-30T00:00:00Z');
  assert.equal(hook.recordLoaded(start(SESSION), {}, now), null);
  assert.equal(hook.recordLoaded(start('a b'), { CLAUDE_PROJECT_DIR: sb.root }, now), null);
  assert.equal(hook.recordLoaded(start(SESSION), { CLAUDE_PROJECT_DIR: join(sb.dir, 'no-such-dir') }, now), null);
  const path = hook.recordLoaded(start(SESSION), { CLAUDE_PROJECT_DIR: sb.root }, now);
  assert.equal(path, loadedRecordPath(sb.commonDir, SESSION));
  assert.equal(readLoadedRecord(path!)!.at, now.toISOString());
  assert.equal(hook.recordLoaded(start(SESSION), { CLAUDE_PROJECT_DIR: sb.root }, now), null, '既にあれば書かない');
});

test('worktree を CLAUDE_PROJECT_DIR にしても、記録は本体と同じ共通ディレクトリの下に置く（HEAD は worktree のもの）', (t) => {
  const sb = harnessSandbox(t);
  const wt = join(sb.dir, 'wt');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', 'claude/issue-199-x', wt);
  const r = runHook(start(SESSION), { CLAUDE_PROJECT_DIR: wt, CLAUDE_ENV_FILE: sb.envFile });
  assert.equal(r.status, 0, r.stderr);
  const rec = readLoadedRecord(loadedRecordPath(sb.commonDir, SESSION)!);
  assert.ok(rec, '共通ディレクトリの下に記録がある');
  assert.equal(rec.head, sb.git(wt, 'rev-parse', 'HEAD'));
});
