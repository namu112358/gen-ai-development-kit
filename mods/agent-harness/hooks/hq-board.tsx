import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { HqBoard } from '../types'

const PANE = 'hq-board'
const hqBoard = atom({ plugin: 'agent-harness', key: 'hqBoard' } as const, null)
const boardPage = atom({ plugin: 'agent-harness', key: 'boardPage' } as const, 'epic')

// 記号の色（panes.ts の MARK_COLOR と同じ対応）
const MARK_COLOR: Record<string, string> = {
  '●': 'green',
  '◉': 'blue',
  '◆': 'magenta',
  '◌': 'yellow',
  '✖': 'red',
}
const markColor = (mark: string): string => MARK_COLOR[mark] ?? 'gray'

const isHqBoard = (value: unknown): value is HqBoard =>
  typeof value === 'object' &&
  value !== null &&
  (value as { version?: unknown }).version === 1 &&
  Array.isArray((value as { epics?: unknown }).epics) &&
  Array.isArray((value as { groups?: unknown }).groups)

/** /hq-board：hq の Epic と Issue のページをペインに出し、ボタンで切り替える（終わったものはグレーで下） */
export const registerHqBoard: Register = on => {
  let root: string | null = null
  let started = false
  let busy = false

  // 同じ plugin に matcher 無しの session.start は1つだけ（hq-todo.tsx が持つ）
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await $.command.register({ name: 'hq-board', description: 'hq の Epic/Issue をペインに出す（ボタンで切り替え）' })
    return next(e)
  })

  on('command.run', { command: 'hq-board' }, async $ => {
    const refresh = async (): Promise<void> => {
      if (busy) return
      busy = true
      let value: HqBoard | null = null
      try {
        if (root !== null) {
          const ran = await $.process.run(['node', 'harness/scripts/panes.ts', 'hq', 'board', '--json'], {
            cwd: root,
            timeoutMs: 20000,
          })
          if (ran.exitCode === 0) {
            const parsed: unknown = JSON.parse(ran.stdout)
            if (isHqBoard(parsed)) value = parsed
          }
        }
      } catch {
        value = null
      }
      busy = false
      await update($, hqBoard, () => value)
    }

    if (!started) {
      started = true
      try {
        const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
        const top = git.stdout.split('\n')[0]
        root = git.exitCode === 0 && top ? top.trim() : null
      } catch {
        root = null
      }
      await refresh()
      $.clock.every(15000, refresh)
    } else {
      await refresh()
    }
    await $.ui.open({ id: PANE, title: 'hq の Epic/Issue' })

    return { text: 'hq の Epic/Issue のペインを開きました。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const board = await read($, hqBoard)
    const page = await read($, boardPage)

    const tabs = (
      <Box flexDirection="row">
        <Button
          key="page-epic"
          label="Epic"
          hotkey="e"
          variant={page === 'epic' ? 'primary' : undefined}
          onPress={() => update($, boardPage, () => 'epic')}
        />
        <Button
          key="page-issue"
          label="Issue"
          hotkey="i"
          variant={page === 'issue' ? 'primary' : undefined}
          onPress={() => update($, boardPage, () => 'issue')}
        />
      </Box>
    )

    if (board === null) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor>Epic/Issue を読めません（panes.ts hq board が動くか確かめる）</Text>
        </Box>
      )
    }

    const divider = <Text dimColor>── 終わったもの ──</Text>

    if (page === 'epic') {
      const items: { done: boolean; node: unknown }[] = board.epics.map(epic => ({
        done: epic.done,
        node: (
          <Box flexDirection="column">
            <Text dimColor={epic.done}>
              {epic.closed === null || epic.total === null ? 'まだ読めていない' : `${epic.closed}/${epic.total}`} 人待ち{' '}
              {epic.waiting} #{epic.number} {epic.themes.join('・')}
            </Text>
            {epic.title && <Text dimColor>{'    ' + epic.title}</Text>}
          </Box>
        ),
      }))
      const none = board.none
      if (none) {
        items.push({
          done: none.done,
          node: (
            <Text dimColor={none.done}>
              Epic なし {none.issues.length} 件 {none.issues.map(n => `#${n}`).join(' ')}
            </Text>
          ),
        })
      }
      const firstDone = items.findIndex(item => item.done)
      return (
        <Box flexDirection="column">
          {tabs}
          {board.warning && <Text color="yellow">{board.warning}</Text>}
          {items.length === 0 && <Text dimColor>fleet の Issue がまだありません</Text>}
          {items.map((item, i) => (
            <Box flexDirection="column">
              {i === firstDone && divider}
              {item.node as never}
            </Box>
          ))}
        </Box>
      )
    }

    const firstDone = board.groups.findIndex(g => g.done)
    return (
      <Box flexDirection="column">
        {tabs}
        {board.warning && <Text color="yellow">{board.warning}</Text>}
        <Text dimColor>{board.steps.join(' ')}</Text>
        {board.groups.map((group, i) => (
          <Box flexDirection="column">
            {i === firstDone && divider}
            <Text bold dimColor={group.done}>
              {group.title}
            </Text>
            {group.rows.map(r => (
              <Box flexDirection="column">
                <Box flexDirection="row">
                  <Text dimColor={group.done}>#{r.issue} </Text>
                  {r.marks.map(mark => (
                    <Text color={group.done ? 'gray' : markColor(mark)}>{mark} </Text>
                  ))}
                </Box>
                <Text dimColor>{'    ' + r.title}</Text>
                <Text dimColor={group.done}>
                  {'    '}
                  {r.label} {r.what}
                  {r.pr !== null ? ` PR #${r.pr}` : ''} この状態になって {r.since}
                </Text>
                {r.waitReason && <Text color="yellow">{'    待つ理由：' + r.waitReason}</Text>}
              </Box>
            ))}
            {group.merged.length > 0 && (
              <Text color="green" dimColor={group.done}>
                {'    ● 済み ' + group.merged.length + ' 件：' + group.merged.map(n => `#${n}`).join(' ')}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
