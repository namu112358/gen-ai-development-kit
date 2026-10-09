// Issue #571：agent.ts step（decideStep）の fix・sync の段階の案内（allowed）の push が、行き先のブランチまで書く形
// （git push origin <PR のブランチ>）で、force push しないと書いてあること。行き先の無い git push を出さず、push の項目が消えても失敗にする。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideStep, type StepNodeResult, type StepResult } from '../lib/step.ts';
import { fleetIssue, openPr, planOkFacts, stepInput } from './support/step-fixtures.ts';

const PUSH = 'git push origin <PR のブランチ>';

function nodeOf(r: StepResult): StepNodeResult {
  assert.equal(r.kind, 'node', `node のはず: ${JSON.stringify(r)}`);
  return r as StepNodeResult;
}

const cases: Array<[StepNodeResult['node'], ReturnType<typeof fleetIssue>]> = [
  ['fix', fleetIssue(planOkFacts(), { prs: [openPr({ acceptance: { reviewPass: false, at: '2026-09-26T03:00:00Z' } })] })],
  ['sync', fleetIssue(planOkFacts(), { prs: [openPr({ conflicted: true })] })],
];

for (const [node, issue] of cases) {
  test(`${node} の案内の push は「${PUSH}」で始まり、force push しないと書く（行き先の無い git push を出さない）`, () => {
    const r = nodeOf(decideStep(stepInput(issue)).result);
    assert.equal(r.node, node);
    const pushes = r.allowed.filter((a) => a.includes('git push'));
    assert.ok(pushes.length >= 1, `push の項目が無い: ${JSON.stringify(r.allowed)}`);
    for (const a of pushes) {
      assert.ok(a.startsWith(PUSH), `行き先のブランチの無い push: ${a}`);
      assert.ok(a.includes('force push しない'), `force push しないと書いていない: ${a}`);
    }
  });
}
