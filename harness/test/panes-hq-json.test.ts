// Issue #508：panes.ts hq todo --json（Claude Code の mod が読む、人待ちの1行の JSON）を確かめる。
// hqTodoJson が全 fleet の人がすることを rank 順に集めて件数・注意・控えが読めないときの形を返すことと、
// CLI が version 1 の1行の JSON を出し、todo 以外の --json は誤りで止まることを見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FLEET_STAGES, type FleetStage, type FleetStatusRow } from '../lib/fleet.ts';
import type { PaneSnapshot } from '../lib/panes.ts';
import type { HqFleet, HqFleetView, HqView } from '../lib/panes-hq.ts';
import { hqTodoJson } from '../scripts/panes.ts';

const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60000).toISOString();
const row = (issue: number, stage: FleetStage, pr: number | null = null): FleetStatusRow => ({
  issue, title: `t${issue}`, pr, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const snap = (session: string, rows: FleetStatusRow[]): PaneSnapshot => ({
  version: 1, at: minutesAgo(1), session, label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: { version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null },
  prs: [], usage: null, history: [],
  since: Object.fromEntries(rows.map((r) => [String(r.issue), { signature: 's', at: minutesAgo(3) }])), error: null,
});
const fleet = (theme: string, session: string | null): HqFleet => ({ theme, epic: null, session, startedAt: minutesAgo(1) });
const fv = (f: HqFleet, s: PaneSnapshot | null, state: HqFleetView['state'] = s ? 'ok' : 'starting'): HqFleetView => ({ fleet: f, snap: s, state });

test('hqTodoJson：全 fleet の人がすることを theme つきで rank 順に集め、count は件数', () => {
  const a = snap('s-a', [row(12, 'plan-review'), row(13, 'plan-ok')]);
  const b = snap('s-b', [row(22, 'human-merge', 50)]);
  const got = hqTodoJson({ ledger: true, fleets: [fv(fleet('ペイン', 's-a'), a), fv(fleet('判定', 's-b'), b)] }, NOW);
  assert.equal(got.version, 1);
  assert.equal(got.ledger, true);
  assert.equal(got.count, got.items.length);
  assert.deepEqual(got.items.map((i) => i.issue), [22, 12], '人の Merge 待ちが計画の判断待ちより先');
  assert.deepEqual(got.items.map((i) => i.theme), ['判定', 'ペイン']);
  assert.equal(got.items[0]!.pr, 50);
  assert.equal(got.warning, null);
});

test('hqTodoJson：人がすることが無い・スナップショットが無い fleet は項目0で、注意を warning に入れる', () => {
  const view: HqView = { ledger: true, fleets: [fv(fleet('a', 's-a'), snap('s-a', [row(11, 'plan-ok')])), fv(fleet('テーマB', 's-b'), null, 'missing')] };
  const got = hqTodoJson(view, NOW);
  assert.equal(got.count, 0);
  assert.deepEqual(got.items, []);
  assert.match(got.warning ?? '', /テーマB/);
});

test('hqTodoJson：控えが読めないときは ledger: false・count 0・warning', () => {
  const got = hqTodoJson({ ledger: false, fleets: [] }, NOW);
  assert.equal(got.ledger, false);
  assert.equal(got.count, 0);
  assert.deepEqual(got.items, []);
  assert.ok(got.warning);
});

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'harness', 'scripts', 'panes.ts');
const missingLedger = join(root, 'harness', 'test', 'no-such-hq-fleets.json');
const cli = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });

test('panes.ts hq todo --json：1行の JSON（version 1）を出す', () => {
  const r = cli(['hq', 'todo', '--json', '--fleets', missingLedger]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  const got = JSON.parse(r.stdout) as { version: number; ledger: boolean; count: number };
  assert.equal(got.version, 1);
  assert.equal(got.ledger, false);
  assert.equal(got.count, 0);
});

test('panes.ts hq board --json は誤りで止まる', () => {
  const r = cli(['hq', 'board', '--json', '--fleets', missingLedger]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--json/);
});
