// Issue #655：history の無い古い宣言の並びは今と同じく読める（並べ替えない）。書式違いの history は無いものとして上の階層だけで読む
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimOf, claimTimeline } from '../lib/facts.ts';
import { claimHistoryOf, type ClaimEntry, type StoredClaim } from '../lib/queue.ts';
import { CLAIM_SESSION, claimComment, claimPair } from './support/claim-fixtures.ts';

const T0 = '2026-10-10T17:00:00.000Z';
const T1 = '2026-10-10T17:10:00.000Z';
const T2 = '2026-10-10T17:20:00.000Z';

test('claimTimeline：history の無い並び（宣言・計画・宣言）は、入力と同じ順・同じ数の要素になる', () => {
  const { perStage } = claimPair([{ claim: { stage: 'plan' }, at: T0 }, { plan: true, at: T1 }, { claim: { stage: 'implement' }, at: T2 }]);
  const input = [...perStage].reverse();
  const items = claimTimeline(input);
  assert.deepEqual(items.map((i) => i.comment.id), input.map((c) => c.id));
  assert.deepEqual(items.map((i) => i.kind), ['claim', 'end', 'claim']);
});

test('書式違いの history は claimHistoryOf が null を返し、claimOf は上の階層の値を返す', () => {
  const top = { by: 'manual' as const, session: CLAIM_SESSION, at: T2, stage: 'implement' as const };
  const many: ClaimEntry[] = [{ stage: 'plan', at: T0 }, ...Array.from({ length: 29 }, (_, i): ClaimEntry => ({ stage: 'plan', at: T1, after: 10 + i })), { stage: 'implement', at: T2, after: 50 }];
  const cases: { name: string; history: ClaimEntry[] }[] = [
    { name: '31件', history: many },
    { name: '最後の段階が上の階層と違う', history: [{ stage: 'plan', at: T0 }, { stage: 'plan-gate', at: T1, after: 5 }] },
    { name: '2件目に after が無い', history: [{ stage: 'plan', at: T0 }, { stage: 'implement', at: T2 }] },
  ];
  for (const c of cases) {
    const value: StoredClaim = { ...top, history: c.history };
    assert.equal(claimHistoryOf(value), null, c.name);
    const got = claimOf([claimComment(1, value, T0)]);
    assert.deepEqual(got && { by: got.by, session: got.session, at: got.at, stage: got.stage }, top, c.name);
  }
});
