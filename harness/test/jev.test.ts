import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { buildJevRequest, callJev, jevAllows, redact } from '../lib/jev.ts';

const config = loadConfig();
const facts = { references: 'none', tests: 'none', fileKinds: 'docs' };

test('8問を1回の呼び出しにまとめ、Claude の判定は state に含めない', () => {
  const req = buildJevRequest(config, 'diff --git a/x b/x', ['x'], facts);
  assert.equal(Object.keys(req.questions).length, 8);
  assert.equal((req.questions.q1_risk as { type: string }).type, 'choice');
  const s = JSON.stringify(req.state);
  assert.ok(!s.includes('"level"') && !s.includes('answers'));
});

test('Jev の許可判定：P(low) と各 Noul の閾値', () => {
  const answers = {
    q1_risk: { type: 'choice', probabilities: { low: 0.95, medium: 0.05, high: 0, critical: 0 } },
    q2_revertible: { type: 'noul', noul: 0.97 },
    q3_publicInterface: { type: 'noul', noul: 0.02 },
    q4_tested: { type: 'noul', noul: 0.95 },
    q5_persistentData: { type: 'noul', noul: 0.01 },
    q6_authBillingSecrets: { type: 'noul', noul: 0.01 },
    q7_dependencies: { type: 'noul', noul: 0.0 },
    q8_harnessConfig: { type: 'noul', noul: 0.05 },
  };
  assert.equal(jevAllows(config, answers), true);
  assert.equal(jevAllows(config, { ...answers, q4_tested: { type: 'noul', noul: 0.5 } }), false);
  assert.equal(jevAllows(config, { ...answers, q1_risk: { type: 'choice', probabilities: { low: 0.8 } } }), false);
});

test('callJev：キーなし・大きすぎる diff は skip、応答を記録、エラーは伏せ字', async () => {
  assert.equal((await callJev(config, undefined, 'd', [], facts)).status, 'skipped');
  assert.equal((await callJev(config, 'k', 'x'.repeat(config.jev.maxDiffChars + 1), [], facts)).status, 'skipped');
  const ok = await callJev(config, 'secret-key', 'd', ['x'], facts, async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer secret-key');
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { q1_risk: { type: 'choice', choice: 'low', probabilities: { low: 1 } }, q2_revertible: { type: 'noul', noul: 0.3 } } }));
  });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.allows, false);
  assert.deepEqual(ok.answers?.q2_revertible, { yes: 0.3 });
  const err = await callJev(config, 'secret-key', 'd', [], facts, async () => new Response('bad key secret-key', { status: 401 }));
  assert.equal(err.status, 'error');
  assert.ok(!err.detail!.includes('secret-key'));
  assert.equal(redact('a token123 b', 'token123'), 'a *** b');
});
