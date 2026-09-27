import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMergeRoute, type Acceptance, type MergeRouteInput } from '../lib/merge-route.ts';

const STACKED_REASON = 'base が既定ブランチではありません（Stacked PR は Human Merge）';

const eligible: Acceptance = {
  version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [],
};

/** stacked 以外は自動 Merge の条件をすべて満たす入力 */
const allOk: MergeRouteInput = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance: eligible };

test('merge-route：Stacked PR に auto-merge が付いていれば、ほかの条件が揃っていても failure', () => {
  const r = evaluateMergeRoute({ ...allOk, stacked: true });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.summary.includes(STACKED_REASON), r.summary);
});

test('merge-route：Stacked PR に auto-merge が無ければ Human Merge 経路として通す', () => {
  const r = evaluateMergeRoute({ ...allOk, autoMergeEnabled: false, stacked: true });
  assert.equal(r.conclusion, 'success');
  assert.equal(r.title, 'auto-merge なし（Human Merge 経路）');
});

test('merge-route：stacked を省略・false にすれば今までどおり', () => {
  assert.equal(evaluateMergeRoute(allOk).conclusion, 'success');
  assert.equal(evaluateMergeRoute({ ...allOk, stacked: false }).conclusion, 'success');
  assert.ok(!evaluateMergeRoute({ ...allOk, hold: true }).summary.includes(STACKED_REASON), 'stacked でない失敗に Stacked の理由を混ぜない');
});

test('merge-route：Stacked の理由はほかの理由と並べて出す', () => {
  const r = evaluateMergeRoute({ ...allOk, hold: true, stacked: true });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.summary.includes(STACKED_REASON) && r.summary.includes('`agent:hold` が付いています'), r.summary);
});
