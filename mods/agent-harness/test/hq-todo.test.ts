import { expect, mock, test } from 'claude-code/testing'

const MAIN_ROOT = 'C:/work/repo'
const todo = (count: number) =>
  JSON.stringify({
    version: 1,
    ledger: true,
    count,
    items: Array.from({ length: count }, (_, i) => ({
      theme: 'ペイン',
      issue: 500 + i,
      pr: null,
      text: `項目${i}の本文`,
      sub: `補足${i}`,
    })),
    warning: null,
  })

// git rev-parse の出力：main の checkout は --git-dir と --git-common-dir が同じ、worktree は違う
const GIT_MAIN = `${MAIN_ROOT}\n${MAIN_ROOT}/.git\n${MAIN_ROOT}/.git\n`
const GIT_WORKTREE = `C:/work/wt\n${MAIN_ROOT}/.git/worktrees/wt\n${MAIN_ROOT}/.git\n`

type Panes = { exitCode: number; stdout: string }

const start = async ($: any, on: any, git: string, panes: Panes) => {
  const calls: { argv: readonly string[]; cwd?: string }[] = []
  on('process.run', async (_$: any, e: any) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: git, stderr: '' } }
    return { value: { exitCode: panes.exitCode, stdout: panes.stdout, stderr: '' } }
  })
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  // プラグインが next(e) に任せたとき、エンジンの素の描き方として返すもの
  on('ui.render', async (hook$: any, e: any) => {
    const { Text } = hook$.ui.resolve(e)
    return (globalThis as any).h(Text, {}, 'engine')
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_ROOT, surface: 'terminal', isInteractive: true })
  return { calls, clock }
}

for (const surface of ['terminal', 'desktop'] as const) {
  const band = (props = { hasSurvey: false, isWorking: false }) => ({
    plugin: 'agent-harness',
    surface,
    component: 'AbovePrompt' as const,
    props,
  })

  test(`${surface}：main の checkout で件数ありなら帯に件数が出て、panes.ts は root で動く`, async ($, on) => {
    const { calls } = await start($, on, GIT_MAIN, { exitCode: 0, stdout: todo(2) })
    const ui = await $.ui.mount(band() as never)
    await expect(ui.find({ type: 'Text', text: '2 件' })).resolves.toBeDefined()
    const panes = calls.find(c => c.argv[0] === 'node')
    expect(panes?.cwd).toBe(MAIN_ROOT)
    expect(panes?.argv).toContain('--json')
  })

  const quiet: [string, string, Panes][] = [
    ['0件', GIT_MAIN, { exitCode: 0, stdout: todo(0) }],
    ['panes.ts が読めない', GIT_MAIN, { exitCode: 2, stdout: '' }],
    ['worktree', GIT_WORKTREE, { exitCode: 0, stdout: todo(2) }],
  ]
  for (const [name, git, panes] of quiet) {
    test(`${surface}：${name}のときは帯を出さない`, async ($, on) => {
      const { calls } = await start($, on, git, panes)
      const ui = await $.ui.mount(band() as never)
      await expect(ui.find({ type: 'Text', text: '件' })).resolves.toBeUndefined()
      if (git === GIT_WORKTREE) expect(calls.some(c => c.argv[0] === 'node')).toBe(false)
    })
  }

  test(`${surface}：/hq-todo のペインに全文が出る`, async ($, on) => {
    await start($, on, GIT_MAIN, { exitCode: 0, stdout: todo(2) })
    await $.command.run({ command: 'hq-todo', args: '', origin: 'user' } as never)
    const ui = await $.ui.mount({
      plugin: 'agent-harness',
      surface,
      component: 'Pane',
      requestId: 'hq-todo',
      props: {},
    } as never)
    await expect(ui.find({ type: 'Text', text: '項目0の本文' })).resolves.toBeDefined()
    await expect(ui.find({ type: 'Text', text: '項目1の本文' })).resolves.toBeDefined()
  })
}
