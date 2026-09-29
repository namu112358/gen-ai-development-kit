// Issue #216：判定の着手宣言（段階 judge）が有効な間は、App が main への追従を待つかを決める純粋関数 holdsMainFollow
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdsMainFollow, type Claim } from '../lib/queue.ts';

const now = new Date('2026-09-26T12:00:00Z');
const limits = { humanClaimStaleHours: 6, routineClaimTakeoverMinutes: 90 };
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const manual = (patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: ago(30), stage: 'judge', ...patch });
const routine = (patch: Partial<Extract<Claim, { by: 'routine' }>> = {}): Claim => ({ by: 'routine', session: 'https://claude.ai/code/session_01ABCDEFGHxyz', at: ago(30), stage: 'judge', ...patch });

test('holdsMainFollow：段階 judge の手動の宣言（期限内）なら待つ', () => {
  assert.equal(holdsMainFollow(manual(), now, limits), true);
  assert.equal(holdsMainFollow(manual({ at: ago(5 * 60) }), now, limits), true, '5 時間前でも 6 時間の期限内');
  assert.equal(holdsMainFollow(manual({ session: '3f2a9c1e-0b1d-4c2e-9f00-123456789abc' }), now, limits), true, 'セッションは問わない');
});

test('holdsMainFollow：段階 judge の Routine の宣言は 90 分以内なら待ち、過ぎたら待たない', () => {
  assert.equal(holdsMainFollow(routine({ at: ago(60) }), now, limits), true);
  assert.equal(holdsMainFollow(routine({ at: ago(120) }), now, limits), false);
});

test('holdsMainFollow：段階 judge の手動の宣言でも humanClaimStaleHours を過ぎたら待たない', () => {
  assert.equal(holdsMainFollow(manual({ at: ago(7 * 60) }), now, limits), false);
  assert.equal(holdsMainFollow(manual({ at: ago(24 * 60) }), now, limits), false);
});

test('holdsMainFollow：期限は渡された limits で数える', () => {
  assert.equal(holdsMainFollow(manual({ at: ago(3 * 60) }), now, { ...limits, humanClaimStaleHours: 2 }), false);
  assert.equal(holdsMainFollow(routine({ at: ago(20) }), now, { ...limits, routineClaimTakeoverMinutes: 10 }), false);
  assert.equal(holdsMainFollow(routine({ at: ago(120) }), now, { ...limits, routineClaimTakeoverMinutes: 180 }), true);
});

test('holdsMainFollow：解除された宣言・judge 以外の段階・段階なし・宣言なしなら待たない', () => {
  assert.equal(holdsMainFollow(manual({ released: true }), now, limits), false, '解除');
  assert.equal(holdsMainFollow(routine({ released: true }), now, limits), false, '解除（Routine）');
  for (const stage of ['fix', 'sync', 'implement', 'plan'] as const) {
    assert.equal(holdsMainFollow(manual({ stage }), now, limits), false, `段階 ${stage}`);
  }
  const { stage: _m, ...noStageManual } = manual() as Extract<Claim, { by: 'manual' }>;
  assert.equal(holdsMainFollow(noStageManual, now, limits), false, '段階なし（手動）');
  const { stage: _r, ...noStageRoutine } = routine() as Extract<Claim, { by: 'routine' }>;
  assert.equal(holdsMainFollow(noStageRoutine, now, limits), false, '段階なし（Routine。今の Routine の判定の宣言）');
  assert.equal(holdsMainFollow(null, now, limits), false, '宣言なし');
});
