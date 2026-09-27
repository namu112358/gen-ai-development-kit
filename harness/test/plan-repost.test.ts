import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { plannerRequestsHuman, planReviewOrigin, priorPlanReviewReleased, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');

type Origin = 'gate' | 'planner';

/** ガードレールに触れず、印が無ければ通る計画 */
const passPlan: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
/** ガードレール（harness/lib/**）に触れるだけで止まる計画 */
const guardrailPlan: Plan = { ...passPlan, files: ['harness/lib/plan.ts'] };

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
    body: `${appMark('plan-gate')}\n停止\n${renderBlock('agent-app', { version: 1, planCommentId: 80, reasons: ['前の理由'], plan: { files: ['docs/**'] }, ...record })}`,
  };
}

const labeledBy = (login: string) => ({ event: 'labeled', created_at: '2026-09-26T00:00:00Z', label: { name: 'agent:plan-review' }, actor: { login } });

/** 前の記録と印の付け手を差し替えた偽の GitHub */
function repostFake(comments: unknown[], events: unknown[]): FakeGitHub {
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('GET', /\/issues\/3\/events/, () => events);
}

/** onPlan が投稿した plan-gate 記録（agent-app ブロック） */
function postedRecord(fake: FakeGitHub): Record<string, any> {
  const post = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments'));
  assert.ok(post, 'plan-gate の記録を投稿する');
  const block = extractBlock(post.body.body, 'agent-app');
  assert.ok(block.found && block.ok, '記録の agent-app ブロックを読める');
  return block.value as Record<string, any>;
}

function postedBody(fake: FakeGitHub): string {
  return fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments'))!.body.body;
}

// ---- 純粋関数 ----

test('plannerRequestsHuman：needsHuman・acChangeProposed・openQuestions のどれかなら true', () => {
  const cases: [Partial<Plan>, boolean][] = [
    [{}, false],
    [{ needsHuman: true, needsHumanReasons: ['x'] }, true],
    [{ acChangeProposed: true }, true],
    [{ openQuestions: ['?'] }, true],
    [{ files: ['harness/lib/plan.ts'] }, false],
    [{ risk: 'high' }, false],
  ];
  for (const [patch, expected] of cases) {
    assert.equal(plannerRequestsHuman({ ...passPlan, ...patch }), expected, JSON.stringify(patch));
  }
});

test('planReviewOrigin：Planner の申告か、解かなかった前の印があれば planner、それ以外は gate', () => {
  const cases: [Partial<Plan>, boolean, Origin][] = [
    [{ files: ['harness/lib/plan.ts'] }, false, 'gate'],
    [{ risk: 'high' }, false, 'gate'],
    [{ openQuestions: ['?'] }, false, 'planner'],
    [{ needsHuman: true, needsHumanReasons: ['x'] }, false, 'planner'],
    [{ acChangeProposed: true }, false, 'planner'],
    [{}, true, 'planner'],
    [{ files: ['harness/lib/plan.ts'] }, true, 'planner'],
  ];
  for (const [patch, labelBefore, expected] of cases) {
    assert.equal(planReviewOrigin({ ...passPlan, ...patch }, labelBefore), expected, `${JSON.stringify(patch)} labelBefore=${labelBefore}`);
  }
});

test('priorPlanReviewReleased：印があり、前の記録が gate の停止で、印を付けたのが App のときだけ true', () => {
  const gateStop = { pass: false, planReviewOrigin: 'gate' as const };
  const cases: [boolean, Parameters<typeof priorPlanReviewReleased>[1], boolean, boolean][] = [
    [true, gateStop, true, true],
    [false, gateStop, true, false],
    [true, gateStop, false, false],
    [true, { pass: false, planReviewOrigin: 'planner' }, true, false],
    [true, { pass: false }, true, false],
    [true, { pass: true, planReviewOrigin: 'gate' }, true, false],
    [true, null, true, false],
    [true, undefined, true, false],
  ];
  for (const [hasLabel, previous, byApp, expected] of cases) {
    assert.equal(priorPlanReviewReleased(hasLabel, previous, byApp), expected, `${hasLabel} ${JSON.stringify(previous)} ${byApp}`);
  }
});

// ---- AC1：ゲートの停止の後、止めた理由が当たらない計画を出し直すと通る ----

test('出し直し：App のゲートの停止（gate）の後、通る計画なら前の印を外して通す', async () => {
  const fake = repostFake([gateRecordComment({ pass: false, planReviewOrigin: 'gate' })], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready', 'agent:plan-review'])));
  assert.deepEqual(fake.writes(), ['label-agent:plan-review', 'label+agent:plan-ok', 'label+area:docs', 'comment:plan-gate', 'check:agent/plan-link=success']);
  assert.ok(postedBody(fake).includes('前の計画ゲートの停止（`agent:plan-review`）を外しました'), '通過コメントに外した旨を書く');
  assert.equal(postedRecord(fake).pass, true);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path.includes('/issues/3/events')), '印を付けた者を events で調べる');
});

test('出し直し：前の印を解いても、新しい計画がガードレールに触れれば止め、出どころは gate', async () => {
  const fake = repostFake([gateRecordComment({ pass: false, planReviewOrigin: 'gate' })], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(guardrailPlan, ['agent:ready', 'agent:plan-review'])));
  assert.deepEqual(fake.writes().slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
  const record = postedRecord(fake);
  assert.equal(record.pass, false);
  assert.equal(record.planReviewOrigin, 'gate');
  assert.ok(!record.reasons.some((r: string) => /人が外す/.test(r)), '前の印は理由にしない（新しい計画の理由だけ）');
});

// ---- AC2：Planner が人の判断を求めた停止は、出し直しても人が外すまで止まる ----

const heldCases: [string, unknown[], unknown[]][] = [
  ['前の停止が Planner の申告（planner）', [gateRecordComment({ pass: false, planReviewOrigin: 'planner', reasons: ['Planner が人間の判断が必要と申告しています'] })], [labeledBy(APP)]],
  ['記録が無い（人が付けた印）', [], [labeledBy('me')]],
  ['出どころの無い古い記録（pass:false）', [gateRecordComment({ pass: false })], [labeledBy(APP)]],
  ['記録は gate だが最後に印を付けたのが人', [gateRecordComment({ pass: false, planReviewOrigin: 'gate' })], [labeledBy(APP), { event: 'unlabeled', label: { name: 'agent:plan-review' }, actor: { login: 'me' } }, labeledBy('me')]],
];

for (const [name, comments, events] of heldCases) {
  test(`出し直し：${name}なら、通る計画でも印を外さずに止める`, async () => {
    const fake = repostFake(comments, events);
    await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready', 'agent:plan-review'])));
    const writes = fake.writes();
    assert.ok(!writes.includes('label-agent:plan-review'), '印を外さない');
    assert.ok(!writes.includes('label+agent:plan-ok'), '通さない');
    assert.deepEqual(writes.slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
    const record = postedRecord(fake);
    assert.equal(record.pass, false);
    assert.equal(record.planReviewOrigin, 'planner', '解かなかった印で止めたら planner');
    assert.ok(record.reasons.some((r: string) => /人が外す/.test(r)), '人が外すまで止める旨を理由に書く');
  });
}

// ---- 印が無いときは今までどおり ----

test('印の無い Issue：前の記録も events も読まず、書き込みは今までどおり', async () => {
  const fake = repostFake([gateRecordComment({ pass: false, planReviewOrigin: 'gate' })], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(passPlan, ['agent:ready'])));
  assert.deepEqual(fake.writes(), ['label+agent:plan-ok', 'label+area:docs', 'comment:plan-gate', 'check:agent/plan-link=success']);
  assert.ok(!fake.calls.some((c) => c.path.includes('/issues/3/events')), 'events を読まない');
  // Issue のコメントは後の plan-link の書き直しでも読むので、計画ゲートの記録の投稿より前に読んでいないことを確かめる
  const postAt = fake.calls.findIndex((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments'));
  const getAt = fake.calls.findIndex((c) => c.method === 'GET' && c.path.includes('/issues/3/comments'));
  assert.ok(getAt === -1 || getAt > postAt, '判定の前に Issue のコメントを読まない');
});

// ---- 停止の記録の出どころ ----

test('停止の記録の出どころ：印が無くガードレールで止めると gate、openQuestions・needsHuman で止めると planner', async () => {
  const guard = repostFake([], []);
  await onComment(ctxFor(guard, 'issue_comment', planEvent(guardrailPlan, ['agent:ready'])));
  assert.equal(postedRecord(guard).pass, false);
  assert.equal(postedRecord(guard).planReviewOrigin, 'gate');

  const questions = repostFake([], []);
  await onComment(ctxFor(questions, 'issue_comment', planEvent({ ...passPlan, openQuestions: ['?'] }, ['agent:ready'])));
  assert.equal(postedRecord(questions).planReviewOrigin, 'planner');

  const human = repostFake([], []);
  await onComment(ctxFor(human, 'issue_comment', planEvent({ ...passPlan, needsHuman: true, needsHumanReasons: ['x'] }, ['agent:ready'])));
  assert.equal(postedRecord(human).planReviewOrigin, 'planner');
});

test('停止の記録の出どころ：印が前から付いていて解かずに止めると、ガードレールに触れる計画でも planner', async () => {
  const fake = repostFake([gateRecordComment({ pass: false, planReviewOrigin: 'planner' })], [labeledBy(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(guardrailPlan, ['agent:ready', 'agent:plan-review'])));
  assert.ok(!fake.writes().includes('label-agent:plan-review'));
  assert.equal(postedRecord(fake).planReviewOrigin, 'planner');
});

// ---- render-plan ----

function renderPlan(plan: unknown): { addLabels: string[]; expectedGate: { pass: boolean } } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-repost-'));
  try {
    const file = join(dir, 'plan.md');
    writeFileSync(file, `## 計画\n\n${renderBlock('agent-plan', plan)}\n`);
    const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'render-plan', '3', file], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('render-plan：agent:plan-review は Planner が人の判断を求めたときだけ付ける', () => {
  const guard = renderPlan(guardrailPlan);
  assert.equal(guard.expectedGate.pass, false, 'ガードレールに触れる計画はゲートで止まる見込み');
  assert.ok(!guard.addLabels.includes('agent:plan-review'), 'ゲートだけで止まる計画には印を付けない（App が付ける）');

  const human = renderPlan({ ...passPlan, needsHuman: true, needsHumanReasons: ['x'] });
  assert.equal(human.expectedGate.pass, false);
  assert.ok(human.addLabels.includes('agent:plan-review'), 'Planner の申告なら印を付ける');

  const ok = renderPlan(passPlan);
  assert.equal(ok.expectedGate.pass, true);
  assert.ok(!ok.addLabels.includes('agent:plan-review'));
});
