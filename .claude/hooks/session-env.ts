/**
 * 付き添いのセッションの SessionStart の hook。.claude/settings.json で matcher なしに登録し、startup・resume・clear・compact のすべてで動く。
 *
 * stdin の JSON の session_id を、CLAUDE_ENV_FILE に `export AGENT_HARNESS_SESSION=<id>` として書く。
 * 以降の Bash で harness/scripts/agent.ts がこの値を読み、着手宣言とコメントの目印に今のセッションの ID を入れる（Issue #157）。
 * /clear などで ID が変わると、自分の古い着手宣言はほかのセッションのものに見える（人に確かめて claim --takeover）。
 * session_id が無い・CLAUDE_ENV_FILE が無い・JSON が読めない・ID に英数字と - _ 以外が入るときは何も書かない。どの場合も exit 0。
 * ID の形の規則は harness/lib/session.ts の TRANSCRIPT_SESSION_ID だけにある（記録の選択と同じもの）。読めなければ何も書かない。
 */
import { appendFileSync } from 'node:fs';

/** ID の形（harness/lib/session.ts）。lib が欠けていても exit 0 で終わるよう、try の中で読む */
let idShape: RegExp | null = null;
try {
  ({ TRANSCRIPT_SESSION_ID: idShape } = await import('../../harness/lib/session.ts'));
} catch {
  idShape = null;
}

/** CLAUDE_ENV_FILE に書く行（書かないなら null）。シェルに渡すので、ID は英数字と - _ だけを受け付ける */
export function envLine(raw: string): string | null {
  if (!idShape) return null;
  let id: unknown;
  try {
    id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
  } catch {
    return null;
  }
  return typeof id === 'string' && idShape.test(id) ? `export AGENT_HARNESS_SESSION=${id}\n` : null;
}

/** hook の本体。直接起動したとき（import.meta.main）と、入口（run.mjs）から呼ばれたときに動く */
export async function main(): Promise<void> {
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += String(chunk);
    const file = process.env.CLAUDE_ENV_FILE;
    const line = envLine(raw);
    if (file && line) appendFileSync(file, line);
  } catch {
    // セッションの開始を止めない
  }
  process.exit(0);
}

if (import.meta.main) await main();
