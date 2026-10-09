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

const GIT_MAIN = `${MAIN_ROOT}\n${MAIN_ROOT}/.git\n${MAIN_ROOT}/.git\n`

// panes.ts の出力の列：1件, 1件, 2件, 2件（尽きたら最後を返し続ける）。
// hq-todo は t=0 に1回目、以後 15000 ごとに読む。t=15000 では hq-todo の2回目と hq-notify の初回の check が
// 同じ時刻に走るが、どちらの順でも hqTodo は1件なので、初回は1件を覚えるだけ。2件になるのは t=30000 から。
const SEQUENCE = [todo(1), todo(1), todo(2), todo(2)]

const stored: unknown[] = []

const run = async ($: any, on: any) => {
  let n = 0
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: GIT_MAIN, stderr: '' } }
    const out = SEQUENCE[Math.min(n, SEQUENCE.length - 1)]
    n += 1
    return { value: { exitCode: 0, stdout: out, stderr: '' } }
  })
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  const notices: any[] = []
  on('ui.notify', async (_$: any, e: any) => {
    notices.push(e)
    return { value: { isSent: true, channel: 'kitty' } }
  })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  // $.store は自前で受ける（set を見たいので mock.store は使わない）
  const held = new Map<string, unknown>()
  on('store.get', async (_$: any, e: any) => ({ value: held.get(e.key) }))
  on('store.set', async (_$: any, e: any) => {
    held.set(e.key, e.value)
    if (e.key === 'hqNotified') stored.push(e.value)
    return { value: undefined }
  })
  const clock = mock.clock(on)
  await $.session.start({ cwd: MAIN_ROOT, surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 6; i++) await clock.advance(15000)
  return notices
}

test('人待ちが増えたら通知を1回だけ出し、同じ件数では繰り返さない', async ($, on) => {
  const notices = await run($, on)
  expect(notices.length).toBe(1)
  expect(JSON.stringify(notices[0])).toContain('1 件')
  expect(JSON.stringify(notices[0])).toContain('項目1の本文')
  expect(JSON.stringify(notices[0])).toContain('hq の人待ち')
  expect(stored.at(-1)).toEqual(['#500||項目0の本文', '#501||項目1の本文'])
})

test('notifyHqTodo が false なら通知を出さない', { options: { notifyHqTodo: false } }, async ($, on) => {
  const notices = await run($, on)
  expect(notices.length).toBe(0)
})
