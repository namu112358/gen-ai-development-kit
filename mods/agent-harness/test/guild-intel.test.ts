// /guild のペインの「情報屋に送る」から入力欄で送った文が intel に届くことと、届かないときに送れなかったことが出ることを確かめる。
import { expect, mock, test } from 'claude-code/testing'
import { GUILD_PANE } from '../hooks/guild.tsx'
import { GUILD_INTEL_PREFIX, GUILD_INTEL_TO } from '../hooks/guild-intel.tsx'

const ROOT = 'C:/work/repo'
const board = JSON.stringify({
  version: 1,
  ledger: true,
  warning: null,
  steps: ['計画', '批評', 'ゲート', '実装', '判定', 'Merge'],
  epics: [],
  none: null,
  groups: [],
})

type Sent = { to: string; text: string }

/** guild.test.ts の start に、session.send のモック（届いた e を控えて reply を返す）を足したもの */
const start = async ($: any, on: any, reply: { isDelivered: true } | { isDelivered: false; reason: string }) => {
  const sent: Sent[] = []
  on('process.run', async (_$: any, e: any) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '' } }
    return { value: { exitCode: 0, stdout: board, stderr: '' } }
  })
  on('command.register', async (_$: any, e: any) => ({ value: { command: e.name } }))
  on('ui.render', async (hook$: any, e: any) => {
    const { Text } = hook$.ui.resolve(e)
    return (globalThis as any).h(Text, {}, 'engine')
  })
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [] }))
  // session.send の結果は { value } で包まず、{ isDelivered, reason } をそのまま返す
  on('session.send', async (_$: any, e: any) => {
    sent.push({ to: e.to, text: e.text })
    return reply
  })
  on('session.start', async (_$: any, e: any) => ({ cwd: e.cwd }))
  mock.clock(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'guild', args: '', origin: 'user' } as never)
  const ui = await $.ui.mount({
    plugin: 'agent-harness',
    surface: 'terminal',
    component: 'Pane',
    requestId: GUILD_PANE,
    props: {},
  } as never)
  return { sent, ui }
}

const send = async (ui: any, text: string) => {
  await ui.press({ key: 'guild-intel' } as never)
  await ui.input({ key: 'guild-intel-input', text } as never)
}

test('terminal：情報屋に送ると、intel に先頭の印つきの文が届き「情報屋に送りました」が出る', async ($, on) => {
  const { sent, ui } = await start($, on, { isDelivered: true })
  await send(ui, 'テスト')
  expect(sent).toHaveLength(1)
  expect(sent[0]!.to).toBe(GUILD_INTEL_TO)
  expect(sent[0]!.to).toBe('intel')
  expect(sent[0]!.text).toBe(`${GUILD_INTEL_PREFIX}テスト`)
  await expect(ui.find({ type: 'Text', text: '情報屋に送りました' })).resolves.toBeDefined()
})

test('terminal：intel がいなくて届かないと「情報屋に送れませんでした」が出る', async ($, on) => {
  const { ui } = await start($, on, { isDelivered: false, reason: 'no agent named intel' })
  await send(ui, 'テスト')
  await expect(ui.find({ type: 'Text', text: '情報屋に送れませんでした' })).resolves.toBeDefined()
})
