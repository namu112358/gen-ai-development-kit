// Issue #941：hq の控えの priorSessions の期限を確かめる。takeoverDecision は、priorSessions[テーマ] のうち控えに入れてから
// staleHours 以内（期限ちょうどを含む。時計のずれ PRIOR_SESSION_CLOCK_SKEW_MS までの未来も含む）のセッションの宣言だけを known にし、
// 期限を過ぎた・at の無い古い形・読めない at・遠い未来の at のものは unknown（人に聞く）にする。控えの今の fleet は at に関係なく known。
// carryPriorSessions は、足す要素の at に渡した now を書き、前からある要素の at を延ばさない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { PRIOR_SESSION_CLOCK_SKEW_MS, takeoverDecision } from '../scripts/hq-decide.ts';
import { carryPriorSessions, readPriorSessions, type HqLedger, type PriorSession } from '../scripts/hq-state.ts';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const HOUR = 3_600_000;
const STALE_HOURS = 24;
const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const ledger = (fleets: Record<string, unknown>[], patch: Partial<HqLedger> = {}): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null, ...patch,
});
const row = (issue: number, session: string): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-ok', stageLabel: FLEET_STAGES['plan-ok'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: { by: 'manual', stage: 'implement', session, own: false }, prClaim: null,
});
const status = (rows: FleetStatusRow[]): FleetStatusData => ({ version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null });

test('PRIOR_SESSION_CLOCK_SKEW_MS は5分', () => {
  assert.equal(PRIOR_SESSION_CLOCK_SKEW_MS, 5 * 60 * 1000);
});

// テーマ T の今の fleet は s-cur。priorSessions[T] に1つだけ要素を置き、その session の宣言が known か unknown かを見る
const expiry: { name: string; entry: unknown; staleHours?: number; want: 'known' | 'unknown' }[] = [
  { name: '1時間前（期限内）', entry: { session: 's-p', at: iso(-HOUR) }, want: 'known' },
  { name: 'ちょうど今', entry: { session: 's-p', at: iso(0) }, want: 'known' },
  { name: '期限ちょうど（staleHours 前）', entry: { session: 's-p', at: iso(-STALE_HOURS * HOUR) }, want: 'known' },
  { name: '期限を1ms過ぎた', entry: { session: 's-p', at: iso(-STALE_HOURS * HOUR - 1) }, want: 'unknown' },
  { name: '期限を大きく過ぎた（30日前）', entry: { session: 's-p', at: iso(-30 * 24 * HOUR) }, want: 'unknown' },
  { name: 'staleHours を短くすると（1時間）2時間前は期限切れ', entry: { session: 's-p', at: iso(-2 * HOUR) }, staleHours: 1, want: 'unknown' },
  { name: 'staleHours を長くすると（48時間）30時間前は期限内', entry: { session: 's-p', at: iso(-30 * HOUR) }, staleHours: 48, want: 'known' },
  { name: 'at の無い古い形（文字列）', entry: 's-p', want: 'unknown' },
  { name: 'at が null', entry: { session: 's-p', at: null }, want: 'unknown' },
  { name: 'at の鍵が無い', entry: { session: 's-p' }, want: 'unknown' },
  { name: 'at が Date.parse できない', entry: { session: 's-p', at: 'not-a-date' }, want: 'unknown' },
  { name: 'at が文字列でない（数）', entry: { session: 's-p', at: NOW.getTime() }, want: 'unknown' },
  { name: '5分ちょうど未来（時計のずれの内）', entry: { session: 's-p', at: iso(5 * 60 * 1000) }, want: 'known' },
  { name: '4分未来', entry: { session: 's-p', at: iso(4 * 60 * 1000) }, want: 'known' },
  { name: '5分を1ms超えた未来', entry: { session: 's-p', at: iso(5 * 60 * 1000 + 1) }, want: 'unknown' },
  { name: '遠い未来（1年後）', entry: { session: 's-p', at: iso(365 * 24 * HOUR) }, want: 'unknown' },
];

test('takeoverDecision：priorSessions の宣言は at が staleHours 以内（と5分以内の未来）なら known、それ以外は unknown', () => {
  for (const c of expiry) {
    const l = ledger([{ theme: 'T', dispatch: 'd-T', session: 's-cur' }], { priorSessions: { T: [c.entry] } });
    const r = takeoverDecision({ theme: 'T', status: status([row(1, 's-p')]), ledger: l, now: NOW, staleHours: c.staleHours ?? STALE_HOURS });
    const known = r.known.map((x) => x.session);
    const unknown = r.unknown.map((x) => x.session);
    if (c.want === 'known') {
      assert.deepEqual({ decision: r.decision, known, unknown }, { decision: 'auto', known: ['s-p'], unknown: [] }, c.name);
    } else {
      assert.deepEqual({ decision: r.decision, known, unknown }, { decision: 'ask', known: [], unknown: ['s-p'] }, c.name);
    }
  }
});

test('takeoverDecision：期限内と期限切れが混ざると、期限切れの宣言だけ unknown で ask。控えの今の fleet は at に関係なく known', () => {
  const l = ledger([{ theme: 'T', dispatch: 'd-T', session: 's-cur' }], {
    priorSessions: {
      // s-cur は今の fleet。priorSessions に期限切れで残っていても known のまま
      T: [{ session: 's-in', at: iso(-HOUR) }, { session: 's-out', at: iso(-25 * HOUR) }, 's-legacy', { session: 's-cur', at: iso(-100 * HOUR) }],
      // 別テーマの期限内のセッションは T の材料にならない
      U: [{ session: 's-u', at: iso(-HOUR) }],
    },
  });
  const r = takeoverDecision({ theme: 'T', status: status([row(1, 's-cur'), row(2, 's-in'), row(3, 's-out'), row(4, 's-legacy'), row(5, 's-u')]), ledger: l, now: NOW, staleHours: STALE_HOURS });
  assert.equal(r.decision, 'ask');
  assert.deepEqual(r.known.map((x) => x.issue), [1, 2]);
  assert.deepEqual(r.unknown.map((x) => x.issue), [3, 4, 5]);
});

test('takeoverDecision：控えの今の fleet の session だけなら、priorSessions が無くても known（at は見ない）', () => {
  const l = ledger([{ theme: 'T', dispatch: 'd-T', session: 's-cur' }]);
  const r = takeoverDecision({ theme: 'T', status: status([row(1, 's-cur')]), ledger: l, now: NOW, staleHours: STALE_HOURS });
  assert.deepEqual({ decision: r.decision, known: r.known.map((x) => x.session), unknown: r.unknown.length }, { decision: 'auto', known: ['s-cur'], unknown: 0 });
});

test('readPriorSessions：古い形の文字列と読めない at は at: null として読み、形の違う要素は捨てる', () => {
  const at = iso(-HOUR);
  const m = readPriorSessions(ledger([], { priorSessions: { T: ['s-legacy', { session: 's-ok', at }, { session: 's-bad', at: 'xx' }, { session: 's-none' }, { session: 3, at }, 5, ''], U: 'bad' } }));
  assert.deepEqual([...m.keys()], ['T']);
  assert.deepEqual(m.get('T'), [
    { session: 's-legacy', at: null }, { session: 's-ok', at }, { session: 's-bad', at: null }, { session: 's-none', at: null },
  ]);
  assert.equal(readPriorSessions(null).size, 0);
});

// 比べるときは鍵ごとに session の順にそろえる
const sorted = (l: HqLedger): Record<string, PriorSession[]> =>
  Object.fromEntries(Object.entries((l.priorSessions ?? {}) as Record<string, PriorSession[]>).map(([k, v]) => [k, [...v].sort((a, b) => a.session.localeCompare(b.session))]));

const T0 = iso(-10 * HOUR);
const T1 = iso(-5 * HOUR);
const carries: { name: string; prev: HqLedger | null; next: HqLedger; want: Record<string, PriorSession[]> }[] = [
  {
    name: '前の fleet の session を足すときは at を now にする',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a1' }]),
    next: ledger([{ theme: 'A', dispatch: 'd-A2', session: 'a2' }]),
    want: { A: [{ session: 'a1', at: NOW.toISOString() }] },
  },
  {
    name: '前の priorSessions にある要素の at はそのまま（now にしない）',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a1' }], { priorSessions: { A: [{ session: 'a0', at: T0 }] } }),
    next: ledger([{ theme: 'A', dispatch: 'd-A2', session: 'a2' }]),
    want: { A: [{ session: 'a0', at: T0 }, { session: 'a1', at: NOW.toISOString() }] },
  },
  {
    name: '前の fleet の session が前の priorSessions にもあれば、前の at を残す（延ばさない）',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'a1' }], { priorSessions: { A: [{ session: 'a1', at: T0 }] } }),
    next: ledger([{ theme: 'A', dispatch: 'd-A2', session: 'a2' }]),
    want: { A: [{ session: 'a1', at: T0 }] },
  },
  {
    name: '同じ session が前と新しい priorSessions の両方にあれば早い at を残す（前が早い）',
    prev: ledger([], { priorSessions: { A: [{ session: 'x', at: T0 }] } }),
    next: ledger([], { priorSessions: { A: [{ session: 'x', at: T1 }] } }),
    want: { A: [{ session: 'x', at: T0 }] },
  },
  {
    name: '同じ session が前と新しい priorSessions の両方にあれば早い at を残す（新しいほうが早い）',
    prev: ledger([], { priorSessions: { A: [{ session: 'x', at: T1 }] } }),
    next: ledger([], { priorSessions: { A: [{ session: 'x', at: T0 }] } }),
    want: { A: [{ session: 'x', at: T0 }] },
  },
  {
    name: 'null と時刻があれば null を残す（前が null）',
    prev: ledger([], { priorSessions: { A: [{ session: 'y', at: null }] } }),
    next: ledger([], { priorSessions: { A: [{ session: 'y', at: T1 }] } }),
    want: { A: [{ session: 'y', at: null }] },
  },
  {
    name: 'null と時刻があれば null を残す（新しいほうが null）',
    prev: ledger([], { priorSessions: { A: [{ session: 'y', at: T1 }] } }),
    next: ledger([], { priorSessions: { A: [{ session: 'y', at: null }] } }),
    want: { A: [{ session: 'y', at: null }] },
  },
  {
    name: '古い形の文字列は at: null として書き、時刻のある同じ session があっても null を残す',
    prev: ledger([{ theme: 'A', dispatch: 'd-A', session: 'z' }], { priorSessions: { A: ['z', 'w'] } }),
    next: ledger([{ theme: 'A', dispatch: 'd-A2', session: 'a2' }]),
    want: { A: [{ session: 'w', at: null }, { session: 'z', at: null }] },
  },
];

test('carryPriorSessions：足す要素の at は now、前からある要素の at は延ばさない', () => {
  for (const c of carries) {
    const before = JSON.stringify(c.next);
    const r = carryPriorSessions(c.prev, c.next, NOW);
    assert.deepEqual(sorted(r), c.want, c.name);
    assert.equal(JSON.stringify(c.next), before, `${c.name}：引数を変えない`);
  }
});

test('carry → takeover：ledger-save を繰り返しても、期限を過ぎた前のセッションは known に戻らない', () => {
  // 1回目の保存（25時間前）で a1 が priorSessions に入り、今の保存で a1 の at が延びないので、今の takeover では unknown
  const first = carryPriorSessions(ledger([{ theme: 'T', dispatch: 'd-T', session: 'a1' }]), ledger([{ theme: 'T', dispatch: 'd-T2', session: 'a2' }]), new Date(NOW.getTime() - 25 * HOUR));
  const second = carryPriorSessions(first, ledger([{ theme: 'T', dispatch: 'd-T3', session: 'a3' }]), NOW);
  const r = takeoverDecision({ theme: 'T', status: status([row(1, 'a1'), row(2, 'a2'), row(3, 'a3')]), ledger: second, now: NOW, staleHours: STALE_HOURS });
  assert.equal(r.decision, 'ask');
  assert.deepEqual(r.known.map((x) => x.session), ['a2', 'a3']);
  assert.deepEqual(r.unknown.map((x) => x.session), ['a1']);
});
