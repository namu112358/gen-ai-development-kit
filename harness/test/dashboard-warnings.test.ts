// Issue #205：ダッシュボードの列の強制のされ方・終了条件（COLUMNS）と、批評を飛ばした計画の注意（issueWarnings・buildGraph の warnings）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FleetPr } from '../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';
import { buildGraph, COLUMNS, issueWarnings, type DashIssue, type DashPr, type Graph, type PlanCopy } from '../scripts/dashboard/graph.ts';

const opts = { now: new Date('2026-09-29T00:00:00Z'), humanClaimStaleHours: 6 };

const issueFacts = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const prFacts = (n: number, issue: number | null): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number | null): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue),
});
const dIssue = (n: number, plan: PlanCopy | null, prs: FleetPr[] = []): DashIssue => ({
  fleet: { facts: issueFacts(n), closed: false, planFiles: null, prs }, body: null, url: `https://github.com/o/r/issues/${n}`, plan,
});
const dPr = (fp: FleetPr, issue: number | null): DashPr => ({
  number: fp.number, title: `pr${fp.number}`, url: `https://github.com/o/r/pull/${fp.number}`,
  headRef: `claude/issue-${issue ?? 0}-pr${fp.number}`, baseRef: 'main', issue, fleet: fp,
});
const task = (g: Graph, id: string) => {
  const t = g.tasks.find((x) => x.id === id);
  assert.ok(t, `${id} のタスクがありません`);
  return t;
};

test('issueWarnings：計画の写しが無い（null）なら注意は無い', () => {
  assert.deepEqual(issueWarnings(null), []);
});

test('issueWarnings：計画に critique が無ければ「批評なし」', () => {
  assert.deepEqual(issueWarnings({}), ['批評なし']);
  assert.deepEqual(issueWarnings({ critique: undefined }), ['批評なし']);
});

test('issueWarnings：revise で mustRemaining が1以上なら、残した件数つきの注意', () => {
  assert.deepEqual(issueWarnings({ critique: { verdict: 'revise', mustRemaining: 2 } }), ['必須の指摘を残して進めた（2 件）']);
  assert.deepEqual(issueWarnings({ critique: { verdict: 'revise', mustRemaining: 1 } }), ['必須の指摘を残して進めた（1 件）']);
});

test('issueWarnings：go・split・drop と、revise で mustRemaining が 0 か無いなら注意は無い', () => {
  for (const verdict of ['go', 'split', 'drop']) {
    assert.deepEqual(issueWarnings({ critique: { verdict } }), [], verdict);
  }
  assert.deepEqual(issueWarnings({ critique: { verdict: 'go', mustRemaining: 0 } }), []);
  assert.deepEqual(issueWarnings({ critique: { verdict: 'revise', mustRemaining: 0 } }), []);
  assert.deepEqual(issueWarnings({ critique: { verdict: 'revise' } }), []);
});

test('issueWarnings：critique の形が崩れていれば「批評の記録が読めない」', () => {
  const broken: unknown[] = [
    null,
    'go',
    3,
    true,
    [],
    {},
    { verdict: 1 },
    { verdict: null },
    { verdict: 'revise', mustRemaining: '2' },
    { verdict: 'revise', mustRemaining: null },
    { verdict: 'go', mustRemaining: 'x' },
  ];
  for (const critique of broken) {
    assert.deepEqual(issueWarnings({ critique }), ['批評の記録が読めない'], JSON.stringify(critique));
  }
});

test('buildGraph：Issue のタスクの warnings は issueWarnings(issue.plan)、PR のタスクの warnings は []', () => {
  const noCritique = openPr(10, 1);
  const g = buildGraph([
    dIssue(1, {}, [noCritique]),
    dIssue(2, { critique: { verdict: 'revise', mustRemaining: 3 } }),
    dIssue(3, { critique: { verdict: 'go' } }),
    dIssue(4, null),
    dIssue(5, { critique: 'broken' }),
  ], [dPr(noCritique, 1), dPr(openPr(20, null), null)], [], opts);
  assert.deepEqual(task(g, 'issue-1').warnings, ['批評なし']);
  assert.deepEqual(task(g, 'issue-2').warnings, ['必須の指摘を残して進めた（3 件）']);
  assert.deepEqual(task(g, 'issue-3').warnings, []);
  assert.deepEqual(task(g, 'issue-4').warnings, []);
  assert.deepEqual(task(g, 'issue-5').warnings, ['批評の記録が読めない']);
  assert.deepEqual(task(g, 'pr-10').warnings, [], 'Issue に注意があっても PR のタスクには出さない');
  assert.deepEqual(task(g, 'pr-20').warnings, [], 'Issue の無い PR');
});

test('COLUMNS：すべての列に強制のされ方（4種のどれか）と、空でない終了条件・止めるものがある', () => {
  const kinds = ['code', 'cond', 'ai', 'human'];
  for (const c of COLUMNS) {
    assert.ok(kinds.includes(c.enforcement), `${c.id} の enforcement が ${String(c.enforcement)}`);
    assert.equal(typeof c.exit, 'string', `${c.id} の exit`);
    assert.ok(c.exit.trim().length > 0, `${c.id} に終了条件がありません`);
    assert.equal(typeof c.stopper, 'string', `${c.id} の stopper`);
    assert.ok(c.stopper.trim().length > 0, `${c.id} に止めるものがありません`);
  }
});

test('COLUMNS：強制のされ方の割り当て', () => {
  const byId = Object.fromEntries(COLUMNS.map((c) => [c.id, c.enforcement]));
  assert.deepEqual(byId, {
    'no-plan': 'code', plan: 'code', 'plan-critique': 'code', 'plan-gate': 'code', 'plan-ok': 'code', judge: 'code',
    implement: 'cond', fix: 'cond', sync: 'cond', dependency: 'cond',
    'plan-review': 'human', merge: 'human', stopped: 'human',
  });
});
