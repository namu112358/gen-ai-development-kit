// /guild（冒険者ギルドのペイン）の Raster・人の Merge 待ちの文・見えている間だけ blit と読み直しをすること・terminal 以外の文・読めないときの文・登録する surface を確かめる。
import { expect, mock, test } from 'claude-code/testing'
import { GUILD_PANE, GUILD_RASTER_KEY } from '../hooks/guild.tsx'

const ROOT = 'C:/work/repo'
const row = (issue: number) => ({
  issue,
  title: `題${issue}`,
  marks: ['●', '●', '●', '●', '●', '○'],
  kind: 'human',
  label: '◆ 人の Merge 待ち',
  what: 'Merge 待ち',
  pr: 601,
  since: '3分前',
  waitReason: null,
})
const board = JSON.stringify({
  version: 1,
  ledger: true,
  warning: null,
  steps: ['計画', '批評', 'ゲート', '実装', '判定', 'Merge'],
  epics: [{ number: 545, title: '冒険者ギルド', closed: 0, total: 3, waiting: 1, themes: ['ギルド'], done: false }],
  none: null,
  groups: [{ title: '#545 冒険者ギルド（ギルド）', epic: 545, done: false, rows: [row(556)], merged: [] }],
})

type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile' | null
type Options = { surface?: Surface; boardExit?: number }

/** hq-board.test.ts の start に、ui.panes（view.shown で isShown を答える）と ui.blit（引数を控える）のモックを足したもの */
const start = async ($: any, on: any, options: Options = {}) => {
  const view = { shown: true }
  const boardRuns: { argv: readonly string[]; cwd?: string }[] = []
  const blits: any[] = []
  const registered: string[] = []
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' } }
    boardRuns.push({ argv: e.argv, cwd: e.init?.cwd })
    const exitCode = options.boardExit ?? 0
    return { value: { exitCode, stdout: exitCode === 0 ? board : '', stderr: '' } }
  })
  on('command.register', async (_$: any, e: any) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.render', async (hook$: any, e: any) => {
    const { Text } = hook$.ui.resolve(e)
    return (globalThis as any).h(Text, {}, 'engine')
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({
    value: [{ id: 'guild', title: '冒険者ギルド', isShown: view.shown, isFocused: false, isPlaced: true }],
  }))
  on('ui.blit', async (_$: any, e: any) => {
    blits.push(e)
    return { value: {} }
  })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  const surface = options.surface === undefined ? 'terminal' : options.surface
  await $.session.start({ cwd: ROOT, surface, isInteractive: true })
  return { view, boardRuns, blits, registered, clock }
}

const pane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'agent-harness',
  surface,
  component: 'Pane' as const,
  requestId: 'guild',
  props: {},
})
const openGuild = ($: any) => $.command.run({ command: 'guild', args: '', origin: 'user' } as never)

test('terminal：/guild のペインに Raster と「! #556 PR #601」が出る', async ($, on) => {
  await start($, on)
  await openGuild($)
  const ui = await $.ui.mount(pane('terminal') as never)
  await expect(ui.find({ type: 'Raster', key: GUILD_RASTER_KEY })).resolves.toBeDefined()
  await expect(ui.find({ type: 'Text', text: '! #556 PR #601' })).resolves.toBeDefined()
})

test('terminal：見えない間は時計を進めても ui.blit を呼ばず、見える状態に戻すと呼ぶ', async ($, on) => {
  const { view, blits, clock } = await start($, on)
  view.shown = true
  await openGuild($)
  await $.ui.mount(pane('terminal') as never)
  await clock.advance(300)
  expect(blits.length > 0).toBe(true)

  blits.length = 0
  view.shown = false
  await clock.advance(1000)
  expect(blits).toHaveLength(0)

  view.shown = true
  await clock.advance(200)
  expect(blits.length > 0).toBe(true)
  expect(blits[0].requestId).toBe(GUILD_PANE)
  expect(blits[0].key).toBe(GUILD_RASTER_KEY)
})

test('terminal：見えない間は 15 秒の読み直しをしない（最初の1回は見え方に関係なく読む）', async ($, on) => {
  const { view, boardRuns, clock } = await start($, on)
  view.shown = false
  await openGuild($)
  expect(boardRuns).toHaveLength(1)
  expect(boardRuns[0]!.cwd).toBe(ROOT)
  await clock.advance(31000)
  expect(boardRuns).toHaveLength(1)
})

test('desktop で始めたセッション：Raster は無く、ターミナル版だけの文と人の Merge 待ちの文が出る', async ($, on) => {
  await start($, on, { surface: 'desktop' })
  await openGuild($)
  const ui = await $.ui.mount(pane('desktop') as never)
  await expect(ui.find({ type: 'Raster' })).resolves.toBeUndefined()
  await expect(ui.find({ type: 'Text', text: 'ターミナル版だけに対応しています' })).resolves.toBeDefined()
  await expect(ui.find({ type: 'Text', text: '! #556' })).resolves.toBeDefined()
})

test('terminal：hq board が exit 1 なら「ギルドの様子を読めません」が出て Raster は無い', async ($, on) => {
  await start($, on, { boardExit: 1 })
  await openGuild($)
  const ui = await $.ui.mount(pane('terminal') as never)
  await expect(ui.find({ type: 'Text', text: 'ギルドの様子を読めません' })).resolves.toBeDefined()
  await expect(ui.find({ type: 'Raster' })).resolves.toBeUndefined()
})

for (const [surface, expected] of [
  ['terminal', true],
  ['desktop', true],
  [null, true],
  ['vscode', false],
] as const) {
  test(`${surface ?? 'null'} で始めたセッション：/guild を${expected ? '登録する' : '登録しない'}`, async ($, on) => {
    const { registered } = await start($, on, { surface })
    expect(registered.includes('guild')).toBe(expected)
  })
}
