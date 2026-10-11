// auto mode で files が前に保留した計画と同じ出し直しを Jev に問い直さずに保留のままにする動作を、偽の GitHub と偽の Jev で確かめる（Issue #680）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, type AutoModeJevRecord } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment, reviewAutoModePlans } from '../gates/on-comment.ts';
import { APP, CRITIQUE, config, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment } from './support/stack-fixtures.ts';

const AUTO = autoModeConfig(config).label;
/** ガードレールに当たる（delegateMergeExclude に当たらない）file と、どちらにも当たらない file */
const GUARDED = 'harness/lib/epic.ts';
const PLAIN = 'docs/a.md';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const planOf = (issue: number, files: string[]): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files, critique: CRITIQUE,
});

let nextCommentId = 9000;

/** 人（OWNER）の計画コメント。wording で本文の言い回しを変える */
function planComment(plan: Plan, wording: string) {
  const id = nextCommentId++;
  return { id, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `${wording}\n\n${renderBlock('agent-plan', plan)}` };
}
type PlanComment = ReturnType<typeof planComment>;

const jevOk = (yes: number): AutoModeJevRecord => ({ status: 'ok', detail: 'jev-test', yes, questionSet: AUTO_MODE_JEV_QUESTION_SET });

/** App の計画ゲートの停止の記録（autoMode を渡せば auto mode の判定の記録も残す） */
function gateStop(comment: PlanComment, plan: Plan, autoMode?: { jev: AutoModeJevRecord; hold: boolean; inheritedFrom?: { planCommentId: number } }) {
  const record: Record<string, unknown> = {
    version: 1, planCommentId: comment.id, planBodySha256: sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'gate', plan,
  };
  if (autoMode) record.autoMode = { skipped: ['s'], label: AUTO, by: 'me', since: minutesAgo(30), reasons: ['Jev：…'], ...autoMode };
  return appRecordComment(nextCommentId++, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record);
}

const planReviewLabeled = (login: string) => ({ event: 'labeled', created_at: '2026-09-28T00:01:00Z', actor: { login }, label: { name: LABELS.planReview } });

/** 偽の Jev。危険の問いに 0.01（安全）を答え、呼ばれた回数を数える（問い直せば通るので、引き継がなかったことも分かる） */
function fakeJev() {
  const asked: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request);
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: 0.01 } } as any };
  };
  return { asked, fn };
}

/** auto mode のラベルを人（me）が付けた世界 */
function autoWorld(): DelegateWorld {
  return { prs: [], dashboardLabels: [AUTO], dashboardEvents: [delegateLabeled(AUTO, minutesAgo(10), 'me')] };
}

/** 前に保留した計画（計画コメントと App の停止の記録）を置き、App が agent:plan-review を付けた Issue にする */
function withPriorHold(w: DelegateWorld, n: number, files: string[], jev: AutoModeJevRecord): PlanComment {
  const plan = planOf(n, files);
  const prior = planComment(plan, '前の計画です。');
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [critiqueClaim(), prior, gateStop(prior, plan, { jev, hold: true })];
  (w.issueEvents ??= {})[n] = [planReviewLabeled(APP)];
  return prior;
}

/** 計画コメントを投稿してゲートを通す */
async function postPlan(w: DelegateWorld, n: number, plan: Plan, jev: ReturnType<typeof fakeJev>): Promise<{ fake: FakeGitHub; comment: PlanComment }> {
  const fake = delegateWorldFake(w);
  const comment = planComment(plan, '言い回しを変えて出し直した計画です。');
  const event = { action: 'created', issue: { number: n, labels: w.issues![n]!.map((name) => ({ name })), state: 'open' }, comment };
  await onComment(ctxFor(fake, 'issue_comment', event, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return { fake, comment };
}

function postsOn(fake: FakeGitHub, n: number): string[] {
  return fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`)).map((c) => String(c.body.body));
}

function labelWrites(fake: FakeGitHub, n: number): string[] {
  return fake.calls
    .filter((c) => (c.method === 'POST' && c.path.endsWith(`/issues/${n}/labels`)) || (c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)))
    .map((c) => (c.method === 'POST' ? `+${(c.body.labels as string[]).join(',')}` : `-${decodeURIComponent(c.path.split('/labels/')[1]!)}`));
}

const added = (fake: FakeGitHub, n: number, label: string) => labelWrites(fake, n).some((x) => x.startsWith('+') && x.slice(1).split(',').includes(label));

function lastGate(fake: FakeGitHub, n: number): { body: string; rec: Record<string, any> } {
  const body = postsOn(fake, n).filter((b) => b.includes(appMark('plan-gate'))).at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `#${n} の plan-gate の記録を読めません`);
  return { body, rec: block.value as Record<string, any> };
}

// ---- AC1：files が前に保留した計画と同じ出し直しは Jev を呼ばずに止まる ----

test('AC1：files が前に保留した計画と集合として同じ出し直しは、言い回しを変えても Jev に問わず agent:plan-review で止まり、記録に引き継いだ計画コメントが残る', async () => {
  const w = autoWorld();
  const prior = withPriorHold(w, 81, [GUARDED, PLAIN], { ...jevOk(0.6), withView: { status: 'ok', yes: 0.7 } });
  const jev = fakeJev();
  const { fake } = await postPlan(w, 81, planOf(81, [PLAIN, GUARDED, PLAIN]), jev);
  assert.equal(jev.asked.length, 0, 'Jev に問い直した');
  assert.ok(!added(fake, 81, LABELS.planOk), `plan-ok を付けた: ${labelWrites(fake, 81).join(' ')}`);
  assert.ok(added(fake, 81, LABELS.planReview), `plan-review を付けていない: ${labelWrites(fake, 81).join(' ')}`);
  const { body, rec } = lastGate(fake, 81);
  assert.equal(rec.pass, false);
  assert.equal(rec.autoMode?.hold, true);
  assert.deepEqual(rec.autoMode?.inheritedFrom, { planCommentId: prior.id });
  assert.equal(rec.autoMode?.jev.status, 'ok');
  assert.equal(rec.autoMode?.jev.yes, 0.6);
  assert.equal(rec.autoMode?.jev.withView, undefined, '見解ありの記録を写した');
  assert.ok(body.includes(prior.html_url), `停止のコメントに前の計画コメントのリンクが無い:\n${body}`);
});

// ---- AC2：files が違う・前の保留が skipped・error なら問い直す ----

test('AC2：files が違う出し直し、前の保留の Jev が skipped・error だった出し直しは、Jev に問い直して引き継がない', async () => {
  const cases: [string, string[], AutoModeJevRecord][] = [
    ['files が違う', [GUARDED], jevOk(0.6)],
    ['前の保留が skipped', [GUARDED, PLAIN], { status: 'skipped', detail: 'JEV_API_KEY が未設定', questionSet: AUTO_MODE_JEV_QUESTION_SET }],
    ['前の保留が error', [GUARDED, PLAIN], { status: 'error', detail: 'HTTP 500', questionSet: AUTO_MODE_JEV_QUESTION_SET }],
  ];
  for (const [name, files, priorJev] of cases) {
    const w = autoWorld();
    withPriorHold(w, 82, [GUARDED, PLAIN], priorJev);
    const jev = fakeJev();
    const { fake } = await postPlan(w, 82, planOf(82, files), jev);
    assert.equal(jev.asked.length, 1, `${name}: Jev に問い直していない`);
    const { rec } = lastGate(fake, 82);
    assert.equal(rec.autoMode?.inheritedFrom, undefined, `${name}: 保留を引き継いだ`);
    assert.equal(rec.pass, true, `${name}: 問い直して安全なのに通していない`);
  }
});

// ---- AC3：auto mode を付けたときの判定し直しでも止まったまま ----

/** 最新の停止の記録（autoMode を渡さなければ auto mode の前のゲートの停止）の前に、files が同じ保留の記録がある Issue を置く */
function stoppedAfterHold(w: DelegateWorld, n: number, latestAutoMode?: (prior: PlanComment) => { jev: AutoModeJevRecord; hold: boolean; inheritedFrom?: { planCommentId: number } }): void {
  const prior = withPriorHold(w, n, [GUARDED, PLAIN], jevOk(0.6));
  const plan = planOf(n, [PLAIN, GUARDED]);
  const current = planComment(plan, '言い回しを変えて出し直した計画です。');
  w.comments![n]!.push(current, gateStop(current, plan, latestAutoMode?.(prior)));
}

test('AC3：auto mode を付けたときの判定し直しでも、files が前に保留した計画と同じ計画は Jev に問わず、コメントもラベルも書かない', async () => {
  const w = autoWorld();
  stoppedAfterHold(w, 83);
  const fake = delegateWorldFake(w);
  const jev = fakeJev();
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }), new Date());
  assert.equal(jev.asked.length, 0, 'Jev に問い直した');
  assert.deepEqual(postsOn(fake, 83), [], 'コメントを増やした');
  assert.deepEqual(labelWrites(fake, 83), [], 'ラベルを変えた');
  assert.ok(w.issues![83]!.includes(LABELS.planReview), 'plan-review が外れた');
});

test('引き継いで止まった記録は使い回さず、保留の線を緩めて元の保留が保留でなくなれば、今の計画を Jev に問い直す', async () => {
  const w = autoWorld();
  stoppedAfterHold(w, 84, (prior) => ({ jev: jevOk(0.6), hold: true, inheritedFrom: { planCommentId: prior.id } }));
  const fake = delegateWorldFake(w);
  const jev = fakeJev();
  const relaxed = { ...config, autoMode: { ...config.autoMode, jev: { ...config.autoMode?.jev, dangerSafe: 0.3 } } } as HarnessConfig;
  await reviewAutoModePlans(ctxFor(fake, 'schedule', {}, { config: relaxed, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }), new Date());
  assert.equal(jev.asked.length, 1, '引き継いだ記録を使い回して、今の計画を Jev に問わなかった');
});
