import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { guardrailFiles, guardrailPatterns } from '../lib/guardrail.ts';
import { buildJevRequest } from '../lib/jev.ts';
import { evaluatePlanGate, type Plan } from '../lib/plan.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';

const config = loadConfig();
const small = { guardrailPaths: ['harness/lib/**', '.github/**'], guardrailExclude: ['harness/lib/usage.ts', 'harness.config.json'] };

test('変更ファイル：一覧に当たり除外に当たらないもの。一覧自身は除外できない', () => {
  assert.deepEqual(guardrailFiles(small, ['harness/lib/plan.ts', 'harness/lib/usage.ts', 'docs/a.md', '.github/workflows/ci.yml']), ['.github/workflows/ci.yml', 'harness/lib/plan.ts']);
  assert.deepEqual(guardrailFiles(small, ['harness.config.json']), ['harness.config.json'], '一覧に無く除外に書いても当たる');
  assert.deepEqual(guardrailFiles({ guardrailPaths: [] }, ['harness.config.json', 'x.ts']), ['harness.config.json']);
});

test('guardrailPaths が無い設定では、すべてのファイルとパターンが当たる', () => {
  assert.deepEqual(guardrailFiles({}, ['docs/a.md', 'src/x.ts']), ['docs/a.md', 'src/x.ts']);
  assert.deepEqual(guardrailPatterns({ guardrailExclude: ['docs/**'] }, ['docs/**']), ['docs/**']);
  assert.equal(evaluatePlanGate({ ...plan, files: ['docs/a.md'] }, 7, {}).pass, false);
});

test('初期の一覧：Issue の表どおり', () => {
  const hit = ['.github/workflows/gate.yml', '.github/ISSUE_TEMPLATE/agent-task.yml', '.claude/settings.json', 'harness/templates/x.json', '.claude/agents/reviewer.md', '.claude/agents/risk-agent.md', 'docs/risk-policy.md', 'harness/gates/run.ts', 'harness/lib/plan.ts', 'harness/lib/epic.ts', 'harness/lib/test-tamper.ts', 'harness/lib/guardrail.ts', 'harness/scripts/setup.ts', 'harness.config.json', 'package.json', 'package-lock.json', '.node-version', 'tsconfig.json', '.claude/hooks/pre.sh', '.mcp.json', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/CODEOWNERS'];
  const miss = ['harness/lib/usage.ts', 'harness/lib/classify.ts', 'harness/lib/worktree.ts', 'harness/lib/issue-triage.ts', 'harness/lib/queue.ts', 'harness/lib/facts.ts', 'harness/lib/concurrency.ts', 'harness/scripts/agent.ts', 'harness/scripts/report.ts', 'harness/test/plan.test.ts', '.claude/routine.md', '.claude/agents/plan-critic.md', '.claude/agents/test-designer.md', '.claude/skills/x/SKILL.md', 'CLAUDE.md', 'docs/plan.md'];
  assert.deepEqual(guardrailFiles(config, [...hit, ...miss]), [...hit].sort());
});

test('計画のパターン：重なりうれば当たり、除外に完全に含まれるときだけ外す', () => {
  const r = (p: string) => guardrailPatterns(config, [p]).length > 0;
  for (const p of ['harness/lib/**', 'harness/**', 'harness/lib/*.ts', 'harness/scripts/*.ts', 'docs/**', 'docs/*.md', '.github/workflows/x.yml', 'harness.config.json', 'harness/gates/**/a.ts']) assert.equal(r(p), true, p);
  for (const p of ['harness/lib/usage.ts', 'harness/test/**', 'harness/scripts/agent.ts', 'docs/plan.md', 'src/**', '.claude/routine.md', 'CLAUDE.md']) assert.equal(r(p), false, p);
  assert.equal(guardrailPatterns({ guardrailPaths: ['a/**'], guardrailExclude: ['a/b/**'] }, ['a/b/**']).length, 0, '除外と同じパターン');
  assert.equal(guardrailPatterns({ guardrailPaths: ['a/**'], guardrailExclude: ['a/b/**'] }, ['a/b/*.ts']).length, 1, '除外に含まれうるワイルドカードでも同じパターンでなければ当たる');
  assert.equal(guardrailPatterns({ guardrailPaths: ['a/**'], guardrailExclude: ['harness.config.json'] }, ['harness.config.json']).length, 1, '一覧自身');
});

const plan: Plan = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/plan.md'] };

test('計画ゲート：files がガードレールに触れると、想定 Risk が low でも止める', () => {
  assert.deepEqual(evaluatePlanGate(plan, 7, config), { pass: true, reasons: [] });
  const r = evaluatePlanGate({ ...plan, files: ['docs/plan.md', 'harness/lib/**'] }, 7, config);
  assert.equal(r.pass, false);
  assert.deepEqual(r.guardrail, ['harness/lib/**']);
  assert.match(r.reasons.join('\n'), /ガードレールに触れます.*harness\/lib\/\*\*/);
  assert.equal(evaluatePlanGate({ ...plan, files: ['harness.config.json'] }, 7, config).pass, false, '一覧自身の変更');
});

test('計画ゲート：split の子課題の files はガードレールの判定に使わない（#94）', () => {
  const child = (files: string[]) => ({ title: 'docs: x', goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files, dependsOn: [] });
  const split = { ...plan, risk: 'critical' as const, files: [], split: [child(['docs/a.md']), child(['src/**'])] };
  assert.deepEqual(evaluatePlanGate(split, 7, config), { pass: true, reasons: [] });
  const guarded = evaluatePlanGate({ ...split, split: [child(['docs/a.md']), child(['harness/gates/x.ts'])] }, 7, config);
  assert.equal(guarded.pass, true);
  assert.equal(guarded.splitInvalid, undefined);
  assert.equal(guarded.guardrail, undefined);
});

test('質問8の文言が risk-policy.md・verdict.ts・risk-agent.md・Jev でそろっている', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const jev = buildJevRequest(config, '', [], { references: '', tests: '', fileKinds: '' }).questions as Record<string, { instructions?: string; criteria?: Record<string, string> }>;
  const texts = {
    'risk-policy.md': read('docs/risk-policy.md').split('\n').find((l) => l.includes('`q8_harnessConfig`') && l.startsWith('| 8'))!,
    'verdict.ts': RISK_QUESTIONS.find((q) => q.key === 'q8_harnessConfig')!.text,
    'risk-agent.md': read('.claude/agents/risk-agent.md').split('\n').find((l) => l.includes('質問8'))!,
    'jev q8': jev.q8_harnessConfig!.instructions!,
  };
  for (const [where, text] of Object.entries(texts)) {
    assert.ok(text, where);
    assert.match(text, /guardrailPaths|guardrail_paths/, where);
    assert.ok(!text.includes('harness/**') && !/\.claude\/\*\*.*harness\.config\.json/.test(text), `${where} に旧来のパスの列挙が残っています`);
  }
  assert.match(jev.q1_risk!.criteria!.critical!, /guardrailPaths/);
  assert.match(read('docs/risk-policy.md'), /\*\*critical\*\*：ガードレール、権限、秘密情報、依存関係/);
});
