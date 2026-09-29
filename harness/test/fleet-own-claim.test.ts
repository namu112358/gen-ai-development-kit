// Issue #243：fleet の重なりの相手に、このセッション自身の実装前（plan・plan-gate など）の着手宣言を含めない。
// 入れ子の ship が並行に宣言を出しても、重なる組の両方が待つことにならず、並び順の先の側を選ぶ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue } from '../lib/fleet.ts';
import type { Claim, ClaimStage, IssueFacts } from '../lib/queue.ts';

const config = loadConfig();
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
/** 計画を投稿し、ゲートの記録を待っている Issue（PR なし） */
const planGate = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: null, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: false, openPr: null, ...patch,
});
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  planGate(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, planOkByApp: true, ...patch });
const fi = (facts: IssueFacts, planFiles: string[] | null): FleetIssue => ({ facts, closed: false, planFiles, prs: [] });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const manual = (session: string, stage: ClaimStage, patch: Partial<Claim> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, stage, ...patch } as Claim);
const select = (f: FleetFacts, current: string | null = SESSION) => selectFleet(config, f, fleetStatus(f), null, current);
const rowOf = (table: string, n: number): string => table.split('\n').find((l) => l.startsWith(`| #${n} t${n} |`))!;

test('(a) このセッションの plan-gate の宣言どうしで計画の files が重なると、並び順の先の側を選び、後の側だけが待つ', () => {
  const f = facts([
    fi(planGate(1, { claim: manual(SESSION, 'plan-gate') }), ['harness/lib/fleet.ts']),
    fi(planGate(2, { claim: manual(SESSION, 'plan-gate') }), ['harness/lib/**']),
  ]);
  assert.equal(fleetStatus(f)[0]!.stage, 'plan-gate', '前提：PR の無い計画ゲート待ち');
  const s = select(f);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.has(1), false, '両方とも待つにならない');
  assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ');
});

test('(a) 並び順は優先度 → agent:ready の早い順 → 番号の小さい順で、先の側を選ぶ', () => {
  // agent:ready が #5 のほうが早い
  const byReady = facts([
    fi(planGate(3, { claim: manual(SESSION, 'plan-gate'), readyAt: '2026-09-26T00:30:00Z' }), ['a.ts']),
    fi(planGate(5, { claim: manual(SESSION, 'plan-gate'), readyAt: '2026-09-26T00:10:00Z' }), ['a.ts']),
  ]);
  const r = select(byReady);
  assert.deepEqual(r.selected, [5]);
  assert.equal(r.excluded.get(3), '#5 と触るファイルが重なるため待つ');

  // agent:ready が同じなら番号の小さい順
  const byNumber = facts([
    fi(planGate(8, { claim: manual(SESSION, 'plan'), readyAt: '2026-09-26T00:10:00Z' }), ['a.ts']),
    fi(planGate(7, { claim: manual(SESSION, 'plan-critique'), readyAt: '2026-09-26T00:10:00Z' }), ['a.ts']),
  ]);
  const n = select(byNumber);
  assert.deepEqual(n.selected, [7]);
  assert.equal(n.excluded.get(8), '#7 と触るファイルが重なるため待つ');

  // 優先度が高いほうが先（番号・agent:ready が後でも）
  const byPriority = facts([
    fi(planGate(1, { claim: manual(SESSION, 'plan-gate') }), ['a.ts']),
    fi(planGate(2, { claim: manual(SESSION, 'plan-gate'), labels: ['agent:ready', 'priority:high'] }), ['a.ts']),
  ]);
  const p = select(byPriority);
  assert.deepEqual(p.selected, [2]);
  assert.equal(p.excluded.get(1), '#2 と触るファイルが重なるため待つ');
});

test('(a) このセッションの実装前の宣言は、並び順が先の宣言なしの Issue を待たせない', () => {
  const f = facts([
    fi(planGate(1), ['a.ts']),
    fi(planGate(2, { claim: manual(SESSION, 'plan') }), ['a.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ');
});

test('(b) このセッションの implement の宣言がある Issue と重なる Issue（宣言なし）は、並び順が先でも待つ', () => {
  const f = facts([
    fi(planOk(1), ['a.ts']),
    fi(planOk(2, { claim: manual(SESSION, 'implement') }), ['a.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [2]);
  assert.equal(s.excluded.get(1), '#2 と触るファイルが重なるため待つ');
});

test('(c) ほかのセッションの解除されていない宣言がある Issue と重なる Issue は待つ（段階によらない）', () => {
  for (const stage of ['plan', 'plan-gate', 'implement'] as const) {
    const f = facts([
      fi(planGate(1), ['a.ts']),
      fi(planGate(2, { claim: manual(OTHER, stage) }), ['a.ts']),
    ]);
    const s = select(f);
    assert.deepEqual(s.selected, [], stage);
    assert.equal(s.excluded.get(1), '#2 と触るファイルが重なるため待つ', stage);
    assert.match(s.excluded.get(2)!, /^着手宣言あり（ほかのセッションが着手中/, stage);
  }
});

test('(c) currentSession が null なら、session 付きの宣言もほかのセッションのものとして重なりの相手になる', () => {
  const f = facts([
    fi(planGate(1), ['a.ts']),
    fi(planGate(2, { claim: manual(SESSION, 'plan-gate') }), ['a.ts']),
  ]);
  const s = select(f, null);
  assert.equal(s.excluded.get(1), '#2 と触るファイルが重なるため待つ');
});

test('(c) 解除済み（released: true）の宣言だけの Issue とは、重なっても待たない', () => {
  for (const session of [OTHER, SESSION]) {
    const f = facts([
      fi(planGate(1), ['a.ts']),
      fi(planGate(2, { claim: manual(session, 'implement', { released: true }) }), ['a.ts']),
    ]);
    const s = select(f);
    assert.deepEqual(s.selected, [1], session);
    assert.equal(s.excluded.has(1), false, session);
    assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ', session);
  }
});

test('(d) 集合の表では重なる後の側の行が「待つ」になり、その Issue だけを渡すと「選ぶ」になる', () => {
  const issues = [
    fi(planGate(1, { claim: manual(SESSION, 'plan-gate') }), ['harness/lib/fleet.ts']),
    fi(planGate(2, { claim: manual(SESSION, 'plan-gate') }), ['docs/operations.md']),
    fi(planGate(3, { claim: manual(SESSION, 'plan-gate') }), ['harness/lib/fleet.ts', 'harness/test/x.test.ts']),
  ];
  const all = facts(issues);
  const rows = fleetStatus(all);
  const sel = selectFleet(config, all, rows, null, SESSION);
  assert.deepEqual(sel.selected, [1, 2]);
  const table = renderFleetStatus(rows, sel, null);
  assert.match(rowOf(table, 1), /\| 選ぶ \|/);
  assert.match(rowOf(table, 2), /\| 選ぶ \|/);
  assert.match(rowOf(table, 3), /\| 待つ：#1 と触るファイルが重なるため待つ \|/);

  // ship が自分の Issue だけで表を読むと、重なる相手が見えずに選ぶになる（ship は集合で表を読む）
  const alone = facts([issues[2]!]);
  const aloneRows = fleetStatus(alone);
  const aloneTable = renderFleetStatus(aloneRows, selectFleet(config, alone, aloneRows, null, SESSION), null);
  assert.match(rowOf(aloneTable, 3), /\| 選ぶ \|/);
});
