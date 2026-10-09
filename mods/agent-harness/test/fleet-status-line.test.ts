import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/work/fleet'
const SESSION = '11111111-2222-3333-4444-555555555555'
const LINE = 'fleet #508 実装 · #517 ゲート（人）'

const start = async ($: any, on: any, panesStdout: string) => {
  const calls: { argv: readonly string[]; cwd?: string }[] = []
  on('process.run', async (_$: any, e: any) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' } }
    return { value: { exitCode: 0, stdout: panesStdout, stderr: '' } }
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  return calls
}

test('スナップショットがあれば status line に1行が出て、panes.ts は root でこのセッションの ID で動く', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const calls = await start($, on, `${LINE}\n`)
  expect(statuses[statuses.length - 1]).toBe(LINE)
  const panes = calls.find(c => c.argv[0] === 'node')
  expect(panes?.cwd).toBe(ROOT)
  expect(panes?.argv[panes.argv.indexOf('--session') + 1]).toBe(SESSION)
})

test('panes.ts が何も出さなければ status line に出さない', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('ui.status', async (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  await start($, on, '')
  expect(statuses.filter(s => s !== undefined)).toEqual([])
})
