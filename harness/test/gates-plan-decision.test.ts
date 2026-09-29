/**
 * 決定の記録（```agent-decision）で App が Planner の申告の停止を外す経路のテスト（Issue #151、harness/gates/plan-decision.ts と on-comment.ts）。
 * shadow は Jev の判定を plan-decision の記録に残すだけでラベルを変えないこと、enforce はしきい値以上で計画ゲートの判定をやり直し
 * （通れば agent:plan-review を外して agent:plan-ok、ガードレールに当たれば gate の停止として残す）、未満なら足りない項目をコメントすること、
 * App の停止・人が付けた印・AC の変更提案・編集された計画などは Jev に問わずラベルも変えないことを、偽の GitHub と偽の Jev で確かめる。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, critiqueClaim, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const P = Date.parse('2026-09-27T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
/** 計画コメント（id 80）の created_at と、その計画ゲートの記録（id 90）の created_at */
const PLAN_AT = P;
const GATE_AT = P + 20_000;
const DECISION_AT = P + 3_600_000;

/** 申告付きの計画（理由1件・質問1件）。答えればガードレールに触れず通る */
const plan: Plan = {
  version: 1, issue: 3, risk: 'low', needsHuman: true, needsHumanReasons: ['既定値を決める'], acChangeProposed: false,
  openQuestions: ['shadow から始めるか'], files: ['docs/a.md'], critique: CRITIQUE,
};

const planBodyOf = (p: unknown) => `${CLAUDE_MARK}\n## 計画\n\n${renderBlock('agent-plan', p)}`;

function comment(id: number, body: string, createdAt: number, login: string) {
  return {
    id, body, html_url: `c${id}`, created_at: iso(createdAt), updated_at: iso(createdAt),
    author_association: login === APP ? 'NONE' : 'OWNER', user: { login, type: login === APP ? 'Bot' : 'User' },
  };
}

const appRecord = (id: number, kind: string, record: unknown, createdAt: number) => comment(id, `${appMark(kind)}\n記録\n${renderBlock('agent-app', record)}`, createdAt, APP);

/** 計画コメントと、その計画の Planner の申告による停止の記録 */
function stoppedPlan(p: Plan = plan, record: Record<string, unknown> = {}, body = planBodyOf(p)) {
  return [
    comment(80, body, PLAN_AT, 'me'),
    appRecord(90, 'plan-gate', { version: 1, planCommentId: 80, planBodySha256: sha256(planBodyOf(p)), pass: false, reasons: ['Planner が人間の判断が必要と申告しています'], plan: p, planReviewOrigin: 'planner', ...record }, GATE_AT),
  ];
}

const labeled = (at: number, login = 'me') => ({ event: 'labeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });
const unlabeled = (at: number, login = 'me') => ({ event: 'unlabeled', created_at: iso(at), label: { name: 'agent:plan-review' }, actor: { login } });
/** post-plan が投稿の直前に付けた印 */
const byPostPlan = [labeled(PLAN_AT - 30_000)];

const answersFor = (p: Plan) => [
  ...p.needsHumanReasons.map((_, i) => ({ to: `reason:${i}`, quote: `理由 ${i} への答え`, at: '2026-09-27T10:00:00+09:00' })),
  ...p.openQuestions.map((_, i) => ({ to: `question:${i}`, choice: '進める', quote: `質問 ${i} への答え`, at: '2026-09-27T10:01:00+09:00' })),
];

const decisionRaw = (p: Plan = plan, patch: Record<string, unknown> = {}) => ({ version: 1, issue: 3, planCommentId: 80, answers: answersFor(p), ...patch });

function decisionEvent(raw: unknown, opts: { id?: number; labels?: string[]; body?: string } = {}) {
  return {
    action: 'created',
    issue: { number: 3, labels: (opts.labels ?? ['agent:ready', 'agent:plan-review']).map((name) => ({ name })), state: 'open' },
    comment: {
      id: opts.id ?? 100,
      body: opts.body ?? `${CLAUDE_MARK}\n## 人の決定\n\n要約\n\n${renderBlock('agent-decision', raw)}`,
      html_url: 'https://example.test/decision',
      author_association: 'OWNER', created_at: iso(DECISION_AT), updated_at: iso(DECISION_AT), user: { login: 'me', type: 'User' },
    },
  };
}

/** Issue #3 のコメントと events を差し替えた偽の GitHub（計画コメントより前に段階 plan-critique の宣言を置く。計画ゲートの批評の関所を通る） */
function world(comments: { id: number }[], events: unknown[], labels = ['agent:ready', 'agent:plan-review']): FakeGitHub {
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => [critiqueClaim(), ...comments])
    .on('GET', /\/issues\/3\/events/, () => events)
    .on('GET', /\/issues\/3\/timeline/, () => events)
    .on('GET', /\/issues\/comments\/(\d+)$/, (m) => {
      const found = comments.find((c) => c.id === Number(m[1]));
      if (!found) throw new Error(`404 comments/${m[1]}`);
      return found;
    })
    .on('GET', /\/issues\/3$/, () => ({ number: 3, state: 'open', body: '', labels: labels.map((name) => ({ name })) }));
}

/** 偽の Jev。問いごとの yes の確率（無ければ 0.95）を返し、受け取った要求を残す */
function fakeJev(p: Record<string, number> = {}, fail = false) {
  const requests: { state: any; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    requests.push(request as any);
    if (fail) return { status: 'error', detail: 'HTTP 500' };
    const answers = Object.fromEntries(Object.keys(request.questions).map((k) => [k, { type: 'noul', noul: p[k] ?? 0.95 }]));
    return { status: 'ok', model: 'jev-test', answers };
  };
  return { requests, fn };
}

const cfg = (decisionRelease?: 'off' | 'shadow' | 'enforce'): HarnessConfig => ({
  ...config,
  jev: { ...config.jev, ...(decisionRelease ? { decisionRelease } : {}), thresholds: { ...config.jev.thresholds, decisionProbability: 0.9 } },
});

const withJev = (jev: ReturnType<typeof fakeJev>, mode?: 'off' | 'shadow' | 'enforce', opts: { noKey?: boolean } = {}) => ({
  config: cfg(mode), secrets: { jevApiKey: opts.noKey ? undefined : 'jev-key' }, askJev: jev.fn,
});

const missingIds = (r: Record<string, any>) => (r.missing as { id: string }[]).map((m) => m.id);

function postedBodies(fake: FakeGitHub, kind: string): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments') && String(c.body.body).includes(`kind=${kind} `))
    .map((c) => String(c.body.body));
}

function postedRecord(fake: FakeGitHub, kind: string): Record<string, any> {
  const body = postedBodies(fake, kind).at(-1);
  assert.ok(body, `${kind} の記録を投稿する`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `${kind} の記録の agent-app ブロックを読める`);
  return block.value as Record<string, any>;
}

const labelWrites = (fake: FakeGitHub) => fake.writes().filter((w) => w.startsWith('label'));

// ---- AC2：shadow ----

test('shadow（既定）：Jev の判定を plan-decision の記録に残し、ラベルは変えない', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev)));
  assert.equal(jev.requests.length, 1, 'Jev に1回問う');
  assert.deepEqual(fake.writes(), ['comment:plan-decision'], 'ラベルの書き込みも計画ゲートの判定し直しも無い');
  const r = postedRecord(fake, 'plan-decision');
  assert.equal(r.version, 1);
  assert.equal(r.decisionCommentId, 100);
  assert.equal(r.planCommentId, 80);
  assert.equal(r.mode, 'shadow');
  assert.equal(r.questionSet, 1);
  assert.equal(r.threshold, 0.9);
  assert.equal(r.status, 'ok');
  assert.equal(r.model, 'jev-test');
  assert.deepEqual(r.answers, { all_answered: { yes: 0.95 }, item_reason_0: { yes: 0.95 }, item_question_0: { yes: 0.95 } }, 'flattenAnswers の形');
  assert.equal(r.pass, true);
  assert.deepEqual(r.missing, []);
  assert.equal(r.regate, false, 'shadow では判定し直さない');
  assert.match(postedBodies(fake, 'plan-decision')[0]!, /enforce/, 'enforce なら外すかを書く');
});

test('shadow：Jev の要求は App が集めた計画の写しの申告と答えだけ（本文・日時を渡さない）', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'shadow')));
  const state = jev.requests[0]!.state;
  assert.deepEqual(state.items.map((i: { id: string }) => i.id), ['reason:0', 'question:0']);
  assert.deepEqual(state.items.map((i: { text: string }) => i.text), ['既定値を決める', 'shadow から始めるか']);
  assert.ok(!JSON.stringify(state).includes('要約'), 'コメントの本文を渡さない');
  assert.ok(!JSON.stringify(state).includes('2026-09-27'), 'at を渡さない');
});

test('shadow：しきい値未満でもラベルは変えず、記録に pass: false と足りない項目を残す', async () => {
  const jev = fakeJev({ item_question_0: 0.3 });
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'shadow')));
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  const r = postedRecord(fake, 'plan-decision');
  assert.equal(r.pass, false);
  assert.deepEqual(missingIds(r), ['question:0']);
  assert.equal(r.missing[0].probability, 0.3);
  assert.equal(r.regate, false);
});

// ---- AC3：enforce ----

test('enforce・しきい値以上：agent:plan-review を外して agent:plan-ok を付け、plan-gate の記録に decisionCommentId を入れる', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  const writes = fake.writes();
  assert.ok(writes.includes('label-agent:plan-review'), 'Planner の申告の印を外す');
  assert.ok(writes.includes('label+agent:plan-ok'), '計画ゲートを通す');
  assert.ok(writes.includes('comment:plan-gate'), '計画ゲートの記録を書く');
  assert.ok(writes.indexOf('comment:plan-decision') < writes.indexOf('label-agent:plan-review'), '決定の記録を先に書く');
  assert.ok(writes.includes('check:agent/plan-link=success'), '判定し直した後に plan-link を書き直す');
  const d = postedRecord(fake, 'plan-decision');
  assert.equal(d.mode, 'enforce');
  assert.equal(d.pass, true);
  assert.equal(d.regate, true);
  const g = postedRecord(fake, 'plan-gate');
  assert.equal(g.pass, true);
  assert.equal(g.planCommentId, 80, '判定し直すのは記録の計画コメント');
  assert.equal(g.decisionCommentId, 100);
  assert.deepEqual(g.plan.openQuestions, ['shadow から始めるか'], '記録の plan は申告を含む元の計画');
  assert.equal(g.plan.needsHuman, true);
  assert.match(postedBodies(fake, 'plan-gate')[0]!, /人の決定の記録/);
  assert.match(postedBodies(fake, 'plan-gate')[0]!, /https:\/\/example\.test\/decision/, '決定の記録のコメントへのリンク');
});

test('enforce・しきい値未満：足りない項目（本文と確率）をコメントするだけで、ラベルは変えない', async () => {
  const jev = fakeJev({ item_reason_0: 0.42 });
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  const body = postedBodies(fake, 'plan-decision')[0]!;
  assert.match(body, /既定値を決める/, '足りない項目の本文');
  assert.match(body, /0\.42|42\s*%/, '足りない項目の確率');
  const r = postedRecord(fake, 'plan-decision');
  assert.equal(r.pass, false);
  assert.deepEqual(missingIds(r), ['reason:0']);
  assert.deepEqual(r.missing[0], { id: 'reason:0', text: '既定値を決める', probability: 0.42 });
  assert.equal(r.regate, false);
});

test('enforce：答えた計画がガードレールに当たれば、印は残り、新しい記録は gate の停止になる', async () => {
  const guarded: Plan = { ...plan, files: ['harness/lib/decision.ts'] };
  const jev = fakeJev();
  const fake = world(stoppedPlan(guarded), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw(guarded)), withJev(jev, 'enforce')));
  const writes = fake.writes();
  assert.ok(!writes.includes('label-agent:plan-review'), '印を外さない');
  assert.ok(!writes.includes('label+agent:plan-ok'), '通さない');
  const g = postedRecord(fake, 'plan-gate');
  assert.equal(g.pass, false);
  assert.equal(g.planReviewOrigin, 'gate', 'Planner の申告は答え済みなので App の停止');
  assert.equal(g.decisionCommentId, 100);
  assert.ok(!g.reasons.some((r: string) => /人が外す/.test(r)), '前の印を理由にしない');
});

// ---- AC4：対象外は Jev に問わず、ラベルを変えない ----

const olderPassRecord = [
  comment(70, planBodyOf({ ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] }), PLAN_AT - 7_200_000, 'me'),
  appRecord(71, 'plan-gate', { version: 1, planCommentId: 70, pass: true, reasons: [], plan: { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] } }, PLAN_AT - 7_180_000),
];

const ineligibleCases: [string, { comments: { id: number }[]; events: unknown[]; mode?: 'off' | 'shadow' | 'enforce'; raw?: unknown; labels?: string[] }][] = [
  ['App のゲートの停止（planReviewOrigin: gate）', { comments: stoppedPlan(plan, { planReviewOrigin: 'gate' }), events: [labeled(GATE_AT - 1000, APP)] }],
  ['人が付けた印：最初の計画より前から付いていた印が残ったまま Planner が申告した', { comments: stoppedPlan(), events: [labeled(PLAN_AT - 86_400_000)] }],
  ['人が付けた印：通過した記録の後に人が付け、申告付きの計画を出し直した', { comments: [...olderPassRecord, ...stoppedPlan()], events: [labeled(PLAN_AT - 600_000)] }],
  ['人が付けた印：計画ゲートの記録の後に人が外して付け直した', { comments: stoppedPlan(), events: [...byPostPlan, unlabeled(GATE_AT + 60_000), labeled(GATE_AT + 120_000)] }],
  ['AC の変更提案（acChangeProposed）', { comments: stoppedPlan({ ...plan, acChangeProposed: true }), events: byPostPlan, raw: decisionRaw({ ...plan, acChangeProposed: true }) }],
  ['決定の planCommentId が記録と違う', { comments: stoppedPlan(), events: byPostPlan, raw: decisionRaw(plan, { planCommentId: 81 }) }],
  ['計画コメントがゲートの後に編集された', { comments: stoppedPlan(plan, {}, `${planBodyOf(plan)}\n追記`), events: byPostPlan }],
  ['decisionRelease が off', { comments: stoppedPlan(), events: byPostPlan, mode: 'off' }],
  ['agent:plan-review が付いていない', { comments: stoppedPlan(), events: [...byPostPlan, unlabeled(GATE_AT + 60_000)], labels: ['agent:ready'] }],
  ['計画ゲートの記録が無い', { comments: [comment(80, planBodyOf(plan), PLAN_AT, 'me')], events: byPostPlan }],
];

for (const [name, c] of ineligibleCases) {
  for (const mode of c.mode ? [c.mode] : (['shadow', 'enforce'] as const)) {
    test(`対象外（${mode}）：${name} → Jev に問わず、ラベルを変えない`, async () => {
      const jev = fakeJev();
      const fake = world(c.comments, c.events, c.labels);
      await onComment(ctxFor(fake, 'issue_comment', decisionEvent(c.raw ?? decisionRaw(), { labels: c.labels }), withJev(jev, mode)));
      assert.equal(jev.requests.length, 0, 'Jev を呼ばない');
      assert.deepEqual(labelWrites(fake), [], 'ラベルを変えない');
      assert.ok(!fake.writes().includes('comment:plan-gate'), '計画ゲートの判定をやり直さない');
    });
  }
}

test('対象外：ineligible の記録に理由を残す', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(plan, { planReviewOrigin: 'gate' }), [labeled(GATE_AT - 1000, APP)]);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  const r = postedRecord(fake, 'plan-decision');
  assert.equal(r.status, 'ineligible');
  assert.equal(r.decisionCommentId, 100);
});

test('post-plan を使わずに申告付きの計画を投稿し、App が停止で印を付けた（記録の直前）場合も対象', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), [labeled(GATE_AT - 1000, APP)]);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 1);
  assert.ok(fake.writes().includes('label-agent:plan-review'));
});

// ---- 書式・答えの無い項目・再実行 ----

test('agent-plan と同じコメントの agent-decision は見ない（計画として判定する）', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  const body = `${planBodyOf({ ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] })}\n\n${renderBlock('agent-decision', decisionRaw())}`;
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(null, { body }), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(postedBodies(fake, 'plan-decision'), []);
  assert.ok(fake.writes().includes('comment:plan-gate'), '今までどおり計画ゲートが判定する');
});

test('答えの無い項目があれば Jev に問わず、invalid の記録で足りない項目を書く', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  const raw = decisionRaw(plan, { answers: answersFor(plan).filter((a) => a.to !== 'question:0') });
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(raw), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'invalid');
  assert.match(postedBodies(fake, 'plan-decision')[0]!, /question:0/);
});

test('存在しない添字への答えがあれば Jev に問わず invalid', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  const raw = decisionRaw(plan, { answers: [...answersFor(plan), { to: 'question:3', quote: 'x', at: '2026-09-27T01:00:00Z' }] });
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(raw), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'invalid');
  assert.match(postedBodies(fake, 'plan-decision')[0]!, /question:3/);
});

test('書式が不正なら Jev に問わず invalid、ラベルは変えない', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw(plan, { version: 2 })), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'invalid');
});

test('同じ決定のコメントに plan-decision の記録があれば、二度問わない', async () => {
  const jev = fakeJev();
  const prior = appRecord(110, 'plan-decision', { version: 1, decisionCommentId: 100, planCommentId: 80, mode: 'enforce', questionSet: 1, threshold: 0.9, status: 'ok', pass: false, missing: [{ id: 'reason:0', text: '既定値を決める', probability: 0.4 }], regate: false }, DECISION_AT + 5000);
  const fake = world([...stoppedPlan(), prior], byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(labelWrites(fake), []);
});

test('コラボレーター以外が書いた決定の記録は無視する', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  const event = decisionEvent(decisionRaw());
  event.comment.author_association = 'NONE';
  await onComment(ctxFor(fake, 'issue_comment', event, withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), []);
});

// ---- Jev を問えない・失敗 ----

test('Jev の鍵が無ければ skipped を記録し、ラベルは変えない', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce', { noKey: true })));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'skipped');
});

test('項目が 20 件を超えれば問わずに skipped', async () => {
  const many: Plan = { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: Array.from({ length: 21 }, (_, i) => `質問 ${i}`) };
  const jev = fakeJev();
  const fake = world(stoppedPlan(many), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw(many)), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'skipped');
});

test('答えの quote・choice の合計が 20000 文字を超えれば問わずに skipped', async () => {
  const jev = fakeJev();
  const fake = world(stoppedPlan(), byPostPlan);
  const answers = answersFor(plan).map((a) => ({ ...a, quote: 'あ'.repeat(10_001) }));
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw(plan, { answers })), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 0);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'skipped');
});

test('Jev の失敗は error として記録し、ラベルは変えない', async () => {
  const jev = fakeJev({}, true);
  const fake = world(stoppedPlan(), byPostPlan);
  await onComment(ctxFor(fake, 'issue_comment', decisionEvent(decisionRaw()), withJev(jev, 'enforce')));
  assert.equal(jev.requests.length, 1);
  assert.deepEqual(fake.writes(), ['comment:plan-decision']);
  assert.equal(postedRecord(fake, 'plan-decision').status, 'error');
});

// ---- workflow ----

test('gate.yml：issue_comment の if: が agent-decision のコメントでもゲートを起動する', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');
  assert.ok(yml.includes("contains(github.event.comment.body, '```agent-decision')"));
});
