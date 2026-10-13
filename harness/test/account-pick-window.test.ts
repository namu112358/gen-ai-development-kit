// Issue #872：アカウントを選ぶとき（harness/scripts/accounts/pick.ts）の 5h・7d の枠の扱いを確かめる。
// 7d がしきい値以上なら外す（null は 7d で外さない）・リセット時刻を過ぎた値は 0%・順番は 5h と 7d の高い方・
// 全部外れたときの wait のリセット時刻・対応表の threshold7d・Orca の weekly.resetsAt の読み取り。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_THRESHOLD_7D,
  effectiveUsage,
  parseAccountsTable,
  parseOrcaAccounts,
  pickAccount,
  type AccountEntry,
  type Launch,
  type UsageValue,
} from '../scripts/accounts/pick.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const DAY = 24 * 60 * MIN;

/** 使用量の値。リセット時刻の既定は 5h が 60 分後、7d が 3 日後（どちらもまだ来ていない） */
const usage = (five: number, seven: number | null, o: { r5?: number | null; r7?: number | null; status?: string; at?: number } = {}): UsageValue => ({
  fiveHour: five,
  fiveHourResetsAt: o.r5 === undefined ? NOW + 60 * MIN : o.r5,
  sevenDay: seven,
  sevenDayResetsAt: o.r7 === undefined ? NOW + 3 * DAY : o.r7,
  status: o.status ?? 'allowed',
  at: o.at ?? NOW - 1 * MIN,
  source: 'orca',
});

const entry = (name: string): AccountEntry => ({ orcaId: `orca-${name}`, name, configDir: `/home/u/.config/agent-harness/claude/${name}` });

/** 対応表の順に [名前, 値] を並べて pickAccount を呼ぶ（しきい値の既定は 5h 80・7d 90） */
function pick(list: [string, UsageValue][], o: { threshold5h?: number; threshold7d?: number; launches?: Launch[] } = {}) {
  return pickAccount({
    accounts: list.map(([n]) => entry(n)),
    threshold5h: o.threshold5h ?? 80,
    threshold7d: o.threshold7d ?? DEFAULT_THRESHOLD_7D,
    usage: new Map(list.map(([n, u]) => [`orca-${n}`, u])),
    launches: o.launches ?? [],
    excluded: [],
    now: NOW,
  });
}

test('7d がしきい値以上（ちょうどを含む）なら 5h が一番低くても選ばれず、7d が null なら 7d では外れない', () => {
  const cases: { label: string; list: [string, UsageValue][]; threshold7d?: number; expect: string }[] = [
    { label: '7d ちょうど 90 は外れる', list: [['a', usage(10, 90)], ['b', usage(50, 10)]], expect: 'b' },
    { label: '7d 95 は外れる', list: [['a', usage(5, 95)], ['b', usage(60, 10)]], expect: 'b' },
    { label: '7d 89 は外れない（ほかは 5h で外れる）', list: [['a', usage(10, 89)], ['b', usage(85, 10)]], expect: 'a' },
    { label: 'threshold7d を使う（並びなら a だが 7d 60 ≥ 50 で外れる）', list: [['a', usage(10, 60)], ['b', usage(70, 10)]], threshold7d: 50, expect: 'b' },
    { label: '7d が null は外れない', list: [['a', usage(10, null)], ['b', usage(20, 5)]], expect: 'a' },
    { label: '7d が null はしきい値 0 でも外れない', list: [['a', usage(10, null)], ['b', usage(5, 0)]], threshold7d: 0, expect: 'a' },
    { label: '7d が null 同士は 5h で決まる', list: [['a', usage(30, null)], ['b', usage(20, null)]], expect: 'b' },
  ];
  for (const c of cases) {
    const r = pick(c.list, { threshold7d: c.threshold7d });
    assert.equal(r.result, 'picked', c.label);
    assert.equal(r.result === 'picked' ? r.name : null, c.expect, c.label);
  }
});

test('effectiveUsage：リセット時刻を過ぎた（ちょうどを含む）5h・7d は 0、リセット時刻が null・まだ来ていない値はそのまま', () => {
  const cases: { label: string; u: UsageValue; expect: { fiveHour: number; sevenDay: number | null } }[] = [
    { label: '5h のリセットを過ぎた', u: usage(41, 30, { r5: NOW - 1 }), expect: { fiveHour: 0, sevenDay: 30 } },
    { label: '7d のリセットを過ぎた', u: usage(20, 95, { r7: NOW - 1 }), expect: { fiveHour: 20, sevenDay: 0 } },
    { label: 'リセット時刻ちょうどはリセット済み', u: usage(41, 95, { r5: NOW, r7: NOW }), expect: { fiveHour: 0, sevenDay: 0 } },
    { label: 'リセット時刻が null はそのまま', u: usage(41, 95, { r5: null, r7: null }), expect: { fiveHour: 41, sevenDay: 95 } },
    { label: 'まだ来ていないリセットはそのまま', u: usage(41, 95, { r5: NOW + 1, r7: NOW + 1 }), expect: { fiveHour: 41, sevenDay: 95 } },
    { label: '7d が null はリセットを過ぎても null', u: usage(41, null, { r7: NOW - 1 }), expect: { fiveHour: 41, sevenDay: null } },
  ];
  for (const c of cases) assert.deepEqual(effectiveUsage(c.u, NOW), c.expect, c.label);
});

test('pickAccount：リセット時刻を過ぎた値は 0% として外さず順番も 0% で決め、picked の usage は元の値', () => {
  const cases: { label: string; list: [string, UsageValue][]; expect: string; fiveHour: number }[] = [
    { label: '5h 85 でもリセット済みなら外れず 0%', list: [['a', usage(85, 10, { r5: NOW - MIN })], ['b', usage(20, 10)]], expect: 'a', fiveHour: 85 },
    { label: '7d 95 でもリセット済みなら外れず 0%', list: [['a', usage(10, 95, { r7: NOW - MIN })], ['b', usage(20, 10)]], expect: 'a', fiveHour: 10 },
    { label: '5h 41 → 0% は 5h 5 より低い', list: [['b', usage(5, null)], ['a', usage(41, null, { r5: NOW - MIN })]], expect: 'a', fiveHour: 41 },
    { label: '5h のリセット時刻が null なら 85 のまま外れる', list: [['a', usage(85, 10, { r5: null })], ['b', usage(50, 10)]], expect: 'b', fiveHour: 50 },
    { label: '7d のリセット時刻が null なら 95 のまま外れる', list: [['a', usage(10, 95, { r7: null })], ['b', usage(50, 10)]], expect: 'b', fiveHour: 50 },
  ];
  for (const c of cases) {
    const r = pick(c.list);
    assert.equal(r.result, 'picked', c.label);
    if (r.result !== 'picked') continue;
    assert.equal(r.name, c.expect, c.label);
    // 実効の値に置き換えない
    assert.equal(r.usage.fiveHour, c.fiveHour, c.label);
    assert.deepEqual(r.usage, c.list.find(([n]) => n === c.expect)![1], c.label);
  }
});

test('順番は 5h と 7d の高い方（＋起こした数の +10）、同じなら実効の 7d、それも同じなら対応表の順', () => {
  const cases: { label: string; list: [string, UsageValue][]; launches?: Launch[]; expect: string }[] = [
    { label: '5h 20・7d 70 より 5h 50・7d 40', list: [['a', usage(20, 70)], ['b', usage(50, 40)]], expect: 'b' },
    { label: '並びを逆にしても同じ', list: [['b', usage(50, 40)], ['a', usage(20, 70)]], expect: 'b' },
    { label: '起こした数の +10 は高い方に足す', list: [['a', usage(20, 60)], ['b', usage(65, 10)]], launches: [{ name: 'a', at: NOW }], expect: 'b' },
    { label: '高い方が同じなら 7d が低いほう', list: [['a', usage(40, 40)], ['b', usage(40, 20)]], expect: 'b' },
    { label: '同じ比べで 7d の null は 0', list: [['a', usage(40, 10)], ['b', usage(40, null)]], expect: 'b' },
    { label: '同じ比べでリセット済みの 7d は 0', list: [['a', usage(40, 10)], ['b', usage(40, 30, { r7: NOW - MIN })]], expect: 'b' },
    { label: '全部同じなら対応表の順', list: [['a', usage(40, 20)], ['b', usage(40, 20)]], expect: 'a' },
  ];
  for (const c of cases) {
    const r = pick(c.list, { launches: c.launches });
    assert.equal(r.result, 'picked', c.label);
    assert.equal(r.result === 'picked' ? r.name : null, c.expect, c.label);
  }
});

test('全部外れたときの wait の resetAt は、外れた理由の枠のリセット時刻（両方なら遅い方、null は数えない）の一番早いもの', () => {
  const iso = (t: number): string => new Date(t).toISOString();
  const cases: { label: string; list: [string, UsageValue][]; expect: string | null }[] = [
    {
      label: '7d で外れたら 7d のリセット',
      list: [['a', usage(10, 95, { r5: NOW + 10 * MIN, r7: NOW + 2 * DAY })], ['b', usage(10, 92, { r5: NOW + 20 * MIN, r7: NOW + 1 * DAY })]],
      expect: iso(NOW + 1 * DAY),
    },
    {
      label: '5h で外れたものと 7d で外れたもの',
      list: [['a', usage(85, 10, { r5: NOW + 60 * MIN })], ['b', usage(10, 95, { r5: NOW + 5 * MIN, r7: NOW + 1 * DAY })]],
      expect: iso(NOW + 60 * MIN),
    },
    {
      label: '両方で外れたら遅い方',
      list: [['a', usage(85, 95, { r5: NOW + 30 * MIN, r7: NOW + 2 * DAY })], ['b', usage(85, 10, { r5: NOW + 90 * MIN })]],
      expect: iso(NOW + 90 * MIN),
    },
    {
      label: 'rejected だけなら 5h のリセット',
      list: [['a', usage(10, 10, { status: 'rejected', r5: NOW + 20 * MIN, r7: NOW + 1 * DAY })], ['b', usage(10, 95, { r7: NOW + 1 * DAY })]],
      expect: iso(NOW + 20 * MIN),
    },
    {
      label: '理由の枠のリセットが null のアカウントは数えない',
      list: [['a', usage(10, 95, { r5: NOW + 5 * MIN, r7: null })], ['b', usage(85, 10, { r5: NOW + 60 * MIN })]],
      expect: iso(NOW + 60 * MIN),
    },
    {
      label: '数えるリセットが無ければ null',
      list: [['a', usage(10, 95, { r5: NOW + 5 * MIN, r7: null })], ['b', usage(85, 10, { r5: null })]],
      expect: null,
    },
  ];
  for (const c of cases) {
    const r = pick(c.list);
    assert.equal(r.result, 'wait', c.label);
    assert.equal(r.result === 'wait' ? r.resetAt : undefined, c.expect, c.label);
  }
});

test('parseAccountsTable：threshold7d を読み、無い・数でないときは既定の 90', () => {
  assert.equal(DEFAULT_THRESHOLD_7D, 90);
  const accounts = [{ orcaId: 'orca-a', name: 'a', configDir: '/x/a' }];
  const cases: { label: string; json: Record<string, unknown>; expect: number }[] = [
    { label: '数', json: { threshold7d: 70, accounts }, expect: 70 },
    { label: '無い', json: { accounts }, expect: 90 },
    { label: '文字列', json: { threshold7d: '70', accounts }, expect: 90 },
    { label: 'null', json: { threshold7d: null, accounts }, expect: 90 },
  ];
  for (const c of cases) assert.equal(parseAccountsTable(c.json).threshold7d, c.expect, c.label);
});

test('parseOrcaAccounts：Orca の weekly.resetsAt を sevenDayResetsAt に読む（無ければ null）', () => {
  const R5 = NOW + 60 * MIN;
  const R7 = NOW + 2 * DAY;
  const json = {
    result: {
      claude: { activeAccountId: 'x', accounts: [{ id: 'x', organizationUuid: 'org-x' }, { id: 'y', organizationUuid: 'org-y' }] },
      rateLimits: {
        claude: { status: 'allowed', session: { usedPercent: 10, resetsAt: R5 }, weekly: { usedPercent: 20, resetsAt: R7 }, updatedAt: NOW },
        inactiveClaudeAccounts: [{ accountId: 'y', rateLimits: { status: 'allowed', session: { usedPercent: 30, resetsAt: R5 }, weekly: { usedPercent: 40 }, updatedAt: NOW } }],
      },
    },
  };
  const out = parseOrcaAccounts(json);
  assert.equal(out.get('x')?.usage?.sevenDayResetsAt, R7);
  assert.equal(out.get('x')?.usage?.sevenDay, 20);
  assert.equal(out.get('y')?.usage?.sevenDayResetsAt, null);
});
