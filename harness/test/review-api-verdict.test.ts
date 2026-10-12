// review-api の Reviewer・Risk の出力の検査と判定の組み立て（review-api/src/verdict.ts）が、写した語彙（BLOCKING_KINDS・NOUL・
// RISK_QUESTIONS の key と safe・RISK_LEVELS）が harness/lib の定義と同じこと、pass と blocking の不整合・知らない kind・空の detail・
// 語彙の外の noul と level・空の rationale・facts の欠けなどをパス（reviewer.・risk. の接頭辞つき）つきの誤りで落とし誤りを全部集めること、
// composeShadowVerdict の結果が harness/lib/verdict.ts の parseVerdict を通ること、verdict.ts が import を持たないことを、
// 外部 API を呼ばずに確かめる（Issue #895）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RISK_LEVELS as HARNESS_RISK_LEVELS } from '../lib/config.ts';
import {
  BLOCKING_KINDS as HARNESS_BLOCKING_KINDS,
  NOUL as HARNESS_NOUL,
  RISK_QUESTIONS as HARNESS_RISK_QUESTIONS,
  parseVerdict,
} from '../lib/verdict.ts';
import {
  BLOCKING_KINDS,
  NOUL,
  RISK_LEVELS,
  RISK_QUESTIONS,
  checkReviewerOutput,
  checkRiskOutput,
  composeShadowVerdict,
  type ReviewerOutput,
  type RiskOutput,
} from '../../review-api/src/verdict.ts';

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

const passingReviewer = (): Record<string, any> => ({ pass: true, blocking: [], nonBlocking: ['命名を揃えるとよい'] });
const failingReviewer = (): Record<string, any> => ({
  pass: false,
  blocking: [{ kind: 'bug', file: 'src/a.ts', detail: 'null のときに落ちる' }],
  nonBlocking: [],
  humanNotes: { concerns: ['境界の値'], checkPoints: ['src/a.ts の parse'] },
});
const validRisk = (): Record<string, any> => ({
  level: 'low',
  answers: {
    q2_revertible: 'yes',
    q3_publicInterface: 'no',
    q4_tested: 'yes',
    q5_persistentData: 'no',
    q6_authBillingSecrets: 'no',
    q7_dependencies: 'no',
    q8_harnessConfig: 'no',
  },
  probabilities: { low: 0.8, medium: 0.15, high: 0.05 },
  rationale: '純粋な関数とテストを足すだけ',
  facts: { references: 'src/a.ts は1か所から呼ばれる', tests: 'test/a.test.ts', fileKinds: 'ts' },
});

// errors のどれかが各パスを含むかを見る（文言全体は固定しない）
const assertErrorsWith = (result: { ok: boolean; errors?: string[] }, ...paths: string[]) => {
  assert.equal(result.ok, false, '誤りになる');
  const errors = result.errors ?? [];
  for (const p of paths) assert.ok(errors.some((e) => e.includes(p)), `errors に ${p} がない: ${errors.join(' / ')}`);
};

test('写しの語彙（BLOCKING_KINDS・NOUL・RISK_LEVELS・RISK_QUESTIONS の key と safe）が harness の定義と同じ', () => {
  assert.deepEqual([...BLOCKING_KINDS], [...HARNESS_BLOCKING_KINDS]);
  assert.deepEqual([...NOUL], [...HARNESS_NOUL]);
  assert.deepEqual([...RISK_LEVELS], [...HARNESS_RISK_LEVELS]);
  assert.deepEqual(
    RISK_QUESTIONS.map((q) => ({ key: q.key, safe: q.safe })),
    HARNESS_RISK_QUESTIONS.map((q) => ({ key: q.key, safe: q.safe })),
  );
});

test('正しい Reviewer の出力（合格・不合格）と Risk の出力は通り、値が入力と同じ（nonBlocking が無ければ空の配列）', () => {
  for (const raw of [passingReviewer(), failingReviewer()]) {
    const result = checkReviewerOutput(raw);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.value, raw);
  }
  const noNonBlocking = passingReviewer();
  delete noNonBlocking.nonBlocking;
  const r = checkReviewerOutput(noNonBlocking);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.value.nonBlocking, []);

  const risk = checkRiskOutput(validRisk());
  assert.ok(risk.ok, JSON.stringify(risk));
  assert.deepEqual(risk.value, validRisk());
});

// 1か所ずつ壊した Reviewer の出力と、errors に入るべきパス
const brokenReviewer: { name: string; path: string; base: () => Record<string, any>; mutate: (r: Record<string, any>) => void }[] = [
  { name: 'pass が真なのに blocking がある', path: 'reviewer.pass', base: failingReviewer, mutate: (r) => { r.pass = true; } },
  { name: 'pass が偽なのに blocking が空', path: 'reviewer.pass', base: passingReviewer, mutate: (r) => { r.pass = false; } },
  { name: '知らない kind', path: 'reviewer.blocking[0].kind', base: failingReviewer, mutate: (r) => { r.blocking[0].kind = 'style'; } },
  { name: '空の detail', path: 'reviewer.blocking[0].detail', base: failingReviewer, mutate: (r) => { r.blocking[0].detail = '  '; } },
];

for (const { name, path, base, mutate } of brokenReviewer) {
  test(`Reviewer の出力：${name}は ${path} を含む誤りになる`, () => {
    const raw = structuredClone(base());
    mutate(raw);
    assertErrorsWith(checkReviewerOutput(raw), path);
  });
}

// 1か所ずつ壊した Risk の出力と、errors に入るべきパス
const brokenRisk: { name: string; path: string; mutate: (r: Record<string, any>) => void }[] = [
  { name: '語彙の外の noul', path: 'risk.answers.q2_revertible', mutate: (r) => { r.answers.q2_revertible = 'maybe'; } },
  { name: '語彙の外の level', path: 'risk.level', mutate: (r) => { r.level = 'severe'; } },
  { name: '空の rationale', path: 'risk.rationale', mutate: (r) => { r.rationale = ''; } },
  { name: 'facts の欠け', path: 'risk.facts', mutate: (r) => { delete r.facts; } },
  { name: 'facts の1つが文字列でない', path: 'risk.facts.references', mutate: (r) => { r.facts.references = 3; } },
  { name: 'probabilities が 1 を超える', path: 'risk.probabilities.low', mutate: (r) => { r.probabilities.low = 1.5; } },
];

for (const { name, path, mutate } of brokenRisk) {
  test(`Risk の出力：${name}は ${path} を含む誤りになる`, () => {
    const raw = structuredClone(validRisk());
    mutate(raw);
    assertErrorsWith(checkRiskOutput(raw), path);
  });
}

test('誤りが2つある入力は、最初で止めずに両方の誤りを返す', () => {
  const reviewer = failingReviewer();
  reviewer.blocking[0].kind = 'style';
  reviewer.blocking[0].detail = '';
  assertErrorsWith(checkReviewerOutput(reviewer), 'reviewer.blocking[0].kind', 'reviewer.blocking[0].detail');

  const risk = validRisk();
  risk.level = 'severe';
  risk.rationale = '';
  assertErrorsWith(checkRiskOutput(risk), 'risk.level', 'risk.rationale');
});

// humanNotes・probabilities がある場合と無い場合
const composeCases: { name: string; reviewer: () => Record<string, any>; risk: () => Record<string, any> }[] = [
  { name: 'humanNotes・probabilities あり', reviewer: failingReviewer, risk: validRisk },
  {
    name: 'humanNotes・probabilities なし',
    reviewer: passingReviewer,
    risk: () => { const r = validRisk(); delete r.probabilities; return r; },
  },
];

for (const { name, reviewer: makeReviewer, risk: makeRisk } of composeCases) {
  test(`composeShadowVerdict の結果は parseVerdict を通り、各部が入力と同じ（${name}）`, () => {
    const reviewer = makeReviewer() as ReviewerOutput;
    const risk = makeRisk() as RiskOutput;
    const verdict = composeShadowVerdict({ pr: 42, headSha: HEAD_SHA, reviewer, risk, model: 'claude-opus-5-5' });
    const parsed = parseVerdict(JSON.parse(JSON.stringify(verdict)));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(parsed.value.pr, 42);
    assert.equal(parsed.value.headSha, HEAD_SHA);
    assert.deepEqual(parsed.value.review, reviewer);
    const { facts, ...riskPart } = risk;
    assert.deepEqual(parsed.value.risk, riskPart);
    assert.deepEqual(parsed.value.facts, facts);
    assert.deepEqual(parsed.value.metrics, { model: 'claude-opus-5-5' });
    assert.ok(!('facts' in verdict.risk), 'facts は risk の外に出す');
  });
}

test('verdict.ts は import を持たず、cloudflare:workers・@anthropic-ai/sdk・node: の字を含まない', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/verdict.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  for (const word of ['cloudflare:workers', '@anthropic-ai/sdk', 'node:']) {
    assert.ok(!source.includes(word), `verdict.ts に ${word} がある`);
  }
});
