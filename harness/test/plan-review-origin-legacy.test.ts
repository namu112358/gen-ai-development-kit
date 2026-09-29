// 出どころの欄（planReviewOrigin）が無い古い停止の記録から出どころを推し量る recordedOrigin と、それを使う出し直しの計画ゲート・委任 Merge の範囲照合を確かめる（Issue #274）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { priorPlanReviewReleased, recordedOrigin, type Plan } from '../lib/plan.ts';
import { plannedFilesForDelegate } from '../lib/state.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, critiqueClaim, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';

/** ガードレールに触れず、印が無ければ通る計画（批評の関所も通る） */
const passPlan: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE };
/** ガードレール（harness/lib/**）に触れるだけで止まる計画 */
const guardrailPlan: Plan = { ...passPlan, files: ['harness/lib/plan.ts'] };

/** 64f6e68（#122）より前のコードが書いた、前の印で止めた理由 */
const OLD_LABEL_REASON = '`agent:plan-review` が付いています（Planner が人の判断を求めています）';
/** 今のコードが書く、前の印で止めた理由 */
const NEW_LABEL_REASON = '`agent:plan-review` が付いています（Planner の申告か人が付けた印です。人が外すまで止めます）';
const GUARDRAIL_REASON = 'ガードレールに触れます（人が実装して Merge する）: harness/lib/plan.ts';

/** 出どころの欄が無い古い停止の記録（実物と同じく、plan は3つの申告の欄がそろった元の計画） */
function legacyRecord(patch: { plan?: Partial<Plan>; reasons?: string[] } = {}): Record<string, unknown> {
  return { pass: false, reasons: patch.reasons ?? [GUARDRAIL_REASON], plan: { ...guardrailPlan, ...patch.plan } };
}

function planEvent(plan: unknown, labels: string[]) {
  return {
    action: 'created',
    issue: { number: 3, labels: labels.map((name) => ({ name })), state: 'open' },
    comment: { id: 81, body: renderBlock('agent-plan', plan), html_url: 'p2', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  };
}

/** App の plan-gate 記録コメント（前の計画の判定） */
function gateRecordComment(record: Record<string, unknown>) {
  return {
    id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\n停止\n${renderBlock('agent-app', { version: 1, planCommentId: 80, ...record })}`,
  };
}

const labeledBy = (login: string) => ({ event: 'labeled', created_at: '2026-09-26T00:00:00Z', label: { name: 'agent:plan-review' }, actor: { login } });

/** 前の記録と印の付け手を差し替えた偽の GitHub（計画より前に段階 plan-critique の宣言を置く） */
function repostFake(comments: unknown[], events: unknown[]): FakeGitHub {
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => [critiqueClaim(), ...comments])
    .on('GET', /\/issues\/3\/events/, () => events);
}

function postedBody(fake: FakeGitHub): string {
  const post = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments'));
  assert.ok(post, 'plan-gate の記録を投稿する');
  return post.body.body;
}

/** onPlan が投稿した plan-gate 記録（agent-app ブロック） */
function postedRecord(fake: FakeGitHub): Record<string, any> {
  const block = extractBlock(postedBody(fake), 'agent-app');
  assert.ok(block.found && block.ok, '記録の agent-app ブロックを読める');
  return block.value as Record<string, any>;
}

// ---- recordedOrigin ----

test('recordedOrigin：planReviewOrigin の欄がある記録はその値を返す', () => {
  assert.equal(recordedOrigin({ pass: false, planReviewOrigin: 'gate' }), 'gate');
  assert.equal(recordedOrigin({ pass: false, planReviewOrigin: 'planner' }), 'planner');
  // 欄があれば推し量らない（計画に申告が無くても planner のまま）
  assert.equal(recordedOrigin({ ...legacyRecord(), planReviewOrigin: 'planner' } as any), 'planner');
});

test('recordedOrigin：古い記録で、計画の3つの欄がそろい申告が無く、前の印の理由も無ければ gate', () => {
  assert.equal(recordedOrigin(legacyRecord() as any), 'gate');
  assert.equal(recordedOrigin(legacyRecord({ plan: { risk: 'critical' }, reasons: ['想定 Risk が critical です', GUARDRAIL_REASON] }) as any), 'gate');
});

test('recordedOrigin：古い記録で、Planner の申告・AC の変更の提案・未解決の質問があれば planner', () => {
  const cases: Partial<Plan>[] = [
    { needsHuman: true, needsHumanReasons: ['x'] },
    { acChangeProposed: true },
    { openQuestions: ['?'] },
  ];
  for (const patch of cases) {
    assert.equal(recordedOrigin(legacyRecord({ plan: patch }) as any), 'planner', JSON.stringify(patch));
  }
});

test('recordedOrigin：古い記録で、計画の欄が欠けている・計画が無いなら推し量らず planner', () => {
  const full = legacyRecord().plan as Record<string, unknown>;
  for (const key of ['needsHuman', 'acChangeProposed', 'openQuestions']) {
    const { [key]: _drop, ...rest } = full;
    assert.equal(recordedOrigin({ pass: false, reasons: [GUARDRAIL_REASON], plan: rest } as any), 'planner', `${key} が無い`);
  }
  assert.equal(recordedOrigin({ pass: false, reasons: [GUARDRAIL_REASON], plan: { files: ['docs/**'] } } as any), 'planner', '計画の欄が files だけ');
  assert.equal(recordedOrigin({ pass: false, reasons: [GUARDRAIL_REASON] } as any), 'planner', '計画が無い');
  assert.equal(recordedOrigin({ pass: false } as any), 'planner', '理由も計画も無い');
});

test('recordedOrigin：古い記録の理由に前の印で止めた文があれば planner（64f6e68 より前の文・今の文の両方）', () => {
  for (const reason of [OLD_LABEL_REASON, NEW_LABEL_REASON]) {
    assert.equal(recordedOrigin(legacyRecord({ reasons: [reason] }) as any), 'planner', reason);
    assert.equal(recordedOrigin(legacyRecord({ reasons: [GUARDRAIL_REASON, reason] }) as any), 'planner', `ガードレール＋${reason}`);
  }
});

test('recordedOrigin：pass: true の古い記録は止まった記録ではないので planner', () => {
  assert.equal(recordedOrigin({ ...legacyRecord(), pass: true } as any), 'planner');
});

test('priorPlanReviewReleased：古い記録でも recordedOrigin が gate で、印を付けたのが App なら true', () => {
  assert.equal(priorPlanReviewReleased(true, legacyRecord() as any, true), true);
  assert.equal(priorPlanReviewReleased(true, legacyRecord() as any, false), false, '最後に印を付けたのが人');
  assert.equal(priorPlanReviewReleased(false, legacyRecord() as any, true), false, '印が無い');
  assert.equal(priorPlanReviewReleased(true, legacyRecord({ plan: { needsHuman: true, needsHumanReasons: ['x'] } }) as any, true), false, 'Planner の申告');
  assert.equal(priorPlanReviewReleased(true, legacyRecord({ reasons: [OLD_LABEL_REASON] }) as any, true), false, '前の印で止めた停止');
  assert.equal(priorPlanReviewReleased(true, { pass: false }, true), false, '計画の欄が欠けた古い記録');
});

// ---- AC1：古い記録でも App のゲートの停止なら、出し直した計画は前の印を理由に止まらない ----

test('出し直し（古い記録・App のゲートの停止）：通る計画なら前の印を外して agent:plan-ok にする', async () => {
  const fake = repostFake([gateRecordComment(legacyRecord())], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready', 'agent:plan-review'])));
  assert.deepEqual(fake.writes(), ['label-agent:plan-review', 'label+agent:plan-ok', 'label+area:docs', 'comment:plan-gate', 'check:agent/plan-link=success']);
  assert.ok(postedBody(fake).includes('前の計画ゲートの停止（`agent:plan-review`）を外しました'), '通過コメントに外した旨を書く');
  assert.equal(postedRecord(fake).pass, true);
});

test('出し直し（古い記録・App のゲートの停止）：ガードレールに触れる計画はまた止まり、出どころは gate（前の印を理由にしない）', async () => {
  const fake = repostFake([gateRecordComment(legacyRecord())], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(guardrailPlan, ['agent:ready', 'agent:plan-review'])));
  assert.deepEqual(fake.writes().slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
  const record = postedRecord(fake);
  assert.equal(record.pass, false);
  assert.equal(record.planReviewOrigin, 'gate');
  assert.ok(!record.reasons.some((r: string) => r.startsWith('`agent:plan-review` が付いています')), '前の印は理由にしない');
});

// ---- AC2：古い記録でも、Planner の申告・AC の変更の提案・人の印で止まったものは今までどおり止まる ----

const heldCases: [string, unknown[], unknown[]][] = [
  ['古い記録の計画に Planner の申告（needsHuman）', [gateRecordComment(legacyRecord({ plan: { needsHuman: true, needsHumanReasons: ['x'] }, reasons: ['Planner が人間の判断が必要と申告しています'] }))], [labeledBy(APP)]],
  ['古い記録の計画に AC の変更の提案', [gateRecordComment(legacyRecord({ plan: { acChangeProposed: true }, reasons: ['要件・AC の変更提案があります'] }))], [labeledBy(APP)]],
  ['古い記録の計画に未解決の質問', [gateRecordComment(legacyRecord({ plan: { openQuestions: ['?'] }, reasons: ['未解決の質問が 1 件あります'] }))], [labeledBy(APP)]],
  ['古い記録の理由に 64f6e68 より前の前の印の文だけ', [gateRecordComment(legacyRecord({ reasons: [OLD_LABEL_REASON] }))], [labeledBy(APP)]],
  ['古い記録の理由に今の前の印の文', [gateRecordComment(legacyRecord({ reasons: [GUARDRAIL_REASON, NEW_LABEL_REASON] }))], [labeledBy(APP)]],
  ['古い記録（申告なし）だが最後に印を付けたのが人', [gateRecordComment(legacyRecord())], [labeledBy(APP), { event: 'unlabeled', label: { name: 'agent:plan-review' }, actor: { login: 'me' } }, labeledBy('me')]],
  ['古い記録の計画に申告の欄が欠けている', [gateRecordComment({ pass: false, reasons: [GUARDRAIL_REASON], plan: { files: ['harness/lib/plan.ts'] } })], [labeledBy(APP)]],
];

for (const [name, comments, events] of heldCases) {
  test(`出し直し：${name}なら、通る計画でも印を外さずに止め、出どころは planner`, async () => {
    const fake = repostFake(comments, events);
    await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready', 'agent:plan-review'])));
    const writes = fake.writes();
    assert.ok(!writes.includes('label-agent:plan-review'), '印を外さない');
    assert.ok(!writes.includes('label+agent:plan-ok'), '通さない');
    const record = postedRecord(fake);
    assert.equal(record.pass, false);
    assert.equal(record.planReviewOrigin, 'planner');
    assert.ok(record.reasons.includes(NEW_LABEL_REASON), '人が外すまで止める旨を理由に書く（文は今のまま）');
  });
}

// ---- AC3：出どころが gate になった計画は、委任・bypass の範囲照合に使われる ----

function fakeWithGate(gate: unknown): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: [] }).on('GET', /\/issues\/3\/comments/, () => [gate]);
}

/** 投稿された plan-gate 記録を、次の読み取りで返す App のコメントにする */
function asAppComment(body: string) {
  return { id: 91, created_at: '2026-09-27T00:00:00Z', updated_at: '', html_url: 'u2', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body };
}

test('範囲照合：古い記録から出し直して出どころが gate になった記録の files を plannedFilesForDelegate が使う', async () => {
  const gate = repostFake([gateRecordComment(legacyRecord())], [labeledBy(APP)]);
  await onComment(ctxFor(gate, 'issue_comment', planEvent(guardrailPlan, ['agent:ready', 'agent:plan-review'])));
  assert.equal(postedRecord(gate).planReviewOrigin, 'gate');

  const r = await plannedFilesForDelegate(new GitHub(fakeWithGate(asAppComment(postedBody(gate))), 'o/r'), config, 5);
  assert.deepEqual(r, { files: ['harness/lib/plan.ts'] });
});

test('範囲照合：古い記録で Planner の申告があり出どころが planner になった記録とは照合しない', async () => {
  const held = repostFake([gateRecordComment(legacyRecord({ plan: { needsHuman: true, needsHumanReasons: ['x'] } }))], [labeledBy(APP)]);
  await onComment(ctxFor(held, 'issue_comment', planEvent(guardrailPlan, ['agent:ready', 'agent:plan-review'])));
  assert.equal(postedRecord(held).planReviewOrigin, 'planner');

  const r = await plannedFilesForDelegate(new GitHub(fakeWithGate(asAppComment(postedBody(held))), 'o/r'), config, 5);
  assert.ok('missing' in r);
});
