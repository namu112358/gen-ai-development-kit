// /guild：hq board の JSON から冒険者ギルドのドット絵をペインに出し、ペインが見えている間だけ 0.1 秒ごとに動かし、15 秒ごとに読み直す。
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { HqBoard } from '../types'
import { GUILD_INTEL_PREFIX, GUILD_INTEL_TO } from './guild-intel'
import { GUILD_COLUMNS, GUILD_ROWS, drawGuild, guildScene, phaseOf } from './guild-scene'

export const GUILD_PANE = 'guild'
export const GUILD_RASTER_KEY = 'guild-raster'

// null はまだ読んでいない、'unreadable' は読めなかった
const guildBoard = atom({ plugin: 'agent-harness', key: 'guildBoard' } as const, null)

// 情報屋に送る入力欄が開いているか・送った結果の文（null はまだ送っていない）
const guildIntelOpen = atom({ plugin: 'agent-harness', key: 'guildIntelOpen' } as const, false)
const guildIntelResult = atom({ plugin: 'agent-harness', key: 'guildIntelResult' } as const, null)

const isHqBoard = (value: unknown): value is HqBoard =>
  typeof value === 'object' &&
  value !== null &&
  (value as { version?: unknown }).version === 1 &&
  Array.isArray((value as { epics?: unknown }).epics) &&
  Array.isArray((value as { groups?: unknown }).groups)

export const registerGuild: Register = on => {
  let root: string | null = null
  let started = false
  let busy = false
  let blitting = false
  let tick = 0
  let latest: HqBoard | null = null

  // desktop のアプリが起こすセッションは surface が null（後から attach される）なので null も入れる。登録するだけで、/guild を呼ぶまで何も始めない
  on('session.start', { surface: ['terminal', 'desktop', null] }, async ($, e, next) => {
    await $.command.register({
      name: 'guild',
      description: '冒険者ギルド（hq・fleet の様子のドット絵）をペインに出す',
    })
    return next(e)
  })

  on('command.run', { command: 'guild' }, async $ => {
    const load = async (): Promise<void> => {
      if (busy) return
      busy = true
      let value: HqBoard | 'unreadable' = 'unreadable'
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
        value = 'unreadable'
      }
      busy = false
      // 一度読めた後に読めなかったときは、前の board のまま変えない
      if (value === 'unreadable' && latest !== null) return
      if (value !== 'unreadable') latest = value
      await update($, guildBoard, () => value)
    }

    const shown = async (): Promise<boolean> => {
      try {
        return (await $.ui.panes()).some(p => p.id === GUILD_PANE && p.isShown && p.isPlaced)
      } catch {
        return false
      }
    }

    const frame = async (): Promise<void> => {
      if (blitting || latest === null) return
      blitting = true
      try {
        if (await shown()) {
          tick += 1
          await $.ui.blit({ requestId: GUILD_PANE, key: GUILD_RASTER_KEY, cells: drawGuild(guildScene(latest), tick) })
        }
      } catch {
        // まだ描かれていない・terminal で描かれていないときは捨てる
      } finally {
        blitting = false
      }
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
      $.clock.every(15000, async () => {
        if (await shown()) await load()
      })
      $.clock.every(100, frame)
    }
    await load()
    await $.ui.open({ id: GUILD_PANE, title: '冒険者ギルド' })

    return { text: '冒険者ギルドのペインを開きました。' }
  })

  on('ui.render', { component: 'Pane', requestId: GUILD_PANE }, async ($, e) => {
    const { Box, Text, Raster, Button, Input } = $.ui.resolve(e)
    const board = await read($, guildBoard)
    const isTerminal = e.surface === 'terminal'

    const waiting: { issue: number; pr: number | null }[] = []
    if (board !== null && board !== 'unreadable') {
      for (const group of board.groups) {
        if (group.done) continue
        for (const r of group.rows) {
          if (phaseOf(r) === 'finishHuman') waiting.push({ issue: r.issue, pr: r.pr })
        }
      }
    }

    const intelOpen = await read($, guildIntelOpen)
    const intelResult = await read($, guildIntelResult)

    const sendIntel = async (text: string): Promise<void> => {
      const body = text.trim()
      if (body === '') return
      let result: string
      let delivered = false
      try {
        const sent = await $.session.send({ to: GUILD_INTEL_TO, text: GUILD_INTEL_PREFIX + body })
        delivered = sent.isDelivered
        result = delivered ? '情報屋に送りました' : '情報屋に送れませんでした：' + (sent.reason ?? '')
      } catch (error) {
        result = '情報屋に送れませんでした：' + (error instanceof Error ? error.message : String(error))
      }
      await update($, guildIntelResult, () => result)
      if (delivered) await update($, guildIntelOpen, () => false)
    }

    return (
      <Box flexDirection="column">
        {!isTerminal && (
          <Text dimColor>現在はターミナル版だけに対応しています（ドット絵はターミナルで /guild を開くと見られます）</Text>
        )}
        {isTerminal && board !== null && board !== 'unreadable' && (
          <Raster
            key={GUILD_RASTER_KEY}
            columns={GUILD_COLUMNS}
            rows={GUILD_ROWS}
            cells={drawGuild(guildScene(board), 0)}
          />
        )}
        {board === null && <Text dimColor>読み込み中</Text>}
        {board === 'unreadable' && <Text color="red">ギルドの様子を読めません（panes.ts hq board が動くか確かめる）</Text>}
        {board !== null && board !== 'unreadable' && board.warning && <Text color="yellow">{board.warning}</Text>}
        {board !== null && board !== 'unreadable' && waiting.length === 0 && <Text dimColor>人の Merge 待ちはありません</Text>}
        {waiting.map(w => (
          <Text color="magenta">{w.pr !== null ? `! #${w.issue} PR #${w.pr}` : `! #${w.issue}`}</Text>
        ))}
        {isTerminal && (
          <Box flexDirection="column">
            <Button key="guild-intel" label="情報屋に送る" hotkey="m" onPress={() => update($, guildIntelOpen, v => !v)} />
            {intelOpen && (
              <Input
                key="guild-intel-input"
                label="情報屋へ"
                placeholder="気づき・質問"
                submitLabel="send"
                autoFocus
                onSubmit={(text: string) => sendIntel(text)}
              />
            )}
            {intelResult !== null && <Text>{intelResult}</Text>}
          </Box>
        )}
      </Box>
    )
  })
}
