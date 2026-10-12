// guild-svg（guildScene の場面を desktop の Svg に出す SVG の文字列にする）の「!」・安全（script・on* の属性・外部の参照が無い）・長さの上限・道 0 本・alt の文を確かめる。ペインは mount しない。
import { expect, test } from 'claude-code/testing'
import { PHASE_COLOR, type GuildMonster, type GuildPhase, type GuildScene } from '../hooks/guild-scene.ts'
import { SVG_MAX, drawGuildSvg, guildSvgAlt } from '../hooks/guild-svg.ts'

const monster = (issue: number, phase: GuildPhase, hp = 5): GuildMonster => ({ issue, phase, hp })
const hex = (rgb: number) => `#${rgb.toString(16).padStart(6, '0')}`

const WAITING: GuildScene = {
  waitingHuman: true,
  roads: [{ epic: 545, monsters: [monster(555, 'battle'), monster(556, 'finishHuman', 1)], overflow: 0 }],
}
const QUIET: GuildScene = {
  waitingHuman: false,
  roads: [
    {
      epic: 1,
      monsters: [
        monster(10, 'scout', 8),
        monster(11, 'battle'),
        monster(12, 'appraise', 3),
        monster(13, 'finishAuto', 1),
        monster(14, 'rest', 0),
      ],
      overflow: 0,
    },
  ],
}
const PHASES: GuildPhase[] = ['scout', 'battle', 'appraise', 'finishHuman', 'finishAuto', 'rest']
/** guildScene の上限（道 3 本×モンスター 5 体）に overflow 4 を足した場面 */
const FULL: GuildScene = {
  waitingHuman: true,
  roads: [100, 200, null].map((epic, r) => ({
    epic,
    monsters: Array.from({ length: 5 }, (_, i) => monster((r + 1) * 1000 + i, PHASES[(r + i) % PHASES.length]!, i)),
    overflow: 4,
  })),
}
const EMPTY: GuildScene = { waitingHuman: false, roads: [] }

test('drawGuildSvg：人の Merge 待ちがあると class="bang" の「!」と #556・finishHuman の色が出て、無いと「!」は出ない', () => {
  const svg = drawGuildSvg(WAITING)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.includes('class="bang"')).toBe(true)
  expect(/class="bang"[^>]*>!</.test(svg)).toBe(true)
  expect(svg.includes('#556')).toBe(true)
  expect(svg.toLowerCase().includes(hex(PHASE_COLOR.finishHuman))).toBe(true)

  expect(drawGuildSvg(QUIET).includes('class="bang"')).toBe(false)
})

test('drawGuildSvg：<script・on* の属性・xmlns の外の http を含まない', () => {
  for (const [name, scene] of [
    ['waiting', WAITING],
    ['quiet', QUIET],
    ['full', FULL],
    ['empty', EMPTY],
  ] as const) {
    const svg = drawGuildSvg(scene)
    expect([name, svg.toLowerCase().includes('<script')]).toEqual([name, false])
    expect([name, /\son[a-z]+=/i.test(svg)]).toEqual([name, false])
    const rest = svg.replaceAll('xmlns="http://www.w3.org/2000/svg"', '')
    expect([name, rest.toLowerCase().includes('http')]).toEqual([name, false])
  }
})

test('drawGuildSvg：上限の場面（道 3 本×5 体、overflow 4）でも SVG_MAX（131072）文字以下で、+4 が出る', () => {
  expect(SVG_MAX).toBe(131072)
  const svg = drawGuildSvg(FULL)
  expect(svg.length <= SVG_MAX).toBe(true)
  expect(svg.includes('+4')).toBe(true)
})

test('drawGuildSvg：道が 0 本でも <svg の文字列を返し、「いまクエストはありません」の札が出る', () => {
  const svg = drawGuildSvg(EMPTY)
  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  expect(svg.includes('いまクエストはありません')).toBe(true)
})

test('guildSvgAlt：道の数・モンスターの数・人の Merge 待ちの数を文に入れる', () => {
  const cases: [GuildScene, string][] = [
    [WAITING, '冒険者ギルド：クエスト 1 本・モンスター 2 体・人の Merge 待ち 1 体'],
    [FULL, `冒険者ギルド：クエスト 3 本・モンスター 15 体・人の Merge 待ち ${FULL.roads.flatMap(r => r.monsters).filter(m => m.phase === 'finishHuman').length} 体`],
    [EMPTY, '冒険者ギルド：クエスト 0 本・モンスター 0 体・人の Merge 待ち 0 体'],
  ]
  for (const [scene, alt] of cases) expect(guildSvgAlt(scene)).toBe(alt)
})
