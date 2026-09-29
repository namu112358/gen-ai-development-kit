// Issue #243：fleet の進め方（入れ子の orca／交互の flat）を harness.config.json の fleet で決め、既定は orca。
// 同時に動かす ship の数は --max（無ければ maxParallelShips）までで、fleet-status の表の末尾にその上限を出す。
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_DEFAULTS, fleetConfig, loadConfig, type HarnessConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue } from '../lib/fleet.ts';
import type { IssueFacts } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
const config = loadConfig();

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const fi = (facts: IssueFacts, planFiles: string[] | null = null): FleetIssue => ({ facts, closed: false, planFiles, prs: [] });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const MODE_LINE = /^進め方：/;

// ---- config.ts：fleetConfig ----

test('fleetConfig：fleet が無ければ既定値（nesting は orca、maxParallelShips は 3）', () => {
  assert.deepEqual(FLEET_DEFAULTS, { nesting: 'orca', maxParallelShips: 3 });
  assert.deepEqual(fleetConfig({}), { nesting: 'orca', maxParallelShips: 3 });
  assert.deepEqual(fleetConfig({ fleet: {} }), { nesting: 'orca', maxParallelShips: 3 });
});

test('fleetConfig：書いた項目はその値、無い項目は既定値', () => {
  assert.deepEqual(fleetConfig({ fleet: { nesting: 'flat' } }), { nesting: 'flat', maxParallelShips: 3 });
  assert.deepEqual(fleetConfig({ fleet: { maxParallelShips: 5 } }), { nesting: 'orca', maxParallelShips: 5 });
  assert.deepEqual(fleetConfig({ fleet: { nesting: 'orca', maxParallelShips: 1 } }), { nesting: 'orca', maxParallelShips: 1 });
});

test('fleetConfig：nesting が orca・flat 以外なら throw する', () => {
  for (const nesting of ['nested', 'ORCA', '', 1, null]) {
    const c = { fleet: { nesting } } as unknown as Pick<HarnessConfig, 'fleet'>;
    assert.throws(() => fleetConfig(c), { message: 'fleet.nesting は orca か flat で書いてください' }, String(nesting));
  }
});

test('fleetConfig：maxParallelShips が正の整数でなければ throw する', () => {
  for (const maxParallelShips of [0, -1, 1.5, '3', Number.NaN, null]) {
    const c = { fleet: { maxParallelShips } } as unknown as Pick<HarnessConfig, 'fleet'>;
    assert.throws(() => fleetConfig(c), { message: 'fleet.maxParallelShips は正の整数で書いてください' }, String(maxParallelShips));
  }
});

test('harness.config.json と雛形の fleet は読めて、nesting は orca', () => {
  assert.equal(fleetConfig(config).nesting, 'orca');
  assert.ok(Number.isInteger(fleetConfig(config).maxParallelShips) && fleetConfig(config).maxParallelShips > 0);
  const template = loadConfig(join(root, 'harness', 'templates', 'harness.config.json'));
  assert.equal(fleetConfig(template).nesting, 'orca');
  assert.ok(template.fleet !== undefined, '雛形に fleet の設定がある');
});

// ---- fleet.ts：renderFleetStatus の進め方の行 ----

const f = facts([fi(planOk(1), ['a.ts']), fi(planOk(2), ['b.ts'])]);
const rows = fleetStatus(f);

test('renderFleetStatus：mode を渡さなければ今と同じ出力（進め方の行は無い）', () => {
  const sel = selectFleet(config, f, rows, null);
  const table = renderFleetStatus(rows, sel, null);
  assert.equal(table.split('\n').filter((l) => MODE_LINE.test(l)).length, 0);
  assert.equal(table.split('\n').at(-1), `選んだ数：${sel.selected.length}（衝突しない範囲で本数を制限しない。絞るときは --max）`);
  assert.equal(renderFleetStatus(rows, sel, null, undefined), table);
});

test('renderFleetStatus：orca で --max が無ければ、末尾に maxParallelShips を上限として出す', () => {
  const sel = selectFleet(config, f, rows, null);
  const table = renderFleetStatus(rows, sel, null, { nesting: 'orca', maxParallelShips: 3 });
  const lines = table.split('\n');
  assert.equal(lines.at(-1), '進め方：入れ子（orca）。ship をサブエージェントで並行に動かす。同時に動かす ship は 3 まで');
  assert.equal(lines.at(-2), `選んだ数：${sel.selected.length}（衝突しない範囲で本数を制限しない。絞るときは --max）`, '選んだ数の行はそのまま残る');
  assert.equal(table, `${renderFleetStatus(rows, sel, null)}\n${lines.at(-1)}`, '末尾に1行足すだけ');
});

test('renderFleetStatus：orca で --max があれば、--max を上限として出す', () => {
  const sel = selectFleet(config, f, rows, 1);
  const table = renderFleetStatus(rows, sel, 1, { nesting: 'orca', maxParallelShips: 3 });
  assert.equal(table.split('\n').at(-1), '進め方：入れ子（orca）。ship をサブエージェントで並行に動かす。同時に動かす ship は 1 まで');
  assert.equal(sel.selected.length, 1, '--max を超えて選ばない');
});

test('renderFleetStatus：flat なら交互の方式の行を出し、上限は出さない', () => {
  const sel = selectFleet(config, f, rows, null);
  const table = renderFleetStatus(rows, sel, null, { nesting: 'flat', maxParallelShips: 3 });
  assert.equal(table.split('\n').at(-1), '進め方：交互（flat）。1つのセッションで段階を交互に進める');
  assert.equal(table.split('\n').filter((l) => MODE_LINE.test(l)).length, 1);
});

test('renderFleetStatus：harness.config.json の設定（fleetConfig）を渡すと orca の行になる', () => {
  const sel = selectFleet(config, f, rows, null);
  const mode = fleetConfig(config);
  assert.equal(renderFleetStatus(rows, sel, null, mode).split('\n').at(-1), `進め方：入れ子（orca）。ship をサブエージェントで並行に動かす。同時に動かす ship は ${mode.maxParallelShips} まで`);
});
