// Issue #1027：panes の todoItems と dashboard の buildTodos が、人がすることの項目（人の Merge・計画ゲートで停止）を
// 同じ決め方（humanTodoKind）で選ぶことを確かめる。同じ fleet-status の行から、両方の human-merge と plan-review の集合が同じになる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetPr, type FleetRow, type FleetStage, type FleetStatusRow } from '../lib/fleet.ts';
import { humanTodoKind, todoItems, type PaneSnapshot } from '../lib/panes.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';
import { buildTodos, type DashIssue, type DashPr } from '../scripts/dashboard/graph.ts';

// ---- 入力の組み立て（panes.test.ts・dashboard-todos.test.ts の補助に倣う） ----

const statusRow = (issue: number, stage: FleetStage, pr: number | null): FleetStatusRow => ({
  issue, title: `t${issue}`, pr, stage, stageLabel: FLEET_STAGES[stage], next: 'none', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const snap = (rows: FleetStatusRow[]): PaneSnapshot => ({
  version: 1, at: '2026-10-13T00:00:00.000Z', session: 'sess-1', label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: { version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null },
  prs: [], usage: null, history: [], since: {}, error: null,
});
const toFleetRow = (r: FleetStatusRow): FleetRow => ({ issue: r.issue, title: r.title, stage: r.stage, next: r.next, pr: r.pr, note: r.note });

const issueFacts = (n: number): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: '2026-10-01T00:00:00Z', claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null,
});
const prFacts = (n: number, issue: number): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-10-01T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const fleetPr = (n: number, issue: number): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue),
});
const dIssue = (n: number, prs: FleetPr[]): DashIssue => ({
  fleet: { facts: issueFacts(n), closed: false, planFiles: null, prs }, body: null, url: `https://github.com/o/r/issues/${n}`, plan: null,
});
const dPr = (fp: FleetPr, issue: number): DashPr => ({
  number: fp.number, title: `pr${fp.number}`, url: `https://github.com/o/r/pull/${fp.number}`, headRef: `claude/issue-${issue}-pr${fp.number}`, baseRef: 'main', issue, fleet: fp,
});
const sorted = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

// ---- humanTodoKind ----

test('humanTodoKind：human-merge は PR があるときだけ merge、plan-review は review、ほかの段階は null', () => {
  const cases: [FleetStage, number | null, 'merge' | 'review' | null][] = [
    ['human-merge', 10, 'merge'],
    ['human-merge', null, null],
    ['plan-review', null, 'review'],
    ['plan-review', 30, 'review'],
    ['no-plan', null, null],
    ['plan-gate', null, null],
    ['plan-ok', null, null],
    ['judge', 40, null],
    ['fix', 40, null],
    ['auto-merge', 40, null],
    ['merged', 40, null],
    ['stopped', null, null],
  ];
  for (const [stage, pr, kind] of cases) assert.equal(humanTodoKind({ stage, pr }), kind, `${stage} pr=${pr}`);
});

// ---- AC：同じ行から、todoItems と buildTodos の集合が同じになる ----

test('同じ fleet-status の行から、todoItems と buildTodos の human-merge（Issue・PR）と plan-review（Issue）の集合が同じになる', () => {
  // [Issue, 段階, PR]
  const spec: [number, FleetStage, number | null][] = [
    [1, 'human-merge', 10],
    [2, 'human-merge', null],
    [3, 'plan-review', null],
    [4, 'plan-ok', null],
    [5, 'auto-merge', 50],
    [6, 'stopped', null],
    [7, 'human-merge', 70],
  ];
  const rows = spec.map(([issue, stage, pr]) => statusRow(issue, stage, pr));

  // panes 側
  const items = todoItems(snap(rows));
  const paneMerge = items.filter((i) => i.rank === 0);
  const paneReview = items.filter((i) => i.rank === 1 && i.pr === null);

  // dashboard 側（行の PR は prs に揃えて渡す）
  const issues = spec.map(([issue, , pr]) => dIssue(issue, pr === null ? [] : [fleetPr(pr, issue)]));
  const prs = spec.flatMap(([issue, , pr]) => (pr === null ? [] : [dPr(fleetPr(pr, issue), issue)]));
  const todos = buildTodos(issues, prs, rows.map(toFleetRow));
  const dashMerge = todos.filter((t) => t.id.startsWith('merge-'));
  const dashReview = todos.filter((t) => t.id.startsWith('review-'));
  const issueOfPr = (n: number): number => prs.find((p) => p.number === n)!.issue!;

  // 両方で同じ
  assert.deepEqual(sorted(paneMerge.map((i) => i.pr!)), sorted(dashMerge.map((t) => t.number)));
  assert.deepEqual(sorted(paneMerge.map((i) => i.issue)), sorted(dashMerge.map((t) => issueOfPr(t.number))));
  assert.deepEqual(sorted(paneReview.map((i) => i.issue)), sorted(dashReview.map((t) => t.number)));

  // 期待する集合（PR の無い human-merge の #2 はどちらにも Merge の項目を出さない）
  assert.deepEqual(sorted(paneMerge.map((i) => i.issue)), [1, 7]);
  assert.deepEqual(sorted(dashMerge.map((t) => t.number)), [10, 70]);
  assert.deepEqual(sorted(paneReview.map((i) => i.issue)), [3]);
  assert.ok(paneMerge.every((i) => i.pr !== null), 'PR の無い Merge の項目がある');
});
