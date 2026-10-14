// Issue #1025：loop の状態をまとめの Issue の本文の1本で読み書きする経路（harness/lib/patrol-issue.ts と commands/patrol-issue.ts の patrol-push、3本のスクリプトの --dir）を確かめる。
// (1) readPatrolIssueState：題の一致する Issue が無ければ issue・state が null で POST しない（Issue を作らない）。本文の状態を読める。version が 1 より新しければ ok: false。
// (2) readDirPart・writeDirPart：<dir> のファイルが無ければ null、書いて読むと同じ、壊れたファイルは ok: false。ファイル名は patrol-pull と同じ。
// (3) patrolBodyChanged・patrolIssueTitleChecked：本文の変化で止める側を返す。題がダッシュボードと同じなら誤り。
// (4) patrol-push を偽の GitHub（FakeGitHub）の上で run から流す：pull の後に本文が変わっていれば終了コード 2 で GET 以外の要求は0件、変わっていなければ PATCH の1件だけ。
// (5) --dir なしの書くサブコマンドは、トークンも gh・git も無い環境で、終了コード 1 と「--dir が要ります」で止まり、作業ディレクトリの git の共通ディレクトリに書かない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { parsePatrolState, type PatrolState } from '../lib/patrol.ts';
import {
  PATROL_DIR_FILES, patrolBodyChanged, patrolIssueTitleChecked, readDirPart, readPatrolIssueState, renderPatrolIssueBody, writeDirPart,
  type PatrolIssueState,
} from '../lib/patrol-issue.ts';
import { parseLoopState, type LoopState } from '../lib/qa-retro-loop.ts';
import { patrolIssueTitle } from '../lib/state.ts';
import { parseTestPruneLoopState, type TestPruneLoopState } from '../lib/test-prune-loop.ts';
import type { AgentCommand } from '../scripts/agent/cli.ts';
import { FakeGitHub } from './support/gate-fixtures.ts';
import { sandbox } from './support/git-sandbox.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const config = loadConfig();
const TITLE = patrolIssueTitle(config);
const AT = '2026-10-01T00:00:00.000Z';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** parsePatrolState・parseLoopState・parseTestPruneLoopState が通る最小の形 */
const patrol: PatrolState = { version: 1, reviews: {}, observe: null, rounds: [{ at: AT, ran: ['qa-retro'], suggested: [] }] };
const qaRetro: LoopState = { version: 1, until: AT, rounds: [{ since: AT, until: AT, advancedAt: AT, prs: 0, drafts: [{ title: 'test: 下書き', body: '本文', created: null }] }] };
const testPrune: TestPruneLoopState = { version: 1, rounds: [{ at: AT, generatedAt: AT, headSha: null, candidates: 0, drafts: [], duplicates: [] }] };

const tempDir = (t: TestContext, prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** 書き込み（GET 以外）の呼び出し */
const writesOf = (fake: FakeGitHub) => fake.calls.filter((c) => c.method !== 'GET');

// --- (1) readPatrolIssueState ---

/** 開いた Issue の一覧だけに答える偽の GitHub */
const issuesWorld = (rows: { number: number; title: string; body: string }[]): FakeGitHub =>
  new FakeGitHub().on('GET', /^\/repos\/o\/r\/issues\?/, () => rows);

test('readPatrolIssueState：Issue が無い・初回の本文なら state は null、状態のある本文は読め、どの場合も GET 以外の要求を出さない（Issue を作らない）', async () => {
  const state: PatrolIssueState = { version: 1, patrol, qaRetro, testPrune };
  const cases: { name: string; rows: { number: number; title: string; body: string }[]; issue: number | null; state: PatrolIssueState | null }[] = [
    { name: '題の一致する Issue が無い', rows: [{ number: 3, title: 'ほかの Issue', body: renderPatrolIssueBody(state) }], issue: null, state: null },
    { name: '本文に patrol-state が無い（初回）', rows: [{ number: 7, title: TITLE, body: 'まとめ' }], issue: 7, state: null },
    { name: '本文に状態がある', rows: [{ number: 3, title: 'ほかの Issue', body: '' }, { number: 7, title: TITLE, body: renderPatrolIssueBody(state) }], issue: 7, state },
  ];
  for (const c of cases) {
    const fake = issuesWorld(c.rows);
    const r = await readPatrolIssueState(new GitHub(fake, 'o/r'), TITLE);
    assert.ok(r.ok, `${c.name}: ${JSON.stringify(r)}`);
    assert.equal(r.issue, c.issue, c.name);
    assert.deepEqual(r.state, c.state, c.name);
    assert.deepEqual(writesOf(fake), [], `${c.name}: 書き込みがある`);
  }
});

test('readPatrolIssueState：本文の patrol-state の version が 1 より新しければ ok: false（誤りに version）で、GET 以外の要求を出さない', async () => {
  const body = ['説明', '', '```patrol-state', JSON.stringify({ version: 2, patrol: null, qaRetro: null, testPrune: null }), '```'].join('\n');
  const fake = issuesWorld([{ number: 7, title: TITLE, body }]);
  const r = await readPatrolIssueState(new GitHub(fake, 'o/r'), TITLE);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => /version が 2/.test(e)), JSON.stringify(r));
  assert.deepEqual(writesOf(fake), []);
});

// --- (2) readDirPart・writeDirPart ---

test('PATROL_DIR_FILES：<dir> の中のファイル名は patrol-pull と同じ', () => {
  assert.deepEqual(PATROL_DIR_FILES, { patrol: 'patrol.json', qaRetro: 'qa-retro-loop.json', testPrune: 'test-prune-loop.json' });
});

test('readDirPart・writeDirPart：ファイルが無ければ null、書いて読むと同じ状態、壊れたファイル・形の違うファイルは ok: false', (t) => {
  const cases = [
    { key: 'patrol', state: patrol, parse: parsePatrolState },
    { key: 'qaRetro', state: qaRetro, parse: parseLoopState },
    { key: 'testPrune', state: testPrune, parse: parseTestPruneLoopState },
  ] as const;
  for (const c of cases) {
    const dir = tempDir(t, 'patrol-dir-');
    const parse = c.parse as (text: string | null) => { ok: true; state: unknown } | { ok: false; errors: string[] };
    assert.deepEqual(readDirPart(dir, c.key, parse), { ok: true, state: null }, `${c.key}: 無いファイル`);

    writeDirPart(dir, c.key, c.state);
    assert.ok(existsSync(join(dir, PATROL_DIR_FILES[c.key])), `${c.key}: ${PATROL_DIR_FILES[c.key]} に書いていない`);
    assert.deepEqual(readDirPart(dir, c.key, parse), { ok: true, state: c.state }, `${c.key}: 書いて読む`);

    for (const broken of ['{壊れ', JSON.stringify({ version: 99 })]) {
      writeFileSync(join(dir, PATROL_DIR_FILES[c.key]), broken);
      const r = readDirPart(dir, c.key, parse);
      assert.equal(r.ok, false, `${c.key}: ${broken}`);
      assert.ok(!r.ok && r.errors.length > 0, `${c.key}: ${broken}`);
    }
  }
});

// --- (3) patrolBodyChanged・patrolIssueTitleChecked ---

test('patrolBodyChanged：pull したときの sha256 と今の本文が違えば true、同じなら false', () => {
  const pulled = 'pull したときの本文';
  for (const [current, expected] of [[pulled, false], ['ほかのセッションが書いた本文', true], ['', true]] as const) {
    assert.equal(patrolBodyChanged(current, sha256(pulled)), expected, current);
  }
});

test('patrolIssueTitleChecked：題がダッシュボード Issue の題と同じなら ok: false、違えば patrolIssueTitle の題', () => {
  assert.deepEqual(patrolIssueTitleChecked(config), { ok: true, title: TITLE });
  const r = patrolIssueTitleChecked({ ...config, patrolIssueTitle: config.dashboardIssueTitle });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.length > 0);
});

// --- (4) patrol-push のコマンドの経路 ---

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadPush = async (): Promise<AgentCommand> => {
  const mod = await import('../scripts/agent/commands/patrol-issue.ts');
  const cmd = (mod.commands as AgentCommand[]).find((c) => c.name === 'patrol-push');
  assert.ok(cmd, 'patrol-push のコマンドが無い');
  return cmd;
};

const ISSUE = 42;

/** GET /issues/<ISSUE> に currentBody を返し、PATCH を受ける偽の GitHub */
const pushWorld = (currentBody: string): FakeGitHub =>
  new FakeGitHub()
    .on('GET', new RegExp(`^/repos/o/r/issues/${ISSUE}$`), () => ({ number: ISSUE, title: TITLE, body: currentBody }))
    .on('PATCH', new RegExp(`^/repos/o/r/issues/${ISSUE}$`), (_m, body) => ({ number: ISSUE, body: body.body }))
    .on('POST', /\/comments$/, () => ({ id: 1, html_url: 'u' }));

/** run を動かす。process.exit は投げる例外にし、終了コードと標準エラーを返す */
async function runPush(t: TestContext, fake: FakeGitHub, args: string[]): Promise<{ exit: number | null; logs: string[]; errors: string[] }> {
  const cmd = await loadPush();
  const logs: string[] = [];
  const errors: string[] = [];
  let exit: number | null = null;
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  t.mock.method(process, 'exit', (code?: number) => {
    exit = code ?? 0;
    throw new Error(`process.exit(${code})`);
  });
  try {
    await cmd.run(args, { counter: null, gh: () => new GitHub(fake, 'o/r') });
  } catch (e) {
    if (exit === null) throw e;
  } finally {
    t.mock.restoreAll();
  }
  return { exit, logs, errors };
}

const writePulled = (dir: string, body: string): void => {
  writeFileSync(join(dir, 'pulled.json'), JSON.stringify({ issue: ISSUE, bodySha256: sha256(body), rounds: { qaRetro: 0, testPrune: 0 } }));
};

test('patrol-push：pull の後にまとめの Issue の本文が変わっていれば、終了コード 2（agent.ts の fail）で止まり、GET 以外の要求（PATCH・コメント）を1件も出さない', async (t) => {
  const dir = tempDir(t, 'patrol-push-');
  writePulled(dir, 'pull したときの本文');
  writeDirPart(dir, 'patrol', patrol);
  writeDirPart(dir, 'qaRetro', qaRetro);
  writeDirPart(dir, 'testPrune', testPrune);
  const fake = pushWorld('ほかのセッションが書いた本文');
  const r = await runPush(t, fake, ['--dir', dir]);
  assert.equal(r.exit, 2, r.errors.join('\n'));
  assert.ok(r.errors.join('\n').includes('pull の後にまとめの Issue の本文が変わりました'), r.errors.join('\n'));
  assert.deepEqual(writesOf(fake), []);
});

test('patrol-push：本文が pull のときのままなら、GET 以外の要求は PATCH /repos/o/r/issues/<番号> の1件だけ（増えた回・下書き・要約が無ければコメントを出さない）', async (t) => {
  const dir = tempDir(t, 'patrol-push-');
  const body = 'patrol-state の無い本文';
  writePulled(dir, body);
  const fake = pushWorld(body);
  const r = await runPush(t, fake, ['--dir', dir]);
  assert.equal(r.exit, null, r.errors.join('\n'));
  const writes = writesOf(fake);
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [`PATCH /repos/o/r/issues/${ISSUE}`]);
  assert.equal(writes[0]!.body.body, renderPatrolIssueBody({ version: 1, patrol: null, qaRetro: null, testPrune: null }));
  assert.deepEqual(JSON.parse(r.logs.at(-1)!), { issue: ISSUE, comment: null });
});

// --- (5) --dir なしの書くサブコマンド ---

/** ディレクトリの下の全ての項目（相対パスと更新時刻） */
function snapshot(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((rel) => `${rel.replace(/\\/g, '/')} ${statSync(join(dir, rel)).mtimeMs}`)
    .sort();
}

test('--dir なしの書くサブコマンドは、トークンも gh・git も無い環境で、終了コード 1 と「--dir が要ります」で止まり、git の共通ディレクトリに書かない', (t) => {
  const sb = sandbox();
  t.after(sb.cleanup);
  const work = tempDir(t, 'patrol-nodir-');
  const emptyPath = join(work, 'empty-path');
  mkdirSync(emptyPath);
  const json = join(work, 'input.json');
  writeFileSync(json, '{}\n');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: emptyPath };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_REMOTE']) delete env[key];

  const commonDir = join(sb.root, '.git');
  const cases: { script: string; args: string[] }[] = [
    { script: 'qa-retro-loop.ts', args: ['advance', json] },
    { script: 'qa-retro-loop.ts', args: ['adopt', '1', '1', '1'] },
    { script: 'test-prune-loop.ts', args: ['record', json] },
    { script: 'test-prune-loop.ts', args: ['adopt', '1', '1', '1'] },
    { script: 'patrol.ts', args: ['record', json, '--ran', 'qa-retro'] },
  ];
  for (const c of cases) {
    const name = `${c.script} ${c.args[0]}`;
    const before = snapshot(commonDir);
    const r = spawnSync(process.execPath, [join(ROOT, 'harness', 'scripts', c.script), ...c.args], { cwd: sb.root, encoding: 'utf8', env });
    assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes('--dir が要ります'), `${name}: ${r.stderr}`);
    assert.deepEqual(snapshot(commonDir), before, `${name}: git の共通ディレクトリが変わった`);
  }
});
