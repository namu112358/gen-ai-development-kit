// guild-scene（hq のボードの行をギルドの絵にする）の段階の決め方・体力・「!」・道の数・使う文字を確かめる。ペインは mount しない。
import { expect, test } from 'claude-code/testing'
import {
  GUILD_COLUMNS,
  GUILD_ROWS,
  HP_FULL,
  PHASE_COLOR,
  drawGuild,
  guildScene,
  phaseOf,
} from '../hooks/guild-scene.ts'

type Kind = 'done' | 'ai' | 'human' | 'app' | 'wait' | 'todo' | 'stopped' | 'epic'

/** drawGuild の base64 を、row-major の [codePoint, fg, bg] の並びに戻す */
const decode = (cells: string): number[][] => {
  const bytes: Uint8Array = (Uint8Array as any).fromBase64(cells)
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const out: number[][] = []
  for (let i = 0; i < words.length; i += 3) out.push([words[i]!, words[i + 1]!, words[i + 2]!])
  return out
}

const row = (issue: number, marks: string[], kind: Kind = 'ai') => ({
  issue,
  title: `題${issue}`,
  marks,
  kind,
  label: '',
  what: '',
  pr: null,
  since: '3分前',
  waitReason: null,
})

const board = (groups: { epic: number | null; done?: boolean; rows: ReturnType<typeof row>[] }[]) =>
  ({
    version: 1,
    ledger: true,
    warning: null,
    steps: ['計画', '批評', 'ゲート', '実装', '判定', 'Merge'],
    epics: [],
    none: null,
    groups: groups.map(g => ({
      title: `#${g.epic} 題`,
      epic: g.epic,
      done: g.done ?? false,
      rows: g.rows,
      merged: [],
    })),
  }) as any

const at = (pos: number) => ['●', '●', '●', '●', '●', '●'].map((m, i) => (i < pos ? m : i === pos ? '◉' : '○'))
const SCOUT = at(0)
const BATTLE = at(3)
const APPRAISE = at(4)
const FINISH = at(5)
const REST = ['✖', '✖', '✖', '✖', '✖', '✖']
const DONE = ['●', '●', '●', '●', '●', '●']

const count = (cells: number[][], cp: number) => cells.filter(c => c[0] === cp).length

test('phaseOf：行の印から段階を決める', () => {
  const cases: [string[], Kind, string | null][] = [
    [['↳', '●', '●', '◉', '○', '○'], 'ai', null],
    [[], 'ai', null],
    [REST, 'stopped', 'rest'],
    [SCOUT, 'ai', 'scout'],
    [at(2), 'app', 'scout'],
    [BATTLE, 'ai', 'battle'],
    [APPRAISE, 'ai', 'appraise'],
    [FINISH, 'human', 'finishHuman'],
    [FINISH, 'ai', 'finishAuto'],
    [DONE, 'done', 'finishAuto'],
  ]
  for (const [marks, kind, phase] of cases) {
    expect(phaseOf(row(1, marks, kind) as any)).toBe(phase)
  }
})

test('drawGuild：偵察・戦闘・鑑定の体力のマスが 8・5・3 で、姿の色が段階ごとに違う（tick で変わらない）', () => {
  const phases = [
    ['scout', SCOUT, 8],
    ['battle', BATTLE, 5],
    ['appraise', APPRAISE, 3],
  ] as const
  const colors = phases.map(([p]) => PHASE_COLOR[p])
  expect(new Set(colors).size).toBe(3)
  for (const [phase, marks, hp] of phases) {
    const scene = guildScene(board([{ epic: 1, rows: [row(10, [...marks])] }]))
    for (let tick = 0; tick < 4; tick++) {
      const cells = decode(drawGuild(scene, tick))
      expect(count(cells, HP_FULL.codePointAt(0)!)).toBe(hp)
      expect(cells.some(c => c[1] === PHASE_COLOR[phase])).toBe(true)
      for (const [other] of phases) {
        if (other === phase) continue
        expect(cells.some(c => c[1] === PHASE_COLOR[other])).toBe(false)
      }
    }
  }
})

test('drawGuild：人の Merge 待ちがあると「!」が2つ（モンスターとギルド長の上）、無いと0', () => {
  const bang = '!'.codePointAt(0)!
  const waiting = guildScene(board([{ epic: 1, rows: [row(10, SCOUT), row(11, FINISH, 'human')] }]))
  expect(waiting.waitingHuman).toBe(true)
  expect(count(decode(drawGuild(waiting, 0)), bang)).toBe(2)

  const quiet = guildScene(
    board([
      {
        epic: 1,
        rows: [row(10, SCOUT), row(11, BATTLE), row(12, APPRAISE), row(13, FINISH, 'ai'), row(14, REST, 'stopped')],
      },
    ]),
  )
  expect(quiet.waitingHuman).toBe(false)
  expect(count(decode(drawGuild(quiet, 0)), bang)).toBe(0)
})

test('guildScene：done の group は道にせず、道は3本まで、1本に5匹まででほかは +N', () => {
  const seven = Array.from({ length: 7 }, (_, i) => row(100 + i, SCOUT))
  const scene = guildScene(
    board([
      { epic: 9, done: true, rows: [row(90, SCOUT)] },
      { epic: 1, rows: seven },
      { epic: 2, rows: [row(200, BATTLE)] },
      { epic: 3, rows: [row(300, APPRAISE)] },
      { epic: 4, rows: [row(400, SCOUT)] },
    ]),
  )
  expect(scene.roads.length).toBe(3)
  expect(scene.roads.map(r => r.epic)).toEqual([1, 2, 3])
  expect(scene.roads[0]!.monsters.length).toBe(5)
  expect(scene.roads[0]!.overflow).toBe(2)

  const cells = decode(drawGuild(scene, 0))
  const text = Array.from({ length: GUILD_ROWS }, (_, r) =>
    cells
      .slice(r * GUILD_COLUMNS, (r + 1) * GUILD_COLUMNS)
      .map(c => String.fromCodePoint(c[0]!))
      .join(''),
  )
  expect(text.some(line => line.includes('+2'))).toBe(true)
})

test('drawGuild：76 列 × 22 行で、文字は幅1の ASCII と ▀ ▄ █ だけ', () => {
  const scene = guildScene(
    board([
      { epic: 1, rows: Array.from({ length: 7 }, (_, i) => row(100 + i, SCOUT)) },
      { epic: 2, rows: [row(200, BATTLE), row(201, APPRAISE), row(202, FINISH, 'human')] },
      { epic: null, rows: [row(300, FINISH, 'ai'), row(301, REST, 'stopped')] },
    ]),
  )
  for (let tick = 0; tick < 4; tick++) {
    const cells = decode(drawGuild(scene, tick))
    expect(cells.length).toBe(76 * 22)
    const bad = cells.filter(([cp]) => !((cp! >= 0x20 && cp! <= 0x7e) || cp === 0x2580 || cp === 0x2584 || cp === 0x2588))
    expect(bad).toEqual([])
  }
})
