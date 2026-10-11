// Issue #640：agent.ts step（decideStep）の implement・fix・sync の allowed に出る検証コマンドが、設定（StepInput.checkCommand）から来ること。
// 渡すとその値、null なら出さない、渡さないと既定の npm run check。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FleetIssue } from '../lib/fleet.ts';
import { decideStep, type StepInput } from '../lib/step.ts';
import { fleetIssue, openPr, planOkFacts, stepInput } from './support/step-fixtures.ts';

const NODES: [string, () => FleetIssue][] = [
  ['implement', () => fleetIssue(planOkFacts())],
  ['fix', () => fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } })] })],
  ['sync', () => fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true })] })],
];

function allowedOf(issue: FleetIssue, patch: Partial<StepInput>, node: string): string[] {
  const d = decideStep(stepInput(issue, patch));
  assert.equal(d.result.kind, 'node', JSON.stringify(d.result));
  if (d.result.kind !== 'node') return [];
  assert.equal(d.result.node, node);
  return d.result.allowed;
}

test('decideStep：checkCommand を渡すと implement・fix・sync の allowed にその値が出て、npm run check は出ない', () => {
  for (const [node, issue] of NODES) {
    const allowed = allowedOf(issue(), { checkCommand: 'pytest -q' }, node);
    assert.ok(allowed.includes('pytest -q'), `${node}: ${JSON.stringify(allowed)}`);
    assert.ok(!allowed.includes('npm run check'), `${node}: ${JSON.stringify(allowed)}`);
  }
});

test('decideStep：checkCommand が null なら implement・fix・sync の allowed に検証コマンドが無い（ほかの項目は変わらない）', () => {
  for (const [node, issue] of NODES) {
    const base = allowedOf(issue(), {}, node);
    const allowed = allowedOf(issue(), { checkCommand: null }, node);
    assert.deepEqual(allowed, base.filter((a) => a !== 'npm run check'), node);
  }
});

test('decideStep：checkCommand を渡さないと implement・fix・sync の allowed は既定の npm run check', () => {
  for (const [node, issue] of NODES) {
    const allowed = allowedOf(issue(), {}, node);
    assert.ok(allowed.includes('npm run check'), `${node}: ${JSON.stringify(allowed)}`);
  }
});
