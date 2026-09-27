import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluatePlanGate, parsePlan } from '../lib/plan.ts';

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
  assert.deepEqual(r.ok && evaluatePlanGate(r.value, 7), { pass: true, reasons: [] });
});

test('plan-critic の定義と、plan 段階の手順がある', () => {
  const agent = readFileSync(new URL('../../.claude/agents/plan-critic.md', import.meta.url), 'utf8');
  for (const v of ['go', 'revise', 'split', 'drop']) assert.match(agent, new RegExp(`\`${v}\``));
  const routine = readFileSync(new URL('../../.claude/routine.md', import.meta.url), 'utf8');
  assert.match(routine, /plan-critic/);
  assert.match(readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8'), /plan-critic/);
});
