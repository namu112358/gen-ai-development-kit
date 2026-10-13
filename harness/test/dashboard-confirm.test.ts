// Issue #964：手元のダッシュボードの「人がすること」の確認事項（agent-confirm）の群と、POST /confirm-answers（harness/scripts/dashboard/confirm.ts）。
// (1) loadAll → buildGraph の todos に、答えの無い確認事項が古い順（コメントの createdAt）に並び、答え済みは出ず、agent:* も宣言も PR も無い確認事項だけの Issue と PR の確認事項も出る。読みは増えない。
// (2) POST /confirm-answers は Origin・合言葉の無い・違う要求を 403 で拒んで書き込み0件、正しい要求は 201 でコメントの POST を1件だけ書き、本文は confirmAnswerOf で答えとして読める。
// (3) createConfirmSink の submit は、答え済み・確認事項が無い・閉じたときは 409、答えのそろわない・存在しない質問・選択肢に無い・空の答えなどは 400 で、どれも書かない。
// (4) page.html の confirmRequest・submitConfirm（答えのそろわない下書きは null、confirm の後に /confirm-answers へ合言葉つきで1回送る）。
// 文言は固定せず、状態の番号・行の id の並び・書き込みの数・confirmAnswerOf で読めるかで確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { claudeMarkSession } from '../lib/blocks.ts';
import { confirmAnswerOf, type Confirm } from '../lib/confirm.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { PAGE_PATH, startServer } from '../scripts/dashboard.ts';
import { createConfirmSink, type ConfirmInfo } from '../scripts/dashboard/confirm.ts';
import { CommentOnlyTransport } from '../scripts/dashboard/decision.ts';
import { DashboardData, ReadOnlyTransport } from '../scripts/dashboard/github.ts';
import { buildGraph, COLUMNS, type Graph } from '../scripts/dashboard/graph.ts';
import { config, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptComments, callNames, dashboardFake, REPO, type WComment, type World } from './support/dashboard-fixtures.ts';
import { confirmCommentBody, confirmValue, shortAnswerBody } from './support/step-fixtures.ts';

const NOW = new Date('2026-10-13T00:00:00Z');
const at = (h: number): string => `2026-10-12T0${h}:00:00Z`;
const confirmC = (id: number, value: Confirm, created_at: string): WComment => ({ id, created_at, body: confirmCommentBody(value) });
const answerC = (id: number, confirmId: number, created_at: string): WComment => ({ id, created_at, body: shortAnswerBody(confirmId, ['はい']) });

/** コメントを一緒に書いた書き込み（GET とまとめた読みの GraphQL を除く） */
const writeCalls = (fake: FakeGitHub) => fake.calls.filter((c) => c.method !== 'GET' && !(c.path === '/graphql' && String(c.body?.query).startsWith('query')));

// --- (1) 一覧 ---

/**
 * #10・#11：agent:ready の Issue に確認事項（作った時刻は #10 が新しく、ID は #10 が小さい）。
 * #12：答え済みの確認事項。#13：agent:* も宣言も PR も無く、確認事項だけ。PR #60：Issue の無い Agent PR に確認事項（いちばん古い）。
 * withConfirms が偽なら確認事項と答えのコメントを置かない
 */
function listWorld(withConfirms: boolean): World {
  const c = (list: WComment[]) => (withConfirms ? list : []);
  return {
    issues: [
      { number: 10, title: 'ten', labels: ['agent:ready'], comments: c([confirmC(1010, confirmValue({ target: 10 }), at(5))]) },
      { number: 11, title: 'eleven', labels: ['agent:ready'], comments: c([confirmC(1110, confirmValue({ target: 11 }), at(3))]) },
      { number: 12, title: 'twelve', labels: ['agent:ready'], comments: c([confirmC(1210, confirmValue({ target: 12 }), at(1)), answerC(1211, 1210, at(2))]) },
      { number: 13, title: 'thirteen', comments: c([confirmC(1310, confirmValue({ target: 13 }), at(4))]) },
    ],
    prs: [{ number: 60, headRef: 'claude/issue-60-x', comments: c([confirmC(6010, confirmValue({ target: 60, stage: 'fix', resume: 'fix' }), at(2))]) }],
  };
}

async function loadGraph(w: World) {
  const fake = dashboardFake(w);
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(fake), REPO), config);
  await data.loadAll();
  const graph = buildGraph(data.issues(), data.prs(), [], { now: NOW, humanClaimStaleHours: 6 });
  return { fake, graph };
}

test('一覧：答えの無い確認事項が古い順に並び、答え済みは出ず、確認事項だけの Issue と PR の確認事項も出る。読みは増えず、書き込みは無い', async () => {
  const { fake, graph } = await loadGraph(listWorld(true));
  const confirms = graph.todos.filter((t) => t.id.startsWith('confirm-'));
  assert.deepEqual(confirms.map((t) => t.id), ['confirm-pr-60-6010', 'confirm-issue-11-1110', 'confirm-issue-13-1310', 'confirm-issue-10-1010']);
  assert.deepEqual(confirms.map((t) => [t.kind, t.number]), [['pr', 60], ['issue', 11], ['issue', 13], ['issue', 10]]);

  const pr = confirms[0]!.confirm;
  assert.ok(pr, '行に答える欄の材料（confirm）が無い');
  assert.deepEqual([pr.target, pr.kind, pr.confirmCommentId, pr.stage, pr.resume], [60, 'pr', 6010, 'fix', 'fix']);
  assert.deepEqual(pr.questions.map((q) => q.choices), [['はい', 'いいえ']]);

  // 群の順：確認事項は priority の群より前
  const ids = graph.todos.map((t) => t.id);
  const firstPriority = ids.findIndex((id) => id.startsWith('priority-'));
  assert.ok(firstPriority < 0 || ids.lastIndexOf('confirm-issue-10-1010') < firstPriority, ids.join('\n'));
  // 確認事項だけの Issue はグラフのカードにも出る
  assert.ok(graph.tasks.some((t) => t.id === 'issue-13'), '確認事項だけの #13 のカードが無い');
  assert.deepEqual(fake.writes(), []);

  // 読みの回数：確認事項の無い見本と同じ
  const base = await loadGraph(listWorld(false));
  assert.deepEqual(base.graph.todos.filter((t) => t.id.startsWith('confirm-')), []);
  assert.deepEqual([...callNames(fake)].sort(), [...callNames(base.fake)].sort(), '確認事項のために読みが増えた');
});

// --- (2)(3) 答えの受け皿 ---

const T = 900;
const TOKEN = 'd'.repeat(64);
/** 質問2つ（question:0 は選択肢つき、question:1 は選択肢なし） */
const TWO = confirmValue({
  target: T,
  questions: [
    { text: '既定を shadow にするか', why: '設定の既定は人の決定', choices: ['はい', 'いいえ'] },
    { text: '名前は何にするか', why: '名付けは人の決定' },
  ],
});
const CONFIRM_ID = 9010;
const GOOD = { target: T, confirmCommentId: CONFIRM_ID, answers: [{ to: 'question:0', choice: 'はい' }, { to: 'question:1', text: '  confirm-answers  ' }] };

function sinkWorld(patch: { state?: 'open' | 'closed'; comments?: WComment[] } = {}) {
  const world: World = {
    issues: [{ number: T, title: 'nine hundred', state: patch.state ?? 'open', labels: ['agent:ready'], comments: patch.comments ?? [confirmC(CONFIRM_ID, TWO, at(1))] }],
    prs: [],
  };
  let n = 0;
  const fake = acceptComments(dashboardFake(world), world, () => `2026-10-12T1${n++}:00:00Z`);
  const sink = createConfirmSink({ read: new GitHub(fake, REPO), write: new GitHub(new CommentOnlyTransport(fake, REPO), REPO), token: TOKEN, now: () => NOW });
  return { world, fake, sink };
}

/** 書き込みの本文を、確認事項への答えとして読む（読めなければ理由で落とす） */
function readAnswer(body: string, id: number) {
  const comment: IssueComment = { id, body, html_url: '', created_at: NOW.toISOString(), updated_at: NOW.toISOString(), author_association: 'OWNER', user: { login: 'me', type: 'User' } };
  const r = confirmAnswerOf({ commentId: CONFIRM_ID, value: TWO }, comment);
  assert.ok(r.ok, `答えとして読めない：${JSON.stringify(r)}`);
  return r.value;
}

const snapshot = (): Graph => ({ columns: COLUMNS, tasks: [], edges: [], sessions: [], todos: [], progress: { epics: null, mergedToday: null, running: { sessions: 0, subagents: 0 } } });

function postConfirm(port: number, h: { origin?: string; token?: string; body: string }): Promise<{ res: IncomingMessage; body: string }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, 'content-type': 'application/json' };
  if (h.origin !== undefined) headers.origin = h.origin;
  if (h.token !== undefined) headers['x-dashboard-token'] = h.token;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/confirm-answers', method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ res, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end(h.body);
  });
}

test('POST /confirm-answers：Origin・合言葉の無い・違う要求は 403 で書き込み0件、正しい要求は 201 でコメントの POST を1件だけ書き、本文は答えとして読める', async () => {
  const { fake, sink } = sinkWorld();
  const s = await startServer({ port: 0, html: '<!doctype html><title>dash</title>', snapshot, confirms: sink });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const body = JSON.stringify(GOOD);
    const refused: [string, { origin?: string; token?: string; body: string }][] = [
      ['Origin が無い', { token: TOKEN, body }],
      ['Origin が違う', { origin: 'http://evil.example', token: TOKEN, body }],
      ['合言葉が無い', { origin, body }],
      ['合言葉が違う', { origin, token: 'e'.repeat(64), body }],
    ];
    for (const [name, h] of refused) {
      const r = await postConfirm(s.port, h);
      assert.equal(r.res.statusCode, 403, name);
      assert.deepEqual(writeCalls(fake), [], `${name}：書かない`);
    }

    const r = await postConfirm(s.port, { origin, token: TOKEN, body });
    assert.equal(r.res.statusCode, 201, r.body);
    assert.equal(typeof (JSON.parse(r.body) as { url?: unknown }).url, 'string');
    const writes = writeCalls(fake);
    assert.equal(writes.length, 1, JSON.stringify(writes.map((c) => `${c.method} ${c.path}`)));
    assert.equal(writes[0]!.method, 'POST');
    assert.equal(writes[0]!.path, `/repos/o/r/issues/${T}/comments`);
    const text = String(writes[0]!.body?.body);
    assert.equal(claudeMarkSession(text), null, '目印にセッションの ID がある');
    const answer = readAnswer(text, CONFIRM_ID + 1);
    assert.deepEqual(answer.answers.map((a) => [a.to, a.choice ?? null, a.quote]), [['question:0', 'はい', 'はい'], ['question:1', null, 'confirm-answers']]);
  } finally {
    await s.close();
  }
});

test('createConfirmSink：答え済み・確認事項が無い・閉じたときは 409、答えのそろわない・存在しない質問・選択肢に無い・空の答えなどは 400 で、どれも書かない', async () => {
  const other = confirmC(9020, confirmValue({ target: T }), at(2));
  const cases: [string, Parameters<typeof sinkWorld>[0], unknown, number][] = [
    ['答え済み', { comments: [confirmC(CONFIRM_ID, TWO, at(1)), { id: CONFIRM_ID + 1, created_at: at(2), body: shortAnswerBody(CONFIRM_ID, ['はい', '名前']) }] }, GOOD, 409],
    ['確認事項が無い（別の確認事項の ID）', { comments: [other] }, GOOD, 409],
    ['確認事項が無い（コメントが無い）', { comments: [] }, GOOD, 409],
    ['閉じた', { state: 'closed' }, GOOD, 409],
    ['答えのそろわない質問', {}, { ...GOOD, answers: [GOOD.answers[0]] }, 400],
    ['存在しない質問', {}, { ...GOOD, answers: [...GOOD.answers, { to: 'question:2', text: 'x' }] }, 400],
    ['質問の形が違う', {}, { ...GOOD, answers: [GOOD.answers[0], { to: 'reason:0', text: 'x' }] }, 400],
    ['同じ質問の重複', {}, { ...GOOD, answers: [...GOOD.answers, { to: 'question:0', choice: 'いいえ' }] }, 400],
    ['選択肢に無い答え', {}, { ...GOOD, answers: [{ to: 'question:0', choice: 'たぶん' }, GOOD.answers[1]] }, 400],
    ['選択肢の無い質問への choice', {}, { ...GOOD, answers: [GOOD.answers[0], { to: 'question:1', choice: 'はい' }] }, 400],
    ['空の答え', {}, { ...GOOD, answers: [GOOD.answers[0], { to: 'question:1', text: '   ' }] }, 400],
    ['answers が空', {}, { ...GOOD, answers: [] }, 400],
    ['target が正の整数でない', {}, { ...GOOD, target: 0 }, 400],
    ['confirmCommentId が正の整数でない', {}, { ...GOOD, confirmCommentId: 'x' }, 400],
  ];
  for (const [name, w, raw, status] of cases) {
    const { fake, sink } = sinkWorld(w);
    const r = await sink.submit(raw);
    assert.equal(r.status, status, name);
    assert.ok(Array.isArray((r.body as { errors?: unknown }).errors), `${name}：errors が無い`);
    assert.deepEqual(writeCalls(fake), [], `${name}：書かない`);
  }

  // 正しい要求は1件だけ書き、書いた後は答え済み（409）になって2件目を書かない
  const ok = sinkWorld();
  assert.equal((await ok.sink.submit(GOOD)).status, 201);
  assert.equal((await ok.sink.submit(GOOD)).status, 409);
  assert.equal(writeCalls(ok.fake).length, 1);
});

// --- (4) page.html の script（node:vm） ---

interface Draft { text: string; answers: Record<string, { choice: string; text: string }> }
interface FakeResponse { status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }
interface Env { confirm(message: string): boolean; fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<FakeResponse>; token: string }

const html = readFileSync(PAGE_PATH, 'utf8');
/** vm の別レルムの値を deepEqual で比べられるよう、JSON で持ち帰る */
const plain = (v: unknown): unknown => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function page() {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  const context: Record<string, unknown> = {};
  runInNewContext(m[1]!, context);
  assert.equal(typeof context.confirmRequest, 'function', 'confirmRequest が定義されていない');
  assert.equal(typeof context.submitConfirm, 'function', 'submitConfirm が定義されていない');
  const req = context.confirmRequest as (info: ConfirmInfo, draft: Draft) => unknown;
  const sub = context.submitConfirm as (info: ConfirmInfo, draft: Draft, env: Env) => Promise<unknown>;
  return {
    confirmRequest: (info: ConfirmInfo, draft: Draft) => plain(req(info, draft)),
    submitConfirm: async (info: ConfirmInfo, draft: Draft, env: Env) => plain(await sub(info, draft, env)),
  };
}

const INFO: ConfirmInfo = {
  target: 70, kind: 'issue', confirmCommentId: 7010, url: 'https://github.com/o/r/issues/70#issuecomment-7010', createdAt: at(1), stage: 'implement', resume: 'implement',
  questions: [
    { text: '既定を shadow にするか', why: '設定の既定は人の決定', choices: ['はい', 'いいえ'] },
    { text: '名前は何にするか', why: '名付けは人の決定', choices: [] },
  ],
};
const draft = (answers: Draft['answers']): Draft => ({ text: '', answers });
const FULL = draft({ 'question:0': { choice: 'はい', text: '' }, 'question:1': { choice: '', text: '  名前  ' } });

function env(confirmed: boolean) {
  const order: string[] = [];
  const fetches: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const confirms: string[] = [];
  const e: Env = {
    token: 'secret-token',
    confirm: (msg) => { order.push('confirm'); confirms.push(msg); return confirmed; },
    fetch: async (url, init) => {
      order.push('fetch');
      fetches.push({ url, init });
      const body = { url: 'https://github.com/o/r/issues/70#issuecomment-7011' };
      return { status: 201, ok: true, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => body, text: async () => JSON.stringify(body) };
    },
  };
  return { e, order, fetches, confirms };
}

test('confirmRequest：1つでも答えの無い質問があれば null、全部あれば target・confirmCommentId と question:<添字> の答えを並べる', () => {
  const { confirmRequest } = page();
  const missing: [string, Draft['answers']][] = [
    ['何も答えていない', {}],
    ['question:0 だけ', { 'question:0': { choice: 'はい', text: '' } }],
    ['question:1 が空白だけ', { 'question:0': { choice: 'はい', text: '' }, 'question:1': { choice: '', text: '   ' } }],
  ];
  for (const [name, answers] of missing) assert.equal(confirmRequest(INFO, draft(answers)), null, name);
  assert.deepEqual(confirmRequest(INFO, FULL), { target: 70, confirmCommentId: 7010, answers: [{ to: 'question:0', choice: 'はい' }, { to: 'question:1', text: '名前' }] });
});

test('submitConfirm：答えがそろわなければ確かめも送りもせず、confirm が偽なら送らず、真なら confirm の後に /confirm-answers へ合言葉つきで1回送る', async () => {
  const { confirmRequest, submitConfirm } = page();

  const missing = env(true);
  await submitConfirm(INFO, draft({}), missing.e);
  assert.deepEqual(missing.order, []);

  const declined = env(false);
  await submitConfirm(INFO, FULL, declined.e);
  assert.deepEqual(declined.order, ['confirm']);

  const x = env(true);
  await submitConfirm(INFO, FULL, x.e);
  assert.deepEqual(x.order, ['confirm', 'fetch']);
  assert.match(x.confirms[0]!, /#70/, '確かめの文に番号が無い');
  const f = x.fetches[0]!;
  assert.equal(f.url, '/confirm-answers');
  assert.equal(f.init.method, 'POST');
  const headers = Object.fromEntries(Object.entries(f.init.headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers['x-dashboard-token'], 'secret-token');
  assert.deepEqual(JSON.parse(f.init.body), confirmRequest(INFO, FULL));
});
