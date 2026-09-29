// Issue #222：usage が今のセッションの ID（AGENT_HARNESS_SESSION）で記録を選び、ほかのセッションの記録を集計しない。
// ID が分からない・ID の記録が無いときは今どおり最も新しい記録を選び、そのことを出力の note で分かるようにする。パスを渡したときは今どおり。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { transcriptSessionId } from '../lib/session.ts';
import { findSessionTranscripts, findSessionTranscriptsWithNote, pickMainTranscript, projectTranscriptDir } from '../lib/usage.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const A = '3f2a9c1e-0b1d-4c2e-9f00-aaaaaaaaaaaa';
const B = '3f2a9c1e-0b1d-4c2e-9f00-bbbbbbbbbbbb';
const C = '3f2a9c1e-0b1d-4c2e-9f00-cccccccccccc';
const FALLBACK = '最も新しい記録';

const line = (id: string, model: string, input: number): string =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: 1 } } });

/** dir に A・B の記録（A はサブエージェント付き）を置き、B のほうを新しくする */
function writeTranscripts(dir: string): { a: string; aSub: string[]; b: string; bSub: string } {
  mkdirSync(dir, { recursive: true });
  const a = join(dir, `${A}.jsonl`);
  const b = join(dir, `${B}.jsonl`);
  writeFileSync(a, `${line('a1', 'claude-opus-5-5', 100)}\n`);
  writeFileSync(b, `${line('b1', 'claude-opus-5-5', 200)}\n`);
  mkdirSync(join(dir, A, 'subagents'), { recursive: true });
  const aSub = [join(dir, A, 'subagents', 'agent-2.jsonl'), join(dir, A, 'subagents', 'agent-1.jsonl')];
  writeFileSync(aSub[0]!, `${line('a2', 'claude-haiku-4-5', 10)}\n`);
  writeFileSync(aSub[1]!, `${line('a3', 'claude-haiku-4-5', 20)}\n`);
  writeFileSync(join(dir, A, 'subagents', 'agent-1.meta.json'), '{}');
  mkdirSync(join(dir, B, 'subagents'), { recursive: true });
  const bSub = join(dir, B, 'subagents', 'agent-9.jsonl');
  writeFileSync(bSub, `${line('b2', 'claude-haiku-4-5', 30)}\n`);
  const old = new Date(Date.now() - 3_600_000);
  const recent = new Date();
  utimesSync(a, old, old);
  utimesSync(b, recent, recent);
  return { a, aSub: [...aSub].sort(), b, bSub };
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'usage-session-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- session.ts ----

test('transcriptSessionId：AGENT_HARNESS_SESSION が英数字・_・- だけなら返し、それ以外は null（Routine は対象外）', () => {
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: A }), A);
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: 'abc_1-2' }), 'abc_1-2');
  assert.equal(transcriptSessionId({}), null);
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: '' }), null);
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: '../x' }), null);
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: 'a/b' }), null);
  assert.equal(transcriptSessionId({ AGENT_HARNESS_SESSION: 'a.jsonl' }), null);
  assert.equal(transcriptSessionId({ CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01ABC' }), null);
});

// ---- usage.ts ----

test('projectTranscriptDir：<home>/.claude/projects/<cwd の英数字以外を - にしたもの>', () => {
  assert.equal(projectTranscriptDir('/mnt/c/a_b.c', '/home/u'), join('/home/u', '.claude', 'projects', '-mnt-c-a-b-c'));
});

test('pickMainTranscript：ID の記録があれば、更新時刻が古くてもそれを選ぶ（bySession: true）', () => {
  withTemp((dir) => {
    const t = writeTranscripts(dir);
    assert.deepEqual(pickMainTranscript(dir, A), { file: t.a, bySession: true });
    assert.deepEqual(pickMainTranscript(dir, B), { file: t.b, bySession: true });
  });
});

test('pickMainTranscript：ID が無い・形が違う・ID の記録が無いときは最も新しい記録（bySession: false）', () => {
  withTemp((dir) => {
    const t = writeTranscripts(dir);
    assert.deepEqual(pickMainTranscript(dir, null), { file: t.b, bySession: false });
    assert.deepEqual(pickMainTranscript(dir, undefined), { file: t.b, bySession: false });
    assert.deepEqual(pickMainTranscript(dir, `../${A}`), { file: t.b, bySession: false });
    assert.deepEqual(pickMainTranscript(dir, C), { file: t.b, bySession: false });
  });
});

test('pickMainTranscript：記録が1つも無ければ file: null', () => {
  withTemp((dir) => {
    assert.deepEqual(pickMainTranscript(dir, A), { file: null, bySession: false });
    assert.deepEqual(pickMainTranscript(join(dir, 'missing'), null), { file: null, bySession: false });
  });
});

test('findSessionTranscriptsWithNote：ID が分かれば、その記録とサブエージェント（ソート済み）を選ぶ', () => {
  withTemp((home) => {
    const cwd = '/work/repo';
    const t = writeTranscripts(projectTranscriptDir(cwd, home));
    assert.deepEqual(findSessionTranscriptsWithNote(cwd, undefined, A, home), { files: [t.a, ...t.aSub], bySession: true });
    assert.deepEqual(findSessionTranscripts(cwd, undefined, A, home), [t.a, ...t.aSub]);
  });
});

test('findSessionTranscriptsWithNote：ID が無い・ID の記録が無いときは最も新しい記録（bySession: false）', () => {
  withTemp((home) => {
    const cwd = '/work/repo';
    const t = writeTranscripts(projectTranscriptDir(cwd, home));
    assert.deepEqual(findSessionTranscriptsWithNote(cwd, undefined, null, home), { files: [t.b, t.bSub], bySession: false });
    assert.deepEqual(findSessionTranscriptsWithNote(cwd, undefined, C, home), { files: [t.b, t.bSub], bySession: false });
    assert.deepEqual(findSessionTranscriptsWithNote(cwd, undefined, '../x', home), { files: [t.b, t.bSub], bySession: false });
    assert.deepEqual(findSessionTranscripts(cwd, undefined, undefined, home), [t.b, t.bSub], 'sessionId を渡さなければ今どおり最新');
  });
});

test('findSessionTranscriptsWithNote：パスを渡したときは sessionId を無視して今どおり', () => {
  withTemp((home) => {
    const cwd = '/work/repo';
    const t = writeTranscripts(projectTranscriptDir(cwd, home));
    assert.deepEqual(findSessionTranscriptsWithNote(cwd, t.a, B, home), { files: [t.a, ...t.aSub], bySession: true });
    assert.deepEqual(findSessionTranscripts(cwd, t.b, A, home), [t.b, t.bSub]);
    assert.deepEqual(findSessionTranscripts(cwd, join(home, 'missing.jsonl'), A, home), []);
  });
});

// ---- review-panel.ts ----

test('review-panel：subagentEntries が今のセッションの ID を findSessionTranscripts に渡す', () => {
  const src = readFileSync(join(root, 'harness', 'scripts', 'review-panel.ts'), 'utf8');
  assert.ok(src.includes('findSessionTranscripts(process.cwd(), session, transcriptSessionId(process.env))'), 'subagentEntries の呼び出し');
});

// ---- agent.ts usage（子プロセス） ----

interface UsageOut { files?: string[]; note?: string; total?: { input: number }; error?: string }

/** HOME・USERPROFILE を一時ディレクトリにし、セッションの変数は親から引き継がない */
function runUsage(home: string, session: string | null, args: string[] = []): UsageOut {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (session !== null) env.AGENT_HARNESS_SESSION = session;
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'usage', ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as UsageOut;
}

test('agent.ts usage：AGENT_HARNESS_SESSION の記録があれば、新しいほかの記録でなくそれを集計し、note に戻った旨は無い', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    const out = runUsage(home, A);
    assert.deepEqual(out.files, [t.a, ...t.aSub]);
    assert.equal(out.total?.input, 130);
    assert.ok(!(out.note ?? '').includes(FALLBACK), out.note);
  });
});

test('agent.ts usage：AGENT_HARNESS_SESSION が無いときは最も新しい記録を集計し、note に戻った旨がある', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    const out = runUsage(home, null);
    assert.deepEqual(out.files, [t.b, t.bSub]);
    assert.equal(out.total?.input, 230);
    assert.ok((out.note ?? '').includes(FALLBACK), out.note);
    assert.ok((out.note ?? '').includes('API で動かした場合の推定料金'), '既存の note 文に続ける');
  });
});

test('agent.ts usage：AGENT_HARNESS_SESSION の記録が無いときは最も新しい記録を集計し、note に戻った旨がある', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    const out = runUsage(home, C);
    assert.deepEqual(out.files, [t.b, t.bSub]);
    assert.ok((out.note ?? '').includes(FALLBACK), out.note);
  });
});

test('agent.ts usage：パスを渡したときはそれを集計し、note に戻った旨は無い', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    for (const session of [null, B]) {
      const out = runUsage(home, session, [t.a]);
      assert.deepEqual(out.files, [t.a, ...t.aSub]);
      assert.ok(!(out.note ?? '').includes(FALLBACK), out.note);
    }
  });
});
