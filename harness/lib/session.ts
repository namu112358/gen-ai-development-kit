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
