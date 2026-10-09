import type { Register } from 'claude-code'

import { registerFleetStatusLine } from './fleet-status-line'
import { registerHqBoard } from './hq-board'
import { registerHqNotify } from './hq-notify'
import { registerHqTodo } from './hq-todo'

// 機能は hooks/<機能>.tsx に書き、ここに1行ずつ足す
export const register: Register = (on, options) => {
  registerHqTodo(on, options)
  registerFleetStatusLine(on, options)
  registerHqNotify(on, options)
  registerHqBoard(on, options)
}
