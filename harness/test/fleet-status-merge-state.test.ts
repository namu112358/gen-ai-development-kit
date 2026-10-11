// Issue #718：fleet-status の表の末尾と --json に、bypass と委任承認の今の状態を出す。
// mergeStateLines の2行（bypass：有効・無効・読めない、委任承認：計画＋Merge・計画のみ・無効・読めない、付けた人が不明）、
// renderFleetStatus の末尾（進め方の行の後に2行）、fleetStatusData の merge と、状態を渡さなければ表と JSON が今と同じことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bypassMergeConfig, delegateConfig, loadConfig } from '../lib/config.ts';
import { delegateState } from '../lib/delegate.ts';
import { fleetStatus, fleetStatusData, mergeStateLines, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetMergeState } from '../lib/fleet.ts';
import type { IssueFacts } from '../lib/queue.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { bypassState } from '../gates/bypass.ts';

const config = loadConfig();
const BYPASS = bypassMergeConfig(config).label;
const { planLabel: PLAN, mergeLabel: MERGE } = delegateConfig(config);
const NOW = new Date('2026-10-11T12:00:00Z');
const AT = '2026-10-11T10:00:00Z';

const dashboard = (...labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
const labeled = (name: string, login = 'me'): TimelineEvent => ({ event: 'labeled', created_at: AT, actor: { login }, label: { name } });

/** bypassState・delegateState の結果から、fleet-status に渡す状態を作る（純粋関数の結果をそのまま使う） */
function stateOf(labels: string[], events: TimelineEvent[]): FleetMergeState {
  const d = dashboard(...labels);
  const b = bypassState(d, events, config);
  const g = delegateState(d, events, config, NOW);
  return {
    readable: true,
    bypass: { active: b.active, by: b.by, since: b.since, reason: b.reason },
    delegate: { mode: g.mode, active: g.active, planActive: g.planActive, by: g.by, since: g.since, reason: g.reason },
  };
}

const NONE = stateOf([], []);
const BYPASS_ON = stateOf([BYPASS], [labeled(BYPASS)]);
const PLAN_MERGE = stateOf([PLAN, MERGE], [labeled(PLAN), labeled(MERGE)]);
const PLAN_ONLY = stateOf([PLAN], [labeled(PLAN)]);
const UNREADABLE: FleetMergeState = { readable: false, error: 'HTTP 502' };

const AUTO = 'App が自動 Merge する';

test('mergeStateLines：2行で、順は bypass・委任承認。行の頭と、有効のときだけ自動 Merge の文が出る', () => {
  const cases: { name: string; s: FleetMergeState; bypass: string; delegate: string; bypassAuto: boolean; delegateAuto: boolean }[] = [
    { name: 'どちらも無効', s: NONE, bypass: 'bypass：無効', delegate: '委任承認：無効', bypassAuto: false, delegateAuto: false },
    { name: 'bypass 有効', s: BYPASS_ON, bypass: 'bypass：有効', delegate: '委任承認：無効', bypassAuto: true, delegateAuto: false },
    { name: '委任 計画＋Merge', s: PLAN_MERGE, bypass: 'bypass：無効', delegate: '委任承認：計画＋Merge', bypassAuto: false, delegateAuto: true },
    { name: '委任 計画のみ', s: PLAN_ONLY, bypass: 'bypass：無効', delegate: '委任承認：計画のみ', bypassAuto: false, delegateAuto: false },
    { name: '読めない', s: UNREADABLE, bypass: 'bypass：読めない', delegate: '委任承認：読めない', bypassAuto: false, delegateAuto: false },
  ];
  // 前提：純粋関数の結果が想定どおり
  assert.equal(BYPASS_ON.readable && BYPASS_ON.bypass.active, true);
  assert.equal(PLAN_MERGE.readable && PLAN_MERGE.delegate.mode, 'plan+merge');
  assert.equal(PLAN_ONLY.readable && PLAN_ONLY.delegate.mode, 'plan');
  for (const c of cases) {
    const lines = mergeStateLines(c.s);
    assert.equal(lines.length, 2, c.name);
    assert.ok(lines[0]!.startsWith(c.bypass), `${c.name}：${lines[0]}`);
    assert.ok(lines[1]!.startsWith(c.delegate), `${c.name}：${lines[1]}`);
    assert.equal(lines[0]!.includes(AUTO), c.bypassAuto, `${c.name}：${lines[0]}`);
    assert.equal(lines[1]!.includes(AUTO), c.delegateAuto, `${c.name}：${lines[1]}`);
  }
  assert.ok(mergeStateLines(BYPASS_ON)[0]!.includes('@me'), '付けた人を出す');
  assert.ok(mergeStateLines(PLAN_MERGE)[1]!.includes('@me'), '付けた人を出す');
  assert.ok(mergeStateLines(UNREADABLE).every((l) => l.includes('HTTP 502')), '読めない理由を出す');
});

test('mergeStateLines：付けた人が null なら「付けた人は不明」', () => {
  const s: FleetMergeState = {
    readable: true,
    bypass: { active: true, by: null, since: null, reason: 'x' },
    delegate: { mode: 'plan+merge', active: true, planActive: true, by: null, since: null, reason: 'x' },
  };
  const [b, d] = mergeStateLines(s);
  assert.ok(b!.startsWith('bypass：有効') && b!.includes('付けた人は不明'), b);
  assert.ok(d!.startsWith('委任承認：計画＋Merge') && d!.includes('付けた人は不明'), d);
  assert.ok(!b!.includes('@null') && !d!.includes('@null'));
});

// ---- 表と JSON ----

const issue = (n: number): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: '2026-10-11T00:00:00Z', claim: null, openBlockers: [],
  gate: { pass: true, planCommentId: 5, at: '2026-10-11T01:01:00Z' }, latestPlanAt: '2026-10-11T01:00:00Z', planOkByApp: true, openPr: null,
});
const fi = (n: number, files: string[]): FleetIssue => ({ facts: issue(n), closed: false, planFiles: files, prs: [] });
const facts: FleetFacts = { issues: [fi(1, ['a.ts']), fi(2, ['a.ts']), fi(3, ['b.ts'])], prConflicts: [] };
const MODE = { nesting: 'orca' as const, maxParallelShips: 3 };
const rows = fleetStatus(facts);
const sel = selectFleet(config, facts, rows, null, null);

test('renderFleetStatus：merge を渡すと、進め方の行の後（最後の2行）に bypass・委任承認の行が出る', () => {
  for (const s of [NONE, BYPASS_ON, PLAN_MERGE, PLAN_ONLY, UNREADABLE]) {
    const lines = renderFleetStatus(rows, sel, null, MODE, s).split('\n');
    assert.deepEqual(lines.slice(-2), mergeStateLines(s));
    assert.ok(lines.at(-3)!.startsWith('進め方：'), lines.at(-3));
  }
  // 進め方を渡さないときは、選んだ数の行の後
  const noMode = renderFleetStatus(rows, sel, null, undefined, PLAN_ONLY).split('\n');
  assert.deepEqual(noMode.slice(-2), mergeStateLines(PLAN_ONLY));
  assert.ok(noMode.at(-3)!.startsWith('選んだ数：'), noMode.at(-3));
});

test('renderFleetStatus：merge を渡さなければ今と同じ（merge 付きから末尾2行を除いたもの）', () => {
  for (const mode of [undefined, MODE]) {
    for (const max of [null, 1]) {
      const plain = renderFleetStatus(rows, sel, max, mode);
      assert.ok(!/^(bypass|委任承認)：/m.test(plain), '状態の行が無い');
      for (const s of [BYPASS_ON, UNREADABLE]) {
        const withMerge: string[] = renderFleetStatus(rows, sel, max, mode, s).split('\n');
        assert.equal(plain, withMerge.slice(0, -2).join('\n'), JSON.stringify({ mode, max }));
      }
    }
  }
});

test('fleetStatusData：merge を渡すとそのまま入り（読めた・読めない）、version は 1。渡さなければ merge の鍵が無い', () => {
  for (const s of [BYPASS_ON, PLAN_MERGE, PLAN_ONLY, NONE, UNREADABLE]) {
    const data = fleetStatusData(facts, rows, sel, null, null, MODE, s);
    assert.equal(data.version, 1);
    assert.deepEqual(data.merge, s);
    assert.deepEqual(JSON.parse(JSON.stringify(data)).merge, s, 'JSON にしても同じ');
  }
  for (const mode of [undefined, MODE]) {
    const plain = fleetStatusData(facts, rows, sel, null, null, mode);
    assert.equal('merge' in plain, false);
    assert.equal(plain.version, 1);
    const { merge: _m, ...rest } = fleetStatusData(facts, rows, sel, null, null, mode, BYPASS_ON);
    assert.deepEqual(rest, plain, 'merge の鍵のほかは今と同じ');
  }
});
