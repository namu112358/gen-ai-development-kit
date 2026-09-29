// Jev にラベルを問う材料（依存・今のラベル・子の数・リポジトリの priority の基準）のテスト（#259）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { IssueContract } from '../lib/issue-form.ts';
import { buildTriageRequest } from '../lib/issue-triage.ts';
import type { askJev } from '../lib/jev.ts';
import { triageLabels } from '../gates/label-apply.ts';
import { onIssue } from '../gates/on-issue.ts';
import { config as fixtureConfig, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const repoConfig = loadConfig();
const contract: IssueContract = {
  goal: 'g', background: 'b', requirements: 'r', nonGoals: 'n', acceptanceCriteria: '- [ ] a', dependencies: '#216 の後', validation: '',
};

/** 既定の priority の基準（harness/lib/issue-triage.ts の PRIORITIES と同じ英文） */
const DEFAULT_PRIORITIES = {
  highest: 'Emergency: security, data loss, a broken main branch, or everything else is blocked on it. Drop other work.',
  high: 'Urgent: blocks users or other planned work; should be done before regular work.',
  medium: 'Regular planned work.',
  low: 'Nice to have; can wait until there is spare capacity.',
  lowest: 'Someday: only if nothing else is waiting.',
};

type State = Record<string, unknown>;
type Build = (config: HarnessConfig, title: string, c: IssueContract, context?: { labels?: string[]; subIssues?: number }) => ReturnType<typeof buildTriageRequest>;
/** 第4引数（context）付きで呼ぶ（実装の前でも型検査が通るように緩めて呼ぶ） */
const build = buildTriageRequest as unknown as Build;
const stateOf = (req: { state: unknown }) => req.state as State;
const priorityCriteria = (req: { questions: Record<string, unknown> }) => (req.questions.priority as { criteria: Record<string, string> }).criteria;

/** 設定を複製して classification.priorityCriteria を差し替える */
const withPriorityCriteria = (value: unknown): HarnessConfig =>
  ({ ...repoConfig, classification: { ...repoConfig.classification, priorityCriteria: value } }) as unknown as HarnessConfig;
/** priorityCriteria を持たない設定 */
const withoutPriorityCriteria = (): HarnessConfig => {
  const { priorityCriteria: _drop, ...rest } = repoConfig.classification as Record<string, unknown>;
  return { ...repoConfig, classification: rest } as unknown as HarnessConfig;
};

// --- state の材料 ---

test('state に dependencies が常に入り、今のキーはそのまま', () => {
  const s = stateOf(build(repoConfig, 't', contract));
  assert.equal(s.dependencies, '#216 の後');
  assert.equal(s.title, 't');
  assert.equal(s.goal, 'g');
  assert.equal(s.background, 'b');
  assert.equal(s.requirements, 'r');
  assert.equal(s.non_goals, 'n');
  assert.equal(s.acceptance_criteria, '- [ ] a');
});

test('dependencies が空でもキーは入る', () => {
  const s = stateOf(build(repoConfig, 't', { ...contract, dependencies: '' }));
  assert.ok('dependencies' in s);
  assert.equal(s.dependencies, '');
});

test('context が無ければ known_labels・sub_issue_count のキーは無い', () => {
  const s = stateOf(build(repoConfig, 't', contract));
  assert.ok(!('known_labels' in s));
  assert.ok(!('sub_issue_count' in s));
});

test('known_labels は type:*・risk:*・area:*・epic だけを名前順に入れ、priority:*・agent:* などは入れない', () => {
  const labels = ['priority:high', 'type:feat', 'agent:ready', 'epic', 'risk:low', 'area:harness', 'area:docs', 'good first issue'];
  const s = stateOf(build(repoConfig, 't', contract, { labels }));
  assert.deepEqual(s.known_labels, ['area:docs', 'area:harness', 'epic', 'risk:low', 'type:feat']);
});

test('ラベルの付いた順が違っても同じ要求になる', () => {
  const a = build(repoConfig, 't', contract, { labels: ['type:feat', 'area:harness', 'agent:ready'], subIssues: 2 });
  const b = build(repoConfig, 't', contract, { labels: ['agent:ready', 'area:harness', 'type:feat'], subIssues: 2 });
  assert.deepEqual(a, b);
});

test('当たるラベルが無ければ known_labels のキーを入れない', () => {
  for (const labels of [[], ['priority:high', 'agent:ready']]) {
    const s = stateOf(build(repoConfig, 't', contract, { labels }));
    assert.ok(!('known_labels' in s), `labels=${JSON.stringify(labels)}`);
  }
});

test('sub_issue_count は子が1以上のときだけ入る', () => {
  assert.equal(stateOf(build(repoConfig, 't', contract, { subIssues: 3 })).sub_issue_count, 3);
  assert.equal(stateOf(build(repoConfig, 't', contract, { subIssues: 1 })).sub_issue_count, 1);
  assert.ok(!('sub_issue_count' in stateOf(build(repoConfig, 't', contract, { subIssues: 0 }))));
  assert.ok(!('sub_issue_count' in stateOf(build(repoConfig, 't', contract, { labels: ['type:feat'] }))));
});

test('材料を足しても質問のキーは変わらない', () => {
  const req = build(repoConfig, 't', contract, { labels: ['type:feat', 'area:harness'], subIssues: 2 });
  assert.deepEqual(Object.keys(req.questions), ['type', 'area', 'priority', 'ac_verifiable', 'requirements_clear']);
});

// --- priority の基準 ---

test('priorityCriteria が無ければ priority の criteria は既定の英文', () => {
  assert.deepEqual(priorityCriteria(build(withoutPriorityCriteria(), 't', contract)), DEFAULT_PRIORITIES);
});

test('priorityCriteria の空でない文字列だけが既定を上書きし、選択肢の名前と並びは変わらない', () => {
  const cfg = withPriorityCriteria({ high: 'Blocks the harness itself.', low: '', medium: 42, unknown: 'ignored' });
  const c = priorityCriteria(build(cfg, 't', contract));
  assert.deepEqual(Object.keys(c), ['highest', 'high', 'medium', 'low', 'lowest']);
  assert.equal(c.high, 'Blocks the harness itself.');
  assert.equal(c.low, DEFAULT_PRIORITIES.low, '空文字は無視する');
  assert.equal(c.medium, DEFAULT_PRIORITIES.medium, '文字列でない値は無視する');
  assert.equal(c.highest, DEFAULT_PRIORITIES.highest);
  assert.equal(c.lowest, DEFAULT_PRIORITIES.lowest);
  assert.ok(!('unknown' in c), '知らないキーは入れない');
});

test('このリポジトリの設定（loadConfig）では priority の high の基準が既定と違う', () => {
  const c = priorityCriteria(build(repoConfig, 't', contract));
  assert.equal(typeof c.high, 'string');
  assert.ok(c.high!.length > 0);
  assert.notEqual(c.high, DEFAULT_PRIORITIES.high);
});

// --- ゲートが材料を渡す ---

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria', 'Dependencies'].map((h) => `### ${h}\n\nx`).join('\n\n');
const ANSWERS = {
  type: { type: 'choice', probabilities: { feature: 0.9 } },
  area: { type: 'choice', probabilities: { harness: 0.9 } },
  priority: { type: 'choice', probabilities: { high: 0.9 } },
  ac_verifiable: { type: 'noul', noul: 0.9 },
  requirements_clear: { type: 'noul', noul: 0.9 },
};

function fakeJev() {
  const requests: { state: unknown; questions: Record<string, unknown> }[] = [];
  const fn = (async (_key: string, request: { model: string; state: unknown; questions: Record<string, unknown> }) => {
    requests.push(request);
    return { status: 'ok', model: 'jev-test', answers: ANSWERS };
  }) as unknown as typeof askJev;
  return { requests, fn };
}

function writableFake(): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\/\d+\/comments/, () => [])
    .on('GET', /\/issues\/\d+\/events/, () => [])
    .on('POST', /\/issues\/\d+\/labels$/, () => [])
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

test('triageLabels：Issue のラベルと子の数が要求の known_labels・sub_issue_count に入る', async () => {
  const jev = fakeJev();
  const ctx = ctxFor(writableFake(), 'issues', {}, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });
  const issue = { number: 61, title: 'feat: 材料を足す', body: FORM_BODY, labels: ['type:feat', 'area:harness', 'agent:ready'], subIssues: 2 };
  const asked = await (triageLabels as unknown as (...args: unknown[]) => Promise<boolean>)(ctx, issue, [], { proposal: true });
  assert.equal(asked, true);
  assert.equal(jev.requests.length, 1);
  const s = stateOf(jev.requests[0]!);
  assert.deepEqual(s.known_labels, ['area:harness', 'type:feat']);
  assert.equal(s.sub_issue_count, 2);
  assert.equal(s.dependencies, 'x');
});

test('triageLabels：subIssues が無ければ sub_issue_count は入らない', async () => {
  const jev = fakeJev();
  const ctx = ctxFor(writableFake(), 'issues', {}, { secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });
  await triageLabels(ctx, { number: 62, title: 'feat: t', body: FORM_BODY, labels: ['type:feat'] }, [], { proposal: true });
  const s = stateOf(jev.requests[0]!);
  assert.deepEqual(s.known_labels, ['type:feat']);
  assert.ok(!('sub_issue_count' in s));
});

test('on-issue（shadow）：agent:ready で問う要求に、イベントの Issue のラベルと sub_issues_summary.total が入る', async () => {
  const jev = fakeJev();
  const shadow: HarnessConfig = { ...fixtureConfig, classification: { ...fixtureConfig.classification, issueTriage: 'shadow' } };
  const event = {
    action: 'labeled', label: { name: 'agent:ready' }, sender: { login: 'me' },
    issue: {
      number: 63, title: 'feat: 材料を足す', body: FORM_BODY, state: 'open',
      labels: [{ name: 'agent:ready' }, { name: 'type:feat' }, { name: 'area:harness' }, { name: 'priority:high' }],
      sub_issues_summary: { total: 3, completed: 0, percent_completed: 0 },
    },
  };
  await onIssue(ctxFor(writableFake(), 'issues', event, { config: shadow, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  assert.equal(jev.requests.length, 1);
  const s = stateOf(jev.requests[0]!);
  assert.deepEqual(s.known_labels, ['area:harness', 'type:feat']);
  assert.equal(s.sub_issue_count, 3);
  assert.equal(s.dependencies, 'x');
});

test('on-issue（shadow）：sub_issues_summary が無ければ sub_issue_count は入らない', async () => {
  const jev = fakeJev();
  const shadow: HarnessConfig = { ...fixtureConfig, classification: { ...fixtureConfig.classification, issueTriage: 'shadow' } };
  const event = {
    action: 'labeled', label: { name: 'agent:ready' }, sender: { login: 'me' },
    issue: { number: 64, title: 'feat: t', body: FORM_BODY, state: 'open', labels: [{ name: 'agent:ready' }, { name: 'type:feat' }] },
  };
  await onIssue(ctxFor(writableFake(), 'issues', event, { config: shadow, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  const s = stateOf(jev.requests[0]!);
  assert.deepEqual(s.known_labels, ['type:feat']);
  assert.ok(!('sub_issue_count' in s));
});
