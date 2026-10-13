// Issue #979：アカウントを選ぶとき（harness/scripts/accounts/pick.ts の pickAccount）の順番を確かめる。
// 点数は実効の 5h ＋ 直近 15 分（LAUNCH_WINDOW_MS）に起こした数 × 10 で、7d は点数に入れない。
// 同点なら実効の 7d が低い方（リセット済みは 0、null は 7d のあるアカウントより後ろ）、それも同じなら対応表の順。
// 起こした数は値の時刻にかかわらず数え（未来の分も数える）、ちょうど 15 分前は数えない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_THRESHOLD_7D, LAUNCH_WINDOW_MS, pickAccount, type AccountEntry, type Launch, type UsageValue } from '../scripts/accounts/pick.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const DAY = 24 * 60 * MIN;

/** 使用量の値。リセット時刻の既定は 5h が 60 分後、7d が 3 日後（どちらもまだ来ていない） */
const usage = (five: number, seven: number | null, o: { r5?: number | null; r7?: number | null; at?: number } = {}): UsageValue => ({
  fiveHour: five,
  fiveHourResetsAt: o.r5 === undefined ? NOW + 60 * MIN : o.r5,
  sevenDay: seven,
  sevenDayResetsAt: o.r7 === undefined ? NOW + 3 * DAY : o.r7,
  status: 'allowed',
  at: o.at ?? NOW - 1 * MIN,
  source: 'probe',
});

const entry = (name: string): AccountEntry => ({ orcaId: `orca-${name}`, name, configDir: `/home/u/.config/agent-harness/claude/${name}` });

/** 対応表の順に [名前, 値] を並べて pickAccount を呼ぶ（しきい値は 5h 80・7d 90） */
function pick(list: [string, UsageValue][], launches: Launch[] = []) {
  return pickAccount({
    accounts: list.map(([n]) => entry(n)),
    threshold5h: 80,
    threshold7d: DEFAULT_THRESHOLD_7D,
    usage: new Map(list.map(([n, u]) => [`orca-${n}`, u])),
    launches,
    excluded: [],
    now: NOW,
  });
}

test('順番は実効の 5h（7d は点数に入れない）、同じなら実効の 7d が低い方（null は後ろ）、それも同じなら対応表の順', () => {
  const cases: { label: string; list: [string, UsageValue][]; expect: string }[] = [
    { label: '5h 0・7d 46 は 5h 9・7d null より先', list: [['a', usage(0, 46)], ['b', usage(9, null)]], expect: 'a' },
    { label: '並びを逆にしても同じ', list: [['b', usage(9, null)], ['a', usage(0, 46)]], expect: 'a' },
    { label: '7d が高くても（しきい値未満）5h が低いほう', list: [['a', usage(50, 10)], ['b', usage(20, 70)]], expect: 'b' },
    { label: '5h が同じなら 7d が低いほう', list: [['a', usage(40, 40)], ['b', usage(40, 20)]], expect: 'b' },
    { label: '5h が同じなら 7d の null は 7d のあるほうより後ろ', list: [['a', usage(40, null)], ['b', usage(40, 80)]], expect: 'b' },
    { label: '並びを逆にしても 7d の null は後ろ', list: [['b', usage(40, 80)], ['a', usage(40, null)]], expect: 'b' },
    { label: '5h が同じならリセット済みの 7d は 0', list: [['a', usage(40, 10)], ['b', usage(40, 30, { r7: NOW - MIN })]], expect: 'b' },
    { label: 'リセット済みの 5h は 0（7d は点数に入れない）', list: [['a', usage(10, 5)], ['b', usage(70, 60, { r5: NOW - MIN })]], expect: 'b' },
    { label: '7d が null 同士で 5h も同じなら対応表の順', list: [['a', usage(40, null)], ['b', usage(40, null)]], expect: 'a' },
    { label: '全部同じなら対応表の順', list: [['a', usage(40, 20)], ['b', usage(40, 20)]], expect: 'a' },
  ];
  for (const c of cases) {
    const r = pick(c.list);
    assert.equal(r.result, 'picked', c.label);
    assert.equal(r.result === 'picked' ? r.name : null, c.expect, c.label);
  }
});

test('起こした数の +10：直近 15 分（ちょうど 15 分前は除く）に起こした同じ名前の分を、値の時刻にかかわらず数える（未来の分も数える）', () => {
  assert.equal(LAUNCH_WINDOW_MS, 15 * MIN);
  // a は 5h 30、b は 5h 25。b に +10 が付けば a、付かなければ b
  const list = (bAt = NOW - 1 * MIN): [string, UsageValue][] => [['a', usage(30, 10)], ['b', usage(25, 10, { at: bAt })]];
  const cases: { label: string; list: [string, UsageValue][]; launches: Launch[]; expect: string }[] = [
    { label: '値を取り直した後（値の時刻が起こした時刻より後）でも数える', list: list(NOW - 1 * MIN), launches: [{ name: 'b', at: NOW - 5 * MIN }], expect: 'a' },
    { label: '値の後に起こした分も数える', list: list(NOW - 10 * MIN), launches: [{ name: 'b', at: NOW - 5 * MIN }], expect: 'a' },
    { label: '15 分より 1 ミリ秒新しい分は数える', list: list(), launches: [{ name: 'b', at: NOW - LAUNCH_WINDOW_MS + 1 }], expect: 'a' },
    { label: 'ちょうど 15 分前は数えない', list: list(), launches: [{ name: 'b', at: NOW - LAUNCH_WINDOW_MS }], expect: 'b' },
    { label: '15 分より前は数えない', list: list(), launches: [{ name: 'b', at: NOW - 20 * MIN }], expect: 'b' },
    { label: '未来の分も数える', list: list(), launches: [{ name: 'b', at: NOW + 1 * MIN }], expect: 'a' },
    { label: 'ほかの名前の分は数えない', list: list(), launches: [{ name: 'c', at: NOW - 1 * MIN }], expect: 'b' },
    {
      label: '2件なら +20（a 30 < b 15 + 20）',
      list: [['a', usage(30, 10)], ['b', usage(15, 10)]],
      launches: [{ name: 'b', at: NOW - 2 * MIN }, { name: 'b', at: NOW - 1 * MIN }],
      expect: 'a',
    },
    { label: '1件なら +10（b 15 + 10 < a 30）', list: [['a', usage(30, 10)], ['b', usage(15, 10)]], launches: [{ name: 'b', at: NOW - 1 * MIN }], expect: 'b' },
  ];
  for (const c of cases) {
    const r = pick(c.list, c.launches);
    assert.equal(r.result, 'picked', c.label);
    assert.equal(r.result === 'picked' ? r.name : null, c.expect, c.label);
  }
});
