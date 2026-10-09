import type { Register } from 'claude-code'

import type { HqTodo } from '../types'

const notifiedKey = (item: HqTodo['items'][number]): string => `#${item.issue}|${item.pr ?? ''}|${item.text}`

/** hq の人待ちに前の読みに無かった項目が出たとき、OS の通知を1回出す（hq-todo.tsx が書く hqTodo を読むだけ） */
export const registerHqNotify: Register = (on, options) => {
  if (options.notifyHqTodo === false) return

  // hq-todo.tsx が matcher 無しの session.start を持つので、ここは matcher を付ける（同じ plugin に matcher 無しを2つは置けない）
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    let busy = false
    const check = async (): Promise<void> => {
      if (busy) return
      busy = true
      try {
        const { value } = await $.state.get({ plugin: 'agent-harness', key: 'hqTodo' })
        if (value === null || value === undefined) return

        const keys = value.items.map(notifiedKey)
        const known = await $.store.get('hqNotified')
        if (!Array.isArray(known)) {
          await $.store.set('hqNotified', keys)
          return
        }

        const seen = new Set(known)
        const fresh = value.items.filter(item => !seen.has(notifiedKey(item)))
        if (fresh.length > 0) {
          const first = fresh[0]
          const text = `${fresh.length} 件増えました：[${first.theme}] ${first.text}`
          try {
            const sent = await $.ui.notify(text, { title: 'hq の人待ち' })
            if (!sent.isSent) $.ui.toast(text)
          } catch {
            // 通知が出せなくても落とさない
          }
        }
        await $.store.set('hqNotified', keys)
      } catch {
        // 次の回でやり直す
      } finally {
        busy = false
      }
    }
    $.clock.every(15000, check)

    return next(e)
  })
}
