import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { JEV_NOUL_QUESTIONS, JEV_QUESTION_SET, buildJevRequest, callJev, flattenAnswers, jevAllows, jevFailures } from '../lib/jev.ts';
import type { JevAnswers } from '../lib/jev.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';

const config = loadConfig();
const LOW = config.jev.thresholds.lowProbability;
const SAFE = config.jev.thresholds.noulSafe;
const facts = { references: 'r', tests: 't', fileKinds: 'k' };

/** 問いのキーの順（q1_risk、続けて RISK_QUESTIONS の順） */
const ALL_KEYS = ['q1_risk', ...RISK_QUESTIONS.map((q) => q.key)];
/** yes が安全な問い */
const YES_SAFE = RISK_QUESTIONS.filter((q) => q.safe === 'yes').map((q) => q.key);
/** no が安全な問い */
const NO_SAFE = RISK_QUESTIONS.filter((q) => q.safe === 'no').map((q) => q.key);

/** CJK 文字（全角記号・かな・漢字・全角英数） */
const CJK = /[　-鿿＀-￯]/;

/** すべての問いがしきい値を満たす記録用の形 */
function safeFlat(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = { q1_risk: { low: 0.97, medium: 0.03, high: 0, critical: 0 } };
  for (const k of YES_SAFE) out[k] = { yes: 0.97 };
  for (const k of NO_SAFE) out[k] = { yes: 0.02 };
  return out;
}

/** すべての問いがしきい値を満たす Jev の答え */
function safeAnswers(): JevAnswers {
  const out: JevAnswers = { q1_risk: { type: 'choice', choice: 'low', probabilities: { low: 0.97, medium: 0.03, high: 0, critical: 0 } } };
  for (const k of YES_SAFE) out[k] = { type: 'noul', noul: 0.97 };
  for (const k of NO_SAFE) out[k] = { type: 'noul', noul: 0.02 };
  return out;
}

type NoulQuestion = { type: string; instructions: string; criteria?: Record<string, string> };

test('問いの版は 2', () => {
  assert.equal(JEV_QUESTION_SET, 2);
});

test('buildJevRequest：問いは 8 個で、q2〜q8 は JEV_NOUL_QUESTIONS の instructions・criteria を持つ noul', () => {
  const req = buildJevRequest(config, 'diff --git a/x b/x', ['x'], facts);
  assert.deepEqual(Object.keys(req.questions).sort(), [...ALL_KEYS].sort());
  assert.deepEqual(Object.keys(JEV_NOUL_QUESTIONS).sort(), RISK_QUESTIONS.map((q) => q.key).sort());
  for (const q of RISK_QUESTIONS) {
    const got = req.questions[q.key] as NoulQuestion;
    const def = JEV_NOUL_QUESTIONS[q.key]!;
    assert.equal(got.type, 'noul', q.key);
    assert.equal(got.instructions, def.instructions, q.key);
    assert.deepEqual(got.criteria, def.criteria, q.key);
  }
});

test('buildJevRequest：criteria は q2・q3・q5・q6 にだけあり（true・false の英文）、q4・q7・q8 にはキーごと無い', () => {
  const req = buildJevRequest(config, 'd', ['x'], facts);
  for (const key of ['q2_revertible', 'q3_publicInterface', 'q5_persistentData', 'q6_authBillingSecrets']) {
    const q = req.questions[key] as NoulQuestion;
    assert.ok(q.criteria, `${key} に criteria が無い`);
    assert.deepEqual(Object.keys(q.criteria).sort(), ['false', 'true'], key);
    assert.ok(q.criteria.true!.trim().length > 0, key);
    assert.ok(q.criteria.false!.trim().length > 0, key);
  }
  for (const key of ['q4_tested', 'q7_dependencies', 'q8_harnessConfig']) {
    const q = req.questions[key] as Record<string, unknown>;
    assert.ok(!('criteria' in q), `${key} に criteria キーがある`);
  }
});

test('buildJevRequest：q1_risk は choice のままで、criteria は low・medium・high・critical', () => {
  const q1 = buildJevRequest(config, 'd', [], facts).questions.q1_risk as NoulQuestion;
  assert.equal(q1.type, 'choice');
  assert.deepEqual(Object.keys(q1.criteria ?? {}).sort(), ['critical', 'high', 'low', 'medium']);
});

test('buildJevRequest：すべての instructions・criteria（q1 も含む）に CJK 文字が無い', () => {
  const req = buildJevRequest(config, 'd', [], facts);
  for (const [key, raw] of Object.entries(req.questions)) {
    const q = raw as NoulQuestion;
    assert.ok(!CJK.test(q.instructions), `${key} の instructions に CJK 文字: ${q.instructions}`);
    for (const [c, text] of Object.entries(q.criteria ?? {})) {
      assert.ok(!CJK.test(text), `${key} の criteria.${c} に CJK 文字: ${text}`);
    }
  }
});

test('buildJevRequest：書き直した q2・q5 の文（diff と git revert をバッククォートで囲む）', () => {
  const req = buildJevRequest(config, 'd', [], facts);
  assert.equal(
    (req.questions.q2_revertible as NoulQuestion).instructions,
    'Would running `git revert` on this change restore the state from before the change?',
  );
  assert.equal(
    (req.questions.q5_persistentData as NoulQuestion).instructions,
    'Does `diff` add or change code that writes, deletes, or migrates persistent data?',
  );
});

test('buildJevRequest：q3・q6 の instructions は今の文のまま', () => {
  const req = buildJevRequest(config, 'd', [], facts);
  assert.equal(
    (req.questions.q3_publicInterface as NoulQuestion).instructions,
    'Judging from `diff` only: does this change modify something that is exported, that other modules may use, or the shape of a configuration, schema, API, or event format? If so, answer yes.',
  );
  assert.equal(
    (req.questions.q6_authBillingSecrets as NoulQuestion).instructions,
    'Does this change touch authentication, authorization, billing, or secrets?',
  );
});

test('callJev：status ok の記録に問いの版（JEV_QUESTION_SET）が入る', async () => {
  const ok = await callJev(config, 'secret-key', 'd', ['x'], facts, async () =>
    new Response(JSON.stringify({ model: 'jev-1.13.0', answers: safeAnswers() })),
  );
  assert.equal(ok.status, 'ok');
  assert.equal(ok.questionSet, JEV_QUESTION_SET);
  assert.equal(ok.allows, true);
});

test('jevFailures：すべて満たせば []', () => {
  assert.deepEqual(jevFailures(config, safeFlat()), []);
});

test('jevFailures：flat が undefined ならすべての問いが q1_risk、q2〜q8 の順で落ちる', () => {
  assert.deepEqual(jevFailures(config, undefined), ALL_KEYS);
});

test('jevFailures：q1_risk は P(low) がしきい値未満で落ち、ちょうどなら通る', () => {
  const f = safeFlat();
  f.q1_risk = { low: LOW - 0.01 };
  assert.deepEqual(jevFailures(config, f), ['q1_risk']);
  f.q1_risk = { low: LOW };
  assert.deepEqual(jevFailures(config, f), []);
});

test('jevFailures：yes が安全な問い（q2・q4）は yes がしきい値未満で落ち、ちょうどなら通る', () => {
  assert.deepEqual(YES_SAFE, ['q2_revertible', 'q4_tested']);
  for (const k of YES_SAFE) {
    const f = safeFlat();
    f[k] = { yes: SAFE - 0.01 };
    assert.deepEqual(jevFailures(config, f), [k], k);
    f[k] = { yes: SAFE };
    assert.deepEqual(jevFailures(config, f), [], k);
  }
});

test('jevFailures：no が安全な問い（q3・q5〜q8）は yes が 1 − しきい値を超えると落ちる', () => {
  assert.deepEqual(NO_SAFE, ['q3_publicInterface', 'q5_persistentData', 'q6_authBillingSecrets', 'q7_dependencies', 'q8_harnessConfig']);
  for (const k of NO_SAFE) {
    const f = safeFlat();
    f[k] = { yes: 1 - SAFE + 0.05 };
    assert.deepEqual(jevFailures(config, f), [k], k);
    f[k] = { yes: 0.05 };
    assert.deepEqual(jevFailures(config, f), [], k);
  }
});

test('jevFailures：値が無い・キーごと無い・NaN の問いは落ちる', () => {
  const noLow = safeFlat();
  noLow.q1_risk = { medium: 1 };
  assert.deepEqual(jevFailures(config, noLow), ['q1_risk']);

  const noKey = safeFlat();
  delete noKey.q4_tested;
  assert.deepEqual(jevFailures(config, noKey), ['q4_tested']);

  const nan = safeFlat();
  nan.q7_dependencies = { yes: NaN };
  assert.deepEqual(jevFailures(config, nan), ['q7_dependencies']);

  const nanLow = safeFlat();
  nanLow.q1_risk = { low: NaN };
  assert.deepEqual(jevFailures(config, nanLow), ['q1_risk']);
});

test('jevFailures：複数落ちたときは q1_risk、q2〜q8 の順で返す', () => {
  const f = safeFlat();
  f.q8_harnessConfig = { yes: 0.8 };
  f.q2_revertible = { yes: 0.1 };
  f.q1_risk = { low: 0.2 };
  f.q5_persistentData = { yes: 0.5 };
  assert.deepEqual(jevFailures(config, f), ['q1_risk', 'q2_revertible', 'q5_persistentData', 'q8_harnessConfig']);
});

test('jevAllows：結果は今と同じ（すべて安全で true、1問でも外れる・欠けると false）', () => {
  const base = safeAnswers();
  assert.equal(jevAllows(config, base), true);
  // 境界ちょうどは通る
  assert.equal(jevAllows(config, { ...base, q2_revertible: { type: 'noul', noul: SAFE }, q1_risk: { type: 'choice', probabilities: { low: LOW } } }), true);
  // 1問だけ境界の外
  assert.equal(jevAllows(config, { ...base, q4_tested: { type: 'noul', noul: SAFE - 0.01 } }), false);
  assert.equal(jevAllows(config, { ...base, q3_publicInterface: { type: 'noul', noul: 1 - SAFE + 0.05 } }), false);
  assert.equal(jevAllows(config, { ...base, q1_risk: { type: 'choice', probabilities: { low: LOW - 0.01 } } }), false);
  // q1 の probabilities.low が欠ける
  assert.equal(jevAllows(config, { ...base, q1_risk: { type: 'choice', probabilities: { medium: 1 } } }), false);
  // Noul の noul が無い
  assert.equal(jevAllows(config, { ...base, q6_authBillingSecrets: { type: 'noul' } }), false);
  // キーごと欠ける
  const missing = { ...base };
  delete missing.q8_harnessConfig;
  assert.equal(jevAllows(config, missing), false);
});

test('jevAllows は jevFailures(config, flattenAnswers(answers)) が空であることと一致する', () => {
  const base = safeAnswers();
  const missing = { ...base };
  delete missing.q2_revertible;
  const cases: JevAnswers[] = [
    base,
    { ...base, q5_persistentData: { type: 'noul', noul: 0.5 } },
    { ...base, q1_risk: { type: 'choice', probabilities: { medium: 1 } } },
    { ...base, q7_dependencies: { type: 'noul' } },
    missing,
  ];
  for (const a of cases) assert.equal(jevAllows(config, a), jevFailures(config, flattenAnswers(a)).length === 0);
});
