// Issue #312：fleet の選び方で、段階が plan-review（人の判断待ち）の Issue を、ほかの Issue の重なりの相手にしない。
// plan-review の Issue 自身は、PR のある Issue やほかのセッションの実装中の Issue と重なれば今までどおり待つ。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { Claim, ClaimStage, IssueFacts, PrFacts } from '../lib/queue.ts';

const config = loadConfig();
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const gateStop = { pass: false, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const base = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: null, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: false, openPr: null, ...patch,
});
/** 計画ゲートで止まり、人の判断を待つ Issue（PR なし） */
const planReview = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  base(n, { labels: ['agent:ready', 'agent:plan-review'], gate: gateStop, ...patch });
/** 計画ゲートを通り、実装を待つ Issue（PR なし） */
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  base(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, planOkByApp: true, ...patch });
const prFacts = (n: number, issue: number): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number): FleetPr => ({ number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue) });
const fi = (facts: IssueFacts, planFiles: string[] | null, prs: FleetPr[] = []): FleetIssue => ({ facts, closed: false, planFiles, prs });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const manual = (session: string, stage: ClaimStage): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, stage } as Claim);
const select = (f: FleetFacts, current: string | null = SESSION) => selectFleet(config, f, fleetStatus(f), null, current);
const stageOf = (f: FleetFacts, n: number) => fleetStatus(f).find((r) => r.issue === n)!.stage;

test('plan-review の Issue（並び順が先）と plan-ok の Issue の計画の files が重なっても、両方を選ぶ', () => {
  const f = facts([
    fi(planReview(1), ['harness/lib/fleet.ts']),
    fi(planOk(2), ['harness/lib/**']),
  ]);
  assert.equal(stageOf(f, 1), 'plan-review', '前提：A の段階は plan-review');
  assert.equal(stageOf(f, 2), 'plan-ok', '前提：B の段階は plan-ok');
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.equal(s.excluded.has(2), false, 'B は A を待たない');
});

test('A が plan-ok（人が進めると決めた後）なら、今までどおり B は A を待つ', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/fleet.ts']),
    fi(planOk(2), ['harness/lib/**']),
  ]);
  assert.equal(stageOf(f, 1), 'plan-ok');
  const s = select(f);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ');
});

test('plan-review の Issue は、ほかのセッションの実装中の Issue と重なれば今までどおり待つ', () => {
  const f = facts([
    fi(planReview(1), ['a.ts']),
    fi(planOk(3, { claim: manual(OTHER, 'implement') }), ['a.ts']),
  ]);
  assert.equal(stageOf(f, 1), 'plan-review');
  const s = select(f);
  assert.equal(s.selected.includes(1), false);
  assert.equal(s.excluded.get(1), '#3 と触るファイルが重なるため待つ');
});

test('plan-review の Issue は、PR のある Issue と重なれば今までどおり待つ', () => {
  const f = facts([
    fi(planReview(1), ['a.ts']),
    fi(planOk(4), ['a.ts'], [openPr(40, 4)]),
  ]);
  assert.equal(stageOf(f, 1), 'plan-review');
  assert.equal(fleetStatus(f).find((r) => r.issue === 4)!.pr, 40, '前提：D は PR のある段階');
  const s = select(f);
  assert.deepEqual(s.selected, [4]);
  assert.equal(s.excluded.get(1), '#4 と触るファイルが重なるため待つ');
});

test('このセッションの plan-gate の宣言が残った plan-review の Issue と plan-ok の Issue が重なっても、両方を選ぶ', () => {
  const f = facts([
    fi(planReview(1, { claim: manual(SESSION, 'plan-gate') }), ['harness/lib/fleet.ts']),
    fi(planOk(2), ['harness/lib/fleet.ts']),
  ]);
  assert.equal(stageOf(f, 1), 'plan-review', '前提：宣言が残っていても段階は plan-review');
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.equal(s.excluded.has(2), false);
});
