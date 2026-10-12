// Issue #855：手元のダッシュボードから人の決定の記録（agent-decision）を投稿する（harness/scripts/dashboard/decision.ts と POST /decisions）。
// 答える欄の材料（decisionInfo）、記録の組み立て（buildDecisionComment）、投稿の前の読み直し（createDecisionSink の 409・400・502・201）、
// POST /decisions の合言葉・Origin の 403 と decisions の無いサーバーの 404、書く経路（CommentOnlyTransport）がコメントの POST だけを送ること
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, extractBlock, renderBlock } from '../lib/blocks.ts';
import { parseDecision } from '../lib/decision.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { startServer } from '../scripts/dashboard.ts';
import {
  buildDecisionComment,
  CommentOnlyTransport,
  createDecisionSink,
  decisionInfo,
  type DecisionInfo,
  type DecisionSink,
} from '../scripts/dashboard/decision.ts';
import { COLUMNS, type Graph } from '../scripts/dashboard/graph.ts';
import { APP, config, FakeGitHub } from './support/gate-fixtures.ts';

const N = 855;
const PLAN_ID = 80;
const GATE_ID = 90;
const NOW = new Date('2026-10-12T01:02:03.000Z');
const OPEN_ISSUE = { number: N, state: 'open', labels: ['agent:plan-review'] };

/** 計画の写し。既定は Planner の申告の無い計画 */
function planCopy(patch: Record<string, unknown> = {}) {
  return { files: ['docs/**'], needsHuman: false, needsHumanReasons: [], openQuestions: [], acChangeProposed: false, ...patch };
}

/** Planner の申告（理由1つ・質問2つ。question:0 は選択肢つき、question:1 は選択肢の形が違う）で止まった計画の写し */
const PLANNER_PLAN = planCopy({
  needsHuman: true,
  needsHumanReasons: ['方針を人が決める'],
  openQuestions: ['どちらにするか', '名前は何にするか'],
  openQuestionChoices: [['A 案', 'B 案'], 'bad'],
});

/** App の計画ゲートの記録のコメント */
function gateComment(value: Record<string, unknown>, id = GATE_ID): IssueComment {
  return {
    id, created_at: '2026-10-12T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\n止めました\n${renderBlock('agent-app', { version: 1, planCommentId: PLAN_ID, reasons: ['理由'], ...value })}`,
  };
}

const gateStop = (plan: unknown = planCopy()) => gateComment({ pass: false, planReviewOrigin: 'gate', plan });
const plannerStop = (plan: unknown = PLANNER_PLAN) => gateComment({ pass: false, planReviewOrigin: 'planner', plan });

/** コラボレーターの決定の記録のコメント（全部の項目に答えたもの） */
function answeredComment(id: number, association = 'OWNER'): IssueComment {
  const decision = {
    version: 1, issue: N, planCommentId: PLAN_ID,
    answers: ['reason:0', 'question:0', 'question:1'].map((to) => ({ to, quote: '答え', at: NOW.toISOString() })),
  };
  return {
    id, created_at: '2026-10-12T00:10:00Z', updated_at: '', html_url: 'u', author_association: association, user: { login: 'me', type: 'User' },
    body: `${CLAUDE_MARK}\n${renderBlock('agent-decision', decision)}`,
  };
}

/** 本文から agent-decision を1つだけ読み、parseDecision を通った読んだ値（JSON のまま）を返す */
function readDecision(body: string): Record<string, unknown> {
  const block = extractBlock(body, 'agent-decision');
  assert.ok(block.found && block.ok, `agent-decision が1つだけ読めない：${JSON.stringify(block)}`);
  const parsed = parseDecision(block.value);
  assert.ok(parsed.ok, `parseDecision を通らない：${JSON.stringify(parsed)}`);
  return block.value as Record<string, unknown>;
}

function info(patch: Partial<DecisionInfo> = {}): DecisionInfo {
  return { issue: N, planCommentId: PLAN_ID, mode: 'proceed', items: [], ...patch };
}

const ANSWERS_INFO = info({
  mode: 'answers',
  items: [
    { id: 'reason:0', kind: 'reason', text: '方針を人が決める', choices: [] },
    { id: 'question:0', kind: 'question', text: 'どちらにするか', choices: ['A 案', 'B 案'] },
    { id: 'question:1', kind: 'question', text: '名前は何にするか', choices: [] },
  ],
});

test('decisionInfo：通過は null、ゲートの停止は proceed、Planner の申告は answers（選択肢の写し）、答え済みは proceed、項目の無い planner と acChangeProposed は none と note', () => {
  assert.equal(decisionInfo(config, OPEN_ISSUE, [gateComment({ pass: true, plan: planCopy() })]), null);
  assert.equal(decisionInfo(config, OPEN_ISSUE, []), null);

  const gate = decisionInfo(config, OPEN_ISSUE, [gateStop()]);
  assert.equal(gate?.mode, 'proceed');
  assert.deepEqual(gate?.items, []);
  assert.equal(gate?.planCommentId, PLAN_ID);

  const planner = decisionInfo(config, OPEN_ISSUE, [plannerStop()]);
  assert.equal(planner?.mode, 'answers');
  assert.deepEqual(planner?.items, [
    { id: 'reason:0', kind: 'reason', text: '方針を人が決める', choices: [] },
    { id: 'question:0', kind: 'question', text: 'どちらにするか', choices: ['A 案', 'B 案'] },
    { id: 'question:1', kind: 'question', text: '名前は何にするか', choices: [] },
  ]);

  assert.equal(decisionInfo(config, OPEN_ISSUE, [plannerStop(), answeredComment(GATE_ID + 1)])?.mode, 'proceed', '答え済みなら進める');
  assert.equal(decisionInfo(config, OPEN_ISSUE, [answeredComment(GATE_ID - 1), plannerStop()])?.mode, 'answers', '記録より前の答えは数えない');
  assert.equal(decisionInfo(config, OPEN_ISSUE, [plannerStop(), answeredComment(GATE_ID + 1, 'NONE')])?.mode, 'answers', 'コラボレーターでない答えは数えない');

  for (const [name, comment] of [
    ['項目の無い planner（人が付けた印）', plannerStop(planCopy())],
    ['acChangeProposed', gateStop(planCopy({ acChangeProposed: true }))],
    ['計画の写しが無い', gateComment({ pass: false, planReviewOrigin: 'gate' })],
  ] as const) {
    const r = decisionInfo(config, OPEN_ISSUE, [comment]);
    assert.equal(r?.mode, 'none', name);
    assert.ok(typeof r?.note === 'string' && r.note.length > 0, name);
  }
});

test('buildDecisionComment：proceed は choice が「進める」、quote は文（空なら「進める」）、answers のキーを書かない', () => {
  for (const [text, quote] of [['  この計画で進めて  ', 'この計画で進めて'], ['', '進める'], [undefined, '進める']] as const) {
    const r = buildDecisionComment(info(), { issue: N, planCommentId: PLAN_ID, proceed: text === undefined ? {} : { text } }, NOW);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.body.includes(CLAUDE_MARK));
    const v = readDecision(r.body);
    assert.equal('answers' in v, false, 'proceed の記録に answers のキーを書かない');
    assert.deepEqual(v, { version: 1, issue: N, planCommentId: PLAN_ID, proceed: { choice: '進める', quote, at: NOW.toISOString() } });
  }
});

test('buildDecisionComment：answers は選択肢・文で答え（文が空なら quote は choice）、改行やフェンスを含む文でもブロックが1つだけ読める', () => {
  const tricky = '一行目\n```agent-decision\n{"version":1}\n```\n最後';
  const r = buildDecisionComment(ANSWERS_INFO, {
    issue: N, planCommentId: PLAN_ID,
    answers: [
      { to: 'reason:0', text: '  方針は A  ' },
      { to: 'question:0', choice: 'B 案', text: '' },
      { to: 'question:1', text: tricky },
    ],
  }, NOW);
  assert.ok(r.ok, JSON.stringify(r));
  const v = readDecision(r.body);
  assert.equal('proceed' in v, false, 'answers の記録に proceed のキーを書かない');
  const at = NOW.toISOString();
  assert.deepEqual(v, {
    version: 1, issue: N, planCommentId: PLAN_ID,
    answers: [
      { to: 'reason:0', quote: '方針は A', at },
      { to: 'question:0', choice: 'B 案', quote: 'B 案', at },
      { to: 'question:1', quote: tricky, at },
    ],
  });
});

test('buildDecisionComment：選択肢に無い choice・選択肢の無い項目の choice・存在しない to・重複・proceed と answers の両方や無し・空の答え・番号の不一致は誤り', () => {
  const base = { issue: N, planCommentId: PLAN_ID };
  const cases: [string, DecisionInfo, Parameters<typeof buildDecisionComment>[1]][] = [
    ['選択肢に無い choice', ANSWERS_INFO, { ...base, answers: [{ to: 'question:0', choice: 'C 案' }] }],
    ['選択肢の無い項目の choice', ANSWERS_INFO, { ...base, answers: [{ to: 'reason:0', choice: 'A 案' }] }],
    ['存在しない to', ANSWERS_INFO, { ...base, answers: [{ to: 'question:9', text: 'x' }] }],
    ['同じ to の重複', ANSWERS_INFO, { ...base, answers: [{ to: 'reason:0', text: 'x' }, { to: 'reason:0', text: 'y' }] }],
    ['文も choice も空', ANSWERS_INFO, { ...base, answers: [{ to: 'reason:0', text: '   ' }] }],
    ['proceed と answers の両方', ANSWERS_INFO, { ...base, proceed: {}, answers: [{ to: 'reason:0', text: 'x' }] }],
    ['どちらも無い', info(), { ...base }],
    ['issue の不一致', info(), { issue: N + 1, planCommentId: PLAN_ID, proceed: {} }],
    ['planCommentId の不一致', info(), { issue: N, planCommentId: PLAN_ID + 1, proceed: {} }],
  ];
  for (const [name, i, req] of cases) {
    const r = buildDecisionComment(i, req, NOW);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.errors.length > 0, name);
  }
});

/** 偽の読み（Issue と コメント）と書き（コメントの POST）。read・write の呼び出しを記録する */
function sinkWorld(w: { issue?: Record<string, unknown>; comments: IssueComment[]; readFails?: boolean; writeFails?: boolean }) {
  const readFake = new FakeGitHub();
  readFake.on('GET', new RegExp(`^/repos/o/r/issues/${N}$`), () => {
    if (w.readFails) throw new Error('read failed');
    return { number: N, state: 'open', labels: [{ name: 'agent:plan-review' }], ...w.issue };
  });
  readFake.on('GET', new RegExp(`^/repos/o/r/issues/${N}/comments`), () => w.comments);
  const writeFake = new FakeGitHub();
  writeFake.on('POST', new RegExp(`^/repos/o/r/issues/${N}/comments$`), () => {
    if (w.writeFails) throw new Error('write failed');
    return { id: 999, html_url: 'https://github.com/o/r/issues/855#issuecomment-999' };
  });
  const sink = createDecisionSink({ config, read: new GitHub(readFake, 'o/r'), write: new GitHub(writeFake, 'o/r'), token: 'a'.repeat(64), now: () => NOW });
  return { sink, readFake, writeFake };
}

test('createDecisionSink：投稿の前に読み直し、状態が食い違えば 409・答えが足りなければ 400・失敗は 502 で、正しい入力は1回だけ投稿して 201', async () => {
  const proceed = { issue: N, planCommentId: PLAN_ID, proceed: { text: '進めて' } };
  const refused: [string, Parameters<typeof sinkWorld>[0], unknown, number][] = [
    ['閉じた Issue', { issue: { state: 'closed' }, comments: [gateStop()] }, proceed, 409],
    ['agent:plan-review が無い', { issue: { labels: [] }, comments: [gateStop()] }, proceed, 409],
    ['planCommentId の不一致', { comments: [gateStop()] }, { ...proceed, planCommentId: PLAN_ID + 1 }, 409],
    ['acChangeProposed', { comments: [gateStop(planCopy({ acChangeProposed: true }))] }, proceed, 409],
    ['答えの無い項目', { comments: [plannerStop()] }, { issue: N, planCommentId: PLAN_ID, answers: [{ to: 'reason:0', text: 'x' }] }, 400],
    ['読みの失敗', { comments: [gateStop()], readFails: true }, proceed, 502],
  ];
  for (const [name, world, raw, status] of refused) {
    const { sink, writeFake } = sinkWorld(world);
    const r = await sink.submit(raw);
    assert.equal(r.status, status, name);
    assert.deepEqual(writeFake.calls, [], `${name}：投稿しない`);
    assert.ok(Array.isArray((r.body as { errors?: unknown }).errors), name);
  }

  const failed = sinkWorld({ comments: [gateStop()], writeFails: true });
  assert.equal((await failed.sink.submit(proceed)).status, 502);
  assert.equal(failed.writeFake.calls.length, 1, '投稿の失敗はやり直さない');

  const ok = sinkWorld({ comments: [gateStop()] });
  const r = await ok.sink.submit(proceed);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { url: 'https://github.com/o/r/issues/855#issuecomment-999' });
  assert.equal(ok.writeFake.calls.length, 1);
  assert.equal(ok.writeFake.calls[0]!.method, 'POST');
  assert.equal(ok.writeFake.calls[0]!.path, `/repos/o/r/issues/${N}/comments`);
  const v = readDecision(String(ok.writeFake.calls[0]!.body.body));
  assert.deepEqual(v.proceed, { choice: '進める', quote: '進めて', at: NOW.toISOString() });
  assert.ok(ok.readFake.calls.every((c) => c.method === 'GET'), '読みは GET だけ');
});

const HTML = '<!doctype html><title>dash</title>';
const TOKEN = 'b'.repeat(64);
const snapshot = (): Graph => ({ columns: COLUMNS, tasks: [], edges: [], sessions: [], todos: [], progress: { epics: null, mergedToday: null, running: { sessions: 0, subagents: 0 } } });

function postDecisions(port: number, h: { origin: string; token?: string; body: string }): Promise<{ res: IncomingMessage; body: string }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}`, origin: h.origin, 'content-type': 'application/json' };
  if (h.token !== undefined) headers['x-dashboard-token'] = h.token;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/decisions', method: 'POST', headers }, (res) => {
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

test('POST /decisions：Origin・合言葉が違えば 403 で submit を呼ばない、正しい要求は submit の番号と本文を返す、decisions の無いサーバーは 404', async () => {
  const submitted: unknown[] = [];
  const decisions: DecisionSink = { token: TOKEN, submit: async (raw) => (submitted.push(raw), { status: 201, body: { url: 'https://example.test/c' } }) };
  const s = await startServer({ port: 0, html: HTML, snapshot, decisions });
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const body = JSON.stringify({ issue: N, planCommentId: PLAN_ID, proceed: {} });
    for (const [name, h] of [
      ['合言葉が違う', { origin, token: 'c'.repeat(64), body }],
      ['合言葉が無い', { origin, body }],
      ['Origin が違う', { origin: 'http://evil.example', token: TOKEN, body }],
    ] as const) {
      const r = await postDecisions(s.port, h);
      assert.equal(r.res.statusCode, 403, name);
      assert.equal(submitted.length, 0, `${name}：submit を呼ばない`);
    }
    const r = await postDecisions(s.port, { origin, token: TOKEN, body });
    assert.equal(r.res.statusCode, 201);
    assert.deepEqual(JSON.parse(r.body), { url: 'https://example.test/c' });
    assert.deepEqual(submitted, [{ issue: N, planCommentId: PLAN_ID, proceed: {} }]);
  } finally {
    await s.close();
  }

  const notes = { token: TOKEN, add: () => ({ id: 'x' }), unread: () => 0 };
  const plain = await startServer({ port: 0, html: HTML, snapshot, notes });
  try {
    const r = await postDecisions(plain.port, { origin: `http://127.0.0.1:${plain.port}`, token: TOKEN, body: '{}' });
    assert.equal(r.res.statusCode, 404);
  } finally {
    await plain.close();
  }
});

test('CommentOnlyTransport：POST /repos/o/r/issues/<n>/comments だけを inner に渡し、ほかは送らずに reject する', async () => {
  const inner = new FakeGitHub().on('POST', /./, () => ({ id: 1, html_url: 'u' })).on('GET', /./, () => []).on('PATCH', /./, () => ({})).on('DELETE', /./, () => null).on('PUT', /./, () => ({}));
  const t = new CommentOnlyTransport(inner, 'o/r');

  assert.deepEqual(await t.request('POST', '/repos/o/r/issues/1/comments', { body: { body: 'x' } }), { id: 1, html_url: 'u' });
  assert.deepEqual(await new GitHub(t, 'o/r').comment(12, 'y'), { id: 1, html_url: 'u' }, 'GitHub.comment の経路は通る');
  assert.equal(inner.calls.length, 2);

  const denied: [string, string][] = [
    ['GET', '/repos/o/r/issues/1/comments'],
    ['PATCH', '/repos/o/r/issues/comments/5'],
    ['DELETE', '/repos/o/r/issues/comments/5'],
    ['POST', '/repos/o/r/issues/1/labels'],
    ['DELETE', '/repos/o/r/issues/1/labels/agent%3Aplan-review'],
    ['PATCH', '/repos/o/r/issues/1'],
    ['PUT', '/repos/o/r/pulls/1/merge'],
    ['POST', '/repos/o/r/pulls/1/comments'],
    ['POST', '/repos/x/y/issues/1/comments'],
    ['POST', '/repos/o/r/issues/abc/comments'],
    ['POST', '/repos/o/r/issues/1/comments/extra'],
    ['POST', '/repos/o/r/issues/1/comments?x=1'],
    ['POST', '/graphql'],
  ];
  for (const [method, path] of denied) {
    await assert.rejects(t.request(method, path, { body: { body: 'x', query: 'mutation { x }' } }), `${method} ${path}`);
  }
  assert.equal(inner.calls.length, 2, '拒んだ要求は inner に届かない');
});
