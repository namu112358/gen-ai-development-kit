import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/work/repo'
const row = (issue: number) => ({
  issue,
  title: `題${issue}`,
  marks: ['●', '●', '●', '◉', '○', '○'],
  kind: 'ai',
  label: '◉ AI が作業中',
  what: '実装中',
  pr: null,
  since: '3分前',
  waitReason: null,
})
const board = JSON.stringify({
  version: 1,
  ledger: true,
  warning: null,
  steps: ['計画', '批評', 'ゲート', '実装', '判定', 'Merge'],
  epics: [
    { number: 520, title: '動いている Epic', closed: 1, total: 3, waiting: 1, themes: ['新'], done: false },
    { number: 392, title: '終わった Epic', closed: 2, total: 2, waiting: 0, themes: ['旧'], done: true },
  ],
  none: null,
  groups: [
    { title: '#520 動いている Epic（新）', epic: 520, done: false, rows: [row(519)], merged: [508] },
    { title: '#392 終わった Epic（旧）', epic: 392, done: true, rows: [], merged: [400] },
  ],
})

const start = async ($: any, on: any) => {
  const calls: { argv: readonly string[]; cwd?: string }[] = []
  on('process.run', async (_$: any, e: any) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' } }
    return { value: { exitCode: 0, stdout: board, stderr: '' } }
  })
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.render', async (hook$: any, e: any) => {
    const { Text } = hook$.ui.resolve(e)
    return (globalThis as any).h(Text, {}, 'engine')
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return calls
}

for (const surface of ['terminal', 'desktop'] as const) {
  const pane = { plugin: 'agent-harness', surface, component: 'Pane' as const, requestId: 'hq-board', props: {} }

  test(`${surface}：/hq-board のペインに Epic が出て、panes.ts board --json は root で動く`, async ($, on) => {
    const calls = await start($, on)
    await $.command.run({ command: 'hq-board', args: '', origin: 'user' } as never)
    const ui = await $.ui.mount(pane as never)
    await expect(ui.find({ type: 'Text', text: '#520' })).resolves.toBeDefined()
    const ran = calls.find(c => c.argv[0] === 'node' && c.argv.includes('board'))
    expect(ran?.cwd).toBe(ROOT)
    expect(ran?.argv).toContain('--json')
  })

  test(`${surface}：Issue のボタンで Issue のページに替わる`, async ($, on) => {
    await start($, on)
    await $.command.run({ command: 'hq-board', args: '', origin: 'user' } as never)
    const ui = await $.ui.mount(pane as never)
    await ui.press({ key: 'page-issue' } as never)
    await expect(ui.find({ type: 'Text', text: '#519' })).resolves.toBeDefined()
  })
}
