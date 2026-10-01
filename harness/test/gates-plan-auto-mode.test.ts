// auto mode の間、計画コメントの計画ゲート（onComment → onPlan）が、飛ばせる理由だけで止まる計画を Jev の危険の判定で通す・保留にする動作を、偽の GitHub と偽の Jev で確かめる（Issue #345）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, CRITIQUE, DELEGATE, config, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';

const AUTO = autoModeConfig(config).label;
/** ガードレールに当たり、delegateMergeExclude に当たらない files */
const GUARDED = 'harness/lib/epic.ts';
/** ガードレールにも delegateMergeExclude にも当たる files */
const EXCLUDED = 'harness/gates/on-comment.ts';
const GUARD_REASON = (f: string) => `ガードレールに触れます（人が実装して Merge する）: ${f}`;

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const planOf = (issue: number, patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE, ...patch,
});

let nextCommentId = 7000;

/** 人（OWNER）の計画コメント */
function planComment(plan: Plan) {
  const id = nextCommentId++;
  return { id, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
}

const planEvent = (issue: number, labels: string[], comment: ReturnType<typeof planComment>) => ({
  action: 'created',
  issue: { number: issue, labels: labels.map((name) => ({ name })), state: 'open' },
  comment,
});

const planReviewLabeled = (login: string) => ({ event: 'labeled', created_at: '2026-09-28T00:01:00Z', actor: { login }, label: { name: LABELS.planReview } });

/** 偽の Jev。危険の問い（danger）にだけ答え、呼ばれた要求を残す */
function fakeJev(answer: number | 'error' | 'no-answer') {
  const asked: { state: any; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: any; questions: Record<string, unknown> });
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    if (answer === 'error') return { status: 'error', detail: 'HTTP 500' };
    if (answer === 'no-answer') return { status: 'ok', model: 'jev-test', answers: {} };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return { asked, fn };
}

/** auto mode のラベルを付けた世界（既定は人 me が付けた）。extra でほかのラベル（委任・停止スイッチ）を足す */
function autoWorld(o: { at?: string; login?: string; extra?: string[]; delegateAt?: string } = {}): DelegateWorld {
  const at = o.at ?? minutesAgo(10);
  const extra = o.extra ?? [];
  return {
    prs: [],
    dashboardLabels: [AUTO, ...extra],
    dashboardEvents: [delegateLabeled(AUTO, at, o.login ?? 'me'), ...extra.filter((l) => l === DELEGATE.planLabel || l === DELEGATE.mergeLabel).map((l) => delegateLabeled(l, o.delegateAt ?? at))],
  };
}

/** 計画コメントを投稿してゲートを通す。comment を渡すと同じコメントでもう一度判定する */
async function postPlan(
  w: DelegateWorld,
  plan: Plan,
  o: { n?: number; labels?: string[]; events?: unknown[]; jev?: ReturnType<typeof fakeJev>; key?: boolean; comment?: ReturnType<typeof planComment>; claim?: boolean } = {},
): Promise<{ fake: FakeGitHub; comment: ReturnType<typeof planComment> }> {
  const n = o.n ?? plan.issue;
  const labels = o.labels ?? [LABELS.ready];
  (w.issues ??= {})[n] = [...labels];
  (w.comments ??= {})[n] ??= o.claim === false ? [] : [critiqueClaim()];
  if (o.events) (w.issueEvents ??= {})[n] = o.events;
  const fake = delegateWorldFake(w);
  const comment = o.comment ?? planComment(plan);
  const extra = { secrets: o.key === false ? {} : { jevApiKey: 'jev-key' }, ...(o.jev ? { askJev: o.jev.fn } : {}) };
  await onComment(ctxFor(fake, 'issue_comment', planEvent(n, labels, comment), extra));
  return { fake, comment };
}

function postsOn(fake: FakeGitHub, n: number, kind?: string): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`) && (kind === undefined || String(c.body.body).includes(appMark(kind))))
    .map((c) => String(c.body.body));
}

function labelWrites(fake: FakeGitHub, n: number): string[] {
  return fake.calls
    .filter((c) => (c.method === 'POST' && c.path.endsWith(`/issues/${n}/labels`)) || (c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)))
    .map((c) => (c.method === 'POST' ? `+${(c.body.labels as string[]).join(',')}` : `-${decodeURIComponent(c.path.split('/labels/')[1]!)}`));
}

function lastGateRecord(fake: FakeGitHub, n: number): Record<string, any> {
  const body = postsOn(fake, n, 'plan-gate').at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `#${n} の plan-gate の記録を読めません`);
  return block.value as Record<string, any>;
}

const added = (fake: FakeGitHub, n: number, label: string) => labelWrites(fake, n).some((x) => x.startsWith('+') && x.split(',').some((l) => l.replace(/^\+/, '') === label));

function assertAutoPassed(fake: FakeGitHub, n: number, skipped: RegExp[]): Record<string, any> {
  assert.ok(added(fake, n, LABELS.planOk), `plan-ok を付けていない: ${labelWrites(fake, n).join(' ')}`);
  assert.ok(!added(fake, n, LABELS.planReview), `plan-review を付けた: ${labelWrites(fake, n).join(' ')}`);
  const rec = lastGateRecord(fake, n);
  assert.equal(rec.pass, true);
  assert.deepEqual(rec.reasons, []);
  assert.equal(rec.delegated, undefined, 'auto mode で通した記録に delegated がある');
  assert.ok(rec.autoMode, '記録に autoMode が無い');
  assert.equal(rec.autoMode.hold, false);
  assert.equal(rec.autoMode.label, AUTO);
  assert.equal(rec.autoMode.by, 'me');
  assert.equal(rec.autoMode.jev.status, 'ok');
  const body = postsOn(fake, n, 'plan-gate').at(-1)!;
  assert.ok(body.includes(AUTO), `本文に auto mode のラベルが無い:\n${body}`);
  for (const re of skipped) {
    assert.ok((rec.autoMode.skipped as string[]).some((s) => re.test(s)), `記録の skipped に ${re} が無い: ${rec.autoMode.skipped.join(' / ')}`);
    assert.match(body, re, `本文に飛ばした理由 ${re} が無い`);
  }
  return rec;
}

function assertStopped(fake: FakeGitHub, n: number): Record<string, any> {
  assert.ok(!added(fake, n, LABELS.planOk), `plan-ok を付けた: ${labelWrites(fake, n).join(' ')}`);
  const rec = lastGateRecord(fake, n);
  assert.equal(rec.pass, false);
  return rec;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- AC1：飛ばせる理由だけで止まる計画を、Jev が安全と答えれば通す ----

test('AC1：auto mode の間、ガードレールだけで止まる計画に Jev が安全と答えれば plan-ok を付け、記録とコメントに auto mode と飛ばした理由を残す', async () => {
  const at = minutesAgo(10);
  const jev = fakeJev(0.01);
  const { fake, comment } = await postPlan(autoWorld({ at }), planOf(41), { jev });
  const rec = assertAutoPassed(fake, 41, [new RegExp(escape(GUARD_REASON(GUARDED)))]);
  assert.equal(Date.parse(rec.autoMode.since), Date.parse(at));
  assert.equal(rec.autoMode.jev.yes, 0.01);
  assert.equal(jev.asked.length, 1, 'Jev に1回だけ問う');
  assert.equal(jev.asked[0]!.state.plan, comment.body, 'Jev には計画コメントの本文を渡す');
  assert.deepEqual(jev.asked[0]!.state.files, [GUARDED]);
});

test('AC1：delegateMergeExclude・harness.config.json に重なる計画も、Jev が安全なら通し、委任では通さない理由も飛ばした理由に残す', async () => {
  for (const file of [EXCLUDED, 'harness.config.json']) {
    const jev = fakeJev(0.02);
    const { fake } = await postPlan(autoWorld(), planOf(42, { files: [file] }), { jev });
    assertAutoPassed(fake, 42, [new RegExp(escape(GUARD_REASON(file))), new RegExp(`delegateMergeExclude[^\\n]*${escape(file)}`)]);
    assert.equal(jev.asked.length, 1, file);
  }
});

test('AC1：想定 Risk critical だけで止まる計画も、Jev が安全なら通す', async () => {
  const jev = fakeJev(0.05);
  const { fake } = await postPlan(autoWorld(), planOf(43, { risk: 'critical', files: ['docs/a.md'] }), { jev });
  assertAutoPassed(fake, 43, [/想定 Risk が critical です/]);
});

// ---- AC2：Jev が危険・記録が無いなら保留 ----

test('AC2：Jev が危険と答えた計画は agent:plan-review になり、記録の autoMode.hold が真で、Jev の1行がコメントに出る', async () => {
  const jev = fakeJev(0.5);
  const { fake } = await postPlan(autoWorld(), planOf(44, { files: [EXCLUDED] }), { jev });
  const rec = assertStopped(fake, 44);
  assert.ok(added(fake, 44, LABELS.planReview), 'plan-review を付けていない');
  assert.equal(rec.planReviewOrigin, 'gate');
  assert.equal(rec.autoMode?.hold, true);
  assert.equal(rec.autoMode?.jev.status, 'ok');
  assert.equal(rec.autoMode?.jev.yes, 0.5);
  const body = postsOn(fake, 44, 'plan-gate').at(-1)!;
  assert.ok(body.includes(AUTO), `本文に auto mode のラベルが無い:\n${body}`);
  assert.match(body, /Jev：危険の確率/, `本文に Jev の1行が無い:\n${body}`);
});

test('AC2：安全側の確率が下限（0.9）ちょうど未満なら保留、ちょうどなら通す', async () => {
  const hold = await postPlan(autoWorld(), planOf(45), { jev: fakeJev(0.11) });
  assert.equal(assertStopped(hold.fake, 45).autoMode?.hold, true);
  const pass = await postPlan(autoWorld(), planOf(45), { jev: fakeJev(0.1) });
  assertAutoPassed(pass.fake, 45, []);
});

test('AC2：判定の記録が無い（鍵なし＝skipped・error・答えが無い）計画は agent:plan-review になり、理由がコメントに出る', async () => {
  const cases: [string, { key?: boolean; jev?: ReturnType<typeof fakeJev> }, string, RegExp][] = [
    ['鍵なし', { key: false, jev: fakeJev(0.01) }, 'skipped', /JEV_API_KEY/],
    ['error', { jev: fakeJev('error') }, 'error', /HTTP 500/],
    ['答えが無い', { jev: fakeJev('no-answer') }, 'ok', /Jev：危険の確率が読めない/],
  ];
  for (const [name, o, status, reason] of cases) {
    const { fake } = await postPlan(autoWorld(), planOf(46), o);
    const rec = assertStopped(fake, 46);
    assert.ok(added(fake, 46, LABELS.planReview), `${name}: plan-review を付けていない`);
    assert.equal(rec.autoMode?.hold, true, name);
    assert.equal(rec.autoMode?.jev.status, status, name);
    assert.match(postsOn(fake, 46, 'plan-gate').at(-1)!, reason, `${name}: コメントに理由が無い`);
    if (name === '鍵なし') assert.equal(o.jev!.asked.length, 0, '鍵が無ければ Jev に問わない');
  }
});

// ---- AC3：Planner の申告・人の印・批評の関所・files の欠落は auto mode でも止まる ----

test('AC3：Planner の申告（needsHuman・openQuestions・acChangeProposed）と files の欠落は、auto mode でも止まり Jev に問わない', async () => {
  const cases: [string, Plan][] = [
    ['needsHuman', planOf(47, { needsHuman: true, needsHumanReasons: ['r'] })],
    ['openQuestions', planOf(47, { openQuestions: ['?'] })],
    ['acChangeProposed', planOf(47, { acChangeProposed: true })],
    ['files の欠落', planOf(47, { risk: 'high', files: [] })],
  ];
  for (const [name, plan] of cases) {
    const jev = fakeJev(0.01);
    const { fake } = await postPlan(autoWorld(), plan, { jev });
    const rec = assertStopped(fake, 47);
    assert.ok(added(fake, 47, LABELS.planReview), `${name}: plan-review を付けていない`);
    assert.equal(rec.autoMode, undefined, `${name}: 記録に autoMode がある`);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
  }
});

test('AC3：人が付けた agent:plan-review がある Issue は、auto mode でも止まり、人の印を外さず Jev に問わない', async () => {
  const jev = fakeJev(0.01);
  const { fake } = await postPlan(autoWorld(), planOf(48), { jev, labels: [LABELS.ready, LABELS.planReview], events: [planReviewLabeled('me')] });
  const rec = assertStopped(fake, 48);
  assert.ok(!labelWrites(fake, 48).includes(`-${LABELS.planReview}`), '人の印を外した');
  assert.equal(rec.autoMode, undefined);
  assert.equal(jev.asked.length, 0);
});

test('AC3：批評の関所（critique が無い・plan-critique の着手宣言が無い）に当たる計画は、auto mode でも止まり Jev に問わない', async () => {
  const noCritique = planOf(49);
  delete noCritique.critique;
  const cases: [string, Plan, boolean][] = [
    ['critique が無い', noCritique, true],
    ['着手宣言が無い', planOf(49), false],
  ];
  for (const [name, plan, claim] of cases) {
    const jev = fakeJev(0.01);
    const { fake } = await postPlan(autoWorld(), plan, { jev, claim });
    const rec = assertStopped(fake, 49);
    assert.ok(added(fake, 49, LABELS.planReview), `${name}: plan-review を付けていない`);
    assert.equal(rec.autoMode, undefined, name);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
  }
});

// ---- 委任との順番・auto mode が効かないとき ----

test('委任で通る計画は委任で通り、auto mode の記録にならず Jev に問わない', async () => {
  const jev = fakeJev(0.9);
  const { fake } = await postPlan(autoWorld({ extra: [DELEGATE.planLabel] }), planOf(50), { jev });
  assert.ok(added(fake, 50, LABELS.planOk), 'plan-ok を付けていない');
  const rec = lastGateRecord(fake, 50);
  assert.equal(rec.pass, true);
  assert.ok(rec.delegated, '記録に delegated が無い');
  assert.equal(rec.autoMode, undefined);
  assert.equal(jev.asked.length, 0);
});

test('委任で通らない（delegateMergeExclude に重なる）計画は、委任の間でも auto mode で判定する', async () => {
  const jev = fakeJev(0.01);
  const { fake } = await postPlan(autoWorld({ extra: [DELEGATE.mergeLabel] }), planOf(51, { files: [EXCLUDED] }), { jev });
  const rec = assertAutoPassed(fake, 51, [new RegExp(escape(GUARD_REASON(EXCLUDED)))]);
  assert.equal(rec.delegated, undefined);
  assert.equal(jev.asked.length, 1);
});

test('auto mode のラベルが無い・人以外（App・bot）が付けた・停止スイッチがあるときは auto mode で通らず、Jev に問わない', async () => {
  const worlds: [string, DelegateWorld][] = [
    ['ラベルが無い', { prs: [], dashboardLabels: [], dashboardEvents: [] }],
    ['App', autoWorld({ login: APP })],
    ['bot', autoWorld({ login: 'someone[bot]' })],
    ['停止スイッチ', autoWorld({ extra: [config.autoMergeStopLabel] })],
  ];
  for (const [name, w] of worlds) {
    const jev = fakeJev(0.01);
    const { fake } = await postPlan(w, planOf(52), { jev });
    const rec = assertStopped(fake, 52);
    assert.ok(added(fake, 52, LABELS.planReview), `${name}: plan-review を付けていない`);
    assert.equal(rec.autoMode, undefined, `${name}: 記録に autoMode がある`);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
  }
});

test('ゲートを通る計画は、auto mode の間でも Jev に問わず autoMode の記録にならない', async () => {
  const jev = fakeJev(0.9);
  const { fake } = await postPlan(autoWorld(), planOf(53, { files: ['docs/a.md'] }), { jev });
  const rec = lastGateRecord(fake, 53);
  assert.equal(rec.pass, true);
  assert.equal(rec.autoMode, undefined);
  assert.equal(jev.asked.length, 0);
});

// ---- Jev の記録の使い回し ----

test('同じ計画コメント（同じ本文）の2回目の判定では、前の plan-gate の記録の autoMode.jev（ok）を使い回して Jev に問わない', async () => {
  for (const answer of [0.01, 0.5]) {
    const w = autoWorld();
    const jev = fakeJev(answer);
    const first = await postPlan(w, planOf(54), { jev });
    assert.equal(jev.asked.length, 1);
    const firstRec = lastGateRecord(first.fake, 54);
    const second = await postPlan(w, planOf(54), { jev, comment: first.comment });
    assert.equal(jev.asked.length, 1, `${answer}: 2回目にも Jev に問った`);
    const rec = lastGateRecord(second.fake, 54);
    assert.deepEqual(rec.autoMode?.jev, firstRec.autoMode?.jev, `${answer}: 使い回した記録が前と違う`);
    assert.equal(rec.pass, firstRec.pass, answer.toString());
  }
});

test('前の記録が error なら使い回さず、2回目にもう一度 Jev に問う', async () => {
  const w = autoWorld();
  const first = await postPlan(w, planOf(55), { jev: fakeJev('error') });
  assert.equal(lastGateRecord(first.fake, 55).autoMode?.jev.status, 'error');
  const jev = fakeJev(0.01);
  const second = await postPlan(w, planOf(55), { jev, comment: first.comment });
  assert.equal(jev.asked.length, 1);
  assertAutoPassed(second.fake, 55, []);
});
