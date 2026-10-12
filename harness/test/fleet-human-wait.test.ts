// Issue #667：人の判断待ちが hq.humanWaitMinutes を超えた Issue を fleet の選ぶ対象から外し（脇に置く）、解除する着手宣言を決める判定を確かめる。
// facts.ts の humanWaitSince（待ちの始まり）、fleet.ts の humanWaitMinutes（設定）・selectFleet の humanWait（外し方）・fleetStatusData の行の humanWait・setAsideReleases。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { humanWaitSince } from '../lib/facts.ts';
import {
  FLEET_STAGES, HUMAN_WAIT_DEFAULT_MINUTES, fleetStatus, fleetStatusData, humanWaitMinutes, selectFleet, setAsideReleases,
  type FleetClaimInfo, type FleetFacts, type FleetIssue, type FleetPr, type FleetStatusRow, type HumanWait,
} from '../lib/fleet.ts';
import type { Claim, ClaimStage, IssueFacts, PrFacts } from '../lib/queue.ts';

const config = loadConfig();
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';

const NOW = new Date('2026-09-30T12:00:00.000Z');
/** NOW から m 分前の ISO */
const minsAgo = (m: number): string => new Date(NOW.getTime() - m * 60000).toISOString();

const gateStop = { pass: false, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const base = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: null, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: false, openPr: null, ...patch,
});
const planReview = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  base(n, { labels: ['agent:ready', 'agent:plan-review'], gate: gateStop, ...patch });
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  base(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, planOkByApp: true, ...patch });
const prFacts = (n: number, issue: number, labels: string[] = []): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels, headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number, labels: string[] = []): FleetPr =>
  ({ number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue, labels) });
const fi = (facts: IssueFacts, prs: FleetPr[] = []): FleetIssue => ({ facts, closed: false, planFiles: null, prs });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const manual = (session: string, stage: ClaimStage): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, stage } as Claim);

test('humanWaitSince：plan-review・止まる印の待ちの始まり。決定の記録で数え直し、計画の出し直しで待ちでなくなる', () => {
  const T1 = '2026-09-30T08:00:00Z';
  const T2 = '2026-09-30T09:00:00Z';
  const T3 = '2026-09-30T10:00:00Z';
  const T0 = '2026-09-30T07:00:00Z';
  const cases: [string, Parameters<typeof humanWaitSince>[0], string | null][] = [
    ['plan-review の印の時刻', { labels: ['agent:plan-review'], labeledAt: { 'agent:plan-review': T1 }, gate: null, latestPlanAt: T0, latestDecisionAt: null }, T1],
    ['止まったゲートが印より後ならゲートの時刻', { labels: ['agent:plan-review'], labeledAt: { 'agent:plan-review': T1 }, gate: { pass: false, at: T2 }, latestPlanAt: T0, latestDecisionAt: null }, T2],
    ['印が無くてもゲートで止まっていればゲートの時刻', { labels: [], labeledAt: {}, gate: { pass: false, at: T2 }, latestPlanAt: T0, latestDecisionAt: null }, T2],
    ['後から決定の記録があればその時刻から数え直す（null にしない）', { labels: ['agent:plan-review'], labeledAt: { 'agent:plan-review': T1 }, gate: { pass: false, at: T2 }, latestPlanAt: T0, latestDecisionAt: T3 }, T3],
    ['始まりより後に計画コメントがあれば null（ゲートの返事待ち）', { labels: ['agent:plan-review'], labeledAt: { 'agent:plan-review': T1 }, gate: { pass: false, at: T2 }, latestPlanAt: T3, latestDecisionAt: null }, null],
    ['計画コメントが始まりと同じ時刻なら待ちのまま', { labels: ['agent:plan-review'], labeledAt: { 'agent:plan-review': T1 }, gate: null, latestPlanAt: T1, latestDecisionAt: null }, T1],
    ['agent:hold はその印の時刻（plan-review より先に見る）', { labels: ['agent:plan-review', 'agent:hold'], labeledAt: { 'agent:plan-review': T1, 'agent:hold': T2 }, gate: null, latestPlanAt: T0, latestDecisionAt: null }, T2],
    ['agent:blocked はその印の時刻', { labels: ['agent:blocked'], labeledAt: { 'agent:blocked': T1 }, gate: null, latestPlanAt: T0, latestDecisionAt: null }, T1],
    ['印も止まったゲートも無ければ null（決定の記録だけでは始まりにしない）', { labels: ['agent:ready'], labeledAt: {}, gate: { pass: true, at: T2 }, latestPlanAt: T0, latestDecisionAt: T3 }, null],
    ['plan-review の印があっても labeled の時刻もゲートの停止も無ければ null', { labels: ['agent:plan-review'], labeledAt: {}, gate: null, latestPlanAt: T0, latestDecisionAt: null }, null],
  ];
  for (const [name, input, want] of cases) assert.equal(humanWaitSince(input), want, name);
});

test('humanWaitMinutes：無ければ既定 120、書けばその値、正の整数でなければ throw', () => {
  assert.equal(HUMAN_WAIT_DEFAULT_MINUTES, 120);
  assert.equal(humanWaitMinutes({}), 120);
  assert.equal(humanWaitMinutes({ hq: {} }), 120);
  assert.equal(humanWaitMinutes({ hq: { humanWaitMinutes: 30 } }), 30);
  for (const v of [0, -1, 1.5, '60', null]) {
    assert.throws(() => humanWaitMinutes({ hq: { humanWaitMinutes: v } }), Error, String(v));
  }
  assert.throws(() => humanWaitMinutes({ hq: 'x' }), Error, 'hq がオブジェクトでない');
});

test('selectFleet：時間を超えた plan-review の Issue を脇に置き、fleetStatusData の行に humanWait と解除する宣言を出す', () => {
  const f = facts([
    fi(planReview(1, { humanWaitSince: minsAgo(121), claim: manual(SESSION, 'plan-gate') })),
    fi(planReview(2, { humanWaitSince: minsAgo(30) })),
    fi(planReview(3, { humanWaitSince: minsAgo(120) })),
    // 依存で止まった行は、plan-review の印が付いていても人の判断待ちに数えない
    fi(planReview(4, { openBlockers: [99], humanWaitSince: minsAgo(500) })),
    // PR の止まる印：時刻は読まず、時間を問わず脇に置く
    fi(planOk(5), [openPr(50, 5, ['agent:hold'])]),
    // Issue の止まる印：その印の時刻から数える
    fi(base(6, { labels: ['agent:ready', 'agent:hold'], humanWaitSince: minsAgo(200) })),
  ]);
  const rows = fleetStatus(f);
  const stageOf = (n: number) => rows.find((r) => r.issue === n)!.stage;
  assert.equal(stageOf(1), 'plan-review', '前提');
  assert.equal(stageOf(4), 'stopped', '前提：依存で止まる');
  assert.equal(stageOf(5), 'stopped', '前提：PR の印で止まる');
  assert.equal(stageOf(6), 'stopped', '前提：Issue の印で止まる');

  // 引数なし（null）なら今のまま選ぶ
  const plain = selectFleet(config, f, rows, null, SESSION, null);
  assert.deepEqual(plain.selected, [1, 2, 3]);

  const sel = selectFleet(config, f, rows, null, SESSION, null, { limitMinutes: 120, now: NOW });
  assert.deepEqual(sel.selected, [2, 3], '121 分は外し、30 分とちょうど 120 分は選ぶ');
  assert.match(sel.excluded.get(1) ?? '', /脇に置く/);

  const data = fleetStatusData(f, rows, sel, null, SESSION);
  const hw = (n: number): HumanWait | null | undefined => data.rows.find((r) => r.issue === n)!.humanWait;
  assert.equal(hw(1)?.overdue, true);
  assert.equal(hw(1)?.minutes, 121);
  assert.equal(hw(1)?.since, minsAgo(121));
  assert.equal(hw(2)?.overdue, false);
  assert.equal(hw(2)?.minutes, 30);
  assert.equal(hw(3)?.overdue, false, 'ちょうど limitMinutes は超えていない');
  assert.equal(hw(4), null, '依存で止まった行は人の判断待ちに数えない');
  assert.equal(hw(5)?.overdue, true, 'PR の止まる印は時間を問わず脇に置く');
  assert.equal(hw(5)?.minutes, null);
  assert.equal(hw(5)?.since, null);
  assert.equal(hw(6)?.overdue, true);
  assert.equal(hw(6)?.minutes, 200);
  assert.deepEqual(data.setAsideReleases, [1], 'このセッションの宣言が残る脇に置いた Issue だけ');
});

test('selectFleet：plan-review のままでも implement の着手宣言があれば（進めると決めた後）脇に置かず、宣言も解除の対象にしない', () => {
  const run = (stage: ClaimStage) => {
    const f = facts([fi(planReview(1, { humanWaitSince: minsAgo(500), claim: manual(SESSION, stage) }))]);
    const rows = fleetStatus(f);
    assert.equal(rows[0]!.stage, 'plan-review', '前提');
    const sel = selectFleet(config, f, rows, null, SESSION, null, { limitMinutes: 120, now: NOW });
    return { sel, data: fleetStatusData(f, rows, sel, null, SESSION) };
  };
  const proceed = run('implement');
  assert.deepEqual(proceed.sel.selected, [1]);
  assert.equal(proceed.sel.excluded.has(1), false);
  assert.equal(proceed.data.rows[0]!.humanWait, null);
  assert.deepEqual(proceed.data.setAsideReleases, []);

  const waiting = run('plan-gate');
  assert.match(waiting.sel.excluded.get(1) ?? '', /脇に置く/);
  assert.deepEqual(waiting.data.setAsideReleases, [1]);
});

const own: FleetClaimInfo = { by: 'manual', stage: 'plan-gate', session: SESSION, own: true };
const other: FleetClaimInfo = { by: 'manual', stage: 'plan-gate', session: 'sess-other', own: false };
const overdue: HumanWait = { since: minsAgo(121), minutes: 121, overdue: true, decide: 'x' };
const notYet: HumanWait = { since: minsAgo(30), minutes: 30, overdue: false, decide: 'x' };
const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-review', stageLabel: FLEET_STAGES['plan-review'], next: 'none', selected: false, waitReason: 'x',
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
});

test('setAsideReleases：時間を超えた行の、このセッションの Issue・PR の宣言だけを行の順に返す', () => {
  const rows = [
    row(10, { humanWait: overdue, claim: own }),
    row(11, { humanWait: overdue, pr: 110, stage: 'stopped', prClaim: own }),
    row(12, { humanWait: overdue, pr: 120, stage: 'stopped', claim: own, prClaim: own }),
    row(13, { humanWait: overdue, claim: other }),
    row(14, { humanWait: overdue, pr: 140, stage: 'stopped', prClaim: other }),
    row(15, { humanWait: notYet, claim: own }),
    row(16, { humanWait: null, claim: own }),
    row(17, { claim: own }),
  ];
  assert.deepEqual(setAsideReleases(rows), [10, 110, 12, 120]);
  assert.deepEqual(setAsideReleases([]), []);
});
