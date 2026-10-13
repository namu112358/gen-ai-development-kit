/**
 * 確認事項（agent-confirm）の答え待ちと再開を、agent.ts step（decideStep）と事実集め（collectFleetIssues・confirmFacts の targetOf）で確かめる（Issue #954）。
 * (1) 偽の GitHub の通し：答えの無い確認事項で wait の human、短い答えを足すと再開の implement（自分の同じ段階の宣言があっても宣言を出し直し、inputs の先頭に人の答え）。
 * (2) confirmFacts の targetOf：html_url から番号が読めないコメントでも、読んだ番号で PR の確認事項を突き合わせ、別の番号のコメントに書いた答えは答えにしない。
 * (3) 答えより後の宣言の値の at（別のセッションの解除済みの宣言も）があれば、再開のノードを返さない。
 * (4) 守り：plan-review の Issue では答えがあっても implement を返さない、再開の implement でも areaFull なら area-limit、
 *     再開の plan の宣言を出し直した後の step --plan は plan-ok でも批評に進む。
 * 文言は固定せず、kind・node・waitingFor・reason・claim の値で確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { confirmFacts } from '../lib/confirm.ts';
import { claimTimeline } from '../lib/facts.ts';
import { LABELS } from '../lib/config.ts';
import { collectFleetIssues, type FleetIssueItem } from '../lib/fleet-reads.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { Snapshot } from '../lib/graphql-prefetch.ts';
import type { StoredClaim } from '../lib/queue.ts';
import { decideStep, type StepNodeResult, type StepResult, type StepStopResult, type StepWaitResult } from '../lib/step.ts';
import { config } from './support/gate-fixtures.ts';
import { APP_SLUG, dashboardFake, REPO, type WActor, type WComment, type World } from './support/dashboard-fixtures.ts';
import {
  ANSWER_AT,
  CONFIRM_AT,
  N,
  OTHER,
  PR,
  SESSION,
  confirmAnswer,
  confirmCommentBody,
  confirmFact,
  confirmValue,
  fleetIssue,
  issueFacts,
  manual,
  planOkFacts,
  shortAnswerBody,
  stepInput,
} from './support/step-fixtures.ts';

function asNode(r: StepResult): StepNodeResult {
  assert.equal(r.kind, 'node', `node のはず: ${JSON.stringify(r)}`);
  return r as StepNodeResult;
}
function asWait(r: StepResult): StepWaitResult {
  assert.equal(r.kind, 'wait', `wait のはず: ${JSON.stringify(r)}`);
  return r as StepWaitResult;
}
function asStop(r: StepResult): StepStopResult {
  assert.equal(r.kind, 'stop', `stop のはず: ${JSON.stringify(r)}`);
  return r as StepStopResult;
}

const BEFORE_ANSWER = '2026-09-26T09:30:00Z';
const AFTER_ANSWER = '2026-09-26T11:00:00Z';

// ---- (1) 偽の GitHub の通し ----

const APP_ACTOR: WActor = { login: APP_SLUG, bot: true };
const PLAN_ID = 1000;
const GATE_ID = 1001;
const CLAIM_ID = 1002;
const CONFIRM_C = 1003;
const ANSWER_C = 1004;

/** 計画ゲートを通った Issue N（計画・App の計画ゲートの記録・App の agent:plan-ok・このセッションの implement の宣言）に、implement で止めた確認事項 */
function confirmWorld(): World {
  const claim: StoredClaim = { by: 'manual', at: BEFORE_ANSWER, session: SESSION, stage: 'implement' };
  return {
    issues: [{
      number: N, title: `t${N}`, labels: [LABELS.ready, LABELS.planOk],
      comments: [
        { id: PLAN_ID, created_at: '2026-09-26T01:00:00Z', body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') },
        {
          id: GATE_ID, created_at: '2026-09-26T01:01:00Z', author: APP_ACTOR, association: 'NONE',
          body: [appMark('plan-gate'), 'App です。', renderBlock('agent-app', { version: 1, planCommentId: PLAN_ID, pass: true, reasons: [], plan: { files: ['harness/lib/step.ts'], critique: { verdict: 'go', rounds: 1 } } })].join('\n'),
        },
        { id: CLAIM_ID, created_at: BEFORE_ANSWER, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', claim)].join('\n') },
        { id: CONFIRM_C, created_at: CONFIRM_AT, body: confirmCommentBody(confirmValue({ stage: 'implement', resume: 'implement' })) },
      ],
      events: [
        { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T00:00:00Z' },
        { event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T01:02:00Z', actor: APP_ACTOR },
      ],
    }],
    prs: [],
  };
}

async function collectIssue(world: World) {
  const fake = dashboardFake(world);
  const gh = new GitHub(fake, REPO);
  const item = await gh.get<FleetIssueItem>(`/issues/${N}`);
  const { issues } = await collectFleetIssues(gh, config, [item], new Snapshot());
  assert.equal(issues.length, 1);
  return issues[0]!;
}

test('偽の GitHub：答えの無い確認事項で wait の human、短い答えを足すと再開の implement（宣言を出し直し、inputs の先頭に人の答え）', async () => {
  const world = confirmWorld();

  const waiting = await collectIssue(world);
  assert.equal(waiting.confirms?.length, 1, 'collectFleetIssues が Issue のコメントの確認事項を confirms に入れる');
  assert.equal(waiting.confirms![0]!.commentId, CONFIRM_C);
  assert.equal(waiting.confirms![0]!.answer, null);
  const d1 = decideStep(stepInput(waiting));
  const w = asWait(d1.result);
  assert.equal(w.waitingFor, 'human');
  assert.equal(d1.claim, null, '答え待ちでは宣言を出さない');
  assert.deepEqual(d1.release, []);

  const answer: WComment = { id: ANSWER_C, created_at: ANSWER_AT, author: { login: 'me' }, association: 'OWNER', body: shortAnswerBody(CONFIRM_C, ['はい']) };
  world.issues[0]!.comments!.push(answer);

  const answered = await collectIssue(world);
  const fact = answered.confirms?.[0];
  assert.equal(fact?.answer?.commentId, ANSWER_C, '短い答えを答えとして読む');
  assert.equal(fact?.resumed, false, '自分の宣言の値の at は答えより前');
  const d2 = decideStep(stepInput(answered));
  const r = asNode(d2.result);
  assert.equal(r.node, 'implement');
  assert.deepEqual(r.claim, { target: N, stage: 'implement' });
  assert.deepEqual(d2.claim, { target: N, stage: 'implement' }, '同じ段階の自分の宣言があっても、再開では宣言を出し直す');
  assert.ok(r.inputs[0]?.includes(fact!.answer!.url), `inputs の先頭に答えのコメントの URL: ${r.inputs.join('\n')}`);
  assert.ok(r.inputs[0]?.includes('はい'), `inputs の先頭に人の答え: ${r.inputs.join('\n')}`);
});

// ---- (2) confirmFacts の targetOf ----

/** html_url から番号が読めないコメント（偽の GitHub の restComment と同じ形） */
const bare = (id: number, body: string, created_at: string): IssueComment => ({
  id, body, html_url: `https://github.com/${REPO}#c${id}`, created_at, updated_at: created_at, author_association: 'OWNER', user: { login: 'me', type: 'User' },
});

test('confirmFacts の targetOf：読んだ番号で PR・Issue の確認事項を突き合わせ、別の番号のコメントに書いた答えは答えにしない', () => {
  const ON_PR = 500;
  const ON_ISSUE = 501;
  const prConfirm = bare(ON_PR, confirmCommentBody(confirmValue({ target: PR, stage: 'fix', resume: 'fix' })), CONFIRM_AT);
  const issueConfirm = bare(ON_ISSUE, confirmCommentBody(confirmValue({ target: N })), CONFIRM_AT);
  const answer = (id: number, to: number) => bare(id, shortAnswerBody(to, ['はい']), ANSWER_AT);

  // [名前, 答えのコメントと読んだ番号, PR の確認事項の答えの ID, Issue の確認事項の答えの ID]
  const cases: [string, [IssueComment, number][], number | null, number | null][] = [
    ['答えなし', [], null, null],
    ['それぞれ同じ番号に答えた', [[answer(510, ON_PR), PR], [answer(511, ON_ISSUE), N]], 510, 511],
    ['PR の確認事項への答えを Issue に書いた', [[answer(510, ON_PR), N]], null, null],
    ['Issue の確認事項への答えを PR に書いた', [[answer(511, ON_ISSUE), PR]], null, null],
    ['Issue に書いた答えの後に PR に書き直した', [[answer(510, ON_PR), N], [answer(512, ON_PR), PR]], 512, null],
  ];
  for (const [name, answers, prAnswer, issueAnswer] of cases) {
    const where = new Map<number, number>([[ON_PR, PR], [ON_ISSUE, N], ...answers.map(([c, n]) => [c.id, n] as [number, number])]);
    const comments = [prConfirm, issueConfirm, ...answers.map(([c]) => c)];
    const facts = confirmFacts(comments, claimTimeline(comments), (c) => where.get(c.id) ?? null);
    assert.deepEqual(facts.map((f) => [f.commentId, f.confirm.target]), [[ON_PR, PR], [ON_ISSUE, N]], name);
    assert.equal(facts[0]!.answer?.commentId ?? null, prAnswer, `${name}：PR の確認事項`);
    assert.equal(facts[1]!.answer?.commentId ?? null, issueAnswer, `${name}：Issue の確認事項`);
  }

  // targetOf が null を返すコメントは確認事項として読まない。targetOf が無ければ今どおり html_url から読む（この形では読めない）
  const comments = [prConfirm, issueConfirm];
  assert.deepEqual(confirmFacts(comments, claimTimeline(comments), () => null), []);
  assert.deepEqual(confirmFacts(comments, claimTimeline(comments)), []);
});

// ---- (3) 答えより後の宣言で再開を返さない ----

/** 着手宣言のコメント（html_url は Issue N） */
const claimComment = (id: number, value: StoredClaim): IssueComment => ({
  id, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', value)].join('\n'),
  html_url: `https://github.com/o/r/issues/${N}#issuecomment-${id}`, created_at: value.at, updated_at: value.at, author_association: 'OWNER', user: { login: 'me', type: 'User' },
});

test('答えの後に別のセッションが再開の段階を宣言した（値の at が答えより後）Issue では、再開のノードを返さない', () => {
  // plan-ok の Issue で、resume plan の確認事項に答えがある。別のセッションの宣言（段階 plan、解除済み）の値の at だけを変える
  const confirm = bare(CONFIRM_C, confirmCommentBody(confirmValue({ stage: 'implement', resume: 'plan' })), CONFIRM_AT);
  const answer = bare(ANSWER_C, shortAnswerBody(CONFIRM_C, ['はい']), ANSWER_AT);
  const cases: [string, string, boolean, StepNodeResult['node']][] = [
    ['宣言の値の at が答えより前', BEFORE_ANSWER, false, 'plan'],
    ['宣言の値の at が答えより後', AFTER_ANSWER, true, 'implement'],
  ];
  for (const [name, at, resumed, node] of cases) {
    const claim: StoredClaim = { by: 'manual', at, session: OTHER, stage: 'plan', released: true };
    const comments = [confirm, answer, claimComment(1100, claim)];
    const confirms = confirmFacts(comments, claimTimeline(comments), () => N);
    assert.equal(confirms[0]?.resumed, resumed, name);
    const d = decideStep(stepInput(fleetIssue(planOkFacts({ claim }), { confirms })));
    assert.equal(asNode(d.result).node, node, name);
  }
});

// ---- (4) 守り ----

test('plan-review の Issue では答えがあっても implement を返さず、再開の implement でも areaFull なら area-limit、再開の plan の後の step --plan は批評に進む', () => {
  const implementAnswered = [confirmFact({ confirm: { stage: 'implement', resume: 'implement' }, answer: confirmAnswer() })];

  // plan-review（計画ゲートで止まった Issue）：答えがあっても今どおり stop の plan-review
  {
    const facts = issueFacts({ labels: [LABELS.ready, LABELS.planReview], gate: { pass: false, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, latestPlanAt: '2026-09-26T01:00:00Z' });
    const d = decideStep(stepInput(fleetIssue(facts, { confirms: implementAnswered })));
    assert.equal(asStop(d.result).reason, 'plan-review');
    assert.equal(d.claim, null);
  }

  // plan-ok で再開の implement：areaFull なら wait の area-limit（宣言を出さない）
  {
    const d = decideStep(stepInput(fleetIssue(planOkFacts(), { confirms: implementAnswered }), { areaFull: 'area:harness が上限' }));
    assert.equal(asWait(d.result).waitingFor, 'area-limit');
    assert.equal(d.claim, null);
  }

  // plan-ok で resume plan の答えの後、自分の宣言（段階 plan、値の at は答えより後で resumed）に step --plan（誤り無し）→ plan-critique
  {
    const claim = manual(SESSION, 'plan', { at: AFTER_ANSWER });
    const confirms = [confirmFact({ confirm: { stage: 'implement', resume: 'plan' }, answer: confirmAnswer(), resumed: true })];
    const d = decideStep(stepInput(fleetIssue(planOkFacts({ claim }), { confirms }), { local: { kind: 'plan', errors: [] } }));
    const r = asNode(d.result);
    assert.equal(r.node, 'plan-critique');
    assert.deepEqual(d.claim, { target: N, stage: 'plan-critique' });
  }
});
