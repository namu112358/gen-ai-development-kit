// Issue #639：fleet-status --json の着手宣言の at・stale（hq の見回しが、控えに無い新しい宣言を止まった宣言にしない）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, fleetStatusData, selectFleet, type ClaimAge, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { Claim, IssueFacts, PrFacts } from '../lib/queue.ts';

const config = loadConfig();
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const NOW = new Date('2026-09-26T12:00:00Z');
const AGE: ClaimAge = { now: NOW, humanClaimStaleHours: 6, routineClaimTakeoverMinutes: 60 };
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const planOk = (n: number, claim: Claim | null = null): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: '2026-09-26T00:00:00Z', claim, openBlockers: [],
  gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null,
});
const prFacts = (n: number, issue: number, claim: Claim | null): PrFacts => ({
  number: n, agent: true, conflicted: false, claim, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number, claim: Claim): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue, claim),
});
const fi = (facts: IssueFacts, prs: FleetPr[] = []): FleetIssue => ({ facts, closed: false, planFiles: null, prs });
const manual = (at: string): Claim => ({ by: 'manual', session: OTHER, stage: 'plan', at });
const routine = (at: string): Claim => ({ by: 'routine', session: OTHER, at });

/** Issue の宣言（番号ごとの宣言と、止まった宣言か） */
const cases: { n: number; claim: Claim; stale: boolean; label: string }[] = [
  { n: 1, claim: manual(ago(60)), stale: false, label: '手動・1時間前（新しい）' },
  { n: 2, claim: manual(ago(6 * 60 - 1)), stale: false, label: '手動・期限の1分前' },
  { n: 3, claim: manual(ago(6 * 60)), stale: true, label: '手動・ちょうど6時間前' },
  { n: 4, claim: manual(ago(7 * 60)), stale: true, label: '手動・7時間前' },
  { n: 5, claim: routine(ago(30)), stale: false, label: 'Routine・30分前（新しい）' },
  { n: 6, claim: routine(ago(60)), stale: true, label: 'Routine・ちょうど60分前' },
  { n: 7, claim: routine(ago(90)), stale: true, label: 'Routine・90分前' },
  { n: 8, claim: manual('not-a-date'), stale: true, label: '時刻が読めない宣言' },
];
/** PR の宣言（Issue の宣言は無い） */
const prCases: { n: number; pr: number; claim: Claim; stale: boolean; label: string }[] = [
  { n: 20, pr: 200, claim: manual(ago(60)), stale: false, label: 'PR・手動・1時間前' },
  { n: 21, pr: 210, claim: manual(ago(6 * 60)), stale: true, label: 'PR・手動・ちょうど6時間前' },
  { n: 22, pr: 220, claim: routine(ago(90)), stale: true, label: 'PR・Routine・90分前' },
];

const facts: FleetFacts = {
  issues: [
    ...cases.map((c) => fi(planOk(c.n, c.claim))),
    ...prCases.map((c) => fi(planOk(c.n), [openPr(c.pr, c.n, c.claim)])),
    fi(planOk(30, { ...manual(ago(7 * 60)), released: true })),
  ],
  prConflicts: [],
};

function build(claimAge?: ClaimAge) {
  const rows = fleetStatus(facts);
  const sel = selectFleet(config, facts, rows, null, SESSION);
  return fleetStatusData(facts, rows, sel, null, SESSION, undefined, undefined, claimAge);
}
type Data = ReturnType<typeof build>;
const rowOf = (d: Data, n: number) => d.rows.find((r) => r.issue === n)!;

test('claimAge を渡すと、Issue と PR の宣言に at と stale が出る（新しい宣言は止まらない、期限の切れた・時刻が読めない宣言は止まる）', () => {
  const data = build(AGE);
  for (const c of cases) {
    const info = rowOf(data, c.n).claim;
    assert.ok(info, c.label);
    assert.equal(info.at, c.claim.at, c.label);
    assert.equal(info.stale, c.stale, c.label);
  }
  for (const c of prCases) {
    const info = rowOf(data, c.n).prClaim;
    assert.ok(info, c.label);
    assert.equal(info.at, c.claim.at, c.label);
    assert.equal(info.stale, c.stale, c.label);
  }
  assert.equal(rowOf(data, 30).claim, null, '解除済みの宣言は null のまま');
});

test('claimAge を渡さないと、宣言に at・stale の鍵が無い', () => {
  const data = build();
  for (const n of cases.map((c) => c.n)) {
    const info = rowOf(data, n).claim!;
    assert.ok(!('at' in info) && !('stale' in info), `#${n}`);
  }
  for (const c of prCases) {
    const info = rowOf(data, c.n).prClaim!;
    assert.ok(!('at' in info) && !('stale' in info), `#${c.n}`);
  }
});
