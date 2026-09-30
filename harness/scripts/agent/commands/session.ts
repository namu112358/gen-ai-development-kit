import { type AgentCommand, sessionUrl, usageReport } from '../cli.ts';

/**
 * このセッションの使用量とセッションの URL。
 *
 *   node harness/scripts/agent.ts usage [transcriptPath]                  このセッション（サブエージェントを含む）のモデル別トークン数と推定料金（JSON）。
 *                                                           パスが無ければ AGENT_HARNESS_SESSION の <ID>.jsonl を選び、無ければ最も新しい記録（そのことを note に書く）
 *   node harness/scripts/agent.ts session-url                             この実行のセッション URL
 */

export const commands: AgentCommand[] = [
  { name: 'usage', run: (args) => void console.log(JSON.stringify(usageReport(args[0]) ?? { error: 'セッション記録が見つからないか、usage がありません' }, null, 2)) },
  { name: 'session-url', run: () => void console.log(sessionUrl() ?? '(none)') },
];
