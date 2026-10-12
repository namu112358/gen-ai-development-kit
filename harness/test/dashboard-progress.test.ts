// Issue #815：ダッシュボードの上の進み具合の帯（Epic ごとの閉じた数／全体・今日の Merge の数（App と人の内訳）・動いているセッションの数）を組む関数と、その材料の問い合わせ・応答の読み取り
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProgressQuery, progressFacts } from '../scripts/dashboard/github.ts';
import { buildGraph, buildProgress, diffGraphs, type DashIssue, type Progress, type ProgressFacts } from '../scripts/dashboard/graph.ts';
import type { SessionInfo, SubagentInfo } from '../scripts/dashboard/sessions.ts';
import { APP } from './support/gate-fixtures.ts';
import { APP_SLUG } from './support/dashboard-fixtures.ts';

/** 手元の時刻で作る（TZ に依らない） */
const NOW = new Date(2026, 9, 12, 15);
const at = (d: number, h: number, m = 0): string => new Date(2026, 9, d, h, m).toISOString();

const sub = (id: string, running: boolean): SubagentInfo => ({ id, type: 'general-purpose', description: id, lastAt: null, running });
const si = (id: string, running: boolean, subagents: SubagentInfo[] = []): SessionInfo => ({
  id, lastAt: null, branch: null, cwd: null, issue: null, running, subagents,
});
const epic = (number: number, total: number, completed: number) => ({
  number, title: `epic${number}`, url: `https://github.com/o/r/issues/${number}`, total, completed,
});
const facts = (patch: Partial<ProgressFacts> = {}): ProgressFacts => ({ epics: [], merged: [], truncated: false, ...patch });

test('buildProgress：Epic は番号の昇順で closed（completed）／total を出し、子の無い Epic も 0/0 で出す', () => {
  const p = buildProgress(facts({ epics: [epic(30, 4, 1), epic(5, 0, 0), epic(12, 3, 3)] }), [], NOW);
  assert.deepEqual(p.epics, [
    { number: 5, title: 'epic5', url: 'https://github.com/o/r/issues/5', closed: 0, total: 0 },
    { number: 12, title: 'epic12', url: 'https://github.com/o/r/issues/12', closed: 3, total: 3 },
    { number: 30, title: 'epic30', url: 'https://github.com/o/r/issues/30', closed: 1, total: 4 },
  ]);
});

test('buildProgress：今日の Merge は手元の日付の 0 時以降だけを数え（0 時ちょうどを含む）、App と人に分ける', () => {
  const merged = [
    { number: 1, mergedAt: at(12, 0), byApp: true }, // 0 時ちょうど：数える
    { number: 2, mergedAt: at(12, 14, 59), byApp: false },
    { number: 3, mergedAt: at(12, 9), byApp: true },
    { number: 4, mergedAt: at(11, 23, 59), byApp: true }, // 前の日：数えない
    { number: 5, mergedAt: at(11, 10), byApp: false }, // 前の日：数えない
  ];
  const p = buildProgress(facts({ merged }), [], NOW);
  assert.deepEqual(p.mergedToday, { total: 3, app: 2, human: 1, truncated: false });
});

test('buildProgress：今日の Merge が無ければ 0 件（null ではない）、truncated は材料から引き継ぐ', () => {
  for (const truncated of [false, true]) {
    const p = buildProgress(facts({ merged: [{ number: 4, mergedAt: at(11, 23, 59), byApp: true }], truncated }), [], NOW);
    assert.deepEqual(p.mergedToday, { total: 0, app: 0, human: 0, truncated }, String(truncated));
  }
});

test('buildProgress：running は動いているセッションの数と、全セッションのサブエージェントのうち動いているものの数（止まったものは数えない）', () => {
  const sessions = [
    si('s-1', true, [sub('a', true), sub('b', false)]),
    si('s-2', false, [sub('c', true)]),
    si('s-3', true),
    si('s-4', false, [sub('d', false)]),
  ];
  assert.deepEqual(buildProgress(facts(), sessions, NOW).running, { sessions: 2, subagents: 2 });
  assert.deepEqual(buildProgress(facts(), [], NOW).running, { sessions: 0, subagents: 0 });
});

test('buildProgress：材料が無い（null）なら epics と mergedToday は null、running は数える', () => {
  const p = buildProgress(null, [si('s-1', true, [sub('a', true)]), si('s-2', false)], NOW);
  assert.deepEqual(p, { epics: null, mergedToday: null, running: { sessions: 1, subagents: 1 } } satisfies Progress);
});

const dIssue = (n: number): DashIssue => ({
  fleet: {
    facts: {
      number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
      gate: null, latestPlanAt: null, planOkByApp: false, openPr: null,
    },
    closed: false, planFiles: null, prs: [],
  },
  body: null, url: `https://github.com/o/r/issues/${n}`, plan: null,
});
const opts = { now: NOW, humanClaimStaleHours: 6 };

test('buildGraph：progress に buildProgress の結果を入れる（材料を渡さなければ null として数える）', () => {
  const sessions = [si('s-1', true, [sub('a', true)])];
  const f = facts({ epics: [epic(9, 2, 1)], merged: [{ number: 1, mergedAt: at(12, 1), byApp: false }] });
  assert.deepEqual(buildGraph([dIssue(1)], [], sessions, { ...opts, progress: f }).progress, buildProgress(f, sessions, NOW));
  assert.deepEqual(buildGraph([dIssue(1)], [], sessions, { ...opts, progress: null }).progress, buildProgress(null, sessions, NOW));
  assert.deepEqual(buildGraph([dIssue(1)], [], sessions, opts).progress, buildProgress(null, sessions, NOW));
});

test('diffGraphs：progress が変われば progress のイベントを1つ（新しい値）出し、変わらなければ出さない', () => {
  const issues = [dIssue(1)];
  const g1 = buildGraph(issues, [], [], { ...opts, progress: facts({ epics: [epic(9, 2, 1)] }) });
  const g2 = buildGraph(issues, [], [], { ...opts, progress: facts({ epics: [epic(9, 2, 2)] }) });
  const ev = diffGraphs(g1, g2);
  assert.deepEqual(ev, [{ type: 'progress', progress: g2.progress }]);
  assert.deepEqual(diffGraphs(g1, buildGraph(issues, [], [], { ...opts, progress: facts({ epics: [epic(9, 2, 1)] }) })), []);
});

/** 「手元の今日の 0 時を UTC にした日付」の前の日（YYYY-MM-DD） */
function expectedSince(now: Date): string {
  const utcDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
  return new Date(Date.parse(`${utcDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

test('buildProgressQuery：今日の Merge 済み PR の search（前の日から）と Epic のラベルを渡し、rateLimit を含み、mutation を含まない', () => {
  const nows = [new Date(2026, 9, 12, 0, 30), new Date(2026, 9, 12, 23, 30), new Date(2026, 0, 1, 0, 0), new Date(2026, 2, 1, 12, 0)];
  for (const now of nows) {
    const { query, variables } = buildProgressQuery('o/r', 'type:epic-815', now);
    const all = JSON.stringify({ query, variables });
    const since = expectedSince(now);
    assert.ok(all.includes(`repo:o/r is:pr is:merged merged:>=${since}`), `${now.toISOString()}: ${all}`);
    // 検索の起点は手元の今日の 0 時より前（取りこぼさない）
    assert.ok(Date.parse(`${since}T00:00:00Z`) <= new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), since);
    assert.ok(all.includes('type:epic-815'), 'Epic のラベル');
    assert.match(query, /rateLimit/);
    assert.doesNotMatch(query, /mutation/);
    for (const field of ['subIssuesSummary', 'mergedAt', 'mergedBy', 'hasNextPage']) assert.ok(query.includes(field), field);
  }
});

test('buildProgressQuery：リポジトリとラベルは引数から使う', () => {
  const { query, variables } = buildProgressQuery('acme/widgets', 'kind:theme', new Date(2026, 9, 12, 15));
  const all = JSON.stringify({ query, variables });
  assert.ok(all.includes('repo:acme/widgets is:pr is:merged merged:>='), all);
  assert.ok(all.includes('kind:theme'), all);
});

const response = (issues: unknown[], prs: unknown[], hasNextPage = false) => ({
  repository: { issues: { nodes: issues } },
  search: { pageInfo: { hasNextPage }, nodes: prs },
});

test('progressFacts：Epic の子の数を読み、subIssuesSummary が null なら 0/0', () => {
  const data = response([
    { number: 12, title: 'e12', url: 'https://github.com/o/r/issues/12', subIssuesSummary: { total: 5, completed: 2 } },
    { number: 3, title: 'e3', url: 'https://github.com/o/r/issues/3', subIssuesSummary: null },
  ], []);
  const f = progressFacts(data, APP);
  const byNumber = [...f.epics].sort((a, b) => a.number - b.number);
  assert.deepEqual(byNumber, [
    { number: 3, title: 'e3', url: 'https://github.com/o/r/issues/3', total: 0, completed: 0 },
    { number: 12, title: 'e12', url: 'https://github.com/o/r/issues/12', total: 5, completed: 2 },
  ]);
  assert.deepEqual(f.merged, []);
  assert.equal(f.truncated, false);
});

test('progressFacts：Merge した人が App（Bot を login[bot] にして appLogin と一致）なら byApp、ほかは人', () => {
  const T = '2026-10-12T01:00:00Z';
  const cases: { mergedBy: unknown; byApp: boolean; why: string }[] = [
    { mergedBy: { __typename: 'Bot', login: APP_SLUG }, byApp: true, why: 'App の Bot' },
    { mergedBy: { __typename: 'Bot', login: `${APP_SLUG}-other` }, byApp: false, why: 'ほかの Bot' },
    { mergedBy: { __typename: 'User', login: APP_SLUG }, byApp: false, why: 'App の slug と同じ名前の人（[bot] が付かない）' },
    { mergedBy: { __typename: 'User', login: 'alice' }, byApp: false, why: '人' },
    { mergedBy: null, byApp: false, why: 'mergedBy が無い' },
  ];
  for (const c of cases) {
    const f = progressFacts(response([], [{ __typename: 'PullRequest', number: 7, mergedAt: T, mergedBy: c.mergedBy }]), APP);
    assert.deepEqual(f.merged, [{ number: 7, mergedAt: T, byApp: c.byApp }], c.why);
  }
});

test('progressFacts：PR でない node（空オブジェクト・番号が無い・mergedAt が null）は数えず、__typename が無い PR は数える', () => {
  const T = '2026-10-12T02:00:00Z';
  const f = progressFacts(response([], [
    {},
    { __typename: 'PullRequest', mergedAt: T, mergedBy: null },
    { __typename: 'PullRequest', number: 8, mergedAt: null, mergedBy: null },
    { number: 9, mergedAt: T, mergedBy: { __typename: 'User', login: 'bob' } },
    { __typename: 'PullRequest', number: 10, mergedAt: T, mergedBy: { __typename: 'Bot', login: APP_SLUG } },
  ]), APP);
  assert.deepEqual(f.merged, [
    { number: 9, mergedAt: T, byApp: false },
    { number: 10, mergedAt: T, byApp: true },
  ]);
});

test('progressFacts：search の hasNextPage を truncated にする', () => {
  for (const hasNextPage of [false, true]) {
    assert.equal(progressFacts(response([], [], hasNextPage), APP).truncated, hasNextPage, String(hasNextPage));
  }
});
