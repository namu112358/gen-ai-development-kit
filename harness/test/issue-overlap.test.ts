// Issue の下書きの重なりを Jev に問う純粋な関数（harness/lib/issue-overlap.ts）のテスト。Issue #499：
// 組ごとの答えの記録、候補の数の上限と絞り方、問いの大きさの上限、判定、問いの criteria の no、設定
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LABELS, limitErrors, loadConfig, type HarnessConfig } from '../lib/config.ts';
import { measureRequest, type JevAnswers } from '../lib/jev.ts';
import {
  buildIssueOverlapRequest,
  decideOverlap,
  issueOverlapRecord,
  issueOverlapSettings,
  MAX_GOAL_CHARS,
  MAX_REQUEST_CHARS,
  MAX_TITLE_CHARS,
  overlapProbabilities,
  selectOverlapCandidates,
  type OpenIssue,
  type OverlapDraft,
} from '../lib/issue-overlap.ts';

const config = loadConfig();
const draft: OverlapDraft = { title: 'feat(harness): Issue の重なりを Jev に問う', body: '### Goal\n\n重なる Issue を作らない\n' };
const openIssue = (number: number, extra: Partial<OpenIssue> = {}): OpenIssue => ({
  number,
  title: `feat: Jev に問う手順 ${number}`,
  body: `### Goal\n\nIssue ${number} の目的\n`,
  labels: [],
  isPullRequest: false,
  ...extra,
});

test('issueOverlapRecord：(1) 下書きと候補の組ごとの Jev の答えと、セッションの判断との一致が記録に残る', () => {
  const answers: JevAnswers = {
    same_10: { type: 'noul', noul: 0.95 },
    same_11: { type: 'noul', noul: 0.2 },
  };
  const probabilities = overlapProbabilities(answers);
  const decision = decideOverlap({ probability: 0.9 }, probabilities);
  const record = (sessionDuplicateOf: number | null | undefined) =>
    issueOverlapRecord({
      mode: 'shadow',
      model: 'm',
      draftTitle: draft.title,
      issues: [10, 11, 12],
      probabilities,
      decision,
      sessionDuplicateOf,
      size: null,
    });

  const agreed = record(10);
  assert.equal(agreed.draftTitle, draft.title);
  assert.deepEqual(agreed.pairs, [
    { issue: 10, probability: 0.95 },
    { issue: 11, probability: 0.2 },
    { issue: 12, probability: null },
  ]);
  assert.equal(agreed.decision.duplicateOf, 10);
  assert.deepEqual([agreed.sessionDuplicateOf, agreed.agree], [10, true]);
  assert.deepEqual([record(11).sessionDuplicateOf, record(11).agree], [11, false]);
  assert.deepEqual([record(undefined).sessionDuplicateOf, record(undefined).agree], [null, null]);
});

test('selectOverlapCandidates：(2) 候補は設定の上限の数までで、PR・ダッシュボード・epic・重なり0を除き、重なりの多い順（同じなら新しい順）', () => {
  const max = issueOverlapSettings(config).maxCandidates;
  assert.equal(max, 5);
  const overlapping = Array.from({ length: 20 }, (_, i) => openIssue(101 + i));
  const issues = [
    openIssue(1, { title: draft.title }), // 一番重なる
    ...overlapping,
    openIssue(201, { isPullRequest: true }),
    openIssue(202, { title: config.dashboardIssueTitle }),
    openIssue(203, { labels: [LABELS.epic] }),
    openIssue(204, { title: 'chore: zzz qqq' }), // 語も日本語の2-gram も重ならない
  ];

  assert.deepEqual(
    selectOverlapCandidates(draft, issues, config.dashboardIssueTitle, max).map((i) => i.number),
    [1, 120, 119, 118, 117],
  );
  const all = selectOverlapCandidates(draft, issues, config.dashboardIssueTitle, 100).map((i) => i.number);
  assert.deepEqual([...all].sort((a, b) => a - b), [1, ...overlapping.map((i) => i.number)]);
});

test('buildIssueOverlapRequest：(3) 問いの大きさは上限を超えず、外すのは末尾の候補から。候補0件なら問わない', () => {
  const full = (number: number): OpenIssue =>
    openIssue(number, {
      title: `t${number} `.padEnd(MAX_TITLE_CHARS, '題'),
      body: `### Goal\n\n${'的'.repeat(MAX_GOAL_CHARS)}\n`,
    });
  const candidates = Array.from({ length: 12 }, (_, i) => full(301 + i));

  // 前提：外す前の12件の要求は上限を超える（1件と2件の大きさから見積もる）
  const sizeOf = (n: number) => {
    const r = buildIssueOverlapRequest(config, draft, candidates.slice(0, n));
    assert.equal(r.ask, true);
    if (!r.ask) return 0;
    assert.equal(r.issues.length, n);
    return measureRequest(r.request).chars;
  };
  const one = sizeOf(1);
  const perCandidate = sizeOf(2) - one;
  assert.ok(one + perCandidate * 11 > MAX_REQUEST_CHARS, `${one} + ${perCandidate} * 11`);

  const r = buildIssueOverlapRequest(config, draft, candidates);
  assert.equal(r.ask, true);
  if (!r.ask) return;
  assert.ok(measureRequest(r.request).chars <= MAX_REQUEST_CHARS, String(measureRequest(r.request).chars));
  assert.ok(r.issues.length >= 1 && r.issues.length < 12, String(r.issues.length));
  assert.deepEqual(r.issues, candidates.slice(0, r.issues.length).map((i) => i.number));
  assert.deepEqual(Object.keys(r.request.questions).sort(), r.issues.map((n) => `same_${n}`).sort());

  assert.equal(buildIssueOverlapRequest(config, draft, []).ask, false);
});

const decisions: { name: string; probability: number | null; probabilities: Record<string, number>; duplicateOf: number | null }[] = [
  { name: '下限未満なら決めない', probability: 0.9, probabilities: { '10': 0.5, '11': 0.3 }, duplicateOf: null },
  { name: '下限以上なら確率の1番目の Issue', probability: 0.9, probabilities: { '10': 0.3, '11': 0.95 }, duplicateOf: 11 },
  { name: '下限が未設定なら決めない', probability: null, probabilities: { '10': 0.99 }, duplicateOf: null },
];
for (const d of decisions) {
  test(`decideOverlap：(4) ${d.name}`, () => {
    assert.equal(decideOverlap({ probability: d.probability }, d.probabilities).duplicateOf, d.duplicateOf);
  });
}

test('buildIssueOverlapRequest：(5) 各問いの criteria.false に同じ領域・分からないが no と書かれている', () => {
  const r = buildIssueOverlapRequest(config, draft, [openIssue(10), openIssue(11)]);
  assert.equal(r.ask, true);
  if (!r.ask) return;
  const questions = Object.values(r.request.questions);
  assert.equal(questions.length, 2);
  for (const q of questions) {
    for (const word of [/same area/i, /cannot tell/i]) assert.match(q.criteria.false, word);
    assert.match(q.instructions, /answer no/i);
  }
});

test('設定：(6) 2つの harness.config.json の値と、キーの無い設定の既定', () => {
  const read = (rel: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8'));
  for (const rel of ['harness.config.json', 'harness/templates/harness.config.json']) {
    const jev = read(rel).jev;
    assert.deepEqual(
      [jev?.issueOverlap, jev?.issueOverlapMaxCandidates, jev?.thresholds?.issueOverlapProbability],
      ['shadow', 5, 0.9],
      rel,
    );
  }
  const { issueOverlap: _m, issueOverlapMaxCandidates: _c, ...jev } = config.jev as HarnessConfig['jev'] & Record<string, unknown>;
  const { issueOverlapProbability: _p, ...thresholds } = config.jev.thresholds as HarnessConfig['jev']['thresholds'] & Record<string, unknown>;
  const bare = { ...config, jev: { ...jev, thresholds } } as HarnessConfig;
  assert.deepEqual(issueOverlapSettings(bare), { mode: 'shadow', maxCandidates: 5, probability: 0.9 });
});

test('設定：(7) limitErrors が jev.issueOverlapMaxCandidates: 0 を誤りにする', () => {
  const bad = { ...config, jev: { ...config.jev, issueOverlapMaxCandidates: 0 } };
  assert.ok(limitErrors(bad).some((e) => e.includes('jev.issueOverlapMaxCandidates')), JSON.stringify(limitErrors(bad)));
});
