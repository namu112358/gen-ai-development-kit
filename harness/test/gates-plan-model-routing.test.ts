// 計画ゲート（onComment → onPlan）が、jev.modelRouting が shadow・enforce のとき実装に勧めるモデル（Jev）と確率を plan-gate の記録の modelRouting に残し、
// ゲートの結果（ラベル・コメントの本文・書き込みの順）は off のときと変えないことを、偽の GitHub と偽の Jev で確かめる（Issue #139 の AC1）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { MODEL_ROUTING_QUESTION_SET } from '../lib/model-routing.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { CRITIQUE, config, critiqueClaim, ctxFor, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';

type Mode = 'off' | 'shadow' | 'enforce';

/** gate-fixtures の config（modelRouting は off）を写して、modelRouting だけ変える */
const withRouting = (mode: Mode): HarnessConfig => ({ ...config, jev: { ...config.jev, modelRouting: mode } }) as HarnessConfig;

const ISSUE_TITLE = 'feat(harness): 実装のモデルを振り分ける';
const ISSUE_BODY = '### Goal\n\n実装のモデルを Jev で振り分ける。';

const planOf = (issue: number, patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE, ...patch,
});

let nextCommentId = 8000;

/** 人（OWNER）の計画コメント。raw を渡すとその本文のまま */
function planComment(plan: Plan | null, raw?: string) {
  const id = nextCommentId++;
  const body = raw ?? `計画です。この本文は Jev に渡さない。\n\n${renderBlock('agent-plan', plan)}`;
  return { id, created_at: '2026-10-09T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: 'OWNER', user: { login: 'me', type: 'User' }, body };
}
type PlanComment = ReturnType<typeof planComment>;

const planEvent = (issue: number, labels: string[], comment: PlanComment) => ({
  action: 'created',
  issue: { number: issue, labels: labels.map((name) => ({ name })), state: 'open', title: ISSUE_TITLE, body: ISSUE_BODY },
  comment,
});

/** 偽の Jev。実装のモデルの問い（implementation_model）にだけ答え、呼ばれた要求を残す */
function fakeJev(answer: { opus: number; sonnet: number } | 'error' | 'throw') {
  const asked: { state: any; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: any; questions: Record<string, unknown> });
    if (answer === 'throw') throw new Error('network down');
    if (!Object.keys(request.questions).includes('implementation_model')) return { status: 'error', detail: '実装のモデルの問いではない' };
    if (answer === 'error') return { status: 'error', detail: 'HTTP 500' };
    return { status: 'ok', model: 'jev-test', answers: { implementation_model: { type: 'choice', choice: answer.opus >= answer.sonnet ? 'opus' : 'sonnet', probabilities: answer } } };
  };
  return { asked, fn };
}

/** 計画コメントを投稿してゲートを通す。w・comment を渡すと同じ世界・同じコメントでもう一度判定する */
async function postPlan(
  mode: Mode,
  plan: Plan | null,
  o: { n?: number; jev?: ReturnType<typeof fakeJev>; comment?: PlanComment; w?: DelegateWorld; claim?: boolean } = {},
): Promise<{ fake: FakeGitHub; comment: PlanComment; w: DelegateWorld }> {
  const n = o.n ?? plan?.issue ?? 60;
  const labels = ['agent:ready'];
  const w: DelegateWorld = o.w ?? { prs: [], dashboardLabels: [] };
  (w.issues ??= {})[n] ??= [...labels];
  (w.comments ??= {})[n] ??= o.claim === false ? [] : [critiqueClaim()];
  const fake = delegateWorldFake(w);
  const comment = o.comment ?? planComment(plan);
  const extra = { config: withRouting(mode), secrets: { jevApiKey: 'jev-key' }, ...(o.jev ? { askJev: o.jev.fn } : {}) };
  await onComment(ctxFor(fake, 'issue_comment', planEvent(n, labels, comment), extra));
  return { fake, comment, w };
}

function gatePosts(fake: FakeGitHub, n: number): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`) && String(c.body.body).includes(appMark('plan-gate')))
    .map((c) => String(c.body.body));
}

function lastGateRecord(fake: FakeGitHub, n: number): Record<string, any> {
  const body = gatePosts(fake, n).at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `#${n} の plan-gate の記録を読めません`);
  return block.value as Record<string, any>;
}

/** コメントの本文のうち、記録のブロック（```agent-app）より前 */
const textOf = (body: string): string => body.slice(0, body.indexOf('```agent-app'));

/** ゲートの結果：書き込みの並び（ラベル・コメントの種類）、コメントの本文（記録より前）、記録から modelRouting を除いたもの */
function outcome(fake: FakeGitHub, n: number) {
  const { modelRouting: _omit, ...record } = lastGateRecord(fake, n);
  return { writes: fake.writes(), text: textOf(gatePosts(fake, n).at(-1)!), record };
}

// ---- 勧めを記録に残し、ゲートの結果は off と同じ ----

test('AC1：shadow・enforce で通過する計画は、記録の modelRouting に勧め・確率・モードが入り、書き込み・本文・ほかの記録は off と同じ', async () => {
  for (const mode of ['shadow', 'enforce'] as const) {
    const plan = planOf(61);
    const off = await postPlan('off', plan);
    const jev = fakeJev({ opus: 0.2, sonnet: 0.8 });
    const on = await postPlan(mode, plan, { jev, comment: off.comment });
    const rec = lastGateRecord(on.fake, 61);
    assert.equal(rec.pass, true, mode);
    assert.equal(rec.modelRouting?.status, 'ok', mode);
    assert.equal(rec.modelRouting?.mode, mode);
    assert.equal(rec.modelRouting?.recommended, 'sonnet', mode);
    assert.deepEqual(rec.modelRouting?.probabilities, { opus: 0.2, sonnet: 0.8 }, mode);
    assert.equal(rec.modelRouting?.questionSet, MODEL_ROUTING_QUESTION_SET, mode);
    assert.equal(rec.modelRouting?.inputs?.fileCount, 1, mode);
    assert.deepEqual(outcome(on.fake, 61), outcome(off.fake, 61), `${mode}: ゲートの結果が off と違う`);
    assert.equal(lastGateRecord(off.fake, 61).modelRouting, undefined, 'off の記録に modelRouting がある');
    assert.equal(jev.asked.length, 1, `${mode}: Jev に1回だけ問う`);
  }
});

test('AC1：Jev には Issue のタイトルと本文・計画の files を渡し、計画コメントの本文は渡さない', async () => {
  const jev = fakeJev({ opus: 0.7, sonnet: 0.3 });
  const { comment } = await postPlan('shadow', planOf(62, { files: ['docs/a.md', 'harness/test/x.test.ts'] }), { jev });
  const state = jev.asked[0]!.state;
  assert.equal(state.issue_title, ISSUE_TITLE);
  assert.equal(state.issue_body, ISSUE_BODY);
  assert.deepEqual(state.planned_files, ['docs/a.md', 'harness/test/x.test.ts']);
  assert.ok(!JSON.stringify(state).includes('この本文は Jev に渡さない'), '計画コメントの本文を Jev に渡した');
  assert.ok(!JSON.stringify(state).includes(comment.body), '計画コメントの本文を Jev に渡した');
});

test('AC1：止まる計画（openQuestions）にも modelRouting を記録し、ラベル・本文は off と同じ', async () => {
  const plan = planOf(63, { openQuestions: ['どちらにしますか'] });
  const off = await postPlan('off', plan);
  const jev = fakeJev({ opus: 0.9, sonnet: 0.1 });
  const on = await postPlan('shadow', plan, { jev, comment: off.comment });
  const rec = lastGateRecord(on.fake, 63);
  assert.equal(rec.pass, false);
  assert.ok(on.fake.writes().includes('label+agent:plan-review'), on.fake.writes().join(' '));
  assert.equal(rec.modelRouting?.status, 'ok');
  assert.equal(rec.modelRouting?.recommended, 'opus');
  assert.deepEqual(outcome(on.fake, 63), outcome(off.fake, 63));
});

test('AC1：Jev が error・throw でもゲートは off と同じに通り、記録の modelRouting は status error', async () => {
  for (const answer of ['error', 'throw'] as const) {
    const plan = planOf(64);
    const off = await postPlan('off', plan);
    const on = await postPlan('shadow', plan, { jev: fakeJev(answer), comment: off.comment });
    const rec = lastGateRecord(on.fake, 64);
    assert.equal(rec.pass, true, answer);
    assert.equal(rec.modelRouting?.status, 'error', answer);
    assert.equal(rec.modelRouting?.recommended, undefined, answer);
    assert.deepEqual(outcome(on.fake, 64), outcome(off.fake, 64), `${answer}: ゲートの結果が off と違う`);
  }
});

// ---- 問わない場合 ----

test('off・split の計画・書式エラーの計画では Jev に問わず、記録に modelRouting が無い', async () => {
  const split = [
    { title: 'feat(x): 一つ目', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['src/a.ts'], dependsOn: [] },
    { title: 'docs: 二つ目', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: ['docs/guide/**'], dependsOn: [0] },
  ];
  const cases: [string, number, (jev: ReturnType<typeof fakeJev>) => Promise<{ fake: FakeGitHub }>][] = [
    ['off', 65, (jev) => postPlan('off', planOf(65), { jev })],
    // 宣言の無い split の計画は Epic を作らずに止まる（split の計画は通過・停止のどちらでも問わない）
    ['split', 66, (jev) => postPlan('shadow', planOf(66, { risk: 'critical', files: [], split: split as Plan['split'], critique: { verdict: 'split', rounds: 1 } }), { jev, claim: false })],
    ['書式エラー', 67, (jev) => postPlan('shadow', null, { n: 67, jev, comment: planComment(null, '計画です。\n\n```agent-plan\n{ "version": 1,\n```') })],
  ];
  for (const [name, n, run] of cases) {
    const jev = fakeJev({ opus: 0.5, sonnet: 0.5 });
    const { fake } = await run(jev);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
    assert.equal(lastGateRecord(fake, n).modelRouting, undefined, `${name}: 記録に modelRouting がある`);
  }
});

// ---- 記録の使い回し ----

test('同じ計画コメント（同じ本文）の2回目の判定では、前の ok の modelRouting を使い回して Jev に問わない', async () => {
  const jev = fakeJev({ opus: 0.3, sonnet: 0.7 });
  const first = await postPlan('shadow', planOf(68), { jev });
  const firstRec = lastGateRecord(first.fake, 68);
  assert.equal(jev.asked.length, 1);
  const second = await postPlan('shadow', planOf(68), { jev, comment: first.comment, w: first.w });
  assert.equal(jev.asked.length, 1, '2回目にも Jev に問った');
  assert.deepEqual(lastGateRecord(second.fake, 68).modelRouting, firstRec.modelRouting);
});

test('前の modelRouting が error なら使い回さず、2回目にもう一度 Jev に問う', async () => {
  const first = await postPlan('shadow', planOf(69), { jev: fakeJev('error') });
  assert.equal(lastGateRecord(first.fake, 69).modelRouting?.status, 'error');
  const jev = fakeJev({ opus: 0.6, sonnet: 0.4 });
  const second = await postPlan('shadow', planOf(69), { jev, comment: first.comment, w: first.w });
  assert.equal(jev.asked.length, 1);
  assert.equal(lastGateRecord(second.fake, 69).modelRouting?.status, 'ok');
  assert.equal(lastGateRecord(second.fake, 69).modelRouting?.recommended, 'opus');
});
