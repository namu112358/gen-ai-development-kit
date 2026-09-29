// Issue #166：合体版の記録のコメントの目印にセッション ID を入れる（ID が無いときは今の形）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_MARK, claudeMark, claudeMarkSession, hasClaudeMark, withClaudeMark } from '../lib/blocks.ts';
import { parsePanelRecord, renderPanelRecord, type PanelRecord } from '../lib/review-panel.ts';
import { sessionFromEnv } from '../lib/session.ts';
import { HEAD } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const LOCAL = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const REMOTE = 'cse_01ABCDEFGHxyz';
const REMOTE_URL = 'https://claude.ai/code/session_01ABCDEFGHxyz';

// ---- sessionFromEnv ----

test('sessionFromEnv：Routine の変数（CLAUDE_CODE_REMOTE_SESSION_ID）ならセッションの URL', () => {
  assert.equal(sessionFromEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE }), REMOTE_URL);
  assert.equal(sessionFromEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: 'session_xyz' }), 'https://claude.ai/code/session_xyz');
});

test('sessionFromEnv：手元の変数（AGENT_HARNESS_SESSION）なら ID', () => {
  assert.equal(sessionFromEnv({ AGENT_HARNESS_SESSION: LOCAL }), LOCAL);
});

test('sessionFromEnv：両方あれば CLAUDE_CODE_REMOTE_SESSION_ID が優先', () => {
  assert.equal(sessionFromEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE, AGENT_HARNESS_SESSION: LOCAL }), REMOTE_URL);
});

test('sessionFromEnv：どちらも無い・空文字なら null', () => {
  assert.equal(sessionFromEnv({}), null);
  assert.equal(sessionFromEnv({ AGENT_HARNESS_SESSION: '', CLAUDE_CODE_REMOTE_SESSION_ID: '' }), null);
  assert.equal(sessionFromEnv({ AGENT_HARNESS_SESSION: undefined }), null);
});

// ---- agent.ts の currentSession() と同じ規則 ----

function agentEnv(vars: { remote?: string; local?: string }): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (vars.remote !== undefined) env.CLAUDE_CODE_REMOTE_SESSION_ID = vars.remote;
  if (vars.local !== undefined) env.AGENT_HARNESS_SESSION = vars.local;
  return env;
}

function runAgent(args: string[], env: NodeJS.ProcessEnv): string {
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

for (const [name, vars] of [
  ['Routine の変数だけ', { remote: REMOTE }],
  ['手元の変数だけ', { local: LOCAL }],
  ['両方', { remote: REMOTE, local: LOCAL }],
  ['どちらも無い', {}],
] as const) {
  test(`sessionFromEnv と agent.ts の currentSession() が同じ値を返す（${name}）`, () => {
    const env = agentEnv(vars);
    const expected = sessionFromEnv(env);
    // render-claim --manual の目印は claudeMark(currentSession())
    const claim = runAgent(['render-claim', '--manual'], env);
    assert.equal(claudeMarkSession(claim), expected, claim);
    // session-url は sessionUrl()（Routine の変数があるときは currentSession() と同じ）
    const url = runAgent(['session-url'], env).trim();
    if (vars.remote !== undefined) assert.equal(url, expected);
    else assert.equal(url, '(none)');
  });
}

// ---- 記録のコメントの目印 ----

function record(): PanelRecord {
  return {
    version: 1, pr: 5, headSha: HEAD, mode: 'shadow',
    review: { pass: true, blocking: [], nonBlocking: [], humanNotes: { concerns: [], checkPoints: [] } },
    findings: [],
    check: { exitCode: 0 },
    material: { pastPrs: 0, pastPrsWithoutComments: 0 },
    cost: { panel: null, reviewer: null },
  };
}

test('記録の本文に withClaudeMark(sessionFromEnv) を当てると目印に ID が入り、parsePanelRecord で読めて hasClaudeMark が true', () => {
  const body = renderPanelRecord(record());
  assert.ok(body.startsWith(`${CLAUDE_MARK}\n`), '組み立ての本文は今の目印で始まる');
  for (const [env, id] of [[{ AGENT_HARNESS_SESSION: LOCAL }, LOCAL], [{ CLAUDE_CODE_REMOTE_SESSION_ID: REMOTE }, REMOTE_URL]] as const) {
    const posted = withClaudeMark(body, sessionFromEnv(env));
    assert.ok(posted.startsWith(`${claudeMark(id)}\n## 合体版のレビューの記録`), posted);
    assert.equal(claudeMarkSession(posted), id);
    assert.ok(!posted.includes(CLAUDE_MARK), 'ID なしの目印は残らない');
    assert.ok(hasClaudeMark(posted));
    const parsed = parsePanelRecord(posted);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join('\n'));
    assert.deepEqual(parsed.value, record());
  }
});

test('ID が無ければ記録の目印は今の形のまま', () => {
  const body = renderPanelRecord(record());
  const posted = withClaudeMark(body, sessionFromEnv({}));
  assert.equal(posted, body);
  assert.equal(claudeMarkSession(posted), null);
  assert.ok(hasClaudeMark(posted));
  assert.ok(parsePanelRecord(posted).ok);
});

test('既に ID 付きの目印の記録はそのまま（別の ID で上書きしない）', () => {
  const already = withClaudeMark(renderPanelRecord(record()), 'other-session');
  assert.equal(withClaudeMark(already, sessionFromEnv({ AGENT_HARNESS_SESSION: LOCAL })), already);
  assert.equal(claudeMarkSession(already), 'other-session');
});

// ---- review-panel.ts の post（API を呼ぶため、ソースの形で確かめる） ----

test('review-panel.ts の post は sessionFromEnv と withClaudeMark で目印を付け、目印の確かめは hasClaudeMark を使う', () => {
  const src = readFileSync(join(root, 'harness/scripts/review-panel.ts'), 'utf8');
  const start = src.indexOf('async function post(');
  assert.ok(start >= 0, 'post がある');
  const end = src.indexOf('\n}\n', start);
  const post = src.slice(start, end);
  assert.match(post, /sessionFromEnv\(process\.env\)/, 'セッション ID は環境から入れる');
  assert.match(post, /withClaudeMark\(/, '記録の目印に ID を入れる');
  assert.match(post, /hasClaudeMark\(/, '目印の確かめは hasClaudeMark');
  assert.doesNotMatch(post, /includes\(CLAUDE_MARK\)/, 'ID の無い目印だけを探す確かめは使わない');
  assert.match(src, /from '\.\.\/lib\/session\.ts'/);
});
