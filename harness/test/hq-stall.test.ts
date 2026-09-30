// Issue #287：hq が進んでいない fleet を見つける判定（harness/lib/hq-stall.ts）と、それを JSON で出す `panes.ts fleets` を確かめる。
// しきい値 hq.staleSnapshotMinutes・hq.stuckMinutes の既定値と不正な値（人の決定）、スナップショットの古さと AI の番の行の長さの境界、
// `--session` で渡したセッションだけを読むこと（無いものは missing）、`--session` なしで止まることを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { HQ_STALL_DEFAULTS, fleetStall, hqStallConfig, missingFleet } from '../lib/hq-stall.ts';
import type { PaneSince, PaneSnapshot } from '../lib/panes.ts';

const root = join(import.meta.dirname, '..', '..');
const PANES = join(root, 'harness', 'scripts', 'panes.ts');

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const own = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-1', own: true });
const other = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-other', own: false });

const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const MIN = 60000;
/** NOW から m 分前の ISO */
const minsAgo = (m: number): string => new Date(NOW - m * MIN).toISOString();
const sinceOf = (entries: [number, number][]): PaneSince => Object.fromEntries(entries.map(([issue, m]) => [String(issue), { signature: 'x', at: minsAgo(m) }]));

const snap = (rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: minsAgo(1), session: 'sess-1', label: 'テーマA', intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: statusData(rows), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});

const CFG = { staleSnapshotMinutes: 30, stuckMinutes: 120 };

// ---- hqStallConfig：既定値 ----

test('HQ_STALL_DEFAULTS：staleSnapshotMinutes 30・stuckMinutes 120', () => {
  assert.deepEqual(HQ_STALL_DEFAULTS, { staleSnapshotMinutes: 30, stuckMinutes: 120 });
});

test('hqStallConfig：hq が無い・空なら既定値', () => {
  assert.deepEqual(hqStallConfig({}), { staleSnapshotMinutes: 30, stuckMinutes: 120 });
  assert.deepEqual(hqStallConfig({ hq: {} }), { staleSnapshotMinutes: 30, stuckMinutes: 120 });
});

test('hqStallConfig：hq.maxFleets だけがあっても既定値（maxFleets は hqConfig が読む）', () => {
  assert.deepEqual(hqStallConfig({ hq: { maxFleets: 4 } }), { staleSnapshotMinutes: 30, stuckMinutes: 120 });
});

test('hqStallConfig：書いた値を読み、書いていない方は既定値', () => {
  assert.deepEqual(hqStallConfig({ hq: { staleSnapshotMinutes: 10 } }), { staleSnapshotMinutes: 10, stuckMinutes: 120 });
  assert.deepEqual(hqStallConfig({ hq: { stuckMinutes: 45 } }), { staleSnapshotMinutes: 30, stuckMinutes: 45 });
  assert.deepEqual(hqStallConfig({ hq: { maxFleets: 2, staleSnapshotMinutes: 1, stuckMinutes: 1 } }), { staleSnapshotMinutes: 1, stuckMinutes: 1 });
});

// ---- hqStallConfig：不正な値 ----

test('hqStallConfig：staleSnapshotMinutes・stuckMinutes が正の整数でなければ throw する', () => {
  for (const key of ['staleSnapshotMinutes', 'stuckMinutes']) {
    for (const v of [0, -1, 1.5, '30', null]) {
      assert.throws(() => hqStallConfig({ hq: { [key]: v } }), Error, `${key}=${String(v)}`);
    }
  }
});

test('hqStallConfig：hq がオブジェクトでなければ throw する', () => {
  for (const hq of [null, 1, 'x', true, [] as unknown[]]) {
    assert.throws(() => hqStallConfig({ hq }), Error, JSON.stringify(hq));
  }
});

// ---- fleetStall：スナップショットの古さ ----

test('fleetStall：session・label・totalUsd をスナップショットから写す', () => {
  const s = fleetStall(snap([], { session: 'abc', label: 'テーマB', usage: { totalUsd: 1.25, perModel: {} } }), NOW, CFG);
  assert.equal(s.session, 'abc');
  assert.equal(s.label, 'テーマB');
  assert.equal(s.totalUsd, 1.25);
  assert.equal(s.missing, undefined);
});

test('fleetStall：usage が無ければ totalUsd は null', () => {
  assert.equal(fleetStall(snap([], { usage: null }), NOW, CFG).totalUsd, null);
});

test('fleetStall：スナップショットの at が staleSnapshotMinutes 以上前なら staleSnapshot（境界は「以上」）', () => {
  const before = fleetStall(snap([], { at: minsAgo(29) }), NOW, CFG);
  assert.equal(before.staleSnapshot, false);
  assert.equal(before.stalled, false);
  const at = fleetStall(snap([], { at: minsAgo(30) }), NOW, CFG);
  assert.equal(at.staleSnapshot, true);
  assert.equal(at.stalled, true);
  const after = fleetStall(snap([], { at: minsAgo(31) }), NOW, CFG);
  assert.equal(after.staleSnapshot, true);
  assert.equal(after.snapshotAgeMinutes, 31);
});

test('fleetStall：しきい値は cfg に従う', () => {
  const s = fleetStall(snap([], { at: minsAgo(10) }), NOW, { staleSnapshotMinutes: 10, stuckMinutes: 120 });
  assert.equal(s.staleSnapshot, true);
});

// ---- fleetStall：進んでいない行 ----

test('fleetStall：AI の番の行の since が stuckMinutes 以上前なら stuck（境界は「以上」）', () => {
  const rows = [row(1), row(2), row(3)];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 119], [2, 120], [3, 180]]) }), NOW, CFG);
  assert.deepEqual(s.stuck?.map((x) => x.issue).sort(), [2, 3]);
  assert.deepEqual(s.stuck?.find((x) => x.issue === 2)?.minutes, 120);
  assert.deepEqual(s.stuck?.find((x) => x.issue === 3)?.minutes, 180);
  assert.equal(s.staleSnapshot, false);
  assert.equal(s.stalled, true, 'stuck があれば stalled');
});

test('fleetStall：自分の宣言で AI が作業中の行（implement・judge など）も stuck に入る', () => {
  const rows = [row(1, { claim: own('implement') }), row(2, { stage: 'judge', pr: 50, prClaim: own('judge') })];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 200], [2, 200]]) }), NOW, CFG);
  assert.deepEqual(s.stuck?.map((x) => x.issue).sort(), [1, 2]);
});

test('fleetStall：人の番・App の番・待ち・終わった行は、長くても stuck に入れない', () => {
  const rows = [
    row(1, { stage: 'human-merge', pr: 50 }), // human
    row(2, { stage: 'plan-review' }), // human
    row(3, { stage: 'plan-gate' }), // app
    row(4, { stage: 'auto-merge', pr: 51 }), // app
    row(5, { stage: 'plan-ok', selected: false, waitReason: '重なり #1' }), // wait
    row(6, { stage: 'merged' }), // done
  ];
  const s = fleetStall(snap(rows, { since: sinceOf(rows.map((r) => [r.issue, 600] as [number, number])) }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：ほかのセッションの宣言の行（other）は stuck に入れない', () => {
  const rows = [row(1, { claim: other('implement') })];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 600]]) }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：since が無い行・at が読めない行は stuck に入れない', () => {
  const rows = [row(1), row(2)];
  const since: PaneSince = { '2': { signature: 'x', at: 'not-a-date' } };
  const s = fleetStall(snap(rows, { since }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：fleet-status が読めていない（status が null）なら stuck は空', () => {
  const s = fleetStall(snap([], { status: null }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
});

test('fleetStall：stuckMinutes は cfg に従う', () => {
  const s = fleetStall(snap([row(1)], { since: sinceOf([[1, 45]]) }), NOW, { staleSnapshotMinutes: 30, stuckMinutes: 45 });
  assert.deepEqual(s.stuck?.map((x) => x.issue), [1]);
});

// ---- missingFleet ----

test('missingFleet：{ session, missing: true, stalled: true }', () => {
  assert.deepEqual(missingFleet('abc'), { session: 'abc', missing: true, stalled: true });
});

// ---- CLI：panes.ts fleets ----

/** OS の一時ディレクトリを dir に差し替えて panes.ts を動かす */
function runPanes(dir: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir };
  return spawnSync(process.execPath, [PANES, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
}

function writeSnap(dir: string, s: PaneSnapshot): void {
  const d = join(dir, 'agent-harness-panes');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${s.session}.json`), JSON.stringify(s));
}

test('panes.ts fleets：--session で渡したセッションのスナップショットだけを読み、FleetStall の配列を JSON で出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-stall-'));
  try {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 24 * 60 * MIN).toISOString();
    writeSnap(dir, snap([row(1)], { session: 'fleetA', label: 'テーマA', at: recent, since: { '1': { signature: 'x', at: recent } } }));
    writeSnap(dir, snap([row(2)], { session: 'fleetB', label: 'テーマB', at: old, usage: { totalUsd: 3.5, perModel: {} } }));
    writeSnap(dir, snap([], { session: 'fleetOld', at: old })); // 渡さないセッションは読まない
    const r = runPanes(dir, ['fleets', '--session', 'fleetA', '--session', 'fleetB', '--session', 'fleetGone']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { session: string; missing?: boolean; label?: string | null; staleSnapshot?: boolean; stalled: boolean; totalUsd?: number | null }[];
    assert.ok(Array.isArray(out));
    assert.deepEqual(out.map((x) => x.session), ['fleetA', 'fleetB', 'fleetGone']);
    const [a, b, gone] = out;
    assert.equal(a!.label, 'テーマA');
    assert.equal(a!.staleSnapshot, false);
    assert.equal(a!.stalled, false);
    assert.equal(b!.staleSnapshot, true, '既定の 30 分より古い');
    assert.equal(b!.stalled, true);
    assert.equal(b!.totalUsd, 3.5);
    assert.deepEqual(gone, { session: 'fleetGone', missing: true, stalled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('panes.ts fleets：--session が無ければ終了コード 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-stall-'));
  try {
    writeSnap(dir, snap([], { session: 'fleetA' }));
    const r = runPanes(dir, ['fleets']);
    assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', '使い方を示す');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
