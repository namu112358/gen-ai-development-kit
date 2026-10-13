// Issue #781：hq が判断の担当（hq-judge）を呼ぶ印（harness/scripts/hq-decide.ts の route の judge と themeCandidates・themes）を、入力と期待の表で確かめる。
// route の judge は、件名 notice で「人の判断が要る」の印が無いものが split、印のあるものが null、worker_done が summary、ほかが null（action は変えない）。
// themeCandidates は、候補の Epic の条件（控えの fleet の Epic・stoppedEpics・「選ぶ」の行が無い Epic を除く）、slots（maxFleets − 動いている fleet の数）、
// judge（候補2つ以上かつ slots 1以上で theme）、子の title・priority・area（--issues の無い・一覧に無い Issue は null、priority のラベルが複数なら最初）。
// CLI は themes の1件だけ（ファイルを読んで JSON を標準出力に書く）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hqConfig, loadConfig } from '../lib/config.ts';
import { FLEET_STAGES, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { routeDelivery, themeCandidates } from '../scripts/hq-decide.ts';
import type { CheckMessage } from '../scripts/hq-watch.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- routeDelivery の judge ----

const judges: { msg: CheckMessage; judge: 'split' | 'summary' | null }[] = [
  { msg: { id: 'n1', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 の計画を出し直した' }, judge: 'split' },
  { msg: { id: 'n2', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 は人の判断が要る' }, judge: null },
  { msg: { id: 'n3', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', payload: { body: '#10 は人の判断が要る' } }, judge: null },
  { msg: { id: 'w1', type: 'worker_done', from_handle: 'dispatch:d-A' }, judge: 'summary' },
  { msg: { id: 'h1', type: 'heartbeat', from_handle: 'dispatch:d-A', body: '#10 実装中' }, judge: null },
  { msg: { id: 'q1', type: 'question', from_handle: 'dispatch:d-A', body: '#10 の計画の files を広げてよいですか' }, judge: null },
  { msg: { id: 'q2', type: 'question', from_handle: 'dispatch:d-A', body: '[交代] Epic #50、Issue #10' }, judge: null },
  { msg: { id: 'e1', type: 'escalation', from_handle: 'dispatch:d-A', body: '止まりました' }, judge: null },
  { msg: { id: 'r1', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-120', body: '自動 Merge：#11 は合格' }, judge: null },
  { msg: { id: 'r2', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-121', body: 'Human Merge：#12' }, judge: null },
  { msg: { id: 's1', type: 'status', from_handle: 'dispatch:d-A', subject: 'merged-120' }, judge: null },
  { msg: { id: 'x1', type: 'something-new', from_handle: 'dispatch:d-A', body: '?' }, judge: null },
];

test('routeDelivery：judge は notice の印なしが split、人の判断が要るが null、worker_done が summary、ほかが null', () => {
  const r = routeDelivery({ deliveryId: 'dl-1', messages: judges.map((c) => c.msg) });
  assert.deepEqual(r.items.map((i) => [i.id, i.judge]), judges.map((c) => [c.msg.id, c.judge]));
});

test('routeDelivery：judge を足しても action は変わらない', () => {
  const msgs: CheckMessage[] = [
    { id: 'a', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 の計画を出し直した' },
    { id: 'b', type: 'worker_done', from_handle: 'dispatch:d-A' },
    { id: 'c', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 は人の判断が要る' },
  ];
  assert.deepEqual(routeDelivery({ deliveryId: null, messages: msgs }).items.map((i) => i.action), ['notice-unmarked', 'worker-done', 'tell-now']);
});

// ---- themeCandidates ----

type ThemeInput = Parameters<typeof themeCandidates>[0];
type Ledger = ThemeInput['ledgerFleets'];

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});

// Epic 50・60・70 の子はどれも「選ぶ」。80 の子は「選ぶ」が無い（依存待ち）
const STATUS = statusData([
  row(51), row(52, { selected: false, waitReason: 'Depends on #51' }),
  row(61, { overlaps: [71] }),
  row(71, { overlaps: [61] }),
  row(81, { selected: false, waitReason: 'Depends on #999' }),
]);
const CHILDREN: Record<string, number[]> = { '50': [51, 52], '60': [61], '70': [71], '80': [81] };
const FLEET_ON_50 = [{ theme: 'a', epic: 50, dispatch: 'd-A', session: 's-A', issues: [51] }] as Ledger;

const base: ThemeInput = {
  status: STATUS, ledgerFleets: [], stoppedEpics: [], epicChildren: CHILDREN, issues: [], liveFleets: 0, maxFleets: 5,
};

const themeCases: { name: string; input: Partial<ThemeInput>; epics: number[]; slots: number; judge: 'theme' | null }[] = [
  { name: '候補2つ以上・空きあり → theme', input: {}, epics: [50, 60, 70], slots: 5, judge: 'theme' },
  { name: '控えの fleet の Epic は除く', input: { ledgerFleets: FLEET_ON_50, liveFleets: 1 }, epics: [60, 70], slots: 4, judge: 'theme' },
  { name: 'stoppedEpics は除く', input: { stoppedEpics: [60] }, epics: [50, 70], slots: 5, judge: 'theme' },
  { name: '候補1つ → judge null', input: { stoppedEpics: [60, 70] }, epics: [50], slots: 5, judge: null },
  { name: '候補0 → judge null', input: { stoppedEpics: [50, 60, 70] }, epics: [], slots: 5, judge: null },
  { name: '「選ぶ」の行が無い Epic だけ → 候補0', input: { epicChildren: { '80': [81] } }, epics: [], slots: 5, judge: null },
  { name: '空き1（maxFleets − liveFleets）→ theme', input: { liveFleets: 4 }, epics: [50, 60, 70], slots: 1, judge: 'theme' },
  { name: '空き0 → judge null（候補は返す）', input: { liveFleets: 5 }, epics: [50, 60, 70], slots: 0, judge: null },
  { name: '空きが負 → judge null', input: { liveFleets: 7 }, epics: [50, 60, 70], slots: -2, judge: null },
];

test('themeCandidates：候補の Epic・slots・judge', () => {
  for (const c of themeCases) {
    const r = themeCandidates({ ...base, ...c.input });
    assert.deepEqual(r.candidates.map((x) => x.epic).sort((a, b) => a - b), c.epics, `${c.name}：candidates`);
    assert.equal(r.slots, c.slots, `${c.name}：slots`);
    assert.equal(r.judge, c.judge, `${c.name}：judge`);
  }
});

const ISSUES: ThemeInput['issues'] = [
  { number: 50, title: 'Epic 50', labels: [{ name: 'epic' }] },
  { number: 51, title: 'Issue 51', labels: [{ name: 'priority:high' }, { name: 'area:harness' }, { name: 'priority:low' }] },
  { number: 52, title: 'Issue 52', labels: [{ name: 'type:feature' }] },
];

test('themeCandidates：Epic と子の title・priority・area（--issues に無ければ null、priority が複数なら最初）と子の行の欄', () => {
  const r = themeCandidates({ ...base, issues: ISSUES });
  const e50 = r.candidates.find((x) => x.epic === 50);
  assert.ok(e50);
  assert.equal(e50.title, 'Epic 50');
  const c51 = e50.children.find((x) => x.issue === 51);
  const c52 = e50.children.find((x) => x.issue === 52);
  assert.ok(c51 && c52);
  assert.deepEqual([c51.title, c51.priority, c51.area, c51.selected, c51.waitReason], ['Issue 51', 'high', 'harness', true, null]);
  assert.deepEqual([c52.title, c52.priority, c52.area, c52.selected, c52.waitReason], ['Issue 52', null, null, false, 'Depends on #51']);
  // 一覧に無い Epic と子
  const e60 = r.candidates.find((x) => x.epic === 60);
  assert.ok(e60);
  assert.equal(e60.title, null);
  const c61 = e60.children.find((x) => x.issue === 61);
  assert.ok(c61);
  assert.deepEqual([c61.title, c61.priority, c61.area, c61.overlaps], [null, null, null, [71]]);
});

test('themeCandidates：issues が空なら title・priority・area はすべて null', () => {
  const r = themeCandidates(base);
  for (const cand of r.candidates) {
    assert.equal(cand.title, null, `Epic ${cand.epic}`);
    for (const ch of cand.children) assert.deepEqual([ch.title, ch.priority, ch.area], [null, null, null], `#${ch.issue}`);
  }
});

// ---- CLI（themes の1件だけ） ----

test('CLI themes：ファイルを読み、{ slots, candidates, judge } を JSON で標準出力に書く', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-decide-themes-'));
  try {
    const status = join(dir, 'status.json');
    const children = join(dir, 'children.json');
    const issues = join(dir, 'issues.json');
    const ledger = join(dir, 'ledger.json');
    writeFileSync(status, JSON.stringify(STATUS));
    writeFileSync(children, JSON.stringify(CHILDREN));
    writeFileSync(issues, JSON.stringify(ISSUES));
    writeFileSync(ledger, JSON.stringify({ fleets: FLEET_ON_50, stoppedEpics: [70] }));
    const r = spawnSync(
      process.execPath,
      ['harness/scripts/hq-decide.ts', 'themes', '--fleet-status', status, '--epic-children', children, '--issues', issues, '--live-fleets', '1', '--ledger', ledger],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    // 50 は控えの fleet、70 は控えの stoppedEpics、80 は「選ぶ」が無い → 残るのは 60 だけ
    assert.deepEqual(out.candidates.map((c: { epic: number }) => c.epic), [60]);
    assert.equal(out.judge, null);
    assert.equal(out.slots, hqConfig(loadConfig()).maxFleets - 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
