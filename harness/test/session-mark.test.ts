// Issue #157：Claude の印にセッション ID を入れる（ID 付き・ID なしの両方の印が読める／ID が得られないとき今の形の印になる）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLAUDE_MARK, claudeMark, claudeMarkSession, extractBlock, hasClaudeMark, renderBlock, shortSession, withClaudeMark } from '../lib/blocks.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const ESCAPED = '&lt;!-- agent-harness:claude --&gt;';
const escapedWith = (id: string): string => `&lt;!-- agent-harness:claude session=${id} --&gt;`;

// ---- blocks.ts ----

test('claudeMark：null なら今の印、ID があれば session=<id> 付きの印', () => {
  assert.equal(CLAUDE_MARK, '<!-- agent-harness:claude -->');
  assert.equal(claudeMark(), CLAUDE_MARK);
  assert.equal(claudeMark(null), CLAUDE_MARK);
  assert.equal(claudeMark(SESSION), `<!-- agent-harness:claude session=${SESSION} -->`);
});

test('hasClaudeMark：ID なし・ID 付き・HTML エンティティの形のどれでも印とみなす', () => {
  assert.ok(hasClaudeMark(`${CLAUDE_MARK}\n本文`));
  assert.ok(hasClaudeMark(`${claudeMark(SESSION)}\n本文`));
  assert.ok(hasClaudeMark(`${ESCAPED}\n本文`));
  assert.ok(hasClaudeMark(`${escapedWith('x')}\n本文`));
  assert.ok(!hasClaudeMark('人のコメント'));
  assert.ok(!hasClaudeMark(null));
  assert.ok(!hasClaudeMark(undefined));
});

test('claudeMarkSession：印から ID を取り出す。ID なしの印や印なしは null', () => {
  assert.equal(claudeMarkSession(`${claudeMark(SESSION)}\n本文`), SESSION);
  assert.equal(claudeMarkSession(`${escapedWith('abc_1-2')}\n本文`), 'abc_1-2');
  assert.equal(claudeMarkSession(`${CLAUDE_MARK}\n本文`), null);
  assert.equal(claudeMarkSession(`${ESCAPED}\n本文`), null);
  assert.equal(claudeMarkSession('人のコメント'), null);
});

test('withClaudeMark：ID なしの印を ID 付きに置き換え、ID 付きはそのまま、印が無ければ先頭に足す', () => {
  assert.equal(withClaudeMark(`${CLAUDE_MARK}\n本文`, SESSION), `${claudeMark(SESSION)}\n本文`);
  assert.equal(withClaudeMark(`${ESCAPED}\n本文`, SESSION), `${claudeMark(SESSION)}\n本文`, 'エンティティの形も置き換える');
  assert.equal(withClaudeMark(`${claudeMark('other')}\n本文`, SESSION), `${claudeMark('other')}\n本文`, 'ID 付きの印はそのまま');
  assert.equal(withClaudeMark('本文', SESSION), `${claudeMark(SESSION)}\n本文`);
  assert.equal(withClaudeMark(`${CLAUDE_MARK}\na\n${CLAUDE_MARK}\n`, SESSION), `${claudeMark(SESSION)}\na\n${CLAUDE_MARK}\n`, '最初の印だけ置き換える');
});

test('withClaudeMark：session が null なら今の形（ID なしの印）', () => {
  assert.equal(withClaudeMark('本文', null), `${CLAUDE_MARK}\n本文`);
  assert.equal(withClaudeMark(`${CLAUDE_MARK}\n本文`, null), `${CLAUDE_MARK}\n本文`);
});

test('shortSession：URL は最後の / の後から session_ / cse_ を除いた先頭8文字、UUID は先頭8文字', () => {
  assert.equal(shortSession('https://claude.ai/code/session_01ABCDEFGHxyz'), '01ABCDEF');
  assert.equal(shortSession('https://claude.ai/code/cse_01ABCDEFGHxyz'), '01ABCDEF');
  assert.equal(shortSession(SESSION), '3f2a9c1e');
});

// ---- composeVerdict ----

const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
const risk = { level: 'low', answers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input: ComposeInput = {
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' },
};

test('composeVerdict：session を渡すと ID 付きの印、渡さなければ今の印', () => {
  const withId = composeVerdict(input, SESSION);
  assert.ok(withId.ok);
  assert.ok(withId.value.startsWith(`${claudeMark(SESSION)}\n## 判定`));
  const plain = composeVerdict(input);
  assert.ok(plain.ok);
  assert.ok(plain.value.startsWith(`${CLAUDE_MARK}\n## 判定`));
  assert.deepEqual(composeVerdict(input, null), plain, 'null は渡さないのと同じ');
});

test('AGENT_HARNESS_SESSION がある状態でも、session を渡さない composeVerdict の結果は今の形のまま', () => {
  const saved = process.env.AGENT_HARNESS_SESSION;
  process.env.AGENT_HARNESS_SESSION = SESSION;
  try {
    const r = composeVerdict(input);
    assert.ok(r.ok);
    assert.ok(r.value.startsWith(`${CLAUDE_MARK}\n## 判定`));
    assert.equal(claudeMarkSession(r.value), null);
  } finally {
    if (saved === undefined) delete process.env.AGENT_HARNESS_SESSION;
    else process.env.AGENT_HARNESS_SESSION = saved;
  }
});

// ---- agent.ts render-plan / render-verdict ----

/** 実行する環境で結果が変わらないように、関係する変数を消してから必要なものだけ入れる */
function agentEnv(session: string | null): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (session !== null) env.AGENT_HARNESS_SESSION = session;
  return env;
}

function runAgent(args: string[], session: string | null) {
  return spawnSync(process.execPath, ['harness/scripts/agent.ts', ...args], { cwd: root, encoding: 'utf8', env: agentEnv(session) });
}

function withTempFile<T>(content: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'session-mark-'));
  try {
    const file = join(dir, 'body.md');
    writeFileSync(file, content);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };

function renderPlanBody(content: string, session: string | null): string {
  return withTempFile(content, (file) => {
    const r = runAgent(['render-plan', '3', file], session);
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout) as { body: string }).body;
  });
}

test('render-plan：AGENT_HARNESS_SESSION があれば本文の印が ID 付きになる（ID なしの印で始まるファイルでも）', () => {
  const bare = `## 計画\n\n${renderBlock('agent-plan', plan)}\n`;
  const noMark = renderPlanBody(bare, SESSION);
  assert.ok(noMark.startsWith(`${claudeMark(SESSION)}\n`), noMark);
  const oldMark = renderPlanBody(`${CLAUDE_MARK}\n${bare}`, SESSION);
  assert.ok(oldMark.startsWith(`${claudeMark(SESSION)}\n`), oldMark);
  assert.ok(!oldMark.includes(CLAUDE_MARK), 'ID なしの印は残らない');
  const b = extractBlock(oldMark, 'agent-plan');
  assert.ok(b.found && b.ok);
});

test('render-plan：AGENT_HARNESS_SESSION が無ければ今の印', () => {
  const body = renderPlanBody(`## 計画\n\n${renderBlock('agent-plan', plan)}\n`, null);
  assert.ok(body.startsWith(`${CLAUDE_MARK}\n`), body);
  assert.equal(claudeMarkSession(body), null);
});

test('render-verdict：AGENT_HARNESS_SESSION があれば ID なしの印で始まる判定ファイルの印が ID 付きになる', () => {
  const composed = composeVerdict(input);
  assert.ok(composed.ok);
  assert.ok(composed.value.startsWith(CLAUDE_MARK));
  withTempFile(composed.value, (file) => {
    const withId = runAgent(['render-verdict', '5', HEAD, file], SESSION);
    assert.equal(withId.status, 0, withId.stderr);
    assert.ok(withId.stdout.startsWith(`${claudeMark(SESSION)}\n## 判定`), withId.stdout);
    assert.equal(claudeMarkSession(withId.stdout), SESSION);

    const plain = runAgent(['render-verdict', '5', HEAD, file], null);
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.startsWith(`${CLAUDE_MARK}\n## 判定`), plain.stdout);
  });
});
