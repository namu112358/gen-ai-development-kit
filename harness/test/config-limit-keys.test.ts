// Issue #272：harness.config.json に移した4つの上限が効くこと。
// classification.issueTriageJevPerRun（label-apply が1回の定期実行で Jev に問う Issue の数）、
// jev.decisionMaxTargets・jev.decisionMaxAnswerChars（buildDecisionRequest が問う大きさの上限）、
// routine.gateReplyTimeoutMinutes（prFacts が判定コメントへの App の返答を待つ時間）。キーが無ければ今の値で動く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { buildDecisionRequest, DECISION_MAX_ANSWER_CHARS, DECISION_MAX_TARGETS, type DecisionTarget } from '../lib/decision.ts';
import { prFacts } from '../lib/facts.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import type { askJev } from '../lib/jev.ts';
import { JEV_PER_RUN, labelApply } from '../gates/label-apply.ts';
import { config, ctxFor, DIFF, FakeGitHub, HEAD, pr, verdict } from './support/gate-fixtures.ts';

// --- classification.issueTriageJevPerRun ---

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const issue = (number: number, title: string, names: string[]) => ({
  number, title, body: FORM_BODY, html_url: `https://x/${number}`, updated_at: '2026-09-27T00:00:00Z', labels: names.map((name) => ({ name })), user: { login: 'me' },
});

/** label-apply の定期実行に要る応答（gates-label-apply.test.ts の worldFake にならう） */
function triageFake(issues: ReturnType<typeof issue>[]): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => issues)
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/pulls\?state=closed/, () => [])
    .on('GET', /\/issues\/(\d+)\/events/, () => [])
    .on('GET', /\/issues\/(\d+)\/comments/, () => [])
    .on('POST', /\/issues\/(\d+)\/labels$/, (m, body) => {
      issues.find((i) => i.number === Number(m[1]))?.labels.push(...(body.labels as string[]).map((name) => ({ name })));
      return [];
    })
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

/** 偽の Jev。問われた Issue のタイトルを記録する */
function fakeJev() {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(String((request.state as { title: string }).title));
    return {
      status: 'ok', model: 'jev-test', answers: {
        type: { type: 'choice', probabilities: { feature: 0.9 } },
        area: { type: 'choice', probabilities: { docs: 0.9 } },
        priority: { type: 'choice', probabilities: { high: 0.9 } },
        ac_verifiable: { type: 'noul', noul: 0.9 },
        requirements_clear: { type: 'noul', noul: 0.9 },
      },
    } as Awaited<ReturnType<typeof askJev>>;
  };
  return { asked, fn };
}

function withTriagePerRun(perRun: number | undefined): HarnessConfig {
  const classification = { ...config.classification, issueTriage: 'label' as const, issueTriageJevPerRun: perRun };
  if (perRun === undefined) delete (classification as { issueTriageJevPerRun?: number }).issueTriageJevPerRun;
  return { ...config, classification };
}

async function askedCount(cfg: HarnessConfig, issueCount: number): Promise<number> {
  const jev = fakeJev();
  const issues = Array.from({ length: issueCount }, (_, k) => issue(40 + k, `feat: ${k}`, ['type:feat']));
  const fake = triageFake(issues);
  await labelApply(ctxFor(fake, 'schedule', {}, { config: cfg, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return jev.asked.length;
}

test('classification.issueTriageJevPerRun を 2 にすると、1回の定期実行で Jev に問う Issue は 2 件', async () => {
  assert.equal(await askedCount(withTriagePerRun(2), JEV_PER_RUN + 2), 2);
});

test('classification.issueTriageJevPerRun を JEV_PER_RUN より大きくすると、その件数まで問う', async () => {
  assert.equal(await askedCount(withTriagePerRun(JEV_PER_RUN + 2), JEV_PER_RUN + 4), JEV_PER_RUN + 2);
});

test('classification.issueTriageJevPerRun が無ければ、今の上限 JEV_PER_RUN（5）件', async () => {
  assert.equal(JEV_PER_RUN, 5);
  assert.equal(await askedCount(withTriagePerRun(undefined), JEV_PER_RUN + 2), JEV_PER_RUN);
});

// --- jev.decisionMaxTargets・jev.decisionMaxAnswerChars ---

const AT = '2026-09-27T01:00:00Z';
const targetsOf = (n: number): DecisionTarget[] => Array.from({ length: n }, (_, i) => ({ id: `question:${i}`, kind: 'question' as const, text: `q${i}` }));
const answersFor = (targets: DecisionTarget[], firstQuote = 'ok') => ({ answers: targets.map((t, i) => ({ to: t.id, quote: i === 0 ? firstQuote : 'ok', at: AT })) });

function withDecisionLimits(limits: { decisionMaxTargets?: number; decisionMaxAnswerChars?: number }): HarnessConfig {
  const jev = { ...config.jev } as HarnessConfig['jev'] & { decisionMaxTargets?: number; decisionMaxAnswerChars?: number };
  delete jev.decisionMaxTargets;
  delete jev.decisionMaxAnswerChars;
  return { ...config, jev: { ...jev, ...limits } };
}

test('jev.decisionMaxTargets を小さくすると、それを超える項目の数で buildDecisionRequest が null', () => {
  const cfg = withDecisionLimits({ decisionMaxTargets: 2 });
  assert.ok(buildDecisionRequest(cfg, targetsOf(2), answersFor(targetsOf(2))), '上限ちょうどは問う');
  assert.equal(buildDecisionRequest(cfg, targetsOf(3), answersFor(targetsOf(3))), null, '上限を超えれば null');
});

test('jev.decisionMaxTargets が無ければ、今の上限 DECISION_MAX_TARGETS（20）件', () => {
  const cfg = withDecisionLimits({});
  assert.equal(DECISION_MAX_TARGETS, 20);
  assert.ok(buildDecisionRequest(cfg, targetsOf(20), answersFor(targetsOf(20))));
  assert.equal(buildDecisionRequest(cfg, targetsOf(21), answersFor(targetsOf(21))), null);
});

test('jev.decisionMaxAnswerChars を小さくすると、答えの合計がそれを超えれば buildDecisionRequest が null', () => {
  const cfg = withDecisionLimits({ decisionMaxAnswerChars: 10 });
  const one = targetsOf(1);
  assert.ok(buildDecisionRequest(cfg, one, answersFor(one, 'あ'.repeat(10))), '上限ちょうどは問う');
  assert.equal(buildDecisionRequest(cfg, one, answersFor(one, 'あ'.repeat(11))), null, '上限を超えれば null');
});

test('jev.decisionMaxAnswerChars が無ければ、今の上限 DECISION_MAX_ANSWER_CHARS（20000）文字', () => {
  const cfg = withDecisionLimits({});
  const one = targetsOf(1);
  assert.equal(DECISION_MAX_ANSWER_CHARS, 20_000);
  assert.ok(buildDecisionRequest(cfg, one, answersFor(one, 'あ'.repeat(20_000))));
  assert.equal(buildDecisionRequest(cfg, one, answersFor(one, 'あ'.repeat(20_001))), null);
});

test('上限を大きくすると、今の上限を超える大きさでも問う', () => {
  const cfg = withDecisionLimits({ decisionMaxTargets: 30, decisionMaxAnswerChars: 30_000 });
  assert.ok(buildDecisionRequest(cfg, targetsOf(25), answersFor(targetsOf(25))));
  assert.ok(buildDecisionRequest(cfg, targetsOf(1), answersFor(targetsOf(1), 'あ'.repeat(25_000))));
});

// --- routine.gateReplyTimeoutMinutes ---

/** 判定の head と今の head を同じにする（facts-verdict-drift.test.ts の組み立てにならう） */
const current = () => pr({ head: { ref: 'claude/issue-3-x', sha: HEAD, repo: { full_name: 'o/r' } } });

function verdictComment(minutesAgo: number): IssueComment {
  return {
    id: 1, html_url: 'u1', created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: `${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', verdict({ headSha: HEAD }))}`,
  };
}

function factsFake(comments: IssueComment[]): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => current())
    .on('GET', /\/issues\/5\/comments/, () => comments)
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/commits\/\w+$/, () => ({ commit: { committer: { date: '2026-09-27T00:00:00Z' } } }))
    .on('GET', /\/commits\/\w+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /\/compare\/main\.\.\.(\w+)$/, () => DIFF)
    .on('POST', /\/graphql/, (_m, body) => {
      if (String(body.query).includes('closingIssuesReferences')) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
      }
      return { data: {} };
    });
}

function withGateReply(minutes: number | undefined): HarnessConfig {
  const routine = { ...config.routine } as HarnessConfig['routine'] & { gateReplyTimeoutMinutes?: number };
  delete routine.gateReplyTimeoutMinutes;
  return { ...config, routine: minutes === undefined ? routine : { ...routine, gateReplyTimeoutMinutes: minutes } };
}

const awaiting = async (cfg: HarnessConfig, minutesAgo: number) =>
  (await prFacts(new GitHub(factsFake([verdictComment(minutesAgo)]), 'o/r'), cfg, current() as never, new Map(), new Map())).verdictAwaitingGate;

test('routine.gateReplyTimeoutMinutes が無ければ、判定コメントへの返答を 30分待つ', async () => {
  assert.equal(await awaiting(withGateReply(undefined), 10), true, '10分前の判定は待つ');
  assert.equal(await awaiting(withGateReply(undefined), 45), false, '45分前の判定は待たない');
});

test('routine.gateReplyTimeoutMinutes を短くすると、それを過ぎた判定は返答待ちにしない', async () => {
  assert.equal(await awaiting(withGateReply(5), 10), false, '5分にすると10分前の判定は待たない');
  assert.equal(await awaiting(withGateReply(5), 2), true, '2分前の判定は待つ');
});

test('routine.gateReplyTimeoutMinutes を長くすると、30分を過ぎた判定も返答待ちにする', async () => {
  assert.equal(await awaiting(withGateReply(60), 45), true, '60分にすると45分前の判定も待つ');
  assert.equal(await awaiting(withGateReply(60), 90), false, '90分前の判定は待たない');
});
