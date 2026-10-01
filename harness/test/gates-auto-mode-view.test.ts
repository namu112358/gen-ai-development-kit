// auto mode の危険の問いで、見解（authorView）のある計画・PR は Jev に見解なし・ありの2回を問い、保留するかは見解なしの確率だけで決め、
// 両方の確率を記録に残して同じ計画コメント・patch-id では問い直さないことを、askPlanJev・askPrJev の単体と、偽の GitHub を通した計画ゲート・判定の受け付けで確かめる（Issue #426）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, planBodyWithoutView } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import type { Verdict } from '../lib/verdict.ts';
import { askPlanJev, askPrJev } from '../gates/auto-mode.ts';
import { onComment, reviewAutoModePlans } from '../gates/on-comment.ts';
import {
  APP, CRITIQUE, DIFF, FakeGitHub, acceptanceFake, config as base, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, pr, verdict, verdictEvent, type DelegateWorld,
} from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, postedRecord } from './support/stack-fixtures.ts';

/** 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };
const AUTO = autoModeConfig(config).label;
/** ガードレールに当たり、delegateMergeExclude に当たらない files（計画ゲートで止まり、auto mode の判定に回る） */
const GUARDED = 'harness/lib/epic.ts';
/** ガードレールにも delegateMergeExclude にも当たる（判定の受け付けで自動 Merge の対象にならない） */
const CONFIG_FILE = 'harness.config.json';
const VIEW = 'VIEW-426：テストを足すだけで、安全装置は弱めません。';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

type Answer = number | 'error';

/** 偽の Jev。見解なし（state に author_view が無い）と見解ありで別の答えを返し、呼ばれた要求を残す */
function fakeJev(noView: Answer, withView: Answer = noView) {
  const asked: { state: Record<string, any>; questions: Record<string, any> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: Record<string, any>; questions: Record<string, any> });
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    const answer = 'author_view' in (request.state as object) ? withView : noView;
    if (answer === 'error') return { status: 'error', detail: 'HTTP 500' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  const plain = () => asked.filter((r) => !('author_view' in r.state));
  const viewed = () => asked.filter((r) => 'author_view' in r.state);
  return { asked, fn, plain, viewed };
}

const ctxWith = (jev: ReturnType<typeof fakeJev>, key = true) => ctxFor(new FakeGitHub(), 'issue_comment', {}, { config, secrets: key ? { jevApiKey: 'jev-key' } : {}, askJev: jev.fn });

// ---- askPlanJev・askPrJev の単体 ----

test('askPlanJev：見解があれば見解なし・ありの2回を問い、yes は見解なし、withView に見解ありの確率が入る', async () => {
  const jev = fakeJev(0.5, 0.01);
  const rec = await askPlanJev(ctxWith(jev), 'plan body', [GUARDED], VIEW);
  assert.equal(jev.asked.length, 2, 'Jev に2回問う');
  assert.equal(jev.plain().length, 1, '見解なしの問いが1回');
  assert.equal(jev.viewed().length, 1, '見解ありの問いが1回');
  assert.equal(jev.viewed()[0]!.state.author_view, VIEW);
  assert.equal(jev.plain()[0]!.state.plan, 'plan body');
  assert.equal(jev.viewed()[0]!.state.plan, 'plan body');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.yes, 0.5, 'yes は見解なしの確率');
  assert.equal(rec.questionSet, AUTO_MODE_JEV_QUESTION_SET);
  assert.equal(rec.withView?.status, 'ok');
  assert.equal(rec.withView?.yes, 0.01, 'withView.yes は見解ありの確率');
});

test('askPlanJev：見解が無ければ1回だけ問い（state に author_view が無い）、withView が無い', async () => {
  const jev = fakeJev(0.02);
  const rec = await askPlanJev(ctxWith(jev), 'plan body', [GUARDED]);
  assert.equal(jev.asked.length, 1);
  assert.ok(!('author_view' in jev.asked[0]!.state));
  assert.equal(rec.status, 'ok');
  assert.equal(rec.yes, 0.02);
  assert.equal(rec.withView, undefined);
});

test('askPlanJev：見解なしが error・鍵なし（skipped）なら見解ありは問わず、withView が無い', async () => {
  const error = fakeJev('error', 0.01);
  const rec = await askPlanJev(ctxWith(error), 'plan body', [GUARDED], VIEW);
  assert.equal(rec.status, 'error');
  assert.equal(error.asked.length, 1, '見解なしの1回だけ');
  assert.equal(error.viewed().length, 0, '見解ありを問った');
  assert.equal(rec.withView, undefined);

  const noKey = fakeJev(0.01);
  const skipped = await askPlanJev(ctxWith(noKey, false), 'plan body', [GUARDED], VIEW);
  assert.equal(skipped.status, 'skipped');
  assert.equal(noKey.asked.length, 0);
  assert.equal(skipped.withView, undefined);
});

test('askPlanJev：見解ありの問いが error なら、withView.status が error で、yes（見解なし）は残る', async () => {
  const jev = fakeJev(0.03, 'error');
  const rec = await askPlanJev(ctxWith(jev), 'plan body', [GUARDED], VIEW);
  assert.equal(jev.asked.length, 2);
  assert.equal(rec.status, 'ok');
  assert.equal(rec.yes, 0.03);
  assert.equal(rec.withView?.status, 'error');
  assert.equal(rec.withView?.yes, undefined);
});

test('askPrJev：見解があれば2回問い、yes は見解なし・withView.yes は見解ありの確率。見解が無ければ1回だけ', async () => {
  const two = fakeJev(0.01, 0.7);
  const rec = await askPrJev(ctxWith(two), DIFF, [CONFIG_FILE], VIEW);
  assert.equal(two.asked.length, 2);
  assert.equal(two.viewed()[0]!.state.author_view, VIEW);
  assert.equal(two.viewed()[0]!.state.diff, DIFF);
  assert.equal(rec.yes, 0.01);
  assert.equal(rec.withView?.status, 'ok');
  assert.equal(rec.withView?.yes, 0.7);

  const one = fakeJev(0.04);
  const plain = await askPrJev(ctxWith(one), DIFF, [CONFIG_FILE]);
  assert.equal(one.asked.length, 1);
  assert.ok(!('author_view' in one.asked[0]!.state));
  assert.equal(plain.yes, 0.04);
  assert.equal(plain.withView, undefined);
});

test('askPrJev：見解なしが error・diff が大きすぎる（skipped）なら見解ありは問わない', async () => {
  const error = fakeJev('error', 0.01);
  const rec = await askPrJev(ctxWith(error), DIFF, [CONFIG_FILE], VIEW);
  assert.equal(rec.status, 'error');
  assert.equal(error.asked.length, 1);
  assert.equal(rec.withView, undefined);

  const small: HarnessConfig = { ...config, jev: { ...config.jev, maxDiffChars: 10 } };
  const big = fakeJev(0.01);
  const skipped = await askPrJev(ctxFor(new FakeGitHub(), 'issue_comment', {}, { config: small, secrets: { jevApiKey: 'jev-key' }, askJev: big.fn }), DIFF, [CONFIG_FILE], VIEW);
  assert.equal(skipped.status, 'skipped');
  assert.equal(big.asked.length, 0);
  assert.equal(skipped.withView, undefined);
});

// ---- 計画ゲート（onComment → onPlan） ----

const planOf = (issue: number, patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE, ...patch,
});

let nextCommentId = 9400;

function planComment(plan: Plan) {
  const id = nextCommentId++;
  return { id, created_at: '2026-09-30T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
}

const planEvent = (issue: number, labels: string[], comment: ReturnType<typeof planComment>) => ({
  action: 'created', issue: { number: issue, labels: labels.map((name) => ({ name })), state: 'open' }, comment,
});

function autoWorld(): DelegateWorld {
  return { prs: [], dashboardLabels: [AUTO], dashboardEvents: [delegateLabeled(AUTO, minutesAgo(10), 'me')] };
}

async function postPlan(w: DelegateWorld, plan: Plan, jev: ReturnType<typeof fakeJev>, comment = planComment(plan)) {
  const n = plan.issue;
  (w.issues ??= {})[n] = [LABELS.ready];
  (w.comments ??= {})[n] ??= [critiqueClaim()];
  const fake = delegateWorldFake(w);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(n, [LABELS.ready], comment), { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return { fake, comment };
}

function lastGateRecord(fake: FakeGitHub, n: number): Record<string, any> {
  const body = fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`) && String(c.body.body).includes(appMark('plan-gate'))).map((c) => String(c.body.body)).at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok);
  return block.value as Record<string, any>;
}

const addedPlanOk = (fake: FakeGitHub, n: number) => fake.calls.some((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/labels`) && (c.body.labels as string[]).includes(LABELS.planOk));

test('計画ゲート：見解のある計画は2回問い、見解ありが安全でも見解なしが危険なら保留し、両方の確率が記録に残る', async () => {
  const jev = fakeJev(0.5, 0.01);
  const { fake } = await postPlan(autoWorld(), planOf(81, { authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2, 'Jev に2回問う');
  assert.ok(!addedPlanOk(fake, 81), '見解ありの確率で通した');
  const rec = lastGateRecord(fake, 81);
  assert.equal(rec.pass, false);
  assert.equal(rec.autoMode?.hold, true);
  assert.equal(rec.autoMode?.jev.yes, 0.5);
  assert.equal(rec.autoMode?.jev.withView?.status, 'ok');
  assert.equal(rec.autoMode?.jev.withView?.yes, 0.01);
});

test('計画ゲート：見解ありが危険でも見解なしが安全なら通す（保留しない）', async () => {
  const jev = fakeJev(0.01, 0.6);
  const { fake } = await postPlan(autoWorld(), planOf(82, { authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2);
  assert.ok(addedPlanOk(fake, 82), '見解ありの確率で保留した');
  const rec = lastGateRecord(fake, 82);
  assert.equal(rec.pass, true);
  assert.equal(rec.autoMode?.hold, false);
  assert.equal(rec.autoMode?.jev.yes, 0.01);
  assert.equal(rec.autoMode?.jev.withView?.yes, 0.6);
});

test('計画ゲート：Jev に渡す計画の本文には authorView が入らず、見解は見解ありの問いの author_view にだけ入る', async () => {
  const jev = fakeJev(0.01, 0.01);
  const { comment } = await postPlan(autoWorld(), planOf(83, { authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2);
  for (const r of jev.asked) {
    assert.equal(r.state.plan, planBodyWithoutView(comment.body), '本文は planBodyWithoutView 済みのもの');
    assert.ok(!String(r.state.plan).includes('authorView'), '本文に authorView が残っている');
    assert.ok(!String(r.state.plan).includes(VIEW), '本文に見解の文が残っている');
  }
  assert.equal(jev.viewed()[0]!.state.author_view, VIEW);
});

test('計画ゲート：同じ計画コメントの2回目の判定では、withView ごと前の記録を使い回して問い直さない', async () => {
  const w = autoWorld();
  const jev = fakeJev(0.5, 0.01);
  const first = await postPlan(w, planOf(84, { authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2);
  const firstRec = lastGateRecord(first.fake, 84);
  const second = await postPlan(w, planOf(84, { authorView: VIEW }), jev, first.comment);
  assert.equal(jev.asked.length, 2, '2回目に問い直した');
  const rec = lastGateRecord(second.fake, 84);
  assert.deepEqual(rec.autoMode?.jev, firstRec.autoMode?.jev, '使い回した記録が前と違う');
  assert.equal(rec.autoMode?.jev.withView?.yes, 0.01);
});

test('計画ゲート：見解の無い計画は今までどおり1回だけ問い、記録に withView が無く、本文はそのまま渡す', async () => {
  const jev = fakeJev(0.01);
  const { fake, comment } = await postPlan(autoWorld(), planOf(85), jev);
  assert.equal(jev.asked.length, 1);
  assert.ok(!('author_view' in jev.asked[0]!.state));
  assert.equal(jev.asked[0]!.state.plan, comment.body);
  const rec = lastGateRecord(fake, 85);
  assert.equal(rec.autoMode?.jev.status, 'ok');
  assert.equal(rec.autoMode?.jev.withView, undefined);
});

test('計画ゲート：見解なしが error なら見解ありは問わず、保留する', async () => {
  const jev = fakeJev('error', 0.01);
  const { fake } = await postPlan(autoWorld(), planOf(86, { authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 1);
  assert.equal(jev.viewed().length, 0);
  const rec = lastGateRecord(fake, 86);
  assert.equal(rec.autoMode?.hold, true);
  assert.equal(rec.autoMode?.jev.status, 'error');
  assert.equal(rec.autoMode?.jev.withView, undefined);
});

// ---- auto mode の判定し直し（reviewAutoModePlans） ----

test('判定し直し：見解のある止まった計画は2回問い、見解なしが安全なら（見解ありが危険でも）通し、withView を記録に残す', async () => {
  const w = autoWorld();
  const n = 87;
  const plan = planOf(n, { authorView: VIEW });
  const comment = planComment(plan);
  const record = { version: 1, planCommentId: comment.id, planBodySha256: sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'gate', plan };
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [critiqueClaim(), comment, appRecordComment(nextCommentId++, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record)];
  (w.issueEvents ??= {})[n] = [{ event: 'labeled', created_at: '2026-09-30T00:01:00Z', actor: { login: APP }, label: { name: LABELS.planReview } }];
  const fake = delegateWorldFake(w);
  const jev = fakeJev(0.01, 0.6);
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }), new Date());
  assert.equal(jev.asked.length, 2, 'Jev に2回問う');
  for (const r of jev.asked) assert.ok(!String(r.state.plan).includes('authorView'), '本文に authorView が残っている');
  assert.ok(w.issues[n]!.includes(LABELS.planOk), `plan-ok が無い: ${w.issues[n]!.join(',')}`);
  const rec = lastGateRecord(fake, n);
  assert.equal(rec.autoMode?.hold, false);
  assert.equal(rec.autoMode?.jev.yes, 0.01);
  assert.equal(rec.autoMode?.jev.withView?.yes, 0.6);
});

// ---- 判定の受け付け（onComment → buildAcceptance） ----

const critical = (patch: Partial<Verdict> = {}) => verdict({ risk: { ...verdict().risk, level: 'critical' }, ...patch });

const planGate = (files: string[]) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } })}`,
});

function verdictFake(prComments: unknown[] = []): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: [], prComments })
    .on('GET', /\/issues\/3\/comments/, () => [planGate([CONFIG_FILE])])
    .on('GET', /\/pulls\/5\/files/, () => [{ filename: CONFIG_FILE, additions: 1, deletions: 1 }])
    .on('GET', /\/issues\/5\/events/, () => []);
}

async function accept(fake: FakeGitHub, v: Verdict, jev: ReturnType<typeof fakeJev>): Promise<Record<string, any>> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return postedRecord(fake, 'acceptance');
}

test('判定の受け付け：見解のある PR は2回問い、見解ありが安全でも見解なしが危険なら eligible が偽で、両方の確率が記録に残る', async () => {
  const jev = fakeJev(0.5, 0.01);
  const a = await accept(verdictFake(), critical({ authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2);
  assert.equal(jev.viewed()[0]!.state.author_view, VIEW);
  assert.equal(jev.plain()[0]!.state.diff, DIFF);
  assert.equal(a.autoMode?.eligible, false);
  assert.equal(a.autoMode?.jev?.yes, 0.5);
  assert.equal(a.autoMode?.jev?.withView?.status, 'ok');
  assert.equal(a.autoMode?.jev?.withView?.yes, 0.01);
});

test('判定の受け付け：見解ありが危険でも見解なしが安全なら eligible が真', async () => {
  const jev = fakeJev(0.01, 0.6);
  const a = await accept(verdictFake(), critical({ authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 2);
  assert.equal(a.autoMode?.eligible, true, (a.autoMode?.reasons ?? []).join(' / '));
  assert.equal(a.autoMode?.jev?.yes, 0.01);
  assert.equal(a.autoMode?.jev?.withView?.yes, 0.6);
});

test('判定の受け付け：見解の無い PR は今までどおり1回だけ問い、記録に withView が無い', async () => {
  const jev = fakeJev(0.01);
  const a = await accept(verdictFake(), critical(), jev);
  assert.equal(jev.asked.length, 1);
  assert.ok(!('author_view' in jev.asked[0]!.state));
  assert.equal(a.autoMode?.jev?.withView, undefined);
});

test('判定の受け付け：同じ patch-id の前の受け付けがあれば、withView ごと使い回して問い直さない', async () => {
  const jevRec = { status: 'ok', detail: 'jev-prev', yes: 0.5, questionSet: AUTO_MODE_JEV_QUESTION_SET, withView: { status: 'ok', detail: 'jev-prev', yes: 0.01 } };
  const previous = acceptanceComment(91, { autoMode: { eligible: false, reasons: [], skipped: [], jev: jevRec } });
  const jev = fakeJev(0.01, 0.01);
  const a = await accept(verdictFake([previous]), critical({ authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 0, '問い直した');
  assert.deepEqual(a.autoMode?.jev, jevRec);
  assert.equal(a.autoMode?.eligible, false, '使い回した見解なしの確率（危険）で保留する');
});

test('判定の受け付け：見解なしが error なら見解ありは問わない', async () => {
  const jev = fakeJev('error', 0.01);
  const a = await accept(verdictFake(), critical({ authorView: VIEW }), jev);
  assert.equal(jev.asked.length, 1);
  assert.equal(a.autoMode?.jev?.status, 'error');
  assert.equal(a.autoMode?.jev?.withView, undefined);
  assert.equal(a.autoMode?.eligible, false);
});
