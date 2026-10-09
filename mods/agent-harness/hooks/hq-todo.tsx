import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { HqTodo } from '../types'

const PANE = 'hq-todo'
const hqTodo = atom({ plugin: 'agent-harness', key: 'hqTodo' } as const, null)

/** 区切りを / に、末尾の / を除き、先頭のドライブ文字の大文字小文字を揃える（Windows の git が返す形のぶれ） */
const normalize = (path: string): string => {
  let out = path.trim().split(String.fromCharCode(92)).join('/')
  while (out.endsWith('/')) out = out.slice(0, -1)
  if (out.charAt(1) === ':') out = out.charAt(0).toLowerCase() + out.slice(1)
  return out
}

const isHqTodo = (value: unknown): value is HqTodo =>
  typeof value === 'object' &&
  value !== null &&
  (value as { version?: unknown }).version === 1 &&
  Array.isArray((value as { items?: unknown }).items) &&
  typeof (value as { count?: unknown }).count === 'number'

/** hq（main の checkout）のセッションにだけ、人待ちの件数を帯に、全文を /hq-todo のペインに出す */
export const registerHqTodo: Register = on => {
  let root: string | null = null

  on('session.start', async ($, e, next) => {
    try {
      const git = await $.process.run([
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
      ])
      const [top, gitDir, commonDir] = git.stdout.split('\n')
      if (git.exitCode === 0 && top && gitDir && commonDir && normalize(gitDir) === normalize(commonDir)) {
        root = top.trim()
      }
    } catch {
      root = null
    }

    if (root !== null) {
      const dir = root
      const refresh = async (): Promise<void> => {
        let value: HqTodo | null = null
        try {
          const ran = await $.process.run(['node', 'harness/scripts/panes.ts', 'hq', 'todo', '--json'], {
            cwd: dir,
            timeoutMs: 20000,
          })
          if (ran.exitCode === 0) {
            const parsed: unknown = JSON.parse(ran.stdout)
            if (isHqTodo(parsed)) value = parsed
          }
        } catch {
          value = null
        }
        await update($, hqTodo, () => value)
      }
      await $.command.register({ name: 'hq-todo', description: 'hq の人待ちを全文でペインに出す' })
      await refresh()
      $.clock.every(15000, refresh)
      refreshNow = refresh
    }

    return next(e)
  })

  let refreshNow: (() => Promise<void>) | null = null

  on('command.run', { command: 'hq-todo' }, async $ => {
    if (refreshNow) await refreshNow()
    await $.ui.open({ id: PANE, title: 'hq の人待ち' })

    return { text: 'hq の人待ちのペインを開きました。' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const todo = await read($, hqTodo)
    if (e.props.hasSurvey || todo === null || todo.count === 0) return next(e)

    const { Text } = $.ui.resolve(e)

    return <Text color="yellow">hq の人待ち {todo.count} 件（/hq-todo で開く）</Text>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const todo = await read($, hqTodo)

    if (todo === null) {
      return <Text dimColor>人待ちを読めません（main の checkout で panes.ts が動くか確かめる）</Text>
    }

    return (
      <Box flexDirection="column">
        {todo.warning && <Text color="yellow">{todo.warning}</Text>}
        {todo.items.length === 0 && <Text color="green">今はありません</Text>}
        {todo.items.map((item, i) => (
          <Box flexDirection="column">
            <Text>
              {i + 1}. [{item.theme}] {item.text}
            </Text>
            {item.sub && <Text dimColor>{item.sub}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
