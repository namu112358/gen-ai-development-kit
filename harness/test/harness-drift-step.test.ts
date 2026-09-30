// Issue #199：agent.ts step（decideStep）が、judge のノードになる状態で読み込みが古い（harnessStale に文）なら宣言を出さずに stop harness-stale を返し、
// 自分の宣言を解除すること。harnessStale が null なら今までどおり judge、judge 以外のノード（plan・implement・fix・sync）では止まらないこと。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_STEP_STOP_REASONS } from '../lib/flow.ts';
import { decideStep, type StepNodeResult, type StepStopResult } from '../lib/step.ts';
import { fleetIssue, issueFacts, manual, N, openPr, PR, planOkFacts, SESSION, stepInput } from './support/step-fixtures.ts';

const STALE = 'このセッションの読み込みが古いため judge を始めません（ship・fleet の SKILL.md の「ハーネスが更新されたときの交代」）';

const judgeIssue = (prClaim?: ReturnType<typeof manual>, issueClaim?: ReturnType<typeof manual>) =>
  fleetIssue(planOkFacts(issueClaim ? { claim: issueClaim } : {}), { prs: [openPr(prClaim ? { claim: prClaim } : {})] });

test('FLOW_STEP_STOP_REASONS に harness-stale がある', () => {
  assert.ok((FLOW_STEP_STOP_REASONS as readonly string[]).includes('harness-stale'));
});

test('judge のノードで harnessStale に文 → stop harness-stale（宣言しない、detail はその文）', () => {
  const d = decideStep(stepInput(judgeIssue(), { harnessStale: STALE }));
  assert.equal(d.result.kind, 'stop', JSON.stringify(d.result));
  const r = d.result as StepStopResult;
  assert.equal(r.reason, 'harness-stale');
  assert.equal(r.detail, STALE);
  assert.equal(d.claim, null, '宣言を出さない');
  assert.deepEqual(d.release, []);
  assert.equal(r.released, false);
});

test('judge のノードで harnessStale → 自分の宣言（Issue と PR）を解除する', () => {
  const d = decideStep(stepInput(judgeIssue(manual(SESSION, 'judge'), manual(SESSION, 'implement')), { harnessStale: STALE }));
  assert.equal(d.result.kind, 'stop');
  assert.equal((d.result as StepStopResult).reason, 'harness-stale');
  assert.equal(d.claim, null);
  assert.deepEqual([...d.release].sort((a, b) => a - b), [N, PR].sort((a, b) => a - b));
  assert.equal((d.result as StepStopResult).released, true);
});

test('harnessStale が null・省略なら今までどおり node judge（PR に stage judge）', () => {
  for (const patch of [{ harnessStale: null }, {}]) {
    const d = decideStep(stepInput(judgeIssue(), patch));
    assert.equal(d.result.kind, 'node', JSON.stringify(d.result));
    assert.equal((d.result as StepNodeResult).node, 'judge');
    assert.deepEqual(d.claim, { target: PR, stage: 'judge' });
  }
});

test('judge 以外のノード（plan・implement・fix・sync）では harnessStale があっても止まらない', () => {
  const cases: [string, ReturnType<typeof fleetIssue>, number][] = [
    ['plan', fleetIssue(issueFacts()), N],
    ['implement', fleetIssue(planOkFacts()), N],
    ['fix', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } })] }), PR],
    ['sync', fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true })] }), PR],
  ];
  for (const [node, issue, target] of cases) {
    const d = decideStep(stepInput(issue, { harnessStale: STALE }));
    assert.equal(d.result.kind, 'node', `${node}: ${JSON.stringify(d.result)}`);
    assert.equal((d.result as StepNodeResult).node, node);
    assert.deepEqual(d.claim, { target, stage: node });
  }
});
