// Issue #519：panes.ts hq board --json（Claude Code の mod が読む、Epic/Issue のページの JSON）を確かめる。
// hqBoardJson が Epic（Close の数・人待ち・テーマ・終わったか）と Issue のまとまり（行・済みの番号・6つの記号）を、
// 終わったものを下に回して返すことと、控えが読めないときの形、CLI が version 1 の1行の JSON を出すことを見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FLEET_STAGES, type FleetStage, type FleetStatusRow } from '../lib/fleet.ts';
import type { PaneEpic, PaneSnapshot } from '../lib/panes.ts';
import type { HqFleet, HqFleetView, HqView } from '../lib/panes-hq.ts';
import { hqBoardJson } from '../scripts/panes.ts';

const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60000).toISOString();
const row = (issue: number, stage: FleetStage = 'plan-ok', pr: number | null = null): FleetStatusRow => ({
  issue, title: `feat(x): t${issue}`, pr, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const epic = (number: number, children: [number, 'OPEN' | 'CLOSED'][], state = 'OPEN'): PaneEpic => ({
  number, title: `Epic ${number}`, state, children: children.map(([n, s]) => ({ number: n, title: `c${n}`, state: s })),
});
const snap = (session: string, rows: FleetStatusRow[], epics: PaneEpic[], issueEpic: Record<string, number | null>): PaneSnapshot => ({
  version: 1, at: minutesAgo(1), session, label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: { version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null },
  prs: [], usage: null, history: [], epics, issueEpic,
  since: Object.fromEntries(rows.map((r) => [String(r.issue), { signature: 's', at: minutesAgo(3) }])), error: null,
});
const fleet = (theme: string, session: string | null, epicNo: number | null = null): HqFleet => ({ theme, epic: epicNo, session, startedAt: minutesAgo(1) });
const fv = (f: HqFleet, s: PaneSnapshot | null, state: HqFleetView['state'] = s ? 'ok' : 'starting'): HqFleetView => ({ fleet: f, snap: s, state });

// #392 は全部 CLOSED で終わり、#520 は動いている。#600 は Epic なしで全部 Merge 済み
const view = (): HqView => ({
  ledger: true,
  fleets: [
    fv(fleet('新しいテーマ', 's-a', 520), snap('s-a', [row(519, 'human-merge', 61), row(508, 'merged', 50)], [epic(520, [[519, 'OPEN'], [508, 'CLOSED']])], { 519: 520, 508: 520 })),
    fv(fleet('古いテーマ', 's-b', 392), snap('s-b', [row(400, 'merged', 40), row(600, 'merged', 41)], [epic(392, [[400, 'CLOSED']], 'CLOSED')], { 400: 392, 600: null })),
  ],
});

test('hqBoardJson：epics は done でないものが先で、Close の数・人待ち・テーマ・done を持つ。子課題が読めていない Epic は closed・total が null', () => {
  const v = view();
  v.fleets.push(fv(fleet('起動中', null, 300), null, 'starting'));
  const got = hqBoardJson(v, NOW);
  assert.equal(got.version, 1);
  assert.equal(got.ledger, true);
  assert.deepEqual(got.epics.map((e) => [e.number, e.done]), [[300, false], [520, false], [392, true]]);
  const e520 = got.epics.find((e) => e.number === 520)!;
  assert.deepEqual([e520.closed, e520.total, e520.waiting, e520.themes], [1, 2, 1, ['新しいテーマ']]);
  const e300 = got.epics.find((e) => e.number === 300)!;
  assert.deepEqual([e300.closed, e300.total, e300.title], [null, null, null]);
  assert.deepEqual(e300.themes, ['起動中（起動中）']);
});

test('hqBoardJson：groups は終わっていないものが先、終わった Epic・Epic なしが下。rows は Merge 済みを含まず、merged に番号、marks は6つ', () => {
  const got = hqBoardJson(view(), NOW);
  assert.deepEqual(got.groups.map((g) => [g.epic, g.done]), [[520, false], [392, true], [null, true]]);
  const g520 = got.groups[0]!;
  assert.deepEqual(g520.rows.map((r) => r.issue), [519]);
  assert.deepEqual(g520.merged, [508]);
  assert.equal(g520.rows[0]!.marks.length, 6);
  assert.equal(g520.rows[0]!.kind, 'human');
  assert.equal(g520.rows[0]!.pr, 61);
  assert.deepEqual(got.none, { issues: [600], done: true });
  assert.deepEqual(got.steps.length, 6);
});

test('hqBoardJson：控えが読めないときは ledger: false・空・warning', () => {
  const got = hqBoardJson({ ledger: false, fleets: [] }, NOW);
  assert.equal(got.ledger, false);
  assert.deepEqual([got.epics, got.groups, got.none], [[], [], null]);
  assert.ok(got.warning);
});

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'harness', 'scripts', 'panes.ts');

test('panes.ts hq board --json：1行の JSON（version 1）を出す', () => {
  const r = spawnSync(process.execPath, [script, 'hq', 'board', '--json', '--fleets', join(root, 'harness', 'test', 'no-such-hq-fleets.json')], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const got = JSON.parse(r.stdout) as { version: number; ledger: boolean };
  assert.equal(got.version, 1);
  assert.equal(got.ledger, false);
});
