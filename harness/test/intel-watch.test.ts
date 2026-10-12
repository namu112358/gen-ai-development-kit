// Issue #854：intel の見張りの時刻の決め方（まとめの時刻の読み・次と直近の時刻・出しそびれ）と、新しく出た人待ちの見分け方
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SLOTS, formatSlot, missedSlot, newUrgent, nextSlot, parseSlots, prevSlot, readWatchState, urgentItems,
  type UrgentItem, type WatchState,
} from '../scripts/intel-watch.ts';
import type { Todo } from '../scripts/dashboard/graph.ts';

/** 手元の時刻で作る（TZ に依らない） */
const local = (d: number, h: number, m = 0): Date => new Date(2026, 9, d, h, m);
const iso = (d: number, h: number, m = 0): string => local(d, h, m).toISOString();
const SLOTS = parseSlots(DEFAULT_SLOTS);
const hm = (x: Date): [number, number, number] => [x.getDate(), x.getHours(), x.getMinutes()];

const todo = (id: string, title = `t${id}`, reason = `reason ${id}`): Todo => {
  const number = Number(id.slice(id.lastIndexOf('-') + 1));
  const kind = id.includes('-pr-') ? 'pr' : 'issue';
  const url = `https://github.com/o/r/${kind === 'pr' ? 'pull' : 'issues'}/${number}`;
  return { id, kind, number, url, title, reason };
};
const item = (id: string): UrgentItem => {
  const t = todo(id);
  return { id: t.id, kind: t.kind, number: t.number, url: t.url, title: t.title, reason: t.reason };
};
const state = (notified: string[]): WatchState => ({ version: 1, notified, digestWokeAt: null });

test('parseSlots：空白を除いて時刻の順に並べ、重複を1つにし、HH:MM でないもの・空は例外', () => {
  assert.deepEqual(parseSlots(' 17:30, 08:30 ,17:30'), [{ h: 8, m: 30 }, { h: 17, m: 30 }]);
  assert.equal(SLOTS.map(formatSlot).join(','), '08:30,17:30');
  for (const bad of ['25:00', '8:3x', '']) {
    assert.throws(() => parseSlots(bad), Error, JSON.stringify(bad));
  }
});

test('nextSlot・prevSlot：次は今より後（同じ時刻は含めない）で、過ぎていれば翌日。直近は今以前（同じ時刻を含む）で、最初より前なら昨日', () => {
  for (const [now, want] of [
    [local(12, 8, 29), [12, 8, 30]],
    [local(12, 8, 30), [12, 17, 30]],
    [local(12, 18, 0), [13, 8, 30]],
  ] as const) {
    const r = nextSlot(now, SLOTS);
    assert.deepEqual(hm(r.at), want, `next ${now.toString()}`);
    assert.deepEqual(r.slot, { h: want[1], m: want[2] });
  }
  for (const [now, want] of [
    [local(12, 8, 30), [12, 8, 30]],
    [local(12, 7, 0), [11, 17, 30]],
  ] as const) {
    const r = prevSlot(now, SLOTS);
    assert.deepEqual(hm(r.at), want, `prev ${now.toString()}`);
    assert.deepEqual(r.slot, { h: want[1], m: want[2] });
  }
});

test('missedSlot：前回のまとめ・起こした時刻の新しいほうが直近の時刻より前か、どちらも無い・読めないなら直近の時刻、そうでなければ null', () => {
  const at830 = { h: 8, m: 30 };
  for (const [name, now, lastDigestAt, digestWokeAt, want] of [
    ['昨日 17:40 のまとめで今 09:00', local(12, 9), iso(11, 17, 40), null, at830],
    ['今日 08:31 のまとめで今 12:00', local(12, 12), iso(12, 8, 31), null, null],
    ['今 07:00（直近は昨日 17:30）で昨日 17:40 のまとめ', local(12, 7), iso(11, 17, 40), null, null],
    ['両方無い', local(12, 9), null, null, at830],
    ['読めない', local(12, 9), 'not-a-date', null, at830],
    ['起こした時刻が直近の時刻より後', local(12, 9), iso(11, 17, 40), iso(12, 8, 31), null],
  ] as const) {
    assert.deepEqual(missedSlot(now, SLOTS, lastDigestAt, digestWokeAt), want, name);
  }
});

test('urgentItems：merge-pr-・review-issue- だけを todos の順に拾い、stop-issue-・priority- を落とし、題と理由を1行にする', () => {
  const todos = [
    todo('stop-issue-7'),
    todo('review-issue-6', '  計画の\n  題  ', '\n理由\nの続き '),
    todo('priority-issue-5'),
    todo('merge-pr-9'),
  ];
  assert.deepEqual(urgentItems(todos), [
    { ...item('review-issue-6'), title: '計画の 題', reason: '理由 の続き' },
    item('merge-pr-9'),
  ]);
});

test('newUrgent：控えが無ければ知らせずに全部を控え、控えにあるものは知らせず、新しいものだけ知らせ、消えたものは控えから外す', () => {
  const current = [item('merge-pr-9'), item('review-issue-6')];
  assert.deepEqual(newUrgent(null, current), { notify: [], notified: ['merge-pr-9', 'review-issue-6'] });
  assert.deepEqual(newUrgent(state(['merge-pr-9', 'review-issue-6']), current), { notify: [], notified: ['merge-pr-9', 'review-issue-6'] });
  assert.deepEqual(
    newUrgent(state(['merge-pr-9', 'review-issue-3']), current),
    { notify: [item('review-issue-6')], notified: ['merge-pr-9', 'review-issue-6'] },
  );
});

test('readWatchState：無い・JSON でない・版の違い・notified や digestWokeAt の形の誤りは null、正しいものは読める', () => {
  const ok: WatchState = { version: 1, notified: ['merge-pr-9'], digestWokeAt: iso(12, 8, 30) };
  assert.deepEqual(readWatchState(JSON.stringify(ok)), ok);
  assert.deepEqual(readWatchState(JSON.stringify(state([]))), state([]));
  for (const [name, text] of [
    ['無い', null],
    ['壊れた JSON', '{'],
    ['版の違い', JSON.stringify({ ...ok, version: 2 })],
    ['notified が文字列の配列でない', JSON.stringify({ ...ok, notified: ['a', 1] })],
    ['digestWokeAt が読めない', JSON.stringify({ ...ok, digestWokeAt: 'not-a-date' })],
  ] as const) {
    assert.equal(readWatchState(text), null, name);
  }
});
