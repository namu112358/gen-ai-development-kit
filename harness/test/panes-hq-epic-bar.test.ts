// Issue #501：hq のペインの Epic のページの棒を、子課題の状態ごとに色分けし（Close 緑■・AI が作業中 青■・App の番 黄■・人の番 マゼンタ■・
// 待ち 灰■・まだ 灰□ の順）、子課題が 10 を超えると色ごとの割合で 10 マスに配り、ページの下に凡例を1行出すことを確かめる。
// 色は ANSI の並びから読み、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { stripAnsi, type PaneEpic, type PaneSnapshot } from '../lib/panes.ts';
import { epicBarCells, renderHqBoard, type EpicBarKind, type HqFleet, type HqView } from '../lib/panes-hq.ts';

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const claim = (stage: string, own: boolean): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess', own });
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});
const NOW = Date.parse('2026-10-11T00:10:00.000Z');
const snap = (rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: '2026-10-11T00:09:00.000Z', session: 's-a', label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: statusData(rows), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});
const fleet: HqFleet = { theme: 'ペイン', epic: 900, session: 's-a', startedAt: '2026-10-11T00:00:00.000Z' };
const viewOf = (s: PaneSnapshot): HqView => ({ ledger: true, fleets: [{ fleet, snap: s, state: 'ok' }] });
const epic = (number: number, children: [number, 'OPEN' | 'CLOSED'][]): PaneEpic => ({
  number, title: 'Epic のタイトル', state: 'OPEN', children: children.map(([n, state]) => ({ number: n, title: `c${n}`, state })),
});

const CODE: Record<string, string> = { 32: 'green', 34: 'blue', 33: 'yellow', 35: 'magenta', 90: 'gray' };
/** 色つきの ■・□ を「色 記号」の並びにする（1つの色でまとめて塗った並びも1マスずつに開く） */
function colorsOf(line: string): string[] {
  return [...line.matchAll(/\x1b\[(\d+)m([■□]+)/g)].flatMap((m) => [...m[2]!].map((ch) => `${CODE[m[1]!] ?? m[1]}${ch}`));
}

/** 状態を1つずつ持つ Epic #900（子課題の並びは状態の順とわざと違える） */
function mixedView(): HqView {
  const rows = [
    row(906, { stage: 'plan-review' }), // 人の番
    row(907, { stage: 'plan-ok', selected: false, waitReason: '#902 と触るファイルが重なるため待つ' }), // 待ち（順番待ち）
    row(905, { stage: 'merged', pr: 55 }), // Merge 済みでまだ開いている → App の番
    row(902, { claim: claim('implement', true) }), // 自分の宣言で実装中 → AI
    row(904, { stage: 'plan-gate' }), // App の番
    row(903, { stage: 'judge', pr: 53, claim: claim('judge', false) }), // ほかのセッションの宣言 → AI
    row(901, { stage: 'merged', pr: 51 }), // 子課題は CLOSED → Close（行があっても）
    row(950), // 子課題の一覧に無い行 → 数えない
    row(900, { stage: 'stopped', note: 'Epic（子課題で進める）', selected: false, next: 'none' }), // Epic 自身の行
  ];
  const children: [number, 'OPEN' | 'CLOSED'][] = [[908, 'OPEN'], [906, 'OPEN'], [905, 'OPEN'], [902, 'OPEN'], [907, 'OPEN'], [901, 'CLOSED'], [904, 'OPEN'], [903, 'OPEN']];
  const issueEpic = Object.fromEntries([...children.map(([n]) => n), 950].map((n) => [String(n), 900]));
  return viewOf(snap(rows, { epics: [epic(900, children)], issueEpic }));
}

const ORDER = ['green■', 'blue■', 'yellow■', 'magenta■', 'gray■', 'gray□'];

test('renderHqBoard（epic）：子課題の状態ごとに、Close・AI・App・人・待ち・まだ の色と順で1件1マスの棒を描く', () => {
  const out = renderHqBoard(mixedView(), 'epic', NOW, 120);
  const bar = out.split('\n').find((l) => stripAnsi(l).includes('#900'));
  assert.ok(bar, out);
  assert.deepEqual(colorsOf(bar), ['green■', 'blue■', 'blue■', 'yellow■', 'yellow■', 'magenta■', 'gray■', 'gray□']);
  assert.ok(stripAnsi(bar).includes('1/8'), 'closed/total は今のまま');
});

const k = (n: number, kind: EpicBarKind): EpicBarKind[] => Array<EpicBarKind>(n).fill(kind);
const counts = (c: Partial<Record<EpicBarKind, number>>): Record<EpicBarKind, number> => ({ done: 0, ai: 0, app: 0, human: 0, wait: 0, rest: 0, ...c });

const CELL_CASES: { name: string; c: Record<EpicBarKind, number>; want: EpicBarKind[] }[] = [
  { name: '10 件ちょうどは1件1マス', c: counts({ done: 4, ai: 3, rest: 3 }), want: [...k(4, 'done'), ...k(3, 'ai'), ...k(3, 'rest')] },
  { name: '30 件（Close 15・AI 9・まだ 6）は 5:3:2 で、0 件の色は出さない', c: counts({ done: 15, ai: 9, rest: 6 }), want: [...k(5, 'done'), ...k(3, 'ai'), ...k(2, 'rest')] },
  { name: '人の番が1件だけでも1マス出し、一番多い色から減らす', c: counts({ done: 20, ai: 9, human: 1 }), want: [...k(6, 'done'), ...k(3, 'ai'), 'human'] },
  { name: '11 件で6色すべてあっても合計 10 マス', c: counts({ done: 6, ai: 1, app: 1, human: 1, wait: 1, rest: 1 }), want: [...k(5, 'done'), 'ai', 'app', 'human', 'wait', 'rest'] },
];

for (const { name, c, want } of CELL_CASES) {
  test(`epicBarCells：${name}`, () => {
    assert.deepEqual(epicBarCells(c), want);
  });
}

test('renderHqBoard（epic）：Epic があればページの一番下に凡例を1行（6つの意味を順に、棒と同じ色の記号で）', () => {
  const v = mixedView();
  const s = v.fleets[0]!.snap!;
  s.issueEpic = { ...s.issueEpic, 960: null }; // Epic なしの行の後に凡例が来ること
  s.status!.rows.push(row(960));
  const out = renderHqBoard(v, 'epic', NOW, 120);
  const last = out.split('\n').at(-1)!;
  const text = stripAnsi(last);
  const at = ['Close', 'AI が作業中', 'App の番', '人の番', '待ち', 'まだ'].map((m) => text.indexOf(m));
  assert.ok(at.every((i) => i >= 0), text);
  assert.deepEqual([...at].sort((a, b) => a - b), at, `意味の順：${text}`);
  assert.deepEqual(colorsOf(last), ORDER);
  assert.ok(stripAnsi(out).indexOf('Epic なし') < stripAnsi(out).lastIndexOf('Close'), 'Epic なしの行の後');
});

test('renderHqBoard（epic）：Epic が無ければ凡例を出さない（行が無いとき・Epic なしの行だけのとき）', () => {
  const empty: HqView = { ledger: true, fleets: [] };
  const onlyNone = viewOf(snap([row(11)], { issueEpic: { 11: null } }));
  for (const v of [empty, onlyNone]) {
    const text = stripAnsi(renderHqBoard(v, 'epic', NOW, 120));
    assert.ok(!(text.includes('AI が作業中') && text.includes('人の番')), text);
  }
});
