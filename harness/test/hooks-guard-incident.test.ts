// Issue #187：guard.ts（run.mjs 経由）が操作を止めたとき、セッションの問題の記録（harness/lib/incident.ts）に deny を1件足し、agent.ts incident list に出るか。記録できなくても hook の出力と終了コードは変わらないか
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { incidentFile, readIncidents } from '../lib/incident.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const RUN = join(root, '.claude', 'hooks', 'run.mjs');
const GUARD = join(root, '.claude', 'hooks', 'guard.ts');
const AGENT = join(root, 'harness', 'scripts', 'agent.ts');

// 秘密に見える値。リポジトリに秘密そのものの形で書かないよう、つないで作る
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
/** 記録の置き場所にする一時ディレクトリ（まだ作らない下のディレクトリを返す） */
function tempIncidentDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'guard-incident-'));
  tmpDirs.push(d);
  return join(d, 'incidents');
}

/** 子プロセスの env：実行環境の AGENT_HARNESS_SESSION・AGENT_HARNESS_INCIDENT_DIR に頼らない */
function envWith(patch: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo' };
  delete env.AGENT_HARNESS_SESSION;
  delete env.AGENT_HARNESS_INCIDENT_DIR;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** 本番と同じく run.mjs を通して guard を動かす */
function runGuard(command: string, session: unknown, dir: string) {
  const input: Record<string, unknown> = { tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PreToolUse', cwd: root };
  if (session !== undefined) input.session_id = session;
  return spawnSync(process.execPath, [RUN, GUARD], { cwd: root, input: JSON.stringify(input), encoding: 'utf8', env: envWith({ AGENT_HARNESS_INCIDENT_DIR: dir }) });
}

function assertDenyOutput(r: ReturnType<typeof runGuard>, label: string): void {
  assert.equal(r.status, 0, `${label}: exit code（stderr: ${r.stderr}）`);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', label);
}

const FORCE_PUSH = 'git push --force origin x';

test('guard が止めたとき、deny を出して exit 0 で、記録が1件（kind=deny・source=hook）増える', () => {
  const dir = tempIncidentDir();
  const r = runGuard(FORCE_PUSH, 'test-sess-1', dir);
  assertDenyOutput(r, FORCE_PUSH);
  const items = readIncidents('test-sess-1', { AGENT_HARNESS_INCIDENT_DIR: dir });
  assert.equal(items.length, 1, `記録の件数: ${JSON.stringify(items)}`);
  assert.equal(items[0]!.kind, 'deny');
  assert.equal(items[0]!.source, 'hook');
  assert.match(items[0]!.what, /guard\.ts/);

  // もう1回止めると、もう1件増える
  assertDenyOutput(runGuard(FORCE_PUSH, 'test-sess-1', dir), `${FORCE_PUSH}（2回目）`);
  assert.equal(readIncidents('test-sess-1', { AGENT_HARNESS_INCIDENT_DIR: dir }).length, 2);
});

test('guard が session_id=X で書いた記録が、同じ記録のディレクトリで AGENT_HARNESS_SESSION=X の incident list に出る', () => {
  const dir = tempIncidentDir();
  assertDenyOutput(runGuard(FORCE_PUSH, 'test-sess-1', dir), FORCE_PUSH);
  const r = spawnSync(process.execPath, [AGENT, 'incident', 'list'], {
    cwd: root,
    encoding: 'utf8',
    env: envWith({ AGENT_HARNESS_INCIDENT_DIR: dir, AGENT_HARNESS_SESSION: 'test-sess-1' }),
  });
  assert.equal(r.status, 0, `incident list: ${r.stderr}`);
  assert.match(r.stdout, /\(deny\)|（deny）/, r.stdout);
  assert.ok(r.stdout.includes('[test-sess-1:1]'), r.stdout);
  assert.ok(r.stdout.includes('guard.ts'), r.stdout);
});

test('通す操作では記録しない', () => {
  const dir = tempIncidentDir();
  const r = runGuard('git status', 'test-sess-1', dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.deepEqual(readIncidents('test-sess-1', { AGENT_HARNESS_INCIDENT_DIR: dir }), []);
});

test('session_id が無い・形が違う・記録のディレクトリに書けないときも、標準出力は記録の無いときと同じで exit 0', () => {
  // 記録の無いとき（session_id が無い）の出力を基準にする
  const baseDir = tempIncidentDir();
  const base = runGuard(FORCE_PUSH, undefined, baseDir);
  assertDenyOutput(base, 'session_id 無し');
  assert.equal(existsSync(baseDir), false, 'session_id が無ければ記録のディレクトリを作らない');

  for (const session of ['../x', 'a/b', '', 42]) {
    const dir = tempIncidentDir();
    const r = runGuard(FORCE_PUSH, session, dir);
    assert.equal(r.status, 0, `session_id=${JSON.stringify(session)}: ${r.stderr}`);
    assert.equal(r.stdout, base.stdout, `session_id=${JSON.stringify(session)}`);
    const parent = join(dir, '..');
    const files = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(files, [], `session_id=${JSON.stringify(session)} で記録を書いた: ${files.join(', ')}`);
    assert.deepEqual(readdirSync(parent).filter((f) => f.endsWith('.jsonl')), [], `session_id=${JSON.stringify(session)} で外に書いた`);
  }

  // 記録のディレクトリが通常のファイル（書けない）
  const holder = tempIncidentDir();
  const blocked = join(holder, '..', 'not-a-dir');
  writeFileSync(blocked, 'x');
  const r = runGuard(FORCE_PUSH, 'test-sess-1', blocked);
  assert.equal(r.status, 0, `書けないディレクトリ: ${r.stderr}`);
  assert.equal(r.stdout, base.stdout, '書けないディレクトリ');
});

test('秘密に見える文字列を含むコマンドを止めたとき、記録のファイルに元の文字列が残らない', () => {
  const dir = tempIncidentDir();
  const cmd = `git push --force https://x:${GHP}@github.com/o/r x`;
  assertDenyOutput(runGuard(cmd, 'test-sess-secret', dir), 'secret を含む force push');
  const env = { AGENT_HARNESS_INCIDENT_DIR: dir };
  assert.equal(readIncidents('test-sess-secret', env).length, 1, '記録が1件');
  const text = readFileSync(incidentFile('test-sess-secret', env), 'utf8');
  assert.equal(text.includes(GHP), false, `記録に秘密が残った: ${text}`);
});
