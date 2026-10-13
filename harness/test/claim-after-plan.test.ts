// Issue #193：post-plan の後の着手宣言。ゲートを通る見込みなら plan-gate を出し直し、agent:plan-review で止まる見込みなら解除する
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeMark, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { claimOf } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import { evaluatePlanGate, type Plan } from '../lib/plan.ts';
import { claimAfterPlan, claimBlocker, claimValueAfterPlan, isOwnClaim, requireOwnClaim, type Claim } from '../lib/queue.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
const ISSUE = 3;

const config = loadConfig();
const now = new Date('2026-09-26T12:00:00Z');
const opts = { takeover: false, now, humanClaimStaleHours: config.routine.humanClaimStaleHours };
const base: Extract<Claim, { by: 'manual' }> = { by: 'manual', at: '2026-09-26T11:00:00Z', session: SESSION };

const plan = (patch: Partial<Plan> = {}): Plan => ({
  version: 1,
  issue: ISSUE,
  risk: 'low',
  needsHuman: false,
  needsHumanReasons: [],
  acChangeProposed: false,
  openQuestions: [],
  files: ['harness/docs/operations.md'],
  ...patch,
});

// ---- claimAfterPlan ----

test('claimAfterPlan：ゲートを通る見込みなら plan-gate、通らない見込みなら release', () => {
  assert.equal(claimAfterPlan({ pass: true }), 'plan-gate');
  assert.equal(claimAfterPlan({ pass: false }), 'release');
});

// ---- evaluatePlanGate と組み合わせる ----

test('claimAfterPlan：ガードレールに触れない low の計画は plan-gate', () => {
  const gate = evaluatePlanGate(plan(), ISSUE, config);
  assert.equal(gate.pass, true, '前提：ゲートを通る計画');
  assert.equal(claimAfterPlan(gate), 'plan-gate');
});

test('claimAfterPlan：agent:plan-review で止まる計画は release', () => {
  for (const [label, p] of [
    ['ガードレールに触れる', plan({ files: ['CLAUDE.md', 'harness/docs/operations.md'] })],
    ['ガードレールに触れる（harness/scripts/agent.ts）', plan({ files: ['harness/scripts/agent.ts'] })],
    ['risk critical', plan({ risk: 'critical' })],
    ['risk high', plan({ risk: 'high' })],
    ['needsHuman', plan({ needsHuman: true, needsHumanReasons: ['人が決める'] })],
    ['未解決の質問', plan({ openQuestions: ['どちらにするか'] })],
    ['AC の変更提案', plan({ acChangeProposed: true })],
  ] as const) {
    const gate = evaluatePlanGate(p, ISSUE, config);
    assert.equal(gate.pass, false, `前提：ゲートで止まる計画: ${label}`);
    assert.equal(claimAfterPlan(gate), 'release', label);
  }
});

// ---- claimValueAfterPlan ----

test('claimValueAfterPlan：plan-gate なら段階 plan-gate の宣言、release なら解除の値', () => {
  assert.deepEqual(claimValueAfterPlan({ pass: true }, base), { ...base, stage: 'plan-gate' });
  const released = claimValueAfterPlan({ pass: false }, base);
  assert.deepEqual(released, { ...base, released: true });
  assert.equal(isOwnClaim(released, SESSION), false, '解除した宣言は自分の宣言として残らない');
});

// Issue #171：--takeover の印は引き継いだときの宣言だけのもの。post-plan の宣言し直しには持ち越さない
test('claimValueAfterPlan：base に takeover があっても、plan-gate・release のどちらの値にも持ち越さない', () => {
  const taken: Extract<Claim, { by: 'manual' }> = { ...base, stage: 'plan-critique', takeover: true };
  for (const gate of [{ pass: true }, { pass: false }]) {
    const v = claimValueAfterPlan(gate, taken);
    assert.equal('takeover' in v, false, `pass=${gate.pass}`);
    assert.equal(v.session, SESSION);
  }
  assert.deepEqual(claimValueAfterPlan({ pass: true }, taken), { ...base, stage: 'plan-gate' });
  assert.deepEqual(claimValueAfterPlan({ pass: false }, taken), { ...base, stage: 'plan-critique', released: true });
});

// ---- post-plan が投稿するコメントの並びで claimOf が返すもの ----

let nextId = 1;
function comment(body: string): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:00:${String(id).padStart(2, '0')}Z`, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}
const claimComment = (value: Claim) => comment(`${claudeMark(SESSION)}\n着手宣言です。\n\n${renderBlock('agent-claim', value)}`);
const planComment = (p: Plan) => comment(`${claudeMark(SESSION)}\n## 計画\n\n${renderBlock('agent-plan', p)}`);

/** post-plan の後の Issue のコメント：critique 中の宣言 → 計画 → post-plan の宣言 */
function afterPostPlan(p: Plan): IssueComment[] {
  const gate = evaluatePlanGate(p, ISSUE, config);
  return [
    claimComment({ ...base, at: '2026-09-26T10:00:00Z', stage: 'plan-critique' }),
    planComment(p),
    claimComment(claimValueAfterPlan(gate, base)),
  ];
}

test('post-plan の後：agent:plan-review で止まる計画では宣言が残らず、どのセッションも implement を宣言できる', () => {
  for (const p of [plan({ files: ['CLAUDE.md'] }), plan({ risk: 'critical' }), plan({ needsHuman: true, needsHumanReasons: ['x'] })]) {
    const c = claimOf(afterPostPlan(p));
    assert.equal(c, null, `宣言が残らない: ${JSON.stringify(p.files)} / ${p.risk} / ${p.needsHuman}`);
    assert.equal(isOwnClaim(c, SESSION), false);
    assert.equal(claimBlocker(c, SESSION, opts), null, '同じセッションが claim --stage implement できる');
    assert.equal(claimBlocker(c, OTHER, opts), null, '別のセッションが claim --stage implement できる');
    assert.equal(claimBlocker(c, null, opts), null, 'セッションが分からなくても止めない');
  }
});

test('post-plan の後：ゲートを通る見込みの計画では、同じセッションの plan-gate の宣言が有効に残る', () => {
  const c = claimOf(afterPostPlan(plan()));
  assert.deepEqual(c, { ...base, stage: 'plan-gate' });
  assert.equal(isOwnClaim(c, SESSION), true);
  assert.deepEqual(requireOwnClaim(c, SESSION), { error: null, warning: null });
  assert.equal(claimBlocker(c, SESSION, opts), null, '同じセッションは段階を進められる');
  assert.ok(claimBlocker(c, OTHER, opts), '別のセッションは止められる');
});
