// Issue #306：agent.ts step（decideStep）が、今の状態に合うノードを1つだけ返すこと。計画なし → plan、計画の検査・批評の結果で plan ⇄ plan-critique、
// 計画ゲート通過 → implement、PR の判定・指摘・衝突で judge・fix・sync、App・人の待ちは wait。宣言する番号と段階（同じ段階の自分の宣言があれば出さない）と、
// 段階が fleet の表（fleetStatus）の行と食い違わないことも確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fleetStatus, issueNode, type FleetIssue } from '../lib/fleet.ts';
import { fleetStageOf } from '../lib/flow.ts';
import { decideStep, type StepDecision, type StepNodeResult, type StepResult, type StepWaitResult } from '../lib/step.ts';
import {
  GATE_AT,
  manual,
  mergedPr,
  N,
  openPr,
  OTHER,
  PR,
  PR_BRANCH,
  SESSION,
  fleetIssue,
  issueFacts,
  planOkFacts,
  stepInput,
} from './support/step-fixtures.ts';

const POST_PLAN = `node harness/scripts/agent.ts post-plan ${N}`;

function asNode(r: StepResult): StepNodeResult {
  assert.equal(r.kind, 'node', `node のはず: ${JSON.stringify(r)}`);
  return r as StepNodeResult;
}
function asWait(r: StepResult): StepWaitResult {
  assert.equal(r.kind, 'wait', `wait のはず: ${JSON.stringify(r)}`);
  return r as StepWaitResult;
}
const hasPostPlan = (r: StepNodeResult): boolean => r.allowed.some((a) => a.startsWith(POST_PLAN));

/** node で、宣言（decision.claim と result.claim）が target・stage に一致する */
function expectNode(d: StepDecision, node: StepNodeResult['node'], target: number, stage: string): StepNodeResult {
  const r = asNode(d.result);
  assert.equal(r.node, node);
  assert.deepEqual(r.claim, { target, stage });
  assert.deepEqual(d.claim, { target, stage }, '自分の宣言が無いので投稿する');
  assert.deepEqual(d.release, [], 'node では解除しない');
  assert.equal(r.version, 1);
  assert.equal(r.issue, N);
  return r;
}

// ---- 計画の前：plan ⇄ plan-critique ----

test('計画なし → node plan（Issue に stage plan で宣言、skill は plan、PR・branch は null、branchPrefix は claude/issue-<番号>-）', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts())));
  const r = expectNode(d, 'plan', N, 'plan');
  assert.equal(r.skill, 'plan');
  assert.equal(r.pr, null);
  assert.equal(r.branch, null);
  assert.equal(r.branchPrefix, `claude/issue-${N}-`);
  assert.equal(hasPostPlan(r), false);
});

test('local plan（書式の誤りなし）→ node plan-critique（stage plan-critique、post-plan はまだ許さない）', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { local: { kind: 'plan', errors: [] } }));
  const r = expectNode(d, 'plan-critique', N, 'plan-critique');
  assert.equal(r.skill, 'plan');
  assert.equal(hasPostPlan(r), false, 'post-plan を allowed に含まない');
});

test('local plan（書式の誤りあり）→ node plan に戻り、誤りを inputs に出す', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { local: { kind: 'plan', errors: ['files が無い'] } }));
  const r = expectNode(d, 'plan', N, 'plan');
  assert.ok(r.inputs.some((x) => x.includes('files が無い')), r.inputs.join('\n'));
});

test('local critique revise（1回目）→ node plan、inputs に必須の指摘、批評の回を1つ残す', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { local: { kind: 'critique', round: { verdict: 'revise', must: ['AC 2 のテストが無い'] } } }));
  const r = expectNode(d, 'plan', N, 'plan');
  assert.ok(r.inputs.some((x) => x.includes('AC 2 のテストが無い')), r.inputs.join('\n'));
  assert.deepEqual(d.critique, [{ verdict: 'revise', must: ['AC 2 のテストが無い'] }]);
});

for (const verdict of ['go', 'split'] as const) {
  test(`local critique ${verdict} → node plan-critique で post-plan を許す`, () => {
    const d = decideStep(stepInput(fleetIssue(issueFacts()), { local: { kind: 'critique', round: { verdict, must: [] } } }));
    const r = expectNode(d, 'plan-critique', N, 'plan-critique');
    assert.equal(hasPostPlan(r), true, r.allowed.join('\n'));
    assert.deepEqual(d.critique, [{ verdict, must: [] }]);
  });
}

test('段階のファイルから引き継いだ最後の回が go なら、local none でも node plan-critique で post-plan を許す', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { critique: [{ verdict: 'revise', must: ['x'] }, { verdict: 'go', must: [] }] }));
  const r = expectNode(d, 'plan-critique', N, 'plan-critique');
  assert.equal(hasPostPlan(r), true);
});

test('段階のファイルから引き継いだ最後の回が revise なら、local none で node plan（必須の指摘を inputs に）', () => {
  const d = decideStep(stepInput(fleetIssue(issueFacts()), { critique: [{ verdict: 'revise', must: ['x を直す'] }] }));
  const r = expectNode(d, 'plan', N, 'plan');
  assert.ok(r.inputs.some((i) => i.includes('x を直す')));
});

// ---- 計画ゲート ----

test('計画ゲートの結果待ち（最新の計画が記録より後・記録が無い）→ wait app（node plan-gate）、宣言しない', () => {
  for (const facts of [
    issueFacts({ latestPlanAt: '2026-09-26T02:00:00Z', gate: { pass: true, planCommentId: 5, at: GATE_AT } }),
    issueFacts({ latestPlanAt: '2026-09-26T02:00:00Z', gate: null }),
  ]) {
    const d = decideStep(stepInput(fleetIssue(facts)));
    const r = asWait(d.result);
    assert.equal(r.waitingFor, 'app');
    assert.equal(r.node, 'plan-gate');
    assert.equal(d.claim, null);
    assert.deepEqual(d.release, []);
  }
});

test('計画ゲートを通った（gate pass・agent:plan-ok・App が付けた）→ node implement（Issue に stage implement）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts())));
  const r = expectNode(d, 'implement', N, 'implement');
  assert.equal(r.skill, 'implement');
  assert.equal(r.pr, null);
  assert.deepEqual(r.files, ['harness/lib/step.ts'], '計画の files を返す');
});

test('agent:plan-ok を App が付けていない → implement にしない（wait app）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts({ planOkByApp: false }))));
  assert.equal(asWait(d.result).waitingFor, 'app');
});

test('plan-ok で領域の上限（areaFull）→ wait area-limit、宣言しない', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts()), { areaFull: 'harness の領域が上限（2/2）' }));
  const r = asWait(d.result);
  assert.equal(r.waitingFor, 'area-limit');
  assert.equal(r.detail, 'harness の領域が上限（2/2）');
  assert.equal(d.claim, null);
});

test('agent:plan-review で --proceed → node implement、--proceed なし → stop plan-review', () => {
  const facts = issueFacts({ labels: ['agent:ready', 'agent:plan-review'], latestPlanAt: '2026-09-26T01:00:00Z', gate: { pass: false, planCommentId: 5, at: GATE_AT } });
  const go = decideStep(stepInput(fleetIssue(facts), { proceed: true }));
  expectNode(go, 'implement', N, 'implement');
  const no = decideStep(stepInput(fleetIssue(facts)));
  assert.equal(no.result.kind, 'stop');
  assert.equal(no.result.kind === 'stop' && no.result.reason, 'plan-review');
  assert.equal(no.claim, null);
});

test('計画ゲートで停止（gate.pass が false、ラベルなし）→ stop plan-review', () => {
  const facts = issueFacts({ latestPlanAt: '2026-09-26T01:00:00Z', gate: { pass: false, planCommentId: 5, at: GATE_AT } });
  const d = decideStep(stepInput(fleetIssue(facts)));
  assert.equal(d.result.kind === 'stop' && d.result.reason, 'plan-review');
});

// ---- PR ----

test('開いた PR で判定なし → node judge（PR に stage judge、branch は PR の head のブランチ）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr()] })));
  const r = expectNode(d, 'judge', PR, 'judge');
  assert.equal(r.skill, 'judge');
  assert.equal(r.pr, PR);
  assert.equal(r.branch, PR_BRANCH);
});

test('acceptance 不合格（ブロッキング指摘）→ node fix（PR に stage fix）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } })] })));
  const r = expectNode(d, 'fix', PR, 'fix');
  assert.equal(r.skill, 'fix');
  assert.equal(r.branch, PR_BRANCH);
});

test('最後の push より後に人のレビュー → node fix', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ humanFeedbackSincePush: 1 })] })));
  expectNode(d, 'fix', PR, 'fix');
});

test('main と衝突 → node sync（PR に stage sync）。判定・合格の後でも衝突が先', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true })] })));
  const r = expectNode(d, 'sync', PR, 'sync');
  assert.equal(r.skill, 'sync');
  assert.equal(r.branch, PR_BRANCH);
  const passed = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true, acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { autoMerge: true })] })));
  expectNode(passed, 'sync', PR, 'sync');
});

test('合格・Merge 経路待ち → wait app（merge-route-pending）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } })] })));
  const r = asWait(d.result);
  assert.equal(r.waitingFor, 'app');
  assert.equal(r.node, 'merge-route-pending');
  assert.equal(r.pr, PR);
  assert.equal(d.claim, null);
});

test('判定の受け付け待ち → wait app（verdict-pending）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ verdictAwaitingGate: true })] })));
  const r = asWait(d.result);
  assert.equal(r.waitingFor, 'app');
  assert.equal(r.node, 'verdict-pending');
});

test('auto-merge → wait app（auto-merge）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { autoMerge: true })] })));
  const r = asWait(d.result);
  assert.equal(r.waitingFor, 'app');
  assert.equal(r.node, 'auto-merge');
});

test('人の Merge 待ち（合格・kind=human-review・Ready）→ wait human（human-merge）', () => {
  const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { humanReview: true, draft: false })] })));
  const r = asWait(d.result);
  assert.equal(r.waitingFor, 'human');
  assert.equal(r.node, 'human-merge');
});

test('Merge 済み・Close 済み → wait done（merged）', () => {
  const merged = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [mergedPr()] })));
  const r = asWait(merged.result);
  assert.equal(r.waitingFor, 'done');
  assert.equal(r.node, 'merged');
  assert.equal(r.pr, PR);
  const closed = asWait(decideStep(stepInput(fleetIssue(planOkFacts(), { closed: true }))).result);
  assert.equal(closed.waitingFor, 'done');
});

test('人の PR（agent:false）で人のレビュー・衝突 → wait human、宣言しない', () => {
  for (const facts of [{ humanFeedbackSincePush: 1 }, { conflicted: true }, { acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } }]) {
    const d = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ agent: false, ...facts })] })));
    const r = asWait(d.result);
    assert.equal(r.waitingFor, 'human', JSON.stringify(facts));
    assert.equal(d.claim, null);
    assert.deepEqual(d.release, []);
  }
});

// ---- 宣言：同じ段階の自分の宣言があれば出さない ----

test('同じ段階の自分の宣言があれば decision.claim は null（result.claim は残す）、違う段階なら宣言を出す', () => {
  const same = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'implement') }))));
  assert.equal(same.claim, null);
  assert.deepEqual(asNode(same.result).claim, { target: N, stage: 'implement' });

  const other = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'plan-gate') }))));
  assert.deepEqual(other.claim, { target: N, stage: 'implement' });

  const released = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'implement', { released: true }) }))));
  assert.deepEqual(released.claim, { target: N, stage: 'implement' }, '解除済みの宣言は自分の宣言として数えない');
});

test('PR の段階は PR の宣言で見る：PR に同じ段階（judge）の自分の宣言があれば出さない、Issue の宣言では決めない', () => {
  const onPr = decideStep(stepInput(fleetIssue(planOkFacts(), { prs: [openPr({ claim: manual(SESSION, 'judge') })] })));
  assert.equal(onPr.claim, null);
  const onIssue = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(SESSION, 'judge') }), { prs: [openPr()] })));
  assert.deepEqual(onIssue.claim, { target: PR, stage: 'judge' });
});

test('ほかのセッションの解除済みの宣言・Routine の宣言では止まらない', () => {
  const d1 = decideStep(stepInput(fleetIssue(planOkFacts({ claim: manual(OTHER, 'implement', { released: true }) }))));
  expectNode(d1, 'implement', N, 'implement');
  const d2 = decideStep(stepInput(fleetIssue(planOkFacts({ claim: { by: 'routine', session: OTHER, at: '2026-09-26T11:00:00Z' } }))));
  expectNode(d2, 'implement', N, 'implement');
});

// ---- 1つだけ返す・fleet の表と食い違わない ----

const STATES: [string, FleetIssue][] = [
  ['計画なし', fleetIssue(issueFacts())],
  ['計画ゲート待ち', fleetIssue(issueFacts({ latestPlanAt: '2026-09-26T02:00:00Z' }))],
  ['plan-review', fleetIssue(issueFacts({ labels: ['agent:plan-review'], latestPlanAt: '2026-09-26T01:00:00Z' }))],
  ['plan-ok', fleetIssue(planOkFacts())],
  ['judge', fleetIssue(planOkFacts(), { prs: [openPr()] })],
  ['fix', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } })] })],
  ['人のレビュー', fleetIssue(planOkFacts(), { prs: [openPr({ humanFeedbackSincePush: 2 })] })],
  ['衝突', fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true, acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { humanReview: true, draft: false })] })],
  ['verdict-pending', fleetIssue(planOkFacts(), { prs: [openPr({ verdictAwaitingGate: true })] })],
  ['merge-route-pending', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } })] })],
  ['auto-merge', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { autoMerge: true })] })],
  ['human-merge', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: true, at: '2026-09-26T03:00:00Z' } }, { humanReview: true, draft: false })] })],
  ['Merge 済み', fleetIssue(planOkFacts(), { prs: [mergedPr()] })],
  ['人の PR の衝突', fleetIssue(planOkFacts(), { prs: [openPr({ agent: false, conflicted: true })] })],
  ['hold', fleetIssue(planOkFacts({ labels: ['agent:hold'] }))],
  ['依存', fleetIssue(issueFacts({ openBlockers: [7] }))],
];

test('1件の Issue で、step の段階が fleet の表（fleetStatus）の行と食い違わない（段階・PR・次にやること）', () => {
  for (const [name, issue] of STATES) {
    const row = fleetStatus({ issues: [issue], prConflicts: [] })[0]!;
    const at = issueNode(issue, issue.prs.some((p) => p.merged));
    assert.equal(row.stage, fleetStageOf(at.node), `${name}：fleet の段階は issueNode のノードの段階`);
    assert.equal(row.pr, at.pr, `${name}：PR`);
    const d = decideStep(stepInput(issue));
    assert.equal(d.result.pr, row.pr, `${name}：step の PR は fleet の行の PR`);
    if (d.result.kind === 'node') assert.equal(row.next, d.result.skill, `${name}：step の node の skill は fleet の次にやること`);
    else assert.equal(row.next, 'none', `${name}：step が node を返さないなら fleet の次にやることは none（${d.result.kind}）`);
    if (d.result.kind !== 'node' || (d.result.node !== 'sync' && d.result.node !== 'plan' && d.result.node !== 'implement')) {
      assert.equal(d.result.node, at.node, `${name}：step のノードは issueNode のノード`);
    }
  }
});
