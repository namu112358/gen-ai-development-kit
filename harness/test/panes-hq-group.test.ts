// Issue #552：hq の Epic/Issue のペイン（panes-hq.ts）と mod のペイン（panes.ts hq board --json）が使う、
// ただ1つの組み分け groupByEpic を確かめる。親の Epic の下に行を入れること、Epic の無い行を none に入れること、
// Epic 自身の Issue 番号の行を none に入れないこと、Epic の番号順、snap.epics の state を持つこと、
// スナップショットの無い fleet の Epic は state が null であることを見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStage, type FleetStatusRow } from '../lib/fleet.ts';
import type { PaneEpic, PaneSnapshot } from '../lib/panes.ts';
import { groupByEpic, type HqFleet, type HqFleetView, type HqView } from '../lib/panes-hq.ts';

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

// fleet A：Epic #520（OPEN）の下に #519・#508。#520 自身も行にある（親なし）。#600 は Epic なし。
// fleet B：Epic #392（CLOSED）の下に #400。fleet C：スナップショットが無い（起動中）、Epic #300。
const view = (): HqView => ({
  ledger: true,
  fleets: [
    fv(fleet('A', 's-a', 520), snap('s-a', [row(519), row(508, 'merged', 50), row(520), row(600)], [epic(520, [[519, 'OPEN'], [508, 'CLOSED']])], { 519: 520, 508: 520, 520: null, 600: null })),
    fv(fleet('B', 's-b', 392), snap('s-b', [row(400, 'merged', 40)], [epic(392, [[400, 'CLOSED']], 'CLOSED')], { 400: 392 })),
    fv(fleet('C', null, 300), null, 'starting'),
  ],
});

const issues = (rows: { row: FleetStatusRow }[]): number[] => rows.map(({ row: r }) => r.issue);

test('groupByEpic：Epic は番号順で、行は親の Epic の下に入る', () => {
  const { epics } = groupByEpic(view());
  assert.deepEqual(epics.map((g) => g.number), [300, 392, 520]);
  const by = new Map(epics.map((g) => [g.number, g]));
  assert.deepEqual(issues(by.get(520)!.rows), [519, 508]);
  assert.deepEqual(issues(by.get(392)!.rows), [400]);
  assert.deepEqual(issues(by.get(300)!.rows), []);
});

test('groupByEpic：Epic の無い行は none に入り、Epic 自身の Issue 番号の行は none に入らない', () => {
  const { none } = groupByEpic(view());
  assert.deepEqual(issues(none), [600]);
});

test('groupByEpic：snap.epics の state を持ち、スナップショットの無い fleet の Epic は state が null', () => {
  const by = new Map(groupByEpic(view()).epics.map((g) => [g.number, g]));
  assert.deepEqual([300, 392, 520].map((n) => [n, by.get(n)!.state]), [[300, null], [392, 'CLOSED'], [520, 'OPEN']]);
});
