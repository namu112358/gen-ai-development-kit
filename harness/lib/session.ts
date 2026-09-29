/**
 * 今のセッションの ID を環境の値から決める（lib は process.env を直接読まず、呼び出し元が渡す）。
 * Routine（CLAUDE_CODE_REMOTE_SESSION_ID）ならセッションの URL、付き添いのセッションなら
 * SessionStart の hook（.claude/hooks/session-env.ts）が書いた AGENT_HARNESS_SESSION。どちらも無ければ null。
 * harness/scripts/agent.ts の currentSession()・sessionUrl() と同じ規則。
 */
export function sessionFromEnv(env: Record<string, string | undefined>): string | null {
  const remote = env.CLAUDE_CODE_REMOTE_SESSION_ID;
  if (remote) return `https://claude.ai/code/${remote.replace(/^cse_/, 'session_')}`;
  return env.AGENT_HARNESS_SESSION || null;
}

/** 記録のファイル名（`<ID>.jsonl`）に使ってよい ID の形。SessionStart の hook と同じ規則 */
export const TRANSCRIPT_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 今のセッションの記録（`~/.claude/projects/<…>/<ID>.jsonl`）を選ぶための ID。付き添いのセッションの
 * AGENT_HARNESS_SESSION が記録のファイル名に使える形のときだけ返す。Routine（CLAUDE_CODE_REMOTE_SESSION_ID）は
 * クラウドで動き、記録の置き場所が同じとは確かめられていないので対象にしない（null）。
 */
export function transcriptSessionId(env: Record<string, string | undefined>): string | null {
  const id = env.AGENT_HARNESS_SESSION;
  return id && TRANSCRIPT_SESSION_ID.test(id) ? id : null;
}
