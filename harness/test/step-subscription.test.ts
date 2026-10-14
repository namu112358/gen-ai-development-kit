// Issue #1099：reviewSource.mode が subscription のとき、judge のノードで判定が無く routineWaitMinutes 内なら step は wait（waitingFor routine）、
// fleet の表の next は routine、selectFleet は選ばず excluded に入れる。過ぎたら（または差し戻し・headPushedAt が読めない）judge。
// reviewSource 無し（api・local は routineWaitOf が null）は待たず、今と同じ結果になる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fleetStatus, routineWaitOf, routineWaiting, selectFleet, type FleetFacts, type RoutineWait } from '../lib/fleet.ts';
import { decideStep } from '../lib/step.ts';
import { config } from './support/gate-fixtures.ts';
import { fleetIssue, N, NOW, openPr, planOkFacts, stepInput } from './support/step-fixtures.ts';

const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const sub: RoutineWait = { mode: 'subscription', waitMinutes: 20, now: NOW };

function run(prFacts: Parameters<typeof openPr>[0], routine: RoutineWait | null) {
  const issue = fleetIssue(planOkFacts(), { prs: [openPr(prFacts)] });
  const facts = { issues: [issue] } as unknown as FleetFacts;
  const rows = fleetStatus(facts, routine);
  const sel = selectFleet(config, facts, rows, null, null);
  const d = decideStep(stepInput(issue, { reviewSource: routine }));
  return { row: rows[0]!, sel, d };
}

test('subscription・5 分前の push → wait routine（宣言なし）、next は routine、選ばれず excluded に Routine の判定待ち', () => {
  const { row, sel, d } = run({ headPushedAt: ago(5) }, sub);
  assert.equal(d.result.kind, 'wait');
  assert.equal((d.result as { waitingFor: string }).waitingFor, 'routine');
  assert.equal(d.claim, null);
  assert.equal(row.next, 'routine');
  assert.ok(!sel.selected.includes(N));
  assert.ok(sel.excluded.get(N)?.includes('Routine の判定待ち'));
});

const JUDGE_CASES: { name: string; facts: Parameters<typeof openPr>[0]; routine: RoutineWait | null }[] = [
  { name: 'subscription・25 分前（過ぎた）', facts: { headPushedAt: ago(25) }, routine: sub },
  { name: 'reviewSource 無し（api・local）・5 分前', facts: { headPushedAt: ago(5) }, routine: null },
  { name: 'subscription・verdictRejected', facts: { headPushedAt: ago(5), verdictRejected: true }, routine: sub },
  { name: "subscription・headPushedAt ''", facts: { headPushedAt: '' }, routine: sub },
  { name: 'subscription・headPushedAt not-a-date', facts: { headPushedAt: 'not-a-date' }, routine: sub },
];
for (const c of JUDGE_CASES) {
  test(`${c.name} → run judge、next は judge、選ばれる`, () => {
    const { row, sel, d } = run(c.facts, c.routine);
    assert.equal(d.result.kind, 'node');
    assert.equal((d.result as { node: string }).node, 'judge');
    assert.equal(row.next, 'judge');
    assert.ok(sel.selected.includes(N), JSON.stringify([...sel.excluded]));
  });
}

test('routineWaiting の境界：ちょうど waitMinutes 分は偽、1 分前は真', () => {
  const f = (m: number) => ({ acceptance: null, verdictAwaitingGate: false, verdictRejected: false, headPushedAt: ago(m) });
  assert.equal(routineWaiting(f(20), sub), false);
  assert.equal(routineWaiting(f(19), sub), true);
});

test('routineWaitOf：api・local は null、subscription は mode・waitMinutes・now を返す', () => {
  assert.equal(routineWaitOf({ mode: 'api', routineWaitMinutes: 20 }, NOW), null);
  assert.equal(routineWaitOf({ mode: 'local', routineWaitMinutes: 20 }, NOW), null);
  assert.deepEqual(routineWaitOf({ mode: 'subscription', routineWaitMinutes: 20 }, NOW), { mode: 'subscription', waitMinutes: 20, now: NOW });
});
