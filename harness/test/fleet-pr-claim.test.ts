// Issue #221：fleet が、PR のある Issue でも PR の着手宣言（judge・fix・sync の段階）を見て、ほかのセッションが着手中なら選ばない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { Claim, IssueFacts, PrFacts } from '../lib/queue.ts';

const config = loadConfig();
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const prFacts = (n: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue: 1, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, claim: Claim | null = null): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, { claim }),
});
const fi = (facts: IssueFacts, prs: FleetPr[] = [], planFiles: string[] | null = null): FleetIssue => ({ facts, closed: false, planFiles, prs });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const manual = (patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', ...patch });
const select = (f: FleetFacts, current: string | null, max: number | null = null) => selectFleet(config, f, fleetStatus(f), max, current);

test('PR の着手宣言：ほかのセッションの有効な宣言（段階 judge）がある PR の Issue は選ばず、理由に段階と session の短い形が出る', () => {
  const f = facts([fi(planOk(1), [openPr(10, manual({ session: OTHER, stage: 'judge' }))])]);
  const rows = fleetStatus(f);
  assert.equal(rows[0]!.pr, 10, '前提：行の PR は #10');
  const s = select(f, SESSION);
  assert.deepEqual(s.selected, []);
  const reason = s.excluded.get(1)!;
  assert.equal(reason, '着手宣言あり（ほかのセッションが着手中・段階 judge・session 9b8c7d6e）');
});

test('PR の着手宣言：今のセッションの宣言・宣言なし・解除済みの宣言なら今どおり選ぶ', () => {
  const own = facts([fi(planOk(1), [openPr(10, manual({ session: SESSION, stage: 'judge' }))])]);
  assert.deepEqual(select(own, SESSION).selected, [1], '今のセッションの宣言');

  const none = facts([fi(planOk(1), [openPr(10, null)])]);
  assert.deepEqual(select(none, SESSION).selected, [1], '宣言なし');
  assert.deepEqual(select(none, null).selected, [1], '宣言なしなら currentSession が null でも選ぶ');

  const released = facts([fi(planOk(1), [openPr(10, { ...manual({ session: OTHER, stage: 'judge' }), released: true })])]);
  const r = select(released, SESSION);
  assert.deepEqual(r.selected, [1], '解除済みの宣言');
  assert.equal(r.excluded.has(1), false);
  assert.doesNotMatch(r.notes.get(1) ?? '', /PR の着手宣言/, '解除済みの宣言はメモに出さない');
});

test('PR の着手宣言：currentSession が null なら、session 付きの宣言もほかのセッションのものとして選ばない', () => {
  const f = facts([fi(planOk(1), [openPr(10, manual({ session: SESSION, stage: 'fix' }))])]);
  const s = select(f, null);
  assert.deepEqual(s.selected, []);
  assert.match(s.excluded.get(1)!, /着手宣言あり/);
  assert.match(s.excluded.get(1)!, /段階 fix/);

  // session の無い古い書式の宣言も同じ
  const old = facts([fi(planOk(2), [openPr(20, manual())])]);
  const o = select(old, SESSION);
  assert.deepEqual(o.selected, []);
  assert.match(o.excluded.get(2)!, /着手宣言あり/);
});

test('PR の着手宣言：表のメモに段階つきで出る（今のセッションなら「（このセッション）」）', () => {
  const f = facts([
    fi(planOk(1), [openPr(10, manual({ session: SESSION, stage: 'judge' }))]),
    fi(planOk(2), [openPr(20, manual({ session: OTHER, stage: 'sync' }))]),
    fi(planOk(3), [openPr(30, null)]),
  ]);
  const rows = fleetStatus(f);
  const s = selectFleet(config, f, rows, null, SESSION);
  assert.deepEqual(s.selected, [1, 3]);
  assert.match(s.notes.get(1)!, /PR の着手宣言（このセッション）：段階 judge・session 3f2a9c1e/);
  assert.match(s.notes.get(2)!, /PR の着手宣言：段階 sync・session 9b8c7d6e/);
  assert.doesNotMatch(s.notes.get(2)!, /このセッション/);
  assert.doesNotMatch(s.notes.get(3) ?? '', /PR の着手宣言/);

  const table = renderFleetStatus(rows, s, null);
  const row2 = table.split('\n').find((l) => l.startsWith('| #2 t2 |'))!;
  assert.match(row2, /待つ：着手宣言あり（ほかのセッションが着手中・段階 sync・session 9b8c7d6e）/);
  assert.match(row2, /PR の着手宣言：段階 sync/);
  const row1 = table.split('\n').find((l) => l.startsWith('| #1 t1 |'))!;
  assert.match(row1, /\| 選ぶ \|/);
  assert.match(row1, /PR の着手宣言（このセッション）：段階 judge/);
});

test('PR の着手宣言：Issue の宣言と PR の宣言のメモが並んで出る', () => {
  const f = facts([fi(planOk(1, { claim: manual({ session: SESSION, stage: 'implement' }) }), [openPr(10, manual({ session: SESSION, stage: 'judge' }))])]);
  const s = select(f, SESSION);
  assert.deepEqual(s.selected, [1]);
  const note = s.notes.get(1)!;
  assert.match(note, /着手宣言（このセッション）：段階 implement/);
  assert.match(note, /PR の着手宣言（このセッション）：段階 judge/);
});

test('PR の無い Issue：今どおり Issue の宣言を見る（PR の宣言の判定は効かない）', () => {
  const f = facts([
    fi(planOk(1, { claim: manual({ session: OTHER, stage: 'implement' }) })),
    fi(planOk(2, { claim: manual({ session: SESSION, stage: 'implement' }) })),
    fi(planOk(3)),
  ]);
  const s = select(f, SESSION);
  assert.deepEqual(s.selected, [2, 3]);
  assert.equal(s.excluded.get(1), '着手宣言あり（ほかのセッションが着手中・段階 implement・session 9b8c7d6e）');
  for (const n of [1, 2, 3]) assert.doesNotMatch(s.notes.get(n) ?? '', /PR の着手宣言/);
});

test('PR の着手宣言：--max に達していても、宣言のある PR の理由は「着手宣言あり」になる', () => {
  const f = facts([
    fi(planOk(1), [openPr(10, null)]),
    fi(planOk(2), [openPr(20, manual({ session: OTHER, stage: 'judge' }))]),
    fi(planOk(3), [openPr(30, null)]),
  ]);
  const s = select(f, SESSION, 1);
  assert.deepEqual(s.selected, [1]);
  assert.match(s.excluded.get(2)!, /^着手宣言あり/);
  assert.doesNotMatch(s.excluded.get(2)!, /--max/);
  assert.match(s.excluded.get(3)!, /--max/);

  // max が 0 でも同じ
  const z = select(f, SESSION, 0);
  assert.match(z.excluded.get(2)!, /^着手宣言あり/);
});

test('PR の着手宣言：開いた PR が2つあり、行の PR ではない方にだけ宣言があるときは選ぶ', () => {
  const f = facts([fi(planOk(1), [openPr(10, null), openPr(11, manual({ session: OTHER, stage: 'judge' }))])]);
  const rows = fleetStatus(f);
  assert.equal(rows[0]!.pr, 10, '前提：行の PR は先の #10');
  const s = select(f, SESSION);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.has(1), false);

  // 逆に、行の PR に宣言があれば選ばない
  const g = facts([fi(planOk(1), [openPr(10, manual({ session: OTHER, stage: 'judge' })), openPr(11, null)])]);
  assert.equal(fleetStatus(g)[0]!.pr, 10);
  const t = select(g, SESSION);
  assert.deepEqual(t.selected, []);
  assert.match(t.excluded.get(1)!, /着手宣言あり/);
});
