// Issue #371：持ち主のいない衝突した Agent PR（宣言が無いか期限切れ）を選び、ダッシュボードの「引き継ぐか決める」の行にする
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Claim } from '../lib/queue.ts';
import { claimAlive, renderUnownedConflictLine, unownedConflicts, type UnownedConflictInput } from '../lib/unowned-conflict.ts';

const LIMITS = { humanClaimStaleHours: 6, routineClaimTakeoverMinutes: 90 };
const AT = '2026-09-30T00:00:00.000Z';
const after = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000);
const PR = { number: 315, title: 'feat: t', html_url: 'https://x/315' };

const manual = (patch: Partial<Claim> = {}): Claim => ({ by: 'manual', at: AT, session: '38ab2367-aaaa-bbbb', stage: 'judge', ...patch }) as Claim;
const routine = (patch: Partial<Claim> = {}): Claim => ({ by: 'routine', at: AT, session: 'https://claude.ai/code/session_01ABCDEFGHxyz', ...patch }) as Claim;
const input = (claims: (Claim | null)[], patch: Partial<UnownedConflictInput> = {}): UnownedConflictInput => ({ pr: PR, issues: [147], claims, ...patch });

test('claimAlive：手動の宣言は humanClaimStaleHours（時間単位の切り捨て）まで生きている', () => {
  assert.equal(claimAlive(manual(), after(6 * 60 - 1), LIMITS), true);
  assert.equal(claimAlive(manual(), after(6 * 60), LIMITS), false);
});

test('claimAlive：Routine の宣言は routineClaimTakeoverMinutes まで生きている', () => {
  assert.equal(claimAlive(routine(), after(89), LIMITS), true);
  assert.equal(claimAlive(routine(), after(90), LIMITS), false);
});

test('claimAlive：null・解除した宣言・at が読めない宣言は生きていない', () => {
  assert.equal(claimAlive(null, after(1), LIMITS), false);
  assert.equal(claimAlive(manual({ released: true }), after(1), LIMITS), false);
  assert.equal(claimAlive(manual({ at: 'not a date' }), after(1), LIMITS), false);
});

test('unownedConflicts：宣言の無い PR と期限切れの宣言の PR を、入力の順で出す', () => {
  const now = after(7 * 60);
  const rows = unownedConflicts([
    input([manual(), null], { pr: { ...PR, number: 320 } }),
    input([null, null], { pr: { ...PR, number: 310 } }),
  ], now, LIMITS);
  assert.deepEqual(rows.map((r) => r.pr.number), [320, 310]);
  assert.deepEqual(rows[0]!.claim, manual());
  assert.equal(rows[1]!.claim, null);
  assert.deepEqual(rows[0]!.issues, [147]);
});

test('unownedConflicts：PR か Issue のどれかに期限内の宣言があれば出さない', () => {
  const now = after(60);
  assert.deepEqual(unownedConflicts([input([manual(), null])], now, LIMITS), []);
  assert.deepEqual(unownedConflicts([input([null, routine()])], now, LIMITS), []);
  // 期限切れの宣言があっても、ほかに期限内の宣言があれば出さない
  assert.deepEqual(unownedConflicts([input([manual({ at: '2026-09-29T00:00:00.000Z' }), manual()])], now, LIMITS), []);
});

test('unownedConflicts：解除した宣言は持ち主にならない', () => {
  const rows = unownedConflicts([input([manual({ released: true }), null])], after(1), LIMITS);
  assert.deepEqual(rows.map((r) => r.pr.number), [315]);
});

test('unownedConflicts：期限切れの宣言が複数あれば、at の新しいものを表示する', () => {
  const older = manual({ at: '2026-09-29T00:00:00.000Z', session: 'old00000' });
  const newer = manual({ at: '2026-09-29T12:00:00.000Z', session: 'new00000' });
  const rows = unownedConflicts([input([older, newer])], after(7 * 60), LIMITS);
  assert.deepEqual(rows[0]!.claim, newer);
  const reversed = unownedConflicts([input([newer, older])], after(7 * 60), LIMITS);
  assert.deepEqual(reversed[0]!.claim, newer);
});

test('renderUnownedConflictLine：宣言ありは短い ID・時刻・言うことを書く', () => {
  assert.equal(
    renderUnownedConflictLine({ pr: PR, issues: [147], claim: manual() }),
    '- [#315](https://x/315) feat: t（Issue #147）— 引き継ぐか決める：宣言 session 38ab2367・2026-09-30T00:00:00.000Z（期限切れ）。引き継ぐならどのセッションにでも「#315 を引き継いで sync」と言う',
  );
});

test('renderUnownedConflictLine：session の無い宣言は時刻だけを書く', () => {
  const noSession: Claim = { by: 'manual', at: AT };
  const line = renderUnownedConflictLine({ pr: PR, issues: [147], claim: noSession });
  assert.ok(line.includes('— 引き継ぐか決める：宣言 2026-09-30T00:00:00.000Z（期限切れ）。'), line);
  assert.ok(!line.includes('session'), line);
});

test('renderUnownedConflictLine：宣言なし', () => {
  assert.equal(
    renderUnownedConflictLine({ pr: PR, issues: [147], claim: null }),
    '- [#315](https://x/315) feat: t（Issue #147）— 引き継ぐか決める：宣言なし。引き継ぐならどのセッションにでも「#315 を引き継いで sync」と言う',
  );
});

test('renderUnownedConflictLine：Issue が0件・複数の書き方', () => {
  assert.ok(renderUnownedConflictLine({ pr: PR, issues: [], claim: null }).startsWith('- [#315](https://x/315) feat: t（Issue なし）— '));
  assert.ok(renderUnownedConflictLine({ pr: PR, issues: [1, 2], claim: null }).startsWith('- [#315](https://x/315) feat: t（Issue #1・#2）— '));
});
