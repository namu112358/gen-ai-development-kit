// Issue #517：Claude Code の status line に出す1行（panes.ts の fleetStatusLine と `line` のコマンド）を確かめる。
// 段階の読み替え（locateRow）そのものは panes.test.ts が確かめるので、ここは1行の組み立てと古いときの末尾、CLI の出力だけ。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import type { PaneSnapshot } from '../lib/panes.ts';
import { fleetStatusLine } from '../scripts/panes.ts';

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const claim = (stage: string, own: boolean): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess', own });
const data = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null,
});
const snap = (rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: '2026-10-09T00:00:00.000Z', session: 'sess-1', label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: data(rows), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});
const NOW = Date.parse('2026-10-09T00:01:00.000Z');

test('fleetStatusLine：実装・ゲート（人）・待ち・他・済・停止を1行にする', () => {
  const rows = [
    row(1, { claim: claim('implement', true) }),
    row(2, { stage: 'plan-review' }),
    row(3, { stage: 'plan-ok', selected: false, waitReason: '領域の上限' }),
    row(4, { claim: claim('judge', false), stage: 'judge' }),
    row(5, { stage: 'merged' }),
    row(6, { stage: 'stopped', note: '手動で止めた' }),
  ];
  assert.equal(
    fleetStatusLine(snap(rows), NOW),
    'fleet #1 実装 · #2 ゲート（人） · #3 実装（待ち） · #4 判定（他） · #5 済 · #6 停止（人）',
  );
});

test('fleetStatusLine：スナップショットが無い・status が無い・行が無いときは null', () => {
  assert.equal(fleetStatusLine(null, NOW), null);
  assert.equal(fleetStatusLine(snap([row(1)], { status: null }), NOW), null);
  assert.equal(fleetStatusLine(snap([]), NOW), null);
});

test('fleetStatusLine：古いスナップショットは末尾に更新の時刻を足す', () => {
  const s = snap([row(1)], { intervalSeconds: 10 });
  assert.match(fleetStatusLine(s, NOW) ?? '', / · 更新 1分前$/);
  assert.doesNotMatch(fleetStatusLine(snap([row(1)]), NOW) ?? '', /更新/);
});

test('line コマンド：--snapshot のスナップショットから1行を出し、読めなければ何も出さず終了コード 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panes-line-'));
  const file = join(dir, 's.json');
  writeFileSync(file, JSON.stringify(snap([row(7, { claim: claim('implement', true) })], { at: new Date().toISOString() })));
  const run = (path: string) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'panes.ts'), 'line', '--snapshot', path], { encoding: 'utf8' });
  const ok = run(file);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'fleet #7 実装');
  const none = run(join(dir, 'missing.json'));
  assert.equal(none.status, 0);
  assert.equal(none.stdout, '');
});
