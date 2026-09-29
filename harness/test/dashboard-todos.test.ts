// Issue #220：ダッシュボードの一番上に出す「人がすること」の一覧（Merge 待ち・人の判断待ち・止まる印・priority の不足）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIORITY_LABELS } from '../lib/config.ts';
import type { FleetPr, FleetRow } from '../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';
import { buildGraph, buildTodos, diffGraphs, type DashIssue, type DashPr, type Todo } from '../scripts/dashboard/graph.ts';

const NOW = new Date('2026-09-29T00:00:00Z');
const opts = { now: NOW, humanClaimStaleHours: 6 };
const PRIO = PRIORITY_LABELS.medium;

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const issueFacts = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', PRIO], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  issueFacts(n, { labels: ['agent:ready', 'agent:plan-ok', PRIO], gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, ...patch });
const prFacts = (n: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue: null, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, patch: Partial<FleetPr> = {}, facts: Partial<PrFacts> = {}): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, facts), ...patch,
});
const pass = { acceptance: { reviewPass: true, at: 'x' } };

const dIssue = (facts: IssueFacts, prs: FleetPr[] = []): DashIssue => ({
  fleet: { facts, closed: false, planFiles: null, prs }, body: null, url: `https://github.com/o/r/issues/${facts.number}`, plan: null,
});
const dPr = (fp: FleetPr, issue: number | null): DashPr => ({
  number: fp.number, title: `pr${fp.number}`, url: `https://github.com/o/r/pull/${fp.number}`, headRef: `claude/issue-${issue ?? 0}-pr${fp.number}`, baseRef: 'main', issue, fleet: fp,
});
const withPr = (facts: IssueFacts, fp: FleetPr): { issue: DashIssue; pr: DashPr } => {
  const f: FleetPr = { ...fp, facts: fp.facts ? { ...fp.facts, issue: facts.number } : null };
  return { issue: dIssue(facts, [f]), pr: dPr(f, facts.number) };
};
const row = (issue: number, stage: FleetRow['stage'], pr: number | null = null): FleetRow => ({ issue, title: `t${Math.abs(issue)}`, stage, next: 'none', pr, note: null });

const issueTodo = (n: number, key: string, reason: string): Todo => ({
  id: `${key}-issue-${n}`, kind: 'issue', number: n, url: `https://github.com/o/r/issues/${n}`, title: `t${n}`, reason,
});
const mergeTodo = (n: number): Todo => ({
  id: `merge-pr-${n}`, kind: 'pr', number: n, url: `https://github.com/o/r/pull/${n}`, title: `pr${n}`, reason: 'PR を確かめて Merge する',
});
const REVIEW = '計画ゲートで止まった。進めるか決める';
const NO_PRIORITY = 'priority のラベルが無い';

test('Human Merge：行の stage が human-merge なら、その PR を Merge する項目が出る（url・title は PR から）', () => {
  const p = withPr(planOk(7), openPr(70));
  assert.deepEqual(buildTodos([p.issue], [p.pr], [row(7, 'human-merge', 70)]), [mergeTodo(70)]);
});

test('Human Merge：Issue の無い PR の行（issue が -PR番号）も同じく出る', () => {
  const pr = dPr(openPr(30), null);
  assert.deepEqual(buildTodos([], [pr], [row(-30, 'human-merge', 30)]), [mergeTodo(30)]);
});

test('Human Merge：行の PR が prs に見つからなければ出さない', () => {
  assert.deepEqual(buildTodos([dIssue(planOk(7))], [], [row(7, 'human-merge', 70)]), []);
});

test('自動 Merge 待ち（auto-merge）は出さない', () => {
  const p = withPr(planOk(8), openPr(80));
  assert.deepEqual(buildTodos([p.issue], [p.pr], [row(8, 'auto-merge', 80)]), []);
});

test('人の判断待ち：stage が plan-review の Issue は、進めるか決める項目になる', () => {
  const i = dIssue(issueFacts(3, { labels: ['agent:ready', 'agent:plan-review', PRIO] }));
  assert.deepEqual(buildTodos([i], [], [row(3, 'plan-review')]), [issueTodo(3, 'review', REVIEW)]);
});

test('ほかの段階（計画なし・判定待ち・修正待ち・止まる印あり・Merge 済み）の行だけでは出ない', () => {
  const i = dIssue(planOk(1));
  for (const stage of ['no-plan', 'plan-gate', 'plan-ok', 'judge', 'fix', 'merged', 'stopped'] as const) {
    assert.deepEqual(buildTodos([i], [], [row(1, stage, stage === 'judge' || stage === 'fix' ? 10 : null)]), [], stage);
  }
});

test('止まる印：hold・blocked・waiting のどれかが付いた Issue は対応の項目になる', () => {
  for (const l of ['agent:hold', 'agent:blocked', 'agent:waiting']) {
    const i = dIssue(planOk(2, { labels: ['agent:ready', 'agent:plan-ok', PRIO, l] }));
    assert.deepEqual(buildTodos([i], [], [row(2, 'stopped')]), [issueTodo(2, 'stop', `止まる印（${l}）の対応`)], l);
  }
});

test('止まる印：複数付いていれば「・」でつないで1つの項目にする', () => {
  const i = dIssue(planOk(2, { labels: ['agent:ready', 'agent:hold', 'agent:blocked', 'agent:waiting', PRIO] }));
  assert.deepEqual(buildTodos([i], [], [row(2, 'stopped')]), [issueTodo(2, 'stop', '止まる印（agent:hold・agent:blocked・agent:waiting）の対応')]);
});

test('priority：agent: のラベルがあり priority のラベルが無い Issue は項目になる', () => {
  const i = dIssue(issueFacts(1, { labels: ['agent:ready'] }));
  assert.deepEqual(buildTodos([i], [], [row(1, 'no-plan')]), [issueTodo(1, 'priority', NO_PRIORITY)]);
});

test('priority：epic のラベルがあり priority のラベルが無い Issue も項目になる', () => {
  const i = dIssue(issueFacts(4, { labels: ['epic'] }));
  assert.deepEqual(buildTodos([i], [], [row(4, 'stopped')]), [issueTodo(4, 'priority', NO_PRIORITY)]);
});

test('priority：どの priority のラベルが付いていても出ない', () => {
  for (const p of Object.values(PRIORITY_LABELS)) {
    const i = dIssue(issueFacts(1, { labels: ['agent:ready', p] }));
    assert.deepEqual(buildTodos([i], [], [row(1, 'no-plan')]), [], p);
  }
});

test('priority：agent: のラベルも epic も無い Issue は出ない', () => {
  for (const labels of [[], ['bug'], ['documentation', 'area:harness']]) {
    const i = dIssue(issueFacts(1, { labels }));
    assert.deepEqual(buildTodos([i], [], [row(1, 'no-plan')]), [], labels.join(',') || '(なし)');
  }
});

test('並び：Human Merge → 人の判断待ち → 止まる印 → priority の不足。同じ種類の中は番号の小さい順', () => {
  const m80 = withPr(planOk(8), openPr(80));
  const m20 = withPr(planOk(9), openPr(20));
  const orphan = dPr(openPr(50), null);
  const issues = [
    dIssue(issueFacts(5, { labels: ['agent:ready'] })),
    dIssue(planOk(6, { labels: ['agent:ready', 'agent:hold', PRIO] })),
    m80.issue,
    dIssue(issueFacts(11, { labels: ['agent:ready', 'agent:plan-review', PRIO] })),
    dIssue(issueFacts(1, { labels: ['epic'] })),
    dIssue(planOk(2, { labels: ['agent:ready', 'agent:waiting', PRIO] })),
    m20.issue,
    dIssue(issueFacts(4, { labels: ['agent:ready', 'agent:plan-review', PRIO] })),
  ];
  const rows = [
    row(5, 'no-plan'), row(6, 'stopped'), row(8, 'human-merge', 80), row(11, 'plan-review'),
    row(1, 'stopped'), row(2, 'stopped'), row(9, 'human-merge', 20), row(4, 'plan-review'), row(-50, 'human-merge', 50),
  ];
  const ids = buildTodos(issues, [m80.pr, orphan, m20.pr], rows).map((t) => t.id);
  assert.deepEqual(ids, [
    'merge-pr-20', 'merge-pr-50', 'merge-pr-80',
    'review-issue-4', 'review-issue-11',
    'stop-issue-2', 'stop-issue-6',
    'priority-issue-1', 'priority-issue-5',
  ]);
});

test('buildGraph：グラフの todos に、fleetStatus の段階とラベルから組んだ一覧が入る', () => {
  const human = withPr(planOk(7), openPr(70, { draft: false, humanReview: true }, pass));
  const auto = withPr(planOk(8), openPr(80, { draft: false, autoMerge: true }, pass));
  const orphan = dPr(openPr(30, { draft: false, humanReview: true }, pass), null);
  const g = buildGraph([
    dIssue(issueFacts(1, { labels: ['agent:ready'] })),
    dIssue(issueFacts(3, { labels: ['agent:ready', 'agent:plan-review', PRIO], latestPlanAt: '2026-09-26T01:00:00Z', gate: { ...gatePass, pass: false } })),
    human.issue,
    auto.issue,
    dIssue(planOk(9, { labels: ['agent:ready', 'agent:plan-ok', PRIO, 'agent:hold'] })),
    dIssue(planOk(10)),
  ], [human.pr, auto.pr, orphan], [], opts);
  assert.deepEqual(g.todos, [
    mergeTodo(30),
    mergeTodo(70),
    issueTodo(3, 'review', REVIEW),
    issueTodo(9, 'stop', '止まる印（agent:hold）の対応'),
    issueTodo(1, 'priority', NO_PRIORITY),
  ]);
});

test('buildGraph：人がすることが無ければ todos は空の配列', () => {
  const g = buildGraph([dIssue(planOk(1)), dIssue(issueFacts(2, { labels: ['bug'] }))], [], [], opts);
  assert.deepEqual(g.todos, []);
});

test('差分：todos が変われば todos のイベントを1つ（全体）、変わらなければ出さない', () => {
  const g1 = buildGraph([dIssue(issueFacts(1, { labels: ['agent:ready'] }))], [], [], opts);
  const g1b = buildGraph([dIssue(issueFacts(1, { labels: ['agent:ready'] }))], [], [], opts);
  const g2 = buildGraph([dIssue(issueFacts(1, { labels: ['agent:ready', PRIORITY_LABELS.high] }))], [], [], opts);
  assert.equal(g1.todos.length, 1);
  assert.deepEqual(g2.todos, []);

  const ev = diffGraphs(g1, g2).filter((e) => e.type === 'todos');
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.type === 'todos');
  assert.deepEqual(ev[0]!.todos, []);

  const back = diffGraphs(g2, g1).filter((e) => e.type === 'todos');
  assert.equal(back.length, 1);
  assert.ok(back[0]!.type === 'todos');
  assert.deepEqual(back[0]!.todos, g1.todos);

  assert.ok(!diffGraphs(g1, g1b).some((e) => e.type === 'todos'));
  assert.deepEqual(diffGraphs(g1, g1b), []);
});
