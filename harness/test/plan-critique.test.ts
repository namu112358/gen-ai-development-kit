import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluatePlanGate, parsePlan } from '../lib/plan.ts';

/** ガードレールを問わないテスト用（一覧自身だけが当たる） */
const noGuardrail = { guardrailPaths: [] };

const base = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['src/lib/foo.ts'] };

test('critique は任意。あれば verdict と rounds を読む', () => {
  const none = parsePlan(base);
  assert.ok(none.ok && none.value.critique === undefined);
  const withCritique = parsePlan({ ...base, critique: { verdict: 'go', rounds: 2 } });
  assert.ok(withCritique.ok);
  assert.deepEqual(withCritique.ok && withCritique.value.critique, { verdict: 'go', rounds: 2 });
});

test('critique の書式違いは拒否する', () => {
  for (const critique of [{ verdict: 'ok', rounds: 1 }, { verdict: 'go', rounds: 0 }, { verdict: 'go', rounds: 1.5 }, { verdict: 'go' }, 'go']) {
    const r = parsePlan({ ...base, critique });
    assert.equal(r.ok, false, JSON.stringify(critique));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('plan.critique')), JSON.stringify(critique));
  }
});

test('critique はゲートの判断に使わない（revise のままでも他の条件だけで決まる）', () => {
  const r = parsePlan({ ...base, critique: { verdict: 'revise', rounds: 1 } });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && evaluatePlanGate(r.value, 7, noGuardrail), { pass: true, reasons: [] });
});

test('plan-critic の定義と、plan 段階の手順がある', () => {
  const agent = readFileSync(new URL('../../.claude/agents/plan-critic.md', import.meta.url), 'utf8');
  for (const v of ['go', 'revise', 'split', 'drop']) assert.match(agent, new RegExp(`\`${v}\``));
  const routine = readFileSync(new URL('../../.claude/routine.md', import.meta.url), 'utf8');
  assert.match(routine, /plan-critic/);
  assert.match(readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8'), /plan-critic/);
});

test('critique の mustRemaining は任意。あれば 0 以上の整数', () => {
  const none = parsePlan({ ...base, critique: { verdict: 'go', rounds: 1 } });
  assert.ok(none.ok && none.value.critique?.mustRemaining === undefined);
  for (const mustRemaining of [0, 2]) {
    const r = parsePlan({ ...base, critique: { verdict: 'revise', rounds: 3, mustRemaining } });
    assert.ok(r.ok, JSON.stringify(mustRemaining));
    assert.deepEqual(r.ok && r.value.critique, { verdict: 'revise', rounds: 3, mustRemaining });
  }
  for (const mustRemaining of [-1, 1.5, '1', null]) {
    const r = parsePlan({ ...base, critique: { verdict: 'go', rounds: 1, mustRemaining } });
    assert.equal(r.ok, false, JSON.stringify(mustRemaining));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('plan.critique.mustRemaining')), JSON.stringify(mustRemaining));
  }
});

test('mustRemaining もゲートの判断に使わない', () => {
  const r = parsePlan({ ...base, critique: { verdict: 'revise', rounds: 3, mustRemaining: 2 } });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && evaluatePlanGate(r.value, 7, noGuardrail), { pass: true, reasons: [] });
});

test('plan-critic は fixes を必須・推奨に分け、revise は必須があるときだけ', () => {
  const agent = readFileSync(new URL('../../.claude/agents/plan-critic.md', import.meta.url), 'utf8');
  assert.match(agent, /"severity": "must \| should"/);
  assert.match(agent, /`must`（必須）/);
  assert.match(agent, /`should`（推奨）/);
  assert.match(agent, /`revise`：必須の指摘がある/);
  assert.match(agent, /推奨だけで `revise` にしない/);
});

test('plan 段階の止める条件は堂々巡りと3回目の上限で、有人セッションではその場で聞く', () => {
  const routine = readFileSync(new URL('../../.claude/routine.md', import.meta.url), 'utf8');
  assert.match(routine, /前回と同じ必須の指摘が直っていない/);
  assert.match(routine, /3回目でも必須が残る/);
  assert.doesNotMatch(routine, /2回続けて `revise`/);
  const claude = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');
  assert.match(claude, /前回と同じ必須の指摘が直っていない/);
  assert.match(claude, /3回目でも必須が残る/);
  assert.match(claude, /「進める／直す／やめる」を聞く/);
});
