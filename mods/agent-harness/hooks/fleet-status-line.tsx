import type { Register } from 'claude-code'

/** collect のスナップショットがあるセッション（fleet）だけ、Issue と段階を status line の1行に出す */
export const registerFleetStatusLine: Register = on => {
  // hq-todo.tsx が matcher 無しの session.start を持つので、ここは matcher を付ける（同じ plugin に matcher 無しを2つは置けない）
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    let root: string | null = null
    try {
      const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'])
      const top = git.stdout.split('\n')[0]?.trim()
      if (git.exitCode === 0 && top) root = top
    } catch {
      root = null
    }

    if (root !== null) {
      const dir = root
      let busy = false
      const refresh = async (): Promise<void> => {
        if (busy) return
        busy = true
        let line: string | undefined
        try {
          const id = await $.session.id()
          const ran = await $.process.run(['node', 'harness/scripts/panes.ts', 'line', '--session', id], {
            cwd: dir,
            timeoutMs: 20000,
          })
          const first = ran.stdout.split('\n')[0]?.trim()
          if (ran.exitCode === 0 && first) line = first
        } catch {
          line = undefined
        }
        await $.ui.status(line)
        busy = false
      }
      await refresh()
      $.clock.every(15000, refresh)
    }

    return next(e)
  })
}
