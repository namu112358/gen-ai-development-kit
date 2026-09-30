/**
 * 人が「進める」と決めた記録（```agent-decision の proceed）の受け付けを確かめる（Issue #365、harness/gates/plan-decision.ts と on-comment.ts）。
 * コラボレーターの proceed の決定のコメントには、Jev に問わず、jev.decisionRelease（off・shadow・enforce）に依らず、App が kind=plan-proceed の記録を Issue に付けること、
 * ラベルを変えず plan-decision の記録も付けないこと、対象外なら status: ineligible と理由を残すこと、同じ決定への2回目は何も書かないことを、偽の GitHub と偽の Jev で確かめる。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, critiqueClaim, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';
import { postedBodies, postedRecord } from './support/stack-fixtures.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const P = Date.parse('2026-09-27T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const PLAN_AT = P;
const GATE_AT = P + 20_000;
const DECISION_AT = P + 3_600_000;

/** Planner が人の判断が必要と申告した計画 */
const plan: Plan = {
  version: 1, issue: 3, risk: 'low', needsHuman: true, needsHumanReasons: ['既定値を決める'], acChangeProposed: false,
  openQuestions: ['shadow から始めるか'], files: ['docs/a.md'], critique: CRITIQUE,
};

const planBodyOf = (p: unknown) => `${CLAUDE_MARK}\n## 計画\n\n${renderBlock('agent-plan', p)}`;
const PLAN_BODY = planBodyOf(plan);

function comment(id: number, body: string, createdAt: number, login: string) {
  return {
    id, body, html_url: `c${id}`, created_at: iso(createdAt), updated_at: iso(createdAt),
    author_association: login === APP ? 'NONE' : 'OWNER', user: { login, type: login === APP ? 'Bot' : 'User' },
  };
}

const appRecord = (id: number, kind: string, record: unknown, createdAt: number) => comment(id, `${appMark(kind)}\n記録\n${renderBlock('agent-app', record)}`, createdAt, APP);

/** 計画コメント（id 80）と、Planner の申告による停止の記録（id 90） */
function stoppedPlan(p: Plan = plan, body = planBodyOf(p)) {
  return [
    comment(80, body, PLAN_AT, 'me'),
    appRecord(90, 'plan-gate', { version: 1, planCommentId: 80, planBodySha256: sha256(planBodyOf(p)), pass: false, reasons: ['Planner が人間の判断が必要と申告しています'], plan: p, planReviewOrigin: 'planner' }, GATE_AT),
  ];
}

const labeled = (at: number, login = 'me') => ({ event: 'labeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });
/** post-plan が投稿の直前に付けた印 */
const byPostPlan = [labeled(PLAN_AT - 30_000)];

const proceedRaw = (patch: Record<string, unknown> = {}) => ({
  version: 1, issue: 3, planCommentId: 80, proceed: { choice: '進める', quote: 'このまま進めてください', at: '2026-09-27T10:00:00+09:00' }, ...patch,
});

function decisionEvent(raw: unknown, opts: { id?: number; association?: string } = {}) {
  return {
    action: 'created',
    issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'agent:plan-review' }], state: 'open' },
    comment: {
      id: opts.id ?? 100,
      body: `${CLAUDE_MARK}\n## 人の決定\n\n進める\n\n${renderBlock('agent-decision', raw)}`,
      html_url: 'https://example.test/decision',
      author_association: opts.association ?? 'OWNER', created_at: iso(DECISION_AT), updated_at: iso(DECISION_AT), user: { login: 'me', type: 'User' },
    },
  };
}

/** Issue #3 のコメントと events を差し替えた偽の GitHub */
function world(comments: { id: number }[], events: unknown[]): FakeGitHub {
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => [critiqueClaim(), ...comments])
    .on('GET', /\/issues\/3\/events/, () => events)
    .on('GET', /\/issues\/3\/timeline/, () => events)
    .on('GET', /\/issues\/comments\/(\d+)$/, (m) => {
      const found = comments.find((c) => c.id === Number(m[1]));
      if (!found) throw new Error(`404 comments/${m[1]}`);
      return found;
    })
    .on('GET', /\/issues\/3$/, () => ({ number: 3, state: 'open', body: '', labels: [{ name: 'agent:ready' }, { name: 'agent:plan-review' }] }));
}

/** 呼ばれたら数える偽の Jev */
function fakeJev() {
  const requests: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    requests.push(request);
    const answers = Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: 'noul', noul: 0.99 }]));
    return { status: 'ok', model: 'jev-test', answers };
  };
  return { requests, fn };
}

const cfg = (decisionRelease: 'off' | 'shadow' | 'enforce'): HarnessConfig => ({ ...config, jev: { ...config.jev, decisionRelease } });

const MODES = ['off', 'shadow', 'enforce'] as const;

const labelWrites = (fake: FakeGitHub) => fake.writes().filter((w) => w.startsWith('label'));

async function send(fake: FakeGitHub, mode: (typeof MODES)[number], event = decisionEvent(proceedRaw())) {
  const jev = fakeJev();
  await onComment(ctxFor(fake, 'issue_comment', event, { config: cfg(mode), secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return jev;
}

for (const mode of MODES) {
  test(`proceed（decisionRelease: ${mode}）：Jev に問わず、App が plan-proceed（ok）の記録を付け、ラベルは変えない`, async () => {
    const fake = world(stoppedPlan(), byPostPlan);
    const jev = await send(fake, mode);
    assert.equal(jev.requests.length, 0, 'Jev を呼ばない');
    assert.deepEqual(fake.writes(), ['comment:plan-proceed'], 'plan-proceed の記録だけを書く（ラベル・計画ゲートの判定し直し・plan-decision の記録は無い）');
    assert.deepEqual(labelWrites(fake), []);
    assert.deepEqual(postedBodies(fake, 'plan-decision'), [], 'plan-decision の記録は付けない');
    const r = postedRecord(fake, 'plan-proceed');
    assert.equal(r.version, 1);
    assert.equal(r.decisionCommentId, 100);
    assert.equal(r.planCommentId, 80);
    assert.equal(r.planBodySha256, sha256(PLAN_BODY), 'ok のときは計画コメントの本文の sha256');
    assert.equal(r.status, 'ok');
    assert.ok(r.reasons === undefined || (Array.isArray(r.reasons) && r.reasons.length === 0), JSON.stringify(r.reasons));
  });
}

test('proceed：記録は Issue に付ける（PR には付けない）', async () => {
  const fake = world(stoppedPlan(), byPostPlan);
  await send(fake, 'shadow');
  const posts = fake.calls.filter((c) => c.method === 'POST' && /\/comments$/.test(c.path));
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.path, /\/issues\/3\/comments$/);
});

const ineligibleCases: [string, { comments: { id: number }[]; events: unknown[]; raw?: unknown }][] = [
  ['計画コメントがゲートの後に編集された', { comments: stoppedPlan(plan, `${PLAN_BODY}\n追記`), events: byPostPlan }],
  ['窓の外で人が付けた印', { comments: stoppedPlan(), events: [labeled(PLAN_AT - 86_400_000)] }],
  ['AC の変更提案がある', { comments: stoppedPlan({ ...plan, acChangeProposed: true }), events: byPostPlan }],
  ['決定の planCommentId が記録と違う', { comments: stoppedPlan(), events: byPostPlan, raw: proceedRaw({ planCommentId: 81 }) }],
  ['計画ゲートの記録が無い', { comments: [comment(80, PLAN_BODY, PLAN_AT, 'me')], events: byPostPlan }],
];

for (const [name, c] of ineligibleCases) {
  test(`proceed の対象外：${name} → status: ineligible と理由を残し、Jev に問わず、ラベルを変えない`, async () => {
    const fake = world(c.comments, c.events);
    const jev = await send(fake, 'enforce', decisionEvent(c.raw ?? proceedRaw()));
    assert.equal(jev.requests.length, 0);
    assert.deepEqual(fake.writes(), ['comment:plan-proceed']);
    const r = postedRecord(fake, 'plan-proceed');
    assert.equal(r.version, 1);
    assert.equal(r.decisionCommentId, 100);
    assert.equal(r.status, 'ineligible');
    assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0, JSON.stringify(r.reasons));
  });
}

test('proceed：同じ決定のコメントに plan-proceed の記録があれば、何も書かない', async () => {
  const prior = appRecord(110, 'plan-proceed', { version: 1, decisionCommentId: 100, planCommentId: 80, planBodySha256: sha256(PLAN_BODY), status: 'ok' }, DECISION_AT + 5000);
  const fake = world([...stoppedPlan(), prior], byPostPlan);
  const jev = await send(fake, 'enforce');
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), []);
});

test('proceed：コラボレーター以外が書いた記録は無視する', async () => {
  const fake = world(stoppedPlan(), byPostPlan);
  const jev = await send(fake, 'enforce', decisionEvent(proceedRaw(), { association: 'NONE' }));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), []);
});
