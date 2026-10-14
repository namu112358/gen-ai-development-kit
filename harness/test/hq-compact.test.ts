// Issue #737：hq が fleet と hq 自身に /compact を送る条件の判定（harness/scripts/hq-compact.ts）と、間隔の定数 HQ_COMPACT_DEFAULTS の値（#1076）を確かめる。Orca・GitHub は起動しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStatusRow } from '../lib/fleet.ts';
import type { HqLedger } from '../scripts/hq-state.ts';
import {
  busyIssues, compactDecision, HQ_COMPACT_DEFAULTS, hqSelfDecision, maybeCompactHq, parseCompactFile, recordCompact, runFleetCompact, type CompactFile,
} from '../scripts/hq-compact.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const minsAgo = (m: number): string => new Date(NOW - m * MIN).toISOString();
const CM = HQ_COMPACT_DEFAULTS.compactMinutes;

const claim = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 's', own: false });
const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-ok', stageLabel: FLEET_STAGES['plan-ok'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
});

/** compactDecision に渡す busy・idle の偽物（呼ばれた回数を数える） */
function probes(busy: number[], idle: boolean | null) {
  const n = { busy: 0, idle: 0 };
  return { n, busy: () => { n.busy++; return busy; }, idle: () => { n.idle++; return idle; } };
}

// ---- HQ_COMPACT_DEFAULTS ----

test('HQ_COMPACT_DEFAULTS：/compact を送る間隔は 180 分', () => {
  assert.deepEqual(HQ_COMPACT_DEFAULTS, { compactMinutes: 180 });
});

// ---- compactDecision ----

test('compactDecision：基準から compactMinutes ちょうどで、busy なし・idle なら送る', () => {
  const p = probes([], true);
  const d = compactDecision({ now: NOW, lastAt: null, startedAt: minsAgo(CM), compactMinutes: CM, busy: p.busy, idle: p.idle });
  assert.equal(d.send, true);
  assert.equal(d.reason, 'due');
});

test('compactDecision：1分前は not-due で、busy・idle を呼ばない', () => {
  const p = probes([], true);
  const d = compactDecision({ now: NOW, lastAt: null, startedAt: minsAgo(CM - 1), compactMinutes: CM, busy: p.busy, idle: p.idle });
  assert.deepEqual([d.send, d.reason], [false, 'not-due']);
  assert.deepEqual(p.n, { busy: 0, idle: 0 });
});

test('compactDecision：基準は前に縮めた時刻と startedAt の新しいほう', () => {
  const p = probes([], true);
  // startedAt は古いが前に縮めたのが最近 → not-due
  assert.equal(compactDecision({ now: NOW, lastAt: minsAgo(10), startedAt: minsAgo(500), compactMinutes: CM, busy: p.busy, idle: p.idle }).reason, 'not-due');
  // 前に縮めたのは古いが起こし直したのが最近（startedAt が新しい）→ not-due
  assert.equal(compactDecision({ now: NOW, lastAt: minsAgo(500), startedAt: minsAgo(10), compactMinutes: CM, busy: p.busy, idle: p.idle }).reason, 'not-due');
});

test('compactDecision：基準が無ければ unknown-start で送らない', () => {
  const p = probes([], true);
  const d = compactDecision({ now: NOW, lastAt: null, startedAt: null, compactMinutes: CM, busy: p.busy, idle: p.idle });
  assert.deepEqual([d.send, d.reason], [false, 'unknown-start']);
});

test('compactDecision：busy なら busy、idle が偽なら not-idle で送らない', () => {
  const b = probes([12], true);
  const db = compactDecision({ now: NOW, lastAt: null, startedAt: minsAgo(CM), compactMinutes: CM, busy: b.busy, idle: b.idle });
  assert.deepEqual([db.send, db.reason, db.busy], [false, 'busy', [12]]);
  const i = probes([], false);
  const di = compactDecision({ now: NOW, lastAt: null, startedAt: minsAgo(CM), compactMinutes: CM, busy: i.busy, idle: i.idle });
  assert.deepEqual([di.send, di.reason], [false, 'not-idle']);
});

// ---- busyIssues ----

test('busyIssues：宣言の stage が plan-gate は数えず、implement の claim・prClaim・stage null は数える', () => {
  const rows = [
    row(1),
    row(2, { claim: claim('plan-gate') }),
    row(3, { claim: claim('implement') }),
    row(4, { prClaim: claim('judge'), stage: 'plan-gate' }),
    row(5, { claim: claim(null) }),
  ];
  assert.deepEqual(busyIssues(rows), [3, 4, 5]);
});

// ---- hqSelfDecision ----

test('hqSelfDecision：記録に今の hqSession が無ければ基準を now にして送らない', () => {
  let called = 0;
  const old: CompactFile = { version: 1, fleets: {}, hq: { session: 'sess-old', at: minsAgo(999), count: 2 } };
  for (const file of [null, old]) {
    const r = hqSelfDecision(file, 'sess-hq', NOW, CM, () => { called++; return true; });
    assert.equal(r.decision.send, false);
    assert.equal(r.file.hq?.session, 'sess-hq');
    assert.equal(r.file.hq?.at, new Date(NOW).toISOString());
  }
  assert.equal(called, 0);
});

test('hqSelfDecision：同じ session で compactMinutes 経ち idle なら送る', () => {
  const file: CompactFile = { version: 1, fleets: {}, hq: { session: 'sess-hq', at: minsAgo(CM), count: 0 } };
  const r = hqSelfDecision(file, 'sess-hq', NOW, CM, () => true);
  assert.deepEqual([r.decision.send, r.decision.reason], [true, 'due']);
});

// ---- recordCompact・parseCompactFile ----

test('recordCompact：初回は count 1、dispatch が変わっても count を引き継いで at・dispatch を新しくする', () => {
  const a = recordCompact(null, 'テーマA', 'd-1', minsAgo(100));
  assert.deepEqual(a.fleets['テーマA'], { at: minsAgo(100), count: 1, dispatch: 'd-1' });
  const b = recordCompact(a, 'テーマA', 'd-2', minsAgo(0));
  assert.deepEqual(b.fleets['テーマA'], { at: minsAgo(0), count: 2, dispatch: 'd-2' });
});

test('parseCompactFile：正しい形は読み、壊れた値は null', () => {
  const ok: CompactFile = { version: 1, fleets: { A: { at: minsAgo(1), count: 1, dispatch: 'd-1' } }, hq: { session: 's', at: minsAgo(2), count: 0 } };
  assert.deepEqual(parseCompactFile(ok), ok);
  for (const bad of [null, 'x', { version: 2, fleets: {}, hq: null }, { version: 1, fleets: { A: { at: 1, count: 'x', dispatch: 'd' } }, hq: null }, { version: 1, hq: null }]) {
    assert.equal(parseCompactFile(bad), null, JSON.stringify(bad));
  }
});

// ---- runFleetCompact ----

const ledger = (fleets: Record<string, unknown>[] = [{ theme: 'テーマA', dispatch: 'd-1', startedAt: minsAgo(CM), issues: [10, 11] }]): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null,
});

function fleetDeps(opts: { ledger?: HqLedger | null } = {}) {
  const sent: [string, string][] = [];
  const saved: CompactFile[] = [];
  const deps = {
    ledger: (): HqLedger | null => (opts.ledger === undefined ? ledger() : opts.ledger),
    record: (): CompactFile | null => null,
    saveRecord: (f: CompactFile): void => { saved.push(f); },
    fleetStatusRows: (_issues: number[]): FleetStatusRow[] | null => [row(10), row(11, { claim: claim('plan-gate') })],
    terminalOf: (_dispatch: string): string | null => 'term-a',
    idle: (_handle: string): boolean | null => true,
    send: (handle: string, text: string): boolean => { sent.push([handle, text]); return true; },
    now: (): number => NOW,
  };
  return { deps, sent, saved };
}

test('runFleetCompact：条件がそろえば fleet の端末に /compact を送り、記録する', async () => {
  const f = fleetDeps();
  const r = await runFleetCompact(f.deps, 'テーマA', { dryRun: false, compactMinutes: CM });
  assert.deepEqual([r.theme, r.decision.reason, r.sent], ['テーマA', 'due', true]);
  assert.equal(f.sent.length, 1);
  const [handle, text] = f.sent[0] ?? ['', ''];
  assert.equal(handle, 'term-a');
  assert.match(text, /^\/compact /);
  assert.deepEqual(f.saved.at(-1)?.fleets['テーマA'], { at: new Date(NOW).toISOString(), count: 1, dispatch: 'd-1' });
});

test('runFleetCompact：dryRun は判定だけで、送らず記録もしない', async () => {
  const f = fleetDeps();
  const r = await runFleetCompact(f.deps, 'テーマA', { dryRun: true, compactMinutes: CM });
  assert.deepEqual([r.decision.reason, r.sent], ['due', false]);
  assert.deepEqual([f.sent.length, f.saved.length], [0, 0]);
});

test('runFleetCompact：控えにテーマが無ければ unknown-start で送らない', async () => {
  const f = fleetDeps();
  const r = await runFleetCompact(f.deps, '無いテーマ', { dryRun: false, compactMinutes: CM });
  assert.deepEqual([r.decision.send, r.decision.reason, r.sent], [false, 'unknown-start', false]);
  assert.deepEqual([f.sent.length, f.saved.length], [0, 0]);
});

// ---- maybeCompactHq ----

test('maybeCompactHq：send が投げても false でも投げずに compacted: false を返す', async () => {
  const sends: Array<() => boolean> = [() => { throw new Error('orca が無い'); }, () => false];
  for (const send of sends) {
    const deps = {
      ledger: (): HqLedger | null => ledger(),
      record: (): CompactFile | null => ({ version: 1, fleets: {}, hq: { session: 'sess-hq', at: minsAgo(CM), count: 0 } }),
      saveRecord: (_f: CompactFile): void => {},
      idle: (_h: string): boolean | null => true,
      send: (_h: string, _t: string): boolean => send(),
      waitIdle: (_h: string): boolean | null => true,
      now: (): number => NOW,
    };
    const r = await maybeCompactHq(deps, null, CM);
    assert.equal(r.compacted, false);
  }
});
