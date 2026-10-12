// Issue #804：auto mode でも回らない人の判断待ちから、hq.humanWaitMinutes を超えたものを選んで並べる純粋な関数（humanWaitDigest）の端と並び
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanWaitDigest, type HumanWaitItem } from '../lib/auto-mode.ts';

test('humanWaitDigest：limitMinutes を超えたものだけを選び（ちょうどは選ばない・since が null や読めない時刻は選ばない）、待った時間の長い順、同じなら番号の順に並べる', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  const limit = 120;
  const ago = (m: number): string => new Date(now.getTime() - m * 60_000).toISOString();
  const item = (number: number, since: string | null, kind: HumanWaitItem['kind'] = 'plan'): HumanWaitItem =>
    ({ kind, number, title: `t${number}`, url: `u${number}`, since, reason: `r${number}` });
  const items = [
    item(1, null),
    item(2, 'not-a-date'),
    item(3, ago(limit)), // ちょうど
    item(4, new Date(now.getTime() - limit * 60_000 - 59_000).toISOString()), // 分は切り捨てで数えるので、59 秒多くてもちょうど
    item(5, ago(limit + 1)),
    item(9, ago(limit + 300), 'pr'),
    item(7, ago(limit + 300)),
    item(8, ago(10)),
  ];
  const rows = humanWaitDigest(items, now, limit);
  assert.deepEqual(rows.map((r) => [r.number, r.minutes]), [[7, limit + 300], [9, limit + 300], [5, limit + 1]]);
  // 行の中身（種類・理由・URL）はそのまま引き継ぐ
  assert.deepEqual({ ...rows[1], minutes: undefined }, { ...item(9, ago(limit + 300), 'pr'), minutes: undefined });
});
