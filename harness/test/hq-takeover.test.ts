// Issue #770（#941 で priorSessions の要素を { session, at } に、takeoverDecision に now・staleHours を足した）：hq が自分で起こした fleet の着手宣言を人に聞かずに引き継ぐための、控えの前のセッション（priorSessions）を
// 残す処理（hq-state.ts の carryPriorSessions・ledger-save）と、読む処理（hq-decide.ts の takeoverDecision・takeover）を確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { takeoverDecision, type TakeoverResult } from '../scripts/hq-decide.ts';
import { carryPriorSessions, PRIOR_SESSIONS_LIMIT, type HqLedger, type PriorSession } from '../scripts/hq-state.ts';

const root = join(import.meta.dirname, '..', '..');
const ledger = (fleets: Record<string, unknown>[], patch: Partial<HqLedger> = {}): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null, ...patch,
});
const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-ok', stageLabel: FLEET_STAGES['plan-ok'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
});
const claim = (session: string | null, stage = 'implement', own = false): FleetClaimInfo => ({ by: 'manual', stage, session, own });
const status = (rows: FleetStatusRow[]): FleetStatusData => ({ version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null });
const tc = (issue: number, session: string | null, pr: number | null = null, stage = 'implement') => ({ issue, pr, stage, session });
// priorSessions の要素（#941：控えに入れた時刻 at を持つ）。既定の at は NOW の1時間前（STALE_HOURS 以内）
const NOW = new Date('2026-10-13T12:00:00.000Z');
const STALE_HOURS = 24;
const FRESH = new Date(NOW.getTime() - 3_600_000).toISOString();
const ps = (session: string, at: string | null = FRESH): PriorSession => ({ session, at });

// テーマ T の今の fleet は s-cur、前のセッションは s-old。テーマ U の fleet は s-u（別テーマ）
const known = ledger([{ theme: 'T', dispatch: 'd-T', session: 's-cur' }, { theme: 'U', dispatch: 'd-U', session: 's-u' }], { priorSessions: { T: [ps('s-old')], U: [ps('s-u-old')] } });

const decisions: { name: string; rows: FleetStatusRow[]; ledger: HqLedger | null; want: Omit<TakeoverResult, 'theme'> }[] = [
  {
    name: '控えの今の session と priorSessions の宣言だけ（claim と prClaim、own は数えない）→ auto',
    rows: [row(1, { claim: claim('s-cur') }), row(2, { pr: 90, prClaim: claim('s-old', 'judge') }), row(3, { claim: claim('sess-hq', 'implement', true) })],
    ledger: known,
    want: { decision: 'auto', known: [tc(1, 's-cur'), tc(2, 's-old', 90, 'judge')], unknown: [] },
  },
  {
    name: '控えに無い・別テーマ・session が null の宣言が混ざる → ask（known と unknown に分ける）',
    rows: [row(1, { claim: claim('s-old') }), row(2, { claim: claim('stranger') }), row(3, { claim: claim('s-u') }), row(4, { claim: claim('s-u-old') }), row(5, { claim: claim(null) }), row(6, { claim: claim('sess-hq', 'implement', true) })],
    ledger: known,
    want: { decision: 'ask', known: [tc(1, 's-old')], unknown: [tc(2, 'stranger'), tc(3, 's-u'), tc(4, 's-u-old'), tc(5, null)] },
  },
  {
    name: '控えが null → 全部 unknown',
    rows: [row(1, { claim: claim('s-cur') }), row(2, { pr: 91, prClaim: claim('s-old', 'fix') })],
    ledger: null,
    want: { decision: 'ask', known: [], unknown: [tc(1, 's-cur'), tc(2, 's-old', 91, 'fix')] },
  },
  {
    name: '宣言が無い（own の宣言だけも含む）→ none',
    rows: [row(1), row(2, { claim: claim('sess-hq', 'implement', true) })],
    ledger: known,
    want: { decision: 'none', known: [], unknown: [] },
  },
];

test('takeoverDecision：控えの前のセッションの宣言だけなら auto、控えに無い宣言があれば ask、宣言が無ければ none', () => {
  for (const c of decisions) assert.deepEqual(takeoverDecision({ theme: 'T', status: status(c.rows), ledger: c.ledger, now: NOW, staleHours: STALE_HOURS }), { theme: 'T', ...c.want }, c.name);
});

const many = Array.from({ length: PRIOR_SESSIONS_LIMIT }, (_, i) => ps(`p${i}`));
// 比べるときは session だけを順を問わずに見て、空の鍵は無いものとして見る（at は hq-takeover-expiry.test.ts で確かめる）
const prior = (l: HqLedger): Record<string, string[]> | undefined => {
  const p = l.priorSessions as Record<string, PriorSession[]> | undefined;
  if (!p) return undefined;
  const e = Object.entries(p).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.map((x) => x.session).sort()]);
  return e.length === 0 ? undefined : Object.fromEntries(e);
};
const carries: { name: string; prev: HqLedger | null; next: HqLedger; want: Record<string, string[]> | undefined }[] = [
  {
    name: '起こし直し（session が変わる）・交代（null）・控えから外した fleet・theme の無い fleet（dispatch）の前の session が残る',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a1' }, { theme: 'B', dispatch: 'd-B', session: 'b1' }, { theme: 'C', dispatch: 'd-C', session: 'c1' }, { dispatch: 'd-X', session: 'x1' }]),
    next: ledger([{ theme: 'A', dispatch: 'd-A2', session: 'a2' }, { theme: 'B', dispatch: 'd-B', session: null }]),
    want: { A: ['a1'], B: ['b1'], C: ['c1'], 'd-X': ['x1'] },
  },
  {
    name: '前と新しい priorSessions の和をとり、今動いている session を除き、形の違うものを捨てる。同じ session の fleet は足さない',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a2' }, { theme: 'B', dispatch: 'd-B', session: 7 }], { priorSessions: { A: [ps('a0'), ps('a1'), 3, { session: 4, at: FRESH }, { at: FRESH }], B: 'b0', C: [ps('c0')] } }),
    next: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a2' }, { theme: 'C', dispatch: 'd-C', session: 'c0' }], { priorSessions: { A: [ps('a9')] } }),
    want: { A: ['a0', 'a1', 'a9'] },
  },
  { name: '前の控えが null → priorSessions を作らない', prev: null, next: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a1' }]), want: undefined },
  { name: 'priorSessions がオブジェクトでなければ捨てる', prev: ledger([], { priorSessions: [ps('a0')] }), next: ledger([]), want: undefined },
];

test('carryPriorSessions：前の fleet の session を priorSessions に残す', () => {
  for (const c of carries) {
    const before = JSON.stringify(c.next);
    const r = carryPriorSessions(c.prev, c.next, NOW);
    assert.deepEqual(prior(r), c.want, c.name);
    assert.deepEqual(r.fleets, c.next.fleets, `${c.name}：fleets は新しい控えのまま`);
    assert.equal(JSON.stringify(c.next), before, `${c.name}：引数を変えない`);
  }
  const r = carryPriorSessions(ledger([{ theme: 'A', dispatch: 'd-A', session: 'newest' }], { priorSessions: { A: many } }), ledger([{ theme: 'A', dispatch: 'd-A', session: 'next' }]), NOW);
  const kept = ((r.priorSessions as Record<string, PriorSession[]>).A ?? []).map((x) => x.session);
  assert.equal(kept.length, PRIOR_SESSIONS_LIMIT, '鍵ごとに PRIOR_SESSIONS_LIMIT 件まで');
  assert.ok(kept.includes('newest'), '新しいものを残す');
});

const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-takeover-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
const file = (dir: string, name: string, v: unknown): string => { const p = join(dir, name); writeFileSync(p, JSON.stringify(v)); return p; };

test('CLI：ledger-save を2回流すと ledger に priorSessions が残り、hq-decide.ts takeover がそれを読んで auto を返す', () => withDir((dir) => {
  const state = (args: string[]) => node(['harness/scripts/hq-state.ts', args[0]!, '--common-dir', dir, ...args.slice(1)]);
  assert.equal(state(['ledger-save', file(dir, 'in1.json', ledger([{ theme: 'T', dispatch: 'd-T', session: 's-old' }]))]).status, 0);
  const before = Date.now();
  const r = state(['ledger-save', file(dir, 'in2.json', ledger([{ theme: 'T', dispatch: 'd-T2', session: 's-new' }]))]);
  const after = Date.now();
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(state(['ledger']).stdout);
  assert.deepEqual(Object.keys(saved.priorSessions), ['T']);
  assert.equal(saved.priorSessions.T.length, 1);
  assert.equal(saved.priorSessions.T[0].session, 's-old');
  // at は ledger-save のときの時刻（ISO）。takeover は loadConfig().staleHours と new Date() で見るので、直後なら期限内
  const at = Date.parse(saved.priorSessions.T[0].at);
  assert.ok(at >= before - 1000 && at <= after + 1000, `at が ledger-save のときの時刻でない：${saved.priorSessions.T[0].at}`);

  const out = node(['harness/scripts/hq-decide.ts', 'takeover', '--theme', 'T', '--fleet-status', file(dir, 'status.json', status([row(1, { claim: claim('s-old') }), row(2, { claim: claim('s-new') })])), '--ledger', file(dir, 'ledger.json', saved)]);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { decision: 'auto', theme: 'T', known: [tc(1, 's-old'), tc(2, 's-new')], unknown: [] });
}));
