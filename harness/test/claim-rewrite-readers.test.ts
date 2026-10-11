// Issue #655：history を持つ1件の宣言と、同じ意味の段階ごとに1コメントの並びで、持ち主・批評の関所・push の時点の宣言・止まった宣言が同じ答えになる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimActivityAt, claimOf, critiqueClaimedBefore } from '../lib/facts.ts';
import { claimAt } from '../lib/push-claim.ts';
import { planReturnsOf } from '../lib/report.ts';
import { stalledClaims } from '../lib/stalled-claim.ts';
import { claimPair, type ClaimStep } from './support/claim-fixtures.ts';

const T0 = Date.parse('2026-10-10T17:00:00.000Z');
const t = (k: number, extraMinutes = 0) => new Date(T0 + (k * 10 + extraMinutes) * 60_000).toISOString();
const PR = { number: 5, title: 'feat: t', html_url: 'https://x/5' };

test('history の1件と段階ごとの並び（plan → plan-critique → 計画 → plan-gate → implement → plan → fix）で、読む側の答えが同じ', () => {
  const steps: ClaimStep[] = [
    { claim: { stage: 'plan' }, at: t(0) },
    { claim: { stage: 'plan-critique' }, at: t(1) },
    { plan: true, at: t(2) },
    { claim: { stage: 'plan-gate' }, at: t(3) },
    { claim: { stage: 'implement' }, at: t(4) },
    { claim: { stage: 'plan' }, at: t(5) },
    { claim: { stage: 'fix' }, at: t(6) },
  ];
  const { perStage, rewritten, ids } = claimPair(steps);
  const planId = ids[2]!;

  const owner = claimOf(perStage);
  assert.equal(owner?.stage, 'fix');
  assert.deepEqual(claimOf(rewritten), owner);

  assert.equal(critiqueClaimedBefore(perStage, planId), true);
  assert.equal(critiqueClaimedBefore(rewritten, planId), true);

  // push の時点：最初の段階の前と、各段階の間
  for (const pushedAt of [t(0, -5), ...steps.map((_, k) => t(k, 5))]) {
    assert.deepEqual(claimAt(rewritten, pushedAt), claimAt(perStage, pushedAt), pushedAt);
  }

  const now = new Date(T0 + 3 * 3600_000);
  const stalled = (comments: typeof perStage) => stalledClaims([{ pr: PR, claim: claimOf(comments), headCommitAt: t(-6) }], now, 60);
  assert.equal(stalled(perStage).length, 1);
  assert.deepEqual(stalled(rewritten), stalled(perStage));

  assert.equal(planReturnsOf(perStage), 1);
  assert.equal(planReturnsOf(rewritten), 1);
  assert.equal(claimActivityAt(perStage), t(6));
  assert.equal(claimActivityAt(rewritten), t(6));
});

test('plan-critique が計画の後にしか無い並びでは、どちらも批評の関所が偽', () => {
  const { perStage, rewritten, ids } = claimPair([
    { claim: { stage: 'plan' }, at: t(0) },
    { plan: true, at: t(1) },
    { claim: { stage: 'plan-critique' }, at: t(2) },
  ]);
  assert.equal(critiqueClaimedBefore(perStage, ids[1]!), false);
  assert.equal(critiqueClaimedBefore(rewritten, ids[1]!), false);
});
