// hq のボードの JSON（HqBoard）から冒険者ギルドの場面を作り、Raster の cells（base64）に描く純粋な関数。
// $・atom・claude-code の実行時の import は使わない（ペインと時計は呼ぶ側が持つ）。
import type { HqBoard } from '../types'

type BoardRow = HqBoard['groups'][number]['rows'][number]

export type GuildPhase = 'scout' | 'battle' | 'appraise' | 'finishHuman' | 'finishAuto' | 'rest'
export type GuildMonster = { issue: number; phase: GuildPhase; hp: number }
export type GuildRoad = { epic: number | null; monsters: GuildMonster[]; overflow: number }
export type GuildScene = { roads: GuildRoad[]; waitingHuman: boolean }

export const GUILD_COLUMNS = 76
export const GUILD_ROWS = 22
export const GUILD_MASTER = { col: 21, row: 1 }
export const INFO_BROKER = { col: 30, row: 1 }
export const HP_FULL = '='
export const HP_EMPTY = '.'

/** 姿の色（0x00RRGGBB）。ほかの絵には使わない */
export const PHASE_COLOR: Record<GuildPhase, number> = {
  scout: 0x5fafff,
  battle: 0xff5f5f,
  appraise: 0xffd75f,
  finishHuman: 0xd787ff,
  finishAuto: 0x5fd75f,
  rest: 0x8a8a8a,
}

const DEFAULT = 0x01000000
const TEXT = 0xd0d0d0
const WALL = 0xa0703c
const ROOF = 0x7a4a2a
const HERO = 0xe0c090
const MASTER = 0xc8a0e0
const BROKER = 0x70b0a0
const EYE = 0xffffff
const BLINK = 0xf0f0f0
const HP_FULL_COLOR = 0xafff87
const HP_EMPTY_COLOR = 0x585858
const BANG_COLOR = 0xff8700

const MAX_ROADS = 3
const MAX_MONSTERS = 5
const HPS: Record<GuildPhase, number> = { scout: 8, battle: 5, appraise: 3, finishHuman: 1, finishAuto: 1, rest: 8 }

export function phaseOf(row: BoardRow): GuildPhase | null {
  const marks = row.marks
  if (marks.length === 0 || marks[0] === '↳') return null
  if (marks.every(m => m === '✖')) return 'rest'
  const i = marks.findIndex(m => m !== '●')
  if (i < 0) return 'finishAuto'
  if (i <= 2) return 'scout'
  if (i === 3) return 'battle'
  if (i === 4) return 'appraise'
  return row.kind === 'human' ? 'finishHuman' : 'finishAuto'
}

export function hpOf(phase: GuildPhase): number {
  return HPS[phase]
}

export function guildScene(board: HqBoard): GuildScene {
  const roads: GuildRoad[] = []
  let waitingHuman = false
  for (const group of board.groups) {
    if (group.done) continue
    const monsters: GuildMonster[] = []
    for (const row of group.rows) {
      const phase = phaseOf(row)
      if (phase === null) continue
      if (phase === 'finishHuman') waitingHuman = true
      monsters.push({ issue: row.issue, phase, hp: hpOf(phase) })
    }
    if (monsters.length === 0 || roads.length >= MAX_ROADS) continue
    roads.push({
      epic: group.epic,
      monsters: monsters.slice(0, MAX_MONSTERS),
      overflow: Math.max(0, monsters.length - MAX_MONSTERS),
    })
  }
  return { roads, waitingHuman }
}

export function drawGuild(scene: GuildScene, tick: number): string {
  const frame = ((Math.floor(tick) % 4) + 4) % 4
  const words = new Uint32Array(GUILD_COLUMNS * GUILD_ROWS * 3)
  for (let i = 0; i < GUILD_COLUMNS * GUILD_ROWS; i++) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = DEFAULT
    words[i * 3 + 2] = DEFAULT
  }
  const put = (col: number, row: number, ch: string, fg: number) => {
    if (col < 0 || col >= GUILD_COLUMNS || row < 0 || row >= GUILD_ROWS) return
    const at = (row * GUILD_COLUMNS + col) * 3
    words[at] = ch.codePointAt(0)!
    words[at + 1] = fg
  }
  const text = (col: number, row: number, s: string, fg: number, limit = GUILD_COLUMNS) => {
    for (let i = 0; i < s.length && col + i < limit; i++) put(col + i, row, s[i]!, fg)
  }
  const art = (col: number, row: number, lines: string[], fg: number) => {
    lines.forEach((line, dy) => {
      for (let dx = 0; dx < line.length; dx++) if (line[dx] !== ' ') put(col + dx, row + dy, line[dx]!, fg)
    })
  }

  // ギルドの建物（0〜17 列・0〜3 行）
  art(0, 0, ['  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ', ' ▄██████████████▄ '], ROOF)
  art(0, 2, ['  █ ▄▄ █▀▀▀▀█ ▄▄ █', '  █ ▀▀ █ ▄▄ █ ▀▀ █'], WALL)
  // ギルド長と情報屋
  art(GUILD_MASTER.col, GUILD_MASTER.row, [' o ', '/█/', '/ /'], MASTER)
  art(INFO_BROKER.col, INFO_BROKER.row, ['(o)', '<█>', '/ /'], BROKER)
  if (scene.waitingHuman) put(GUILD_MASTER.col, 0, '!', BANG_COLOR)

  scene.roads.forEach((road, r) => {
    const top = 4 + r * 6
    text(0, top, road.epic === null ? '#-' : `#${road.epic}`, TEXT, 7)
    road.monsters.forEach((m, s) => {
      const left = 8 + s * 13
      const color = PHASE_COLOR[m.phase]
      const sword = m.phase === 'battle' || m.phase === 'finishAuto'
      // 勇者
      art(left, top + 2, [' o', '/█'], HERO)
      put(left + 2, top + 2, sword ? (frame % 2 === 0 ? '/' : '-') : '|', BLINK)
      put(left + 2, top + 3, '/', HERO)
      // 姿
      art(left + 4, top + 1, [' ▄██▄ ', '█o██o█', '▀█▀▀█▀'], color)
      put(left + 5, top + 2, 'o', EYE)
      put(left + 8, top + 2, 'o', EYE)
      if (m.phase === 'finishHuman') put(left + 6, top, '!', BANG_COLOR)
      const blink = { scout: '?', appraise: '*', rest: 'z' }[m.phase as 'scout' | 'appraise' | 'rest']
      if (blink && frame % 2 === 0) put(left + 10, top + 1, blink, BLINK)
      text(left + 4, top + 4, `#${m.issue}`, TEXT)
      for (let h = 0; h < 8; h++) {
        const full = h < m.hp
        put(left + 3 + h, top + 5, full ? HP_FULL : HP_EMPTY, full ? HP_FULL_COLOR : HP_EMPTY_COLOR)
      }
    })
    if (road.overflow > 0) text(73, top + 2, `+${road.overflow}`, TEXT)
  })

  return new Uint8Array(words.buffer).toBase64()
}
