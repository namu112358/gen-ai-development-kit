// auto mode の判定し直し（reviewAutoModePlans）が、ゲートの停止で止まった計画を Jev が安全なら通し、保留・対象外の計画には何も書かない動作を、偽の GitHub と偽の Jev で確かめる（Issue #345）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, type AutoModeJevRecord, type AutoModeState } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { reviewAutoModePlans } from '../gates/on-comment.ts';
import { APP, CRITIQUE, config, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment } from './support/stack-fixtures.ts';

const AUTO = autoModeConfig(config).label;
const GUARDED = 'harness/lib/epic.ts';
const EXCLUDED = 'harness/gates/on-comment.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const planOf = (issue: number, patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE, ...patch,
});

let nextCommentId = 8000;

/** 人（OWNER）の計画コメント。本文の印（SAFE・DANGER）で偽の Jev の答えを決める */
function planComment(plan: Plan, marker: 'SAFE' | 'DANGER') {
  const id = nextCommentId++;
  return { id, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です（${marker}）。\n\n${renderBlock('agent-plan', plan)}` };
}

const planReviewLabeled = (login: string, at = '2026-09-28T00:01:00Z') => ({ event: 'labeled', created_at: at, actor: { login }, label: { name: LABELS.planReview } });

const jevOk = (yes: number): AutoModeJevRecord => ({ status: 'ok', detail: 'jev-test', yes, questionSet: AUTO_MODE_JEV_QUESTION_SET });

interface StopOptions {
  marker?: 'SAFE' | 'DANGER';
  origin?: 'gate' | 'planner';
  sha?: string;
  events?: unknown[];
  claim?: boolean;
  /** 停止の記録に残す auto mode の記録（無ければ auto mode の記録の無い古い停止） */
  autoMode?: { jev: AutoModeJevRecord; hold: boolean };
}

/** 世界に、App のゲートの停止で止まった Issue を足す */
function addStopped(w: DelegateWorld, n: number, plan: Plan, o: StopOptions = {}): void {
  const comment = planComment(plan, o.marker ?? 'SAFE');
  const record: Record<string, unknown> = {
    version: 1, planCommentId: comment.id, planBodySha256: o.sha ?? sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: o.origin ?? 'gate', plan,
  };
  if (o.autoMode) record.autoMode = { skipped: ['s'], label: AUTO, by: 'me', since: minutesAgo(30), jev: o.autoMode.jev, hold: o.autoMode.hold, reasons: ['Jev：…'] };
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [...(o.claim === false ? [] : [critiqueClaim()]), comment, appRecordComment(nextCommentId++, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record)];
  (w.issueEvents ??= {})[n] = o.events ?? [planReviewLabeled(APP)];
}

/** 偽の Jev。計画の本文の印で答える（SAFE は 0.01、DANGER は 0.6）。問った計画の issue を残す */
function fakeJev() {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const plan = String((request.state as { plan?: string }).plan ?? '');
    asked.push(plan);
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: plan.includes('DANGER') ? 0.6 : 0.01 } } as any };
  };
  return { asked, fn };
}

const askedIssue = (asked: string[], n: number) => asked.filter((p) => p.includes(`"issue": ${n}`) || p.includes(`"issue":${n}`)).length;

function postsOn(fake: FakeGitHub, n: number): string[] {
  return fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`)).map((c) => String(c.body.body));
}

function labelWrites(fake: FakeGitHub, n: number): string[] {
  return fake.calls
    .filter((c) => (c.method === 'POST' && c.path.endsWith(`/issues/${n}/labels`)) || (c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)))
    .map((c) => (c.method === 'POST' ? `+${(c.body.labels as string[]).join(',')}` : `-${decodeURIComponent(c.path.split('/labels/')[1]!)}`));
}

function lastGateRecord(fake: FakeGitHub, n: number): Record<string, any> {
  const body = postsOn(fake, n).filter((b) => b.includes(appMark('plan-gate'))).at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok);
  return block.value as Record<string, any>;
}

function autoWorld(labels: string[] = [AUTO], login = 'me'): DelegateWorld {
  return { prs: [], dashboardLabels: [...labels], dashboardEvents: labels.includes(AUTO) ? [delegateLabeled(AUTO, minutesAgo(10), login)] : [] };
}

/**
 * 止まった Issue の世界：
 * #61 ガードレールだけ・Jev 安全 → 通す、#62 Risk critical だけ・Jev 安全 → 通す、#63 exclude・Jev 安全 → 通す、
 * #64 前の記録の Jev が skipped（鍵なしで保留）→ 問い直して安全なら通す、
 * #71 auto mode の記録の無い古い停止・Jev 危険、#72 autoMode の保留の記録（Jev ok・危険）がある停止 → 何も書かない、
 * #73 批評の関所、#74 Planner の申告、#75 人が最後に agent:plan-review を付けた、#76 本文が変わった → 判定し直さず Jev にも問わない
 */
function stoppedWorld(labels: string[] = [AUTO]): DelegateWorld {
  const w = autoWorld(labels);
  addStopped(w, 61, planOf(61));
  addStopped(w, 62, planOf(62, { risk: 'critical', files: ['docs/a.md'] }));
  addStopped(w, 63, planOf(63, { files: [EXCLUDED] }));
  addStopped(w, 64, planOf(64), { autoMode: { jev: { status: 'skipped', detail: 'JEV_API_KEY が未設定', questionSet: AUTO_MODE_JEV_QUESTION_SET }, hold: true } });
  addStopped(w, 71, planOf(71), { marker: 'DANGER' });
  addStopped(w, 72, planOf(72), { marker: 'SAFE', autoMode: { jev: jevOk(0.6), hold: true } });
  const noCritique = planOf(73);
  delete noCritique.critique;
  addStopped(w, 73, noCritique);
  addStopped(w, 74, planOf(74, { needsHuman: true, needsHumanReasons: ['r'] }), { origin: 'planner' });
  addStopped(w, 75, planOf(75), { events: [planReviewLabeled(APP), planReviewLabeled('me', '2026-09-28T02:00:00Z')] });
  addStopped(w, 76, planOf(76), { sha: sha256('別の本文') });
  return w;
}

const RELEASED = [61, 62, 63, 64];
const HELD = [71, 72];
const SKIPPED = [73, 74, 75, 76];

const withJev = (jev: ReturnType<typeof fakeJev>) => ({ secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });

function assertUntouched(fake: FakeGitHub, w: DelegateWorld, numbers: number[], name = ''): void {
  for (const n of numbers) {
    assert.deepEqual(postsOn(fake, n), [], `${name}#${n}: コメントを増やした`);
    assert.deepEqual(labelWrites(fake, n), [], `${name}#${n}: ラベルを変えた`);
    assert.ok(w.issues![n]!.includes(LABELS.planReview), `${name}#${n}: plan-review が外れた`);
  }
}

test('AC1・AC4：ゲートの停止で止まった計画を、Jev が安全なら通し（plan-review を外して plan-ok）、記録に auto mode を残す', async () => {
  const w = stoppedWorld();
  const fake = delegateWorldFake(w);
  const jev = fakeJev();
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(jev)), new Date());
  for (const n of RELEASED) {
    assert.ok(w.issues![n]!.includes(LABELS.planOk), `#${n}: plan-ok が無い: ${w.issues![n]!.join(',')}`);
    assert.ok(!w.issues![n]!.includes(LABELS.planReview), `#${n}: plan-review が残っている`);
    const rec = lastGateRecord(fake, n);
    assert.equal(rec.pass, true, `#${n}`);
    assert.equal(rec.autoMode?.hold, false, `#${n}`);
    assert.equal(rec.autoMode?.jev.status, 'ok', `#${n}`);
    assert.equal(askedIssue(jev.asked, n), 1, `#${n}: Jev に1回だけ問う（判定し直しの中で問い直さない）`);
  }
});

test('AC4：Jev が保留と答えた計画（auto mode の記録の無い古い停止も、保留の記録がある停止も）には何も書かない', async () => {
  const w = stoppedWorld();
  const fake = delegateWorldFake(w);
  const jev = fakeJev();
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(jev)), new Date());
  assertUntouched(fake, w, HELD);
  assert.equal(askedIssue(jev.asked, 71), 1, '#71: 古い停止は Jev に問う');
  assert.equal(askedIssue(jev.asked, 72), 0, '#72: 同じ本文の ok の記録は使い回して問い直さない');
});

test('AC3・AC4：批評の関所・Planner の申告・人が最後に付けた agent:plan-review・本文が変わった計画は判定し直さず、Jev にも問わない', async () => {
  const w = stoppedWorld();
  const fake = delegateWorldFake(w);
  const jev = fakeJev();
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(jev)), new Date());
  assertUntouched(fake, w, SKIPPED);
  for (const n of SKIPPED) assert.equal(askedIssue(jev.asked, n), 0, `#${n}: Jev に問った`);
});

test('AC4：鍵が無ければ（Jev の記録が skipped）どの計画も通さず、何も書かない', async () => {
  const w = stoppedWorld();
  const fake = delegateWorldFake(w);
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}), new Date());
  assertUntouched(fake, w, [...RELEASED, ...HELD, ...SKIPPED]);
});

test('auto mode が無効（ラベルが無い・人以外が付けた・停止スイッチ・無効の状態を渡した）なら何もしない', async () => {
  const off: AutoModeState = { active: false, since: null, by: null, reason: 'ラベルが無い' };
  const cases: [string, DelegateWorld, AutoModeState | undefined][] = [
    ['ラベルが無い', stoppedWorld([]), undefined],
    ['停止スイッチ', stoppedWorld([AUTO, config.autoMergeStopLabel]), undefined],
    ['無効の状態を渡した', stoppedWorld(), off],
  ];
  const bot = stoppedWorld();
  bot.dashboardEvents = [delegateLabeled(AUTO, minutesAgo(10), APP)];
  cases.push(['App が付けた', bot, undefined]);
  for (const [name, w, state] of cases) {
    const fake = delegateWorldFake(w);
    const jev = fakeJev();
    await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(jev)), new Date(), state);
    assert.deepEqual(fake.writes(), [], `${name}: 書き込んだ`);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
  }
});

test('有効の状態を渡せば、ダッシュボードに auto mode のラベルが無くても、渡した状態で判定し直す', async () => {
  const on: AutoModeState = { active: true, since: minutesAgo(5), by: 'me', reason: '@me が付けています' };
  const w = stoppedWorld([]);
  const fake = delegateWorldFake(w);
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(fakeJev())), new Date(), on);
  assert.ok(w.issues![61]!.includes(LABELS.planOk), '#61: plan-ok が無い');
  assert.equal(lastGateRecord(fake, 61).autoMode?.by, 'me');
});

test('2回目の判定し直しでは、通した計画にも保留の計画にもコメントを増やさない', async () => {
  const w = stoppedWorld();
  const fake = delegateWorldFake(w);
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(fakeJev())), new Date());
  const before = fake.calls.length;
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, withJev(fakeJev())), new Date());
  const again = fake.calls.slice(before);
  for (const n of [...RELEASED, ...HELD, ...SKIPPED]) {
    assert.ok(!again.some((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`)), `#${n}: 2回目にコメントした`);
  }
});
