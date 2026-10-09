/** `node harness/scripts/panes.ts hq todo --json` の出力（harness/scripts/panes.ts の HqTodoJson と同じ形。mod はフォルダの外を import できないので手で写す） */
export type HqTodo = {
  version: 1
  ledger: boolean
  count: number
  items: { theme: string; issue: number; pr: number | null; text: string; sub: string }[]
  warning: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'agent-harness': { hqTodo: HqTodo | null }
  }
}
