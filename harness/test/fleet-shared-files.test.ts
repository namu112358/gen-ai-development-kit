// fleet の重なりの判定で、行を足すだけの共有ファイル（fleet.sharedFiles）だけが重なる組を待たせないことを確かめる（Issue #159）。
// 共有ファイル以外も重なる組・ワイルドカードで共有ファイルを含む組・sharedFiles の無い設定は今までどおり待ち、
// 表の「重なり」列に「共有ファイルのみ（並行可）」が出ることも確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue } from '../lib/fleet.ts';
import type { IssueFacts } from '../lib/queue.ts';

// 実物の harness.config.json の既定値に依存しないよう、sharedFiles を明示する
const base = loadConfig();
const config = { ...base, fleet: { ...base.fleet, sharedFiles: ['docs/plan.md', '**/README.md'] } };
// sharedFiles の無い設定（今までどおりの判定）
const noShared = { ...base, fleet: { nesting: base.fleet?.nesting, maxParallelShips: base.fleet?.maxParallelShips } };

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const fi = (facts: IssueFacts, planFiles: string[] | null = null): FleetIssue => ({ facts, closed: false, planFiles, prs: [] });
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const select = (f: FleetFacts, c: typeof config | typeof noShared = config) => selectFleet(c, f, fleetStatus(f), null);
const rowOf = (table: string, n: number) => table.split('\n').find((l) => l.startsWith(`| #${n} t${n} |`))!;

test('共有ファイルだけが重なる組は待たず、sharedOnlyOverlaps に入れて overlaps には入れない', () => {
  const f = facts([
    fi(planOk(1), ['docs/plan.md']),
    fi(planOk(2), ['docs/plan.md', 'harness/README.md']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.equal(s.excluded.size, 0);
  assert.deepEqual(s.sharedOnlyOverlaps.get(1), [2]);
  assert.deepEqual(s.sharedOnlyOverlaps.get(2), [1]);
  assert.equal(s.overlaps.get(1), undefined, '共有ファイルだけの重なりは overlaps に入れない');
  assert.equal(s.overlaps.get(2), undefined);
});

test('共有ファイルのパターン（**/README.md）に一致するファイルだけの重なりも待たない', () => {
  const f = facts([
    fi(planOk(1), ['harness/README.md', 'harness/lib/a.ts']),
    fi(planOk(2), ['harness/README.md', 'harness/lib/b.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.deepEqual(s.sharedOnlyOverlaps.get(1), [2]);
});

test('共有ファイル以外も重なる組は今までどおり後の側が待ち、理由の文言も同じ', () => {
  const f = facts([
    fi(planOk(1), ['docs/plan.md', 'harness/lib/fleet.ts']),
    fi(planOk(2), ['docs/plan.md', 'harness/lib/fleet.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ');
  assert.deepEqual(s.overlaps.get(1), [2]);
  assert.deepEqual(s.overlaps.get(2), [1]);
  assert.equal(s.sharedOnlyOverlaps.get(1), undefined, '共有ファイル以外も重なれば shared-only に入れない');
  assert.equal(s.sharedOnlyOverlaps.get(2), undefined);
});

test('ワイルドカードで共有ファイルを含む側（docs/**）は共有ファイルとみなさず、待つ', () => {
  const f = facts([
    fi(planOk(1), ['docs/**']),
    fi(planOk(2), ['docs/plan.md']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1]);
  assert.match(s.excluded.get(2)!, /#1 と触るファイルが重なるため待つ/);
  assert.equal(s.sharedOnlyOverlaps.get(1), undefined);
  assert.equal(s.sharedOnlyOverlaps.get(2), undefined);
});

test('回帰：fleet.sharedFiles の無い設定では、docs/plan.md だけの重なりでも今までどおり待つ', () => {
  const f = facts([
    fi(planOk(1), ['docs/plan.md']),
    fi(planOk(2), ['docs/plan.md']),
  ]);
  const s = select(f, noShared);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), '#1 と触るファイルが重なるため待つ');
  assert.deepEqual(s.overlaps.get(1), [2]);
  assert.equal(s.sharedOnlyOverlaps.get(1), undefined);
});

test('表：共有ファイルだけの重なりは「重なり」列に「共有ファイルのみ（並行可）：#n」と出る', () => {
  const f = facts([
    fi(planOk(1), ['docs/plan.md']),
    fi(planOk(2), ['docs/plan.md']),
  ]);
  const t = renderFleetStatus(fleetStatus(f), select(f), null);
  const r1 = rowOf(t, 1);
  const r2 = rowOf(t, 2);
  assert.match(r1, /\| 選ぶ \| 共有ファイルのみ（並行可）：#2 \|/, 'overlaps が無ければその文だけ');
  assert.match(r2, /\| 選ぶ \| 共有ファイルのみ（並行可）：#1 \|/);
});

test('表：待つ重なりと共有ファイルだけの重なりが両方あれば、両方を「重なり」列に出す', () => {
  // 1 と 2 は共有ファイルだけ、1 と 3 は共有ファイル以外（fleet.ts）も重なる
  const f = facts([
    fi(planOk(1), ['docs/plan.md', 'harness/lib/fleet.ts']),
    fi(planOk(2), ['docs/plan.md']),
    fi(planOk(3), ['harness/lib/fleet.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.match(s.excluded.get(3)!, /#1 と触るファイルが重なるため待つ/);
  const r1 = rowOf(renderFleetStatus(fleetStatus(f), s, null), 1);
  assert.match(r1, /#3/);
  assert.match(r1, /共有ファイルのみ（並行可）：#2/);
});
