// guildScene の場面から、desktop の Svg に出す冒険者ギルドの SVG の文字列を作る純粋な関数。動きは SVG の中の CSS に任せる。
// $・atom・claude-code の実行時の import は使わない。入る可変の値は数だけ（文字列は入れない）。
import { PHASE_COLOR } from './guild-scene'
import type { GuildPhase, GuildScene } from './guild-scene'

export const SVG_MAX = 131072
export const SVG_WIDTH = 760

const PHASE_NAME: Record<GuildPhase, string> = {
  scout: '偵察',
  battle: '戦闘',
  appraise: '鑑定',
  finishHuman: '人の Merge 待ち',
  finishAuto: '自動の Merge 待ち',
  rest: '休み',
}
const PHASES: GuildPhase[] = ['scout', 'battle', 'appraise', 'finishHuman', 'finishAuto', 'rest']

const HP_STEPS = 8
const HP_FULL = '#afff87'
const HP_EMPTY = '#585858'
const BANG = '#ff8700'
const TEXT = '#d0d0d0'
const TOP = 110
const ROAD = 130
const LEGEND = 50

const hex = (rgb: number): string => '#' + rgb.toString(16).padStart(6, '0')
const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0)

const STYLE = `<style>
.twinkle{animation:twinkle 3s ease-in-out infinite}
.flicker{animation:flicker 1.6s ease-in-out infinite}
.bang{animation:bounce .8s ease-in-out infinite}
.swing{animation:swing .6s ease-in-out infinite;transform-box:fill-box;transform-origin:0% 100%}
.shake{animation:shake .5s ease-in-out infinite;transform-box:fill-box;transform-origin:50% 100%}
.float{animation:float 1.6s ease-in-out infinite}
.rise{animation:rise 2.4s ease-in infinite}
.phase-finishAuto .raise{transform:translateY(-4px)}
.bang,.float,.rise{transform-box:fill-box;transform-origin:50% 50%}
@keyframes twinkle{0%,100%{opacity:.25}50%{opacity:1}}
@keyframes flicker{0%,100%{opacity:.7}40%{opacity:1}70%{opacity:.5}}
@keyframes bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes swing{0%,100%{transform:rotate(-25deg)}50%{transform:rotate(25deg)}}
@keyframes shake{0%,100%{transform:translateX(-2px)}50%{transform:translateX(2px)}}
@keyframes float{0%,100%{transform:translateY(0);opacity:.6}50%{transform:translateY(-5px);opacity:1}}
@keyframes rise{0%{transform:translateY(6px);opacity:0}30%{opacity:1}100%{transform:translateY(-12px);opacity:0}}
</style>`

const STARS = [
  [420, 20], [500, 50], [580, 18], [650, 62], [720, 28], [330, 70], [260, 24], [690, 96],
]

function monsterSvg(issue: number, phase: GuildPhase, hp: number, x: number, y: number): string {
  const color = hex(PHASE_COLOR[phase])
  const full = Math.max(0, Math.min(HP_STEPS, int(hp)))
  const sword = phase === 'battle'
    ? '<line class="swing" x1="26" y1="48" x2="40" y2="30" stroke="#f0f0f0" stroke-width="3"/>'
    : phase === 'finishAuto'
      ? '<line class="raise" x1="26" y1="48" x2="30" y2="26" stroke="#f0f0f0" stroke-width="3"/>'
      : '<line x1="26" y1="48" x2="26" y2="62" stroke="#f0f0f0" stroke-width="3"/>'
  const mark = {
    scout: '<text class="float" x="124" y="30" fill="#f0f0f0" font-size="18">?</text>',
    battle: '',
    appraise: '<text class="twinkle" x="124" y="30" fill="#f0f0f0" font-size="18">*</text>',
    finishHuman: `<text class="bang" x="95" y="16" fill="${BANG}" font-size="22" font-weight="bold">!</text>`,
    finishAuto: '',
    rest: '<text class="rise" x="124" y="30" fill="#f0f0f0" font-size="16">z</text>',
  }[phase]
  const bar = Array.from({ length: HP_STEPS }, (_, h) =>
    `<rect x="${60 + h * 8}" y="92" width="6" height="6" fill="${h < full ? HP_FULL : HP_EMPTY}"/>`,
  ).join('')
  const body = phase === 'battle' ? 'shake' : ''
  return `<g class="phase-${phase}" transform="translate(${x} ${y})"><title>#${int(issue)}</title>
<circle cx="14" cy="42" r="6" fill="#e0c090"/><rect x="9" y="48" width="10" height="16" fill="#e0c090"/>${sword}
<g class="${body}"><ellipse cx="100" cy="52" rx="28" ry="24" fill="${color}"/><circle cx="90" cy="48" r="4" fill="#fff"/><circle cx="110" cy="48" r="4" fill="#fff"/></g>
${mark}
<text x="76" y="86" fill="${TEXT}" font-size="12">#${int(issue)}</text>${bar}</g>`
}

export function drawGuildSvg(scene: GuildScene): string {
  const roads = scene.roads
  const height = TOP + Math.max(1, roads.length) * ROAD + LEGEND
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${height}" width="${SVG_WIDTH}" height="${height}" role="img">`,
    STYLE,
    '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1026"/><stop offset="1" stop-color="#1c2a4a"/></linearGradient></defs>',
    `<rect width="${SVG_WIDTH}" height="${height}" fill="url(#sky)"/>`,
  )
  STARS.forEach(([sx, sy], i) => {
    parts.push(`<circle class="twinkle" cx="${sx}" cy="${sy}" r="2" fill="#fff" style="animation-delay:${(i % 4) * 0.7}s"/>`)
  })
  // ギルドの建物とギルド長
  parts.push(
    '<polygon points="20,60 120,60 70,20" fill="#7a4a2a"/>',
    '<rect x="30" y="60" width="80" height="40" fill="#a0703c"/>',
    '<rect class="flicker" x="40" y="70" width="14" height="14" fill="#ffd75f"/>',
    '<rect class="flicker" x="86" y="70" width="14" height="14" fill="#ffd75f" style="animation-delay:.5s"/>',
    '<rect x="62" y="76" width="16" height="24" fill="#5a3a20"/>',
    '<circle cx="150" cy="76" r="8" fill="#c8a0e0"/><rect x="143" y="84" width="14" height="16" fill="#c8a0e0"/>',
  )
  if (scene.waitingHuman) {
    parts.push(`<text class="bang" x="145" y="62" fill="${BANG}" font-size="26" font-weight="bold">!</text>`)
  }
  if (roads.length === 0) {
    parts.push(
      `<rect x="20" y="${TOP}" width="720" height="${ROAD - 20}" rx="14" fill="#2a3a5a" opacity=".6"/>`,
      `<text x="380" y="${TOP + 55}" fill="${TEXT}" font-size="18" text-anchor="middle">いまクエストはありません</text>`,
    )
  }
  roads.forEach((road, r) => {
    const y = TOP + r * ROAD
    parts.push(
      `<rect x="20" y="${y}" width="720" height="${ROAD - 20}" rx="14" fill="#2a3a5a" opacity=".6"/>`,
      `<text x="32" y="${y + 24}" fill="${TEXT}" font-size="14">${road.epic === null ? '#-' : '#' + int(road.epic)}</text>`,
    )
    road.monsters.forEach((m, s) => parts.push(monsterSvg(m.issue, m.phase, m.hp, 60 + s * 128, y + 6)))
    if (road.overflow > 0) {
      parts.push(`<text x="708" y="${y + 60}" fill="${TEXT}" font-size="16" text-anchor="end">+${int(road.overflow)}</text>`)
    }
  })
  // 凡例
  const ly = height - 22
  PHASES.forEach((p, i) => {
    const lx = 24 + i * 120
    parts.push(
      `<circle cx="${lx}" cy="${ly}" r="6" fill="${hex(PHASE_COLOR[p])}"/>`,
      `<text x="${lx + 12}" y="${ly + 4}" fill="${TEXT}" font-size="11">${PHASE_NAME[p]}</text>`,
    )
  })
  parts.push('</svg>')
  return parts.join('\n')
}

export function guildSvgAlt(scene: GuildScene): string {
  const monsters = scene.roads.reduce((n, r) => n + r.monsters.length, 0)
  const waiting = scene.roads.reduce((n, r) => n + r.monsters.filter(m => m.phase === 'finishHuman').length, 0)
  return `冒険者ギルド：クエスト ${scene.roads.length} 本・モンスター ${monsters} 体・人の Merge 待ち ${waiting} 体`
}
