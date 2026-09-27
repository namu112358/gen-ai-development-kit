/**
 * 付き添いのセッションの SessionStart hook（.claude/settings.json で matcher なしに登録。startup・resume・clear・compact のすべてで動く）。
 *
 * stdin の JSON の session_id を、CLAUDE_ENV_FILE に `export AGENT_HARNESS_SESSION=<id>` として書く。
 * 以降の Bash で harness/scripts/agent.ts がこの値を読み、着手宣言とコメントの目印に今のセッションの ID を入れる（Issue #157）。
 * /clear などで ID が変わると、自分の古い着手宣言はほかのセッションのものに見える（人に確かめて claim --takeover）。
 * session_id が無い・CLAUDE_ENV_FILE が無い・JSON が読めない・ID に英数字と - _ 以外が入るときは何も書かない。どの場合も exit 0。
 */
import { appendFileSync } from 'node:fs';

/** CLAUDE_ENV_FILE に書く行（書かないなら null）。シェルに渡すので、ID は英数字と - _ だけを受け付ける */
export function envLine(raw: string): string | null {
  let id: unknown;
  try {
    id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
  } catch {
    return null;
  }
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id) ? `export AGENT_HARNESS_SESSION=${id}\n` : null;
}

if (import.meta.main) {
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
