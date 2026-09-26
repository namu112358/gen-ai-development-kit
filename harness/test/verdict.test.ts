import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMergeRoute, eligibility, type Acceptance } from '../lib/merge-route.ts';
import { fixAllowed, hasCriticalBlocking, parseVerdict, riskAllowsAutoMerge, RISK_QUESTIONS, type Verdict } from '../lib/verdict.ts';

const safeAnswers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'];

const verdict: Verdict = {
  version: 1,
  pr: 3,
  headSha: 'a'.repeat(40),
  review: { pass: true, blocking: [], nonBlocking: ['命名'] },
  risk: { level: 'low', answers: safeAnswers, rationale: 'docs のみ', probabilities: { low: 0.9 } },
  facts: { references: 'なし', tests: 'test/a.test.ts', fileKinds: 'docs' },
};

test('判定の書式検査', () => {
  assert.ok(parseVerdict(verdict).ok);
  const r = parseVerdict({ ...verdict, headSha: 'abc', review: { pass: true, blocking: [{ kind: 'ac-unmet', detail: 'x' }], nonBlocking: [] } });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => e.includes('headSha')));
  assert.ok(r.errors.some((e) => e.includes('pass が true')));
  const missing = parseVerdict({ ...verdict, risk: { ...verdict.risk, answers: { q2_revertible: 'yes' } } });
  assert.ok(!missing.ok && missing.errors.length === 6);
  assert.ok(!parseVerdict({ ...verdict, review: { pass: false, blocking: [], nonBlocking: [] } }).ok);
});

test('Risk：low かつ全 Noul が安全側のときだけ自動 Merge を許す', () => {
  assert.deepEqual(riskAllowsAutoMerge(verdict.risk), { ok: true, reasons: [] });
  assert.equal(riskAllowsAutoMerge({ ...verdict.risk, level: 'medium' }).ok, false);
  for (const q of RISK_QUESTIONS) {
    for (const answer of ['yes', 'no', 'unsure'] as const) {
      const r = riskAllowsAutoMerge({ ...verdict.risk, answers: { ...safeAnswers, [q.key]: answer } });
      assert.equal(r.ok, answer === q.safe, `${q.key}=${answer}`);
    }
  }
});

test('修正回数：通常2回、3回目は critical のみ', () => {
  const limits = { normalLimit: 2, criticalLimit: 3 };
  assert.equal(fixAllowed(0, false, limits), true);
  assert.equal(fixAllowed(1, false, limits), true);
  assert.equal(fixAllowed(2, false, limits), false);
  assert.equal(fixAllowed(2, true, limits), true);
  assert.equal(fixAllowed(3, true, limits), false);
  assert.equal(hasCriticalBlocking({ ...verdict, review: { pass: false, blocking: [{ kind: 'secret-leak', detail: 'x' }], nonBlocking: [] } }), true);
  assert.equal(hasCriticalBlocking({ ...verdict, review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'x' }], nonBlocking: [] } }), false);
});

const acceptance = (autoEligible: boolean): Acceptance => ({
  version: 1, verdictCommentId: 1, verdictHeadSha: verdict.headSha, patchId: 'p', reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible, reasons: autoEligible ? [] : ['Risk レベルが medium'],
});

test('merge-route：auto-merge なしは通す（Human Merge 経路）', () => {
  const r = evaluateMergeRoute({ autoMergeEnabled: false, isAgentPr: false, hold: true, autoMergeMode: false, acceptance: null });
  assert.equal(r.conclusion, 'success');
});

test('merge-route：auto-merge ありは全条件が揃ったときだけ通す', () => {
  const ok = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance: acceptance(true) };
  assert.equal(evaluateMergeRoute(ok).conclusion, 'success');
  assert.equal(evaluateMergeRoute({ ...ok, acceptance: acceptance(false) }).conclusion, 'failure', 'medium に auto-merge が付いても通さない');
  assert.equal(evaluateMergeRoute({ ...ok, acceptance: null }).conclusion, 'failure', '現在の差分に対する判定がない');
  assert.equal(evaluateMergeRoute({ ...ok, hold: true }).conclusion, 'failure');
  assert.equal(evaluateMergeRoute({ ...ok, autoMergeMode: false }).conclusion, 'failure', 'revert で自動停止中');
  assert.equal(evaluateMergeRoute({ ...ok, isAgentPr: false }).conclusion, 'failure');
});

test('eligibility：Reviewer・Risk・範囲照合・Jev（enforce 時）', () => {
  const risk = riskAllowsAutoMerge(verdict.risk);
  assert.equal(eligibility({ reviewPass: true, risk, scopeOk: true, outside: [] }).autoEligible, true);
  assert.equal(eligibility({ reviewPass: false, risk, scopeOk: true, outside: [] }).autoEligible, false);
  assert.equal(eligibility({ reviewPass: true, risk, scopeOk: false, outside: ['x'] }).autoEligible, false);
  assert.equal(eligibility({ reviewPass: true, risk, scopeOk: true, outside: [], jevGate: { ok: false, reason: 'jev' } }).autoEligible, false);
});
