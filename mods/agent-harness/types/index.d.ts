/** `node harness/scripts/panes.ts hq todo --json` の出力（harness/scripts/panes.ts の HqTodoJson と同じ形。mod はフォルダの外を import できないので手で写す） */
export type HqTodo = {
  version: 1
  ledger: boolean
  count: number
  items: { theme: string; issue: number; pr: number | null; text: string; sub: string }[]
  warning: string | null
}

/** `node harness/scripts/panes.ts hq board --json` の出力（harness/scripts/panes.ts の HqBoardJson と同じ形） */
export type HqBoard = {
  version: 1
  ledger: boolean
  warning: string | null
  steps: string[]
  epics: {
    number: number
    title: string | null
    closed: number | null
    total: number | null
    waiting: number
    themes: string[]
    done: boolean
  }[]
  none: { issues: number[]; done: boolean } | null
  groups: {
    title: string
    epic: number | null
    done: boolean
    rows: {
      issue: number
      title: string
      marks: string[]
      kind: 'done' | 'ai' | 'human' | 'app' | 'wait' | 'todo' | 'stopped' | 'epic'
      label: string
      what: string
      pr: number | null
      since: string
      waitReason: string | null
    }[]
    merged: number[]
  }[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-harness': { hqTodo: HqTodo | null; hqBoard: HqBoard | null; boardPage: 'epic' | 'issue'; guildBoard: HqBoard | 'unreadable' | null }
  }
}
