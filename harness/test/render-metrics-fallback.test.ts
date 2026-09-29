// Issue #227：render-metrics が今のセッションの記録を見つけられず最も新しい記録に戻ったとき、メトリクスのコメントの本文にそのことを書く。
// 今のセッションの記録を選べたとき・記録が無い（unknown）ときの本文は今と同じ。usage の JSON の bySession も確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectTranscriptDir } from '../lib/usage.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const A = '7c1d2e3f-0a1b-4c2d-8e00-aaaaaaaaaaaa';
const B = '7c1d2e3f-0a1b-4c2d-8e00-bbbbbbbbbbbb';
const C = '7c1d2e3f-0a1b-4c2d-8e00-cccccccccccc';

const CURRENT_NOTE =
  'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。';
const FALLBACK_NOTE =
  'トークン数と推定料金は、今のセッションの記録が見つからないため、最も新しい記録（ほかのセッションのものかもしれない）の累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。';

const fmt = (n: number): string => n.toLocaleString('en-US');
const tokensCell = (input: number, output: number, cacheWrite: number, cacheRead: number): string =>
  [input, output, cacheWrite, cacheRead].map(fmt).join(' / ');

const line = (id: string, model: string, u: { input: number; output: number; cacheWrite?: number; cacheRead?: number }): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_creation_input_tokens: u.cacheWrite ?? 0,
        cache_read_input_tokens: u.cacheRead ?? 0,
      },
    },
  });

// A（古い、サブエージェント付き）：入力 1,000+20 = 1,020、出力 5+1 = 6、キャッシュ読込 3,000
// B（新しい）：入力 2,000、出力 7、キャッシュ読込 4,000
const A_TOKENS = tokensCell(1020, 6, 0, 3000);
const B_TOKENS = tokensCell(2000, 7, 0, 4000);

/** dir に A・B の記録を置き、B のほうを新しくする */
function writeTranscripts(dir: string): { a: string; b: string } {
  mkdirSync(dir, { recursive: true });
  const a = join(dir, `${A}.jsonl`);
  const b = join(dir, `${B}.jsonl`);
  writeFileSync(a, `${line('a1', 'claude-opus-5-5', { input: 1000, output: 5, cacheRead: 3000 })}\n`);
  writeFileSync(b, `${line('b1', 'claude-opus-5-5', { input: 2000, output: 7, cacheRead: 4000 })}\n`);
  mkdirSync(join(dir, A, 'subagents'), { recursive: true });
  writeFileSync(join(dir, A, 'subagents', 'agent-1.jsonl'), `${line('a2', 'claude-haiku-4-5', { input: 20, output: 1 })}\n`);
  const old = new Date(Date.now() - 3_600_000);
  const recent = new Date();
  utimesSync(a, old, old);
  utimesSync(b, recent, recent);
  return { a, b };
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'render-metrics-fallback-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** HOME・USERPROFILE を一時ディレクトリにし、セッションの変数は親から引き継がずに agent.ts を動かす */
function runAgent(home: string, session: string | null, args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AGENT_HARNESS_SESSION;
  delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (session !== null) env.AGENT_HARNESS_SESSION = session;
  const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const renderMetrics = (home: string, session: string | null): string => runAgent(home, session, ['render-metrics', 'implement', 'm', '1']);

/** 本文の最後の説明の行 */
const lastLine = (body: string): string => body.trimEnd().split('\n').at(-1) ?? '';

/** 表のデータ行のトークン列 */
function tokensOf(body: string): string {
  const row = body.split('\n').find((l) => l.startsWith('| ') && l.includes('| implement |'));
  assert.ok(row, `表のデータ行が無い:\n${body}`);
  return row.split('|').map((c) => c.trim())[5] ?? '';
}

// ---- render-metrics：最も新しい記録に戻ったとき ----

test('render-metrics：AGENT_HARNESS_SESSION が無いときは最も新しい記録（B）を集計し、本文に戻った旨を書く', () => {
  withTemp((home) => {
    writeTranscripts(projectTranscriptDir(root, home));
    const body = renderMetrics(home, null);
    assert.equal(tokensOf(body), B_TOKENS);
    assert.equal(lastLine(body), FALLBACK_NOTE);
    assert.ok(body.includes('最も新しい記録'), body);
    assert.ok(body.includes('ほかのセッションのものかもしれない'), body);
    assert.ok(!body.includes('このセッションのここまでの累計'), body);
  });
});

test('render-metrics：AGENT_HARNESS_SESSION の記録が無いときは最も新しい記録（B）を集計し、本文に戻った旨を書く', () => {
  withTemp((home) => {
    writeTranscripts(projectTranscriptDir(root, home));
    const body = renderMetrics(home, C);
    assert.equal(tokensOf(body), B_TOKENS);
    assert.equal(lastLine(body), FALLBACK_NOTE);
    assert.ok(!body.includes('このセッションのここまでの累計'), body);
  });
});

// ---- render-metrics：今と同じ本文 ----

test('render-metrics：AGENT_HARNESS_SESSION の記録を選べたときは、その記録（A）を集計し、説明の行は今の固定の文のまま', () => {
  withTemp((home) => {
    writeTranscripts(projectTranscriptDir(root, home));
    const body = renderMetrics(home, A);
    assert.equal(tokensOf(body), A_TOKENS);
    assert.equal(lastLine(body), CURRENT_NOTE);
    assert.ok(!body.includes('最も新しい記録'), body);
    assert.ok(!body.includes('ほかのセッションのものかもしれない'), body);
  });
});

test('render-metrics：記録が1つも無い（unknown）ときは、説明の行は今の固定の文のまま', () => {
  withTemp((home) => {
    for (const session of [null, A]) {
      const body = renderMetrics(home, session);
      assert.equal(tokensOf(body), 'unknown');
      assert.equal(lastLine(body), CURRENT_NOTE);
      assert.ok(!body.includes('最も新しい記録'), body);
    }
  });
});

test('render-metrics：記録が無く tokens を渡したときは、その値を使い、説明の行は今の固定の文のまま', () => {
  withTemp((home) => {
    const body = runAgent(home, null, ['render-metrics', 'implement', 'm', '1', '12345']);
    assert.equal(tokensOf(body), '12345');
    assert.equal(lastLine(body), CURRENT_NOTE);
  });
});

// ---- usage の JSON の bySession ----

interface UsageOut { files?: string[]; bySession?: unknown }
const runUsage = (home: string, session: string | null, args: string[] = []): UsageOut =>
  JSON.parse(runAgent(home, session, ['usage', ...args])) as UsageOut;

test('usage：AGENT_HARNESS_SESSION の記録を選べたときは bySession: true', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    const out = runUsage(home, A);
    assert.equal(out.files?.[0], t.a);
    assert.equal(out.bySession, true);
  });
});

test('usage：最も新しい記録に戻ったときは bySession: false', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    for (const session of [null, C]) {
      const out = runUsage(home, session);
      assert.equal(out.files?.[0], t.b);
      assert.equal(out.bySession, false);
    }
  });
});

test('usage：パスを渡したときは bySession: true', () => {
  withTemp((home) => {
    const t = writeTranscripts(projectTranscriptDir(root, home));
    for (const session of [null, C]) {
      const out = runUsage(home, session, [t.a]);
      assert.equal(out.files?.[0], t.a);
      assert.equal(out.bySession, true);
    }
  });
});
