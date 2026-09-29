// Issue #176：ダッシュボードのグラフを組む関数（facts → 列・状態・辺・セッション）と、前後のグラフの差分
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childMarker } from '../lib/epic.ts';
import type { FleetPr } from '../lib/fleet.ts';
import type { Claim, IssueFacts, PrFacts } from '../lib/queue.ts';
import { buildGraph, COLUMNS, diffGraphs, type DashIssue, type DashPr, type Graph } from '../scripts/dashboard/graph.ts';
import type { SessionInfo } from '../scripts/dashboard/sessions.ts';

const NOW = new Date('2026-09-29T00:00:00Z');
const opts = { now: NOW, humanClaimStaleHours: 6 };
const RECENT = '2026-09-28T23:50:00Z';
const OLD = '2026-09-28T12:00:00Z';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const issueFacts = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  issueFacts(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, ...patch });
const prFacts = (n: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue: null, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, patch: Partial<FleetPr> = {}, facts: Partial<PrFacts> = {}): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, facts), ...patch,
});
const pass = { acceptance: { reviewPass: true, at: 'x' } };

const dIssue = (facts: IssueFacts, prs: FleetPr[] = [], body: string | null = null): DashIssue => ({
  fleet: { facts, closed: false, planFiles: null, prs }, body, url: `https://github.com/o/r/issues/${facts.number}`,
});
const dPr = (fp: FleetPr, issue: number | null, headRef = `claude/issue-${issue ?? 0}-pr${fp.number}`, baseRef = 'main'): DashPr => ({
  number: fp.number, title: `pr${fp.number}`, url: `https://github.com/o/r/pull/${fp.number}`, headRef, baseRef, issue, fleet: fp,
});
/** Issue と、その Issue を Closes する PR を組にする */
const withPr = (facts: IssueFacts, fp: FleetPr, headRef?: string, baseRef?: string): { issue: DashIssue; pr: DashPr } => {
  const f: FleetPr = { ...fp, facts: fp.facts ? { ...fp.facts, issue: facts.number } : null };
  return { issue: dIssue(facts, [f]), pr: dPr(f, facts.number, headRef, baseRef) };
};
const si = (id: string, patch: Partial<SessionInfo> = {}): SessionInfo => ({
  id, lastAt: RECENT, branch: null, cwd: null, issue: null, running: false, subagents: [], ...patch,
});
const manual = (stage: Claim['stage'] | undefined, at = RECENT, extra: Partial<Claim> = {}): Claim => ({ by: 'manual', at, ...(stage ? { stage } : {}), ...extra }) as Claim;

const task = (g: Graph, id: string) => {
  const t = g.tasks.find((x) => x.id === id);
  assert.ok(t, `${id} のタスクがありません`);
  return t;
};
const hasEdge = (g: Graph, kind: string, from: string, to: string) => g.edges.some((e) => e.kind === kind && e.from === from && e.to === to);

test('列の並び：段階の列を左から右へ、最後に脇の列（dependency・stopped）', () => {
  assert.deepEqual(COLUMNS.map((c) => c.id), [
    'no-plan', 'plan', 'plan-critique', 'plan-gate', 'plan-review', 'plan-ok',
    'implement', 'judge', 'fix', 'sync', 'merge', 'dependency', 'stopped',
  ]);
  for (const c of COLUMNS) assert.ok(c.label.length > 0, `${c.id} に表示名がありません`);
});

test('列：着手宣言が無ければ fleetStatus の段階から決める', () => {
  const judgeP = withPr(planOk(5), openPr(50));
  const fixP = withPr(planOk(6), openPr(60, {}, { acceptance: { reviewPass: false, at: 'x' } }));
  const humanP = withPr(planOk(7), openPr(70, { draft: false, humanReview: true }, pass));
  const autoP = withPr(planOk(8), openPr(80, { draft: false, autoMerge: true }, pass));
  const g = buildGraph([
    dIssue(issueFacts(1)),
    dIssue(issueFacts(2, { latestPlanAt: '2026-09-26T01:00:00Z' })),
    dIssue(issueFacts(3, { labels: ['agent:ready', 'agent:plan-review'], latestPlanAt: '2026-09-26T01:00:00Z', gate: { ...gatePass, pass: false } })),
    dIssue(planOk(4)),
    judgeP.issue, fixP.issue, humanP.issue, autoP.issue,
    dIssue(planOk(9, { labels: ['agent:ready', 'agent:plan-ok', 'agent:hold'] })),
    dIssue(planOk(10, { openBlockers: [99] })),
    dIssue(issueFacts(11, { labels: ['epic'] })),
    dIssue(planOk(12, { labels: ['agent:ready', 'agent:plan-ok', 'agent:waiting'] })),
  ], [judgeP.pr, fixP.pr, humanP.pr, autoP.pr], [], opts);
  const col = (n: number) => task(g, `issue-${n}`).column;
  assert.equal(col(1), 'no-plan');
  assert.equal(col(2), 'plan-gate');
  assert.equal(col(3), 'plan-review');
  assert.equal(col(4), 'plan-ok');
  assert.equal(col(5), 'judge');
  assert.equal(col(6), 'fix');
  assert.equal(col(7), 'merge', 'human-merge は merge の列');
  assert.equal(col(8), 'merge', 'auto-merge は merge の列');
  assert.equal(col(9), 'stopped', 'hold のラベル');
  assert.equal(col(10), 'dependency', '依存');
  assert.equal(col(11), 'stopped', 'Epic');
  assert.equal(col(12), 'stopped', 'waiting のラベル');
  const t1 = task(g, 'issue-1');
  assert.deepEqual([t1.kind, t1.number, t1.title, t1.url], ['issue', 1, 't1', 'https://github.com/o/r/issues/1']);
});

test('列：有効な着手宣言の stage があればその列。stage が無い・解除済みなら fleetStatus の段階', () => {
  const g = buildGraph([
    dIssue(planOk(1, { claim: manual('implement') })),
    dIssue(issueFacts(2, { claim: manual('plan-critique') })),
    dIssue(issueFacts(3, { claim: manual(undefined) })),
    dIssue(issueFacts(4, { claim: manual('implement', RECENT, { released: true }) })),
    dIssue(issueFacts(5, { claim: { by: 'routine', session: 'r-sess', at: RECENT, stage: 'plan' } })),
    dIssue(planOk(6, { claim: manual('sync') })),
  ], [], [], opts);
  assert.equal(task(g, 'issue-1').column, 'implement');
  assert.equal(task(g, 'issue-2').column, 'plan-critique');
  assert.equal(task(g, 'issue-3').column, 'no-plan', 'stage の無い着手宣言');
  assert.equal(task(g, 'issue-4').column, 'no-plan', '解除済みの着手宣言は見ない');
  assert.equal(task(g, 'issue-4').status, 'idle', '解除済みの着手宣言は active にしない');
  assert.equal(task(g, 'issue-5').column, 'plan');
  assert.equal(task(g, 'issue-6').column, 'sync');
  assert.deepEqual(task(g, 'issue-1').claim, { by: 'manual', stage: 'implement', session: null, at: RECENT });
  assert.deepEqual(task(g, 'issue-5').claim, { by: 'routine', stage: 'plan', session: 'r-sess', at: RECENT });
});

test('列：stop のラベルと依存は着手宣言より優先する', () => {
  const g = buildGraph([
    dIssue(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', 'agent:hold'], claim: manual('implement') })),
    dIssue(planOk(2, { labels: ['agent:ready', 'agent:plan-ok', 'agent:blocked'], claim: manual('implement') })),
    dIssue(planOk(3, { openBlockers: [7], claim: manual('implement') })),
  ], [], [], opts);
  assert.equal(task(g, 'issue-1').column, 'stopped');
  assert.equal(task(g, 'issue-2').column, 'stopped');
  assert.equal(task(g, 'issue-3').column, 'dependency');
  for (const n of [1, 2, 3]) assert.equal(task(g, `issue-${n}`).status, 'blocked', `#${n}`);
});

test('状態：blocked > stale > active > waiting-human > idle（Issue）', () => {
  const g = buildGraph([
    dIssue(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', 'agent:waiting'] })),
    dIssue(planOk(2, { openBlockers: [9] })),
    dIssue(planOk(3, { claim: manual('implement', OLD) })),
    dIssue(planOk(4, { claim: manual('implement', RECENT) })),
    dIssue(planOk(5, { claim: { by: 'routine', session: 's', at: OLD, stage: 'implement' } })),
    dIssue(issueFacts(6, { labels: ['agent:ready', 'agent:plan-review'] })),
    dIssue(planOk(7)),
    dIssue(issueFacts(8)),
  ], [], [], opts);
  const st = (n: number) => task(g, `issue-${n}`).status;
  assert.equal(st(1), 'blocked', 'stop のラベル');
  assert.equal(st(2), 'blocked', '依存');
  assert.equal(st(3), 'stale', 'humanClaimStaleHours 以上前の手動の着手宣言');
  assert.equal(st(4), 'active');
  assert.equal(st(5), 'active', 'stale は手動の着手宣言だけ');
  assert.equal(st(6), 'waiting-human', 'plan-review');
  assert.equal(st(7), 'idle');
  assert.equal(st(8), 'idle');
});

test('PR のタスク：列は Issue と同じ。PR に着手宣言があればその段階。Issue の無い PR は PR だけの段階', () => {
  const a = withPr(planOk(1), openPr(10));
  const b = withPr(planOk(2, { claim: manual('fix') }), openPr(20));
  const c = withPr(planOk(3), openPr(30, {}, { claim: manual('sync') }));
  const noIssue = dPr(openPr(40), null, 'claude/chore-x');
  const g = buildGraph([a.issue, b.issue, c.issue], [a.pr, b.pr, c.pr, noIssue], [], opts);
  const p10 = task(g, 'pr-10');
  assert.deepEqual([p10.kind, p10.number, p10.title, p10.url, p10.column], ['pr', 10, 'pr10', 'https://github.com/o/r/pull/10', 'judge']);
  assert.equal(task(g, 'pr-20').column, 'fix', 'Issue の着手宣言の段階');
  assert.equal(task(g, 'pr-30').column, 'sync', 'PR の着手宣言の段階');
  assert.equal(task(g, 'pr-30').status, 'active');
  assert.equal(task(g, 'pr-40').column, 'judge', 'Issue の無い Agent PR');
});

test('PR のタスクの状態：PR のラベル・衝突・PR の着手宣言を見る。Issue の stop ラベルは PR に効かない', () => {
  const held = withPr(planOk(1), openPr(10, {}, { labels: ['agent:hold'] }));
  const conflicted = withPr(planOk(2), openPr(20, {}, { conflicted: true }));
  const human = withPr(planOk(3), openPr(30, { draft: false, humanReview: true }, pass));
  const issueHeld = withPr(planOk(4, { labels: ['agent:ready', 'agent:plan-ok', 'agent:hold'] }), openPr(40));
  const stale = withPr(planOk(5), openPr(50, {}, { claim: manual('fix', OLD) }));
  const plain = withPr(planOk(6), openPr(60));
  const g = buildGraph(
    [held.issue, conflicted.issue, human.issue, issueHeld.issue, stale.issue, plain.issue],
    [held.pr, conflicted.pr, human.pr, issueHeld.pr, stale.pr, plain.pr], [], opts);
  assert.equal(task(g, 'pr-10').status, 'blocked', 'PR の agent:hold');
  assert.equal(task(g, 'pr-20').status, 'conflict');
  assert.equal(task(g, 'pr-30').status, 'waiting-human', 'Issue の行の stage が human-merge');
  assert.notEqual(task(g, 'pr-40').status, 'blocked', 'Issue の stop ラベルは Issue のタスクにだけ効く');
  assert.equal(task(g, 'issue-4').status, 'blocked');
  assert.equal(task(g, 'pr-50').status, 'stale', 'PR の手動の着手宣言が古い');
  assert.equal(task(g, 'pr-60').status, 'idle');
});

test('辺：depends（一覧に無い依存先にも出す）・epic（親が一覧にあるときだけ）・closes・stacked', () => {
  const base = withPr(planOk(1), openPr(10), 'claude/issue-1-base');
  const top = withPr(planOk(2), openPr(20), 'claude/issue-2-top', 'claude/issue-1-base');
  const g = buildGraph([
    base.issue, top.issue,
    dIssue(planOk(3, { openBlockers: [1, 99] })),
    dIssue(issueFacts(4, { labels: ['epic'] })),
    dIssue(issueFacts(5), [], `本文\n${childMarker(4, 0)}`),
    dIssue(issueFacts(6), [], `本文\n${childMarker(77, 1)}`),
  ], [base.pr, top.pr], [], opts);
  assert.ok(hasEdge(g, 'depends', 'issue-3', 'issue-1'));
  assert.ok(hasEdge(g, 'depends', 'issue-3', 'issue-99'), '一覧に無い依存先');
  assert.ok(hasEdge(g, 'epic', 'issue-4', 'issue-5'));
  assert.ok(!g.edges.some((e) => e.kind === 'epic' && e.to === 'issue-6'), '親が一覧に無い子には epic の辺を出さない');
  assert.ok(hasEdge(g, 'closes', 'issue-1', 'pr-10'));
  assert.ok(hasEdge(g, 'closes', 'issue-2', 'pr-20'));
  assert.ok(hasEdge(g, 'stacked', 'pr-20', 'pr-10'));
  assert.ok(!g.edges.some((e) => e.kind === 'stacked' && e.from === 'pr-10'), 'main に向く PR は stacked にしない');
});

test('辺：session（claim の session・手元のセッションの issue・PR の headRef と同じ branch）と、タスクの sessions', () => {
  const p = withPr(planOk(3), openPr(30), 'claude/issue-3-x');
  const g = buildGraph([
    dIssue(planOk(1, { claim: { by: 'manual', at: RECENT, session: 'claim-session-0001', stage: 'implement' } })),
    dIssue(planOk(2)),
    p.issue,
  ], [p.pr], [
    si('local-session-0002', { issue: 2, branch: 'claude/issue-2-y', running: true }),
    si('local-session-0003', { issue: 3, branch: 'claude/issue-3-x' }),
  ], opts);
  assert.ok(hasEdge(g, 'session', 'issue-1', 'session-claim-session-0001'), 'claim の session');
  assert.ok(hasEdge(g, 'session', 'issue-2', 'session-local-session-0002'), '手元のセッションの issue');
  assert.ok(hasEdge(g, 'session', 'pr-30', 'session-local-session-0003'), 'branch が PR の headRef と同じ');
  assert.deepEqual(task(g, 'issue-1').sessions, ['claim-session-0001']);
  assert.deepEqual(task(g, 'issue-2').sessions, ['local-session-0002']);
  assert.ok(task(g, 'pr-30').sessions.includes('local-session-0003'));
  for (const e of g.edges.filter((x) => x.kind === 'session')) assert.ok(g.sessions.some((s) => s.id === e.to), `${e.to} のセッションのノードがありません`);
});

test('セッションのノード：手元のセッションすべてと、手元に無い claim の session（local=false・subagents 空）', () => {
  const sub = { id: 'a1', type: 'reviewer', description: 'PR を読む', lastAt: RECENT, running: true };
  const g = buildGraph([
    dIssue(planOk(1, { claim: { by: 'routine', session: 'remote-session-abcdef', at: RECENT, stage: 'judge' } })),
  ], [], [
    si('local-session-1234', { issue: null, running: true, lastAt: RECENT, subagents: [sub] }),
  ], opts);
  const local = g.sessions.find((s) => s.session === 'local-session-1234');
  assert.ok(local, '一致するタスクの無い手元のセッションも出す');
  assert.deepEqual([local.id, local.short, local.local, local.running, local.lastAt], ['session-local-session-1234', 'local-se', true, true, RECENT]);
  assert.deepEqual(local.subagents, [{ type: 'reviewer', description: 'PR を読む', lastAt: RECENT, running: true }]);
  const remote = g.sessions.find((s) => s.session === 'remote-session-abcdef');
  assert.ok(remote);
  assert.deepEqual([remote.id, remote.short, remote.local, remote.subagents], ['session-remote-session-abcdef', 'remote-s', false, []]);
  assert.equal(g.sessions.length, 2);
});

test('差分：claim --stage が付くと、そのタスクだけが新しい列で task イベントになる', () => {
  const issues = (claim: Claim | null) => [dIssue(planOk(1, { claim })), dIssue(issueFacts(2))];
  const before = buildGraph(issues(null), [], [], opts);
  const after = buildGraph(issues(manual('implement')), [], [], opts);
  const events = diffGraphs(before, after).filter((e) => e.type === 'task');
  assert.equal(events.length, 1);
  const ev = events[0]!;
  assert.ok(ev.type === 'task');
  assert.equal(ev.task.id, 'issue-1');
  assert.equal(ev.task.column, 'implement');
  assert.equal(ev.task.status, 'active');
});

test('差分：変化が無ければ空。消えたタスクは remove。task イベントの edges はそのタスクの辺すべて', () => {
  const a = withPr(planOk(1, { openBlockers: [9] }), openPr(10));
  const g1 = buildGraph([a.issue, dIssue(issueFacts(2))], [a.pr], [], opts);
  const g1b = buildGraph([a.issue, dIssue(issueFacts(2))], [a.pr], [], opts);
  assert.deepEqual(diffGraphs(g1, g1b), []);

  const g2 = buildGraph([dIssue(issueFacts(2))], [], [], opts);
  const removed = diffGraphs(g1, g2).filter((e) => e.type === 'remove').map((e) => (e.type === 'remove' ? e.id : '')).sort();
  assert.deepEqual(removed, ['issue-1', 'pr-10']);
  assert.ok(!diffGraphs(g1, g2).some((e) => e.type === 'task'), '残ったタスクは変わっていない');

  const added = diffGraphs(g2, g1).find((e) => e.type === 'task' && e.task.id === 'issue-1');
  assert.ok(added && added.type === 'task');
  const expected = g1.edges.filter((e) => e.from === 'issue-1');
  assert.deepEqual([...added.edges].sort((x, y) => x.to.localeCompare(y.to)), [...expected].sort((x, y) => x.to.localeCompare(y.to)));
  assert.ok(added.edges.some((e) => e.kind === 'depends') && added.edges.some((e) => e.kind === 'closes'));
});

test('差分：セッションが変われば sessions イベント（全体）', () => {
  const issues = [dIssue(issueFacts(1))];
  const g1 = buildGraph(issues, [], [si('s-0001', { running: true })], opts);
  const g2 = buildGraph(issues, [], [si('s-0001', { running: false })], opts);
  const ev = diffGraphs(g1, g2).filter((e) => e.type === 'sessions');
  assert.equal(ev.length, 1);
  assert.ok(ev[0]!.type === 'sessions');
  assert.deepEqual(ev[0]!.sessions, g2.sessions);
  assert.ok(!diffGraphs(g1, g2).some((e) => e.type === 'task'), 'セッションに繋がらないタスクは変わらない');
  assert.deepEqual(diffGraphs(g1, buildGraph(issues, [], [si('s-0001', { running: true })], opts)), []);
});
