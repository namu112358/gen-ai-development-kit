// Issue #856：ダッシュボードの「人がすること」の、計画ゲートで止まった行の答える欄。
// 答える欄の材料（decision）が review-issue-<番号> の行にだけ写ること（buildTodos）、loadAll がコメントの読みを増やさずに材料を作ること、
// page.html の decisionRequest・submitDecision（confirm で確かめ、合言葉を付けて POST /decisions に送る・結果の表示）と、innerHTML を使わないこと
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { PRIORITY_LABELS } from '../lib/config.ts';
import type { FleetPr, FleetRow } from '../lib/fleet.ts';
import { GitHub } from '../lib/github.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';
import { PAGE_PATH } from '../scripts/dashboard.ts';
import type { DecisionInfo } from '../scripts/dashboard/decision.ts';
import { DashboardData, ReadOnlyTransport } from '../scripts/dashboard/github.ts';
import { buildTodos, type DashIssue, type DashPr, type Todo } from '../scripts/dashboard/graph.ts';
import { config } from './support/gate-fixtures.ts';
import { APP_SLUG, callNames, dashboardFake, REPO, type WComment, type World } from './support/dashboard-fixtures.ts';

const PRIO = PRIORITY_LABELS.medium;

// --- buildTodos ---

const issueFacts = (n: number, labels: string[]): IssueFacts => ({
  number: n, title: `t${n}`, labels, readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null,
});
const prFacts = (n: number, issue: number): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number): FleetPr => ({ number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue) });
/** decision は計画で DashIssue に足される（実装の前でも型検査を通すよう as で渡す） */
const dIssue = (facts: IssueFacts, decision?: DecisionInfo, prs: FleetPr[] = []): DashIssue => ({
  fleet: { facts, closed: false, planFiles: null, prs }, body: null, url: `https://github.com/o/r/issues/${facts.number}`, plan: null,
  ...(decision ? { decision } : {}),
}) as DashIssue;
const dPr = (fp: FleetPr, issue: number): DashPr => ({
  number: fp.number, title: `pr${fp.number}`, url: `https://github.com/o/r/pull/${fp.number}`, headRef: `claude/issue-${issue}-pr${fp.number}`, baseRef: 'main', issue, fleet: fp,
});
const row = (issue: number, stage: FleetRow['stage'], pr: number | null = null): FleetRow => ({ issue, title: `t${issue}`, stage, next: 'none', pr, note: null });
const decisionOf = (t: Todo): unknown => (t as Todo & { decision?: unknown }).decision;

const answersInfo = (n: number): DecisionInfo => ({
  issue: n, planCommentId: 500 + n, mode: 'answers',
  items: [
    { id: 'reason:0', kind: 'reason', text: '方針を人が決める', choices: [] },
    { id: 'question:0', kind: 'question', text: 'どちらにするか', choices: ['A 案', 'B 案'] },
  ],
});
const proceedInfo = (n: number): DecisionInfo => ({ issue: n, planCommentId: 500 + n, mode: 'proceed', items: [] });

test('buildTodos：decision は計画ゲートで止まった行（review-issue-<番号>）にだけ写り、同じ Issue の止まる印・priority の行と Merge の行には無い。並び順は変わらない', () => {
  const d4 = answersInfo(4);
  const d7 = proceedInfo(7);
  const issues = [
    // #4：止まった計画（材料あり）に、止まる印と priority の不足も重なる
    dIssue(issueFacts(4, ['agent:ready', 'agent:plan-review', 'agent:hold']), d4),
    // #7：止まった計画（材料あり）で、Merge 待ちの PR #70 もある
    dIssue(issueFacts(7, ['agent:ready', 'agent:plan-review', PRIO]), d7, [openPr(70, 7)]),
    // #9：止まった計画だが材料が無い
    dIssue(issueFacts(9, ['agent:ready', 'agent:plan-review', PRIO])),
    // #2：止まる印だけ（材料が無い）
    dIssue(issueFacts(2, ['agent:ready', 'agent:waiting', PRIO])),
  ];
  const prs = [dPr(openPr(70, 7), 7)];
  const rows = [row(4, 'plan-review'), row(7, 'human-merge', 70), row(7, 'plan-review'), row(9, 'plan-review'), row(2, 'stopped')];
  const todos = buildTodos(issues, prs, rows);
  assert.deepEqual(todos.map((t) => t.id), [
    'merge-pr-70',
    'review-issue-4', 'review-issue-7', 'review-issue-9',
    'stop-issue-2', 'stop-issue-4',
    'priority-issue-4',
  ]);
  const byId = new Map(todos.map((t) => [t.id, t]));
  assert.deepEqual(decisionOf(byId.get('review-issue-4')!), d4);
  assert.deepEqual(decisionOf(byId.get('review-issue-7')!), d7);
  for (const id of ['merge-pr-70', 'review-issue-9', 'stop-issue-2', 'stop-issue-4', 'priority-issue-4']) {
    assert.ok(!Object.hasOwn(byId.get(id)!, 'decision'), `${id} に decision のキーがある`);
  }
  // 写るほかの値（id・reason など）は今と同じ
  const { decision: _d, ...rest } = byId.get('review-issue-4') as Todo & { decision?: unknown };
  assert.deepEqual(rest, { id: 'review-issue-4', kind: 'issue', number: 4, url: 'https://github.com/o/r/issues/4', title: 't4', reason: '計画ゲートで止まった。進めるか決める' });
});

// --- DashboardData.loadAll ---

const APP_ACTOR = { login: APP_SLUG, bot: true };
const planC = (id: number): WComment => ({ id, body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') });
const gateC = (id: number, planCommentId: number, record: Record<string, unknown>): WComment => ({
  id, author: APP_ACTOR, association: 'NONE',
  body: [appMark('plan-gate'), 'App です。', renderBlock('agent-app', { version: 1, planCommentId, reasons: [], ...record })].join('\n'),
});
/** Planner の申告（理由1つ・質問1つ。選択肢つき）の計画の写し */
const PLANNER_PLAN = {
  files: ['docs/**'], critique: { verdict: 'go', rounds: 1 }, needsHuman: true, needsHumanReasons: ['方針を人が決める'],
  openQuestions: ['どちらにするか'], openQuestionChoices: [['A 案', 'B 案']], acChangeProposed: false,
};
const PASS_PLAN = { files: ['docs/**'], critique: { verdict: 'go', rounds: 1 }, needsHuman: false, needsHumanReasons: [], openQuestions: [], acChangeProposed: false };

/** #30 は Planner の申告で止まった計画（stopped が偽なら通過した記録）、#31 は通過した計画 */
function world(stopped: boolean): World {
  return {
    issues: [
      { number: 1, title: config.dashboardIssueTitle },
      {
        number: 30, title: 'feat: thirty', body: 'b30', labels: stopped ? ['agent:ready', 'agent:plan-review', PRIO] : ['agent:ready', 'agent:plan-ok', PRIO],
        comments: [planC(3000), gateC(3001, 3000, stopped ? { pass: false, planReviewOrigin: 'planner', plan: PLANNER_PLAN } : { pass: true, plan: PASS_PLAN })],
      },
      {
        number: 31, title: 'feat: thirty-one', body: 'b31', labels: ['agent:ready', 'agent:plan-ok', PRIO],
        comments: [planC(3100), gateC(3101, 3100, { pass: true, plan: PASS_PLAN })],
      },
    ],
    prs: [],
  };
}

async function load(w: World) {
  const fake = dashboardFake(w);
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(fake), REPO), config);
  await data.loadAll();
  return { fake, data };
}
const decisionOfIssue = (i: DashIssue): unknown => (i as DashIssue & { decision?: unknown }).decision;

test('loadAll：Planner の申告で止まった Issue は decision（answers・選択肢）を持ち、通過した Issue には decision のキーが無い。コメントの読みは増えず、書き込みは無い', async () => {
  const { fake, data } = await load(world(true));
  const issues = new Map(data.issues().map((i) => [i.fleet.facts.number, i]));
  assert.deepEqual([...issues.keys()], [30, 31], '見本の前提');

  const d = decisionOfIssue(issues.get(30)!) as DecisionInfo | undefined;
  assert.ok(d, '#30 に decision が無い');
  assert.equal(d.issue, 30);
  assert.equal(d.planCommentId, 3000);
  assert.equal(d.mode, 'answers');
  assert.deepEqual(d.items.map((x) => [x.id, x.kind, x.choices]), [
    ['reason:0', 'reason', []],
    ['question:0', 'question', ['A 案', 'B 案']],
  ]);
  assert.ok(!Object.hasOwn(issues.get(31)!, 'decision'), '通過した Issue に decision のキーがある');
  assert.deepEqual(fake.writes(), []);

  // 読みの回数：止まった Issue があっても、止まっていない見本と同じ（listComments は1回のまま。コメントの REST は流れない）
  const names = callNames(fake);
  assert.equal(names.filter((n) => /^GET \/issues\/\d+\/comments$/.test(n)).length, 0, names.join('\n'));
  const base = await load(world(false));
  assert.ok(!Object.hasOwn(base.data.issues().find((i) => i.fleet.facts.number === 30)!, 'decision'), '通過した記録の #30 に decision のキーがある');
  assert.deepEqual([...names].sort(), [...callNames(base.fake)].sort(), '止まった Issue のために読みが増えた');
});

// --- page.html の script（node:vm） ---

interface Draft { text: string; answers: Record<string, { choice: string; text: string }> }
interface FakeResponse { status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }
interface Env { confirm(message: string): boolean; fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<FakeResponse>; token: string }
interface PageFns {
  decisionRequest(info: DecisionInfo, draft: Draft): unknown;
  submitDecision(info: DecisionInfo, draft: Draft, env: Env): Promise<unknown>;
}

const html = readFileSync(PAGE_PATH, 'utf8');
const script = (): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  return m[1]!;
};
/** vm の別レルムの値を deepEqual で比べられるよう、JSON で持ち帰る */
const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function page(): PageFns {
  const context: Record<string, unknown> = {};
  runInNewContext(script(), context);
  assert.equal(typeof context.decisionRequest, 'function', 'decisionRequest が定義されていない');
  assert.equal(typeof context.submitDecision, 'function', 'submitDecision が定義されていない');
  const req = context.decisionRequest as PageFns['decisionRequest'];
  const sub = context.submitDecision as PageFns['submitDecision'];
  return {
    decisionRequest: (info, draft) => plain(req(info, draft)),
    submitDecision: async (info, draft, env) => plain(await sub(info, draft, env)),
  };
}

const draft = (text = '', answers: Draft['answers'] = {}): Draft => ({ text, answers });
const PROCEED = proceedInfo(40);
const ANSWERS = answersInfo(41);
const NONE: DecisionInfo = { issue: 42, planCommentId: 542, mode: 'none', items: [], note: '人が付けた印です' };

test('decisionRequest：proceed は文の前後の空白を除き、空なら text を書かない', () => {
  const { decisionRequest } = page();
  assert.deepEqual(decisionRequest(PROCEED, draft('  直してほしい点  ')), { issue: 40, planCommentId: 540, proceed: { text: '直してほしい点' } });
  for (const text of ['', '   \n ']) {
    assert.deepEqual(decisionRequest(PROCEED, draft(text)), { issue: 40, planCommentId: 540, proceed: {} }, JSON.stringify(text));
  }
});

test('decisionRequest：answers は1つでも答えの無い項目があれば null、全部あれば to・choice・text を並べる（空の choice・text は書かない）。none は null', () => {
  const { decisionRequest } = page();
  const missing: [string, Draft['answers']][] = [
    ['何も答えていない', {}],
    ['理由だけ答えた', { 'reason:0': { choice: '', text: '理由への答え' } }],
    ['質問は空白だけ', { 'reason:0': { choice: '', text: '理由への答え' }, 'question:0': { choice: '', text: '   ' } }],
  ];
  for (const [name, answers] of missing) assert.equal(decisionRequest(ANSWERS, draft('', answers)), null, name);

  assert.deepEqual(decisionRequest(ANSWERS, draft('', {
    'reason:0': { choice: '', text: '理由への答え' },
    'question:0': { choice: 'A 案', text: '' },
  })), { issue: 41, planCommentId: 541, answers: [{ to: 'reason:0', text: '理由への答え' }, { to: 'question:0', choice: 'A 案' }] });
  assert.deepEqual(decisionRequest(ANSWERS, draft('', {
    'reason:0': { choice: '', text: '理由への答え' },
    'question:0': { choice: 'B 案', text: '補足' },
  })), { issue: 41, planCommentId: 541, answers: [{ to: 'reason:0', text: '理由への答え' }, { to: 'question:0', choice: 'B 案', text: '補足' }] });

  assert.equal(decisionRequest(NONE, draft('進めたい')), null);
});

/** fetch・confirm の呼び出しを残す偽の環境 */
function env(confirmed: boolean, status = 201, body: unknown = { url: 'https://github.com/o/r/issues/40#issuecomment-1' }) {
  const order: string[] = [];
  const fetches: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const confirms: string[] = [];
  const e: Env = {
    token: 'secret-token',
    confirm: (m) => { order.push('confirm'); confirms.push(m); return confirmed; },
    fetch: async (url, init) => {
      order.push('fetch');
      fetches.push({ url, init });
      return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    },
  };
  return { e, order, fetches, confirms };
}

test('submitDecision：confirm が偽なら fetch を呼ばない', async () => {
  const { submitDecision } = page();
  const x = env(false);
  await submitDecision(PROCEED, draft('進めて'), x.e);
  assert.deepEqual(x.order, ['confirm']);
  assert.equal(x.fetches.length, 0);
});

test('submitDecision：答えのそろわない answers・none は確かめも送りもしない', async () => {
  const { submitDecision } = page();
  for (const [info, d] of [[ANSWERS, draft('', { 'reason:0': { choice: '', text: '答え' } })], [NONE, draft('x')]] as const) {
    const x = env(true);
    await submitDecision(info, d, x.e);
    assert.deepEqual(x.order, [], info.mode);
  }
});

test('submitDecision：confirm が真なら、その後に fetch を1回、/decisions に POST・JSON・合言葉のヘッダー・decisionRequest の本文で呼ぶ', async () => {
  const { decisionRequest, submitDecision } = page();
  const cases: [DecisionInfo, Draft][] = [
    [PROCEED, draft('  直してほしい点 ')],
    [ANSWERS, draft('', { 'reason:0': { choice: '', text: '理由への答え' }, 'question:0': { choice: 'A 案', text: '' } })],
  ];
  for (const [info, d] of cases) {
    const x = env(true);
    await submitDecision(info, d, x.e);
    assert.deepEqual(x.order, ['confirm', 'fetch'], info.mode);
    assert.match(x.confirms[0]!, new RegExp(`#${info.issue}`), '確かめの文に Issue 番号が無い');
    const f = x.fetches[0]!;
    assert.equal(f.url, '/decisions');
    assert.equal(f.init.method, 'POST');
    const headers = Object.fromEntries(Object.entries(f.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.equal(headers['content-type'], 'application/json');
    assert.equal(headers['x-dashboard-token'], 'secret-token');
    assert.deepEqual(JSON.parse(f.init.body), decisionRequest(info, d));
  }
});

test('submitDecision：201 の url は https://github.com/ で始まるときだけリンクにする', async () => {
  const { submitDecision } = page();
  const good = 'https://github.com/o/r/issues/40#issuecomment-1';
  assert.deepEqual(await submitDecision(PROCEED, draft(), env(true, 201, { url: good }).e), { ok: true, url: good });
  for (const url of ['javascript:alert(1)', 'http://github.com/o/r', 'https://github.com.evil.test/x', '//github.com/x', 42]) {
    const r = await submitDecision(PROCEED, draft(), env(true, 201, { url }).e) as Record<string, unknown>;
    assert.equal(r.ok, true, String(url));
    assert.ok(!Object.hasOwn(r, 'url'), `リンクにしてはいけない url：${String(url)}`);
  }
});

test('submitDecision：409 の errors は番号と理由が文に出る', async () => {
  const { submitDecision } = page();
  const r = await submitDecision(PROCEED, draft(), env(true, 409, { errors: ['計画が出し直されました', 'ラベルが外れています'] }).e) as Record<string, unknown>;
  assert.equal(r.ok, false);
  assert.equal(typeof r.text, 'string');
  for (const s of ['409', '計画が出し直されました', 'ラベルが外れています']) assert.ok(String(r.text).includes(s), `${s} が文に無い：${String(r.text)}`);
});

// --- 静的な確かめ ---

test('page.html は送る前に confirm( を呼び、innerHTML を使わない', () => {
  const code = script();
  assert.match(code, /\bconfirm\(/);
  assert.ok(!html.includes('innerHTML'), 'page.html が innerHTML を使っている');
});
