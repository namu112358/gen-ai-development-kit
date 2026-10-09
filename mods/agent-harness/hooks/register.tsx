import type { Register } from 'claude-code'

import { registerHqTodo } from './hq-todo'

// 機能は hooks/<機能>.tsx に書き、ここに1行ずつ足す
export const register: Register = (on, options) => {
  registerHqTodo(on, options)
}
