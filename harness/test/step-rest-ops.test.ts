// Issue #708：agent.ts step（decideStep）が返すノードの操作が、GraphQL を使う gh の代わりに REST の入口を案内すること。
// implement の allowed に gh pr create が無く rest-create draft-pr <番号> があり、plan の inputs に gh issue view が無く rest issue-view <番号> がある。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideStep, type StepNodeResult } from '../lib/step.ts';
import { fleetIssue, issueFacts, N, planOkFacts, stepInput } from './support/step-fixtures.ts';

function nodeOf(issue: ReturnType<typeof fleetIssue>, node: string): StepNodeResult {
  const r = decideStep(stepInput(issue)).result;
  assert.equal(r.kind, 'node', JSON.stringify(r));
  assert.equal(r.node, node);
  return r as StepNodeResult;
}

test('implement の allowed：gh pr create が無く、rest-create draft-pr <番号> がある', () => {
  const r = nodeOf(fleetIssue(planOkFacts()), 'implement');
  assert.equal(r.allowed.some((a) => a.includes('gh pr create')), false, JSON.stringify(r.allowed));
  assert.ok(r.allowed.some((a) => a.includes(`rest-create draft-pr ${N}`)), JSON.stringify(r.allowed));
});

test('plan の inputs：gh issue view が無く、rest issue-view <番号> がある', () => {
  const r = nodeOf(fleetIssue(issueFacts()), 'plan');
  assert.equal(r.inputs.some((a) => a.includes('gh issue view')), false, JSON.stringify(r.inputs));
  assert.ok(r.inputs.some((a) => a.includes(`rest issue-view ${N}`)), JSON.stringify(r.inputs));
});
