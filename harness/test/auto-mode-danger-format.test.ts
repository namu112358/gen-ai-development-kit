// auto mode の危険の判定（Claude）の書式：計画の critique.danger・判定の risk.danger の検査、compose-verdict の写し、定義と手順の文書（Issue #343）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { parsePlan } from '../lib/plan.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, riskAllowsAutoMerge, RISK_QUESTIONS, type Verdict } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const validDangers = [
  { answer: 'yes', reason: 'ゲートの判定を変える' },
  { answer: 'no', reason: 'docs のみ' },
  { answer: 'unsure', reason: '判断できない' },
];
const invalidDangers: unknown[] = [
  'yes',
  null,
  [],
  1,
  { answer: 'maybe', reason: 'x' },
  { answer: 'yes' },
  { reason: 'x' },
  { answer: 'yes', reason: '' },
  { answer: 'yes', reason: 1 },
  { answer: 'yes', reason: 'x', extra: true },
];

// ---- 計画の critique.danger

const planBase = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['src/lib/foo.ts'] };
const critique = { verdict: 'go', rounds: 1 };

test('計画：critique.danger が正しければ通り、値を読む', () => {
  for (const danger of validDangers) {
    const r = parsePlan({ ...planBase, critique: { ...critique, danger } });
    assert.ok(r.ok, JSON.stringify(danger));
    assert.deepEqual(r.ok && r.value.critique, { ...critique, danger });
  }
});

test('計画：critique.danger の無い古い計画も読める（キーは無い）', () => {
  const r = parsePlan({ ...planBase, critique });
  assert.ok(r.ok);
  assert.equal(r.ok && r.value.critique?.danger, undefined);
  assert.ok(r.ok && r.value.critique !== undefined && !('danger' in r.value.critique));
});

test('計画：critique.danger の書式違いは拒否する', () => {
  for (const danger of invalidDangers) {
    const r = parsePlan({ ...planBase, critique: { ...critique, danger } });
    assert.equal(r.ok, false, JSON.stringify(danger));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('plan.critique.danger')), JSON.stringify(danger));
  }
});

// ---- 判定の risk.danger

const safeAnswers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'];
const verdict: Verdict = {
  version: 1,
  pr: 3,
  headSha: 'a'.repeat(40),
  review: { pass: true, blocking: [], nonBlocking: [] },
  risk: { level: 'low', answers: safeAnswers, rationale: 'docs のみ' },
  facts: { references: 'なし', tests: 'なし', fileKinds: 'docs' },
};

test('判定：risk.danger が正しければ通り、値を読む', () => {
  for (const danger of validDangers) {
    const r = parseVerdict({ ...verdict, risk: { ...verdict.risk, danger } });
    assert.ok(r.ok, JSON.stringify(danger));
    assert.deepEqual((r.ok && (r.value.risk as Record<string, unknown>).danger), danger);
  }
});

test('判定：risk.danger の無い古い判定も読める', () => {
  const r = parseVerdict(verdict);
  assert.ok(r.ok);
  assert.equal(r.ok && (r.value.risk as Record<string, unknown>).danger, undefined);
});

test('判定：risk.danger の書式違いは拒否する', () => {
  for (const danger of invalidDangers) {
    const r = parseVerdict({ ...verdict, risk: { ...verdict.risk, danger } });
    assert.equal(r.ok, false, JSON.stringify(danger));
    assert.ok(!r.ok && r.errors.some((e) => e.startsWith('verdict.risk.danger')), JSON.stringify(danger));
  }
});

test('riskAllowsAutoMerge は danger を見ない（yes でも low・8問安全なら通る）', () => {
  const r = parseVerdict({ ...verdict, risk: { ...verdict.risk, danger: { answer: 'yes', reason: '危険' } } });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && riskAllowsAutoMerge(r.value.risk), { ok: true, reasons: [] });
});

// ---- compose-verdict

const risk = { level: 'low', answers: safeAnswers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' }, ...patch,
});

test('compose-verdict：risk の danger を判定コメントのブロックと要約に写す', () => {
  const danger = { answer: 'unsure', reason: 'hook の挙動が変わるかもしれない' };
  const r = composeVerdict(input({ risk: { ...risk, danger } }));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  const v = parseVerdict(b.value);
  assert.ok(v.ok);
  assert.deepEqual((v.value.risk as Record<string, unknown>).danger, danger);
  assert.ok(r.value.includes(`- 危険の判定（auto mode）：unsure：hook の挙動が変わるかもしれない`));
});

test('compose-verdict：danger が無ければ要約に危険の判定の行は出ない', () => {
  const r = composeVerdict(input());
  assert.ok(r.ok);
  assert.ok(!r.value.includes('危険の判定（auto mode）'));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  assert.equal((b.value as { risk: Record<string, unknown> }).risk.danger, undefined);
});

test('compose-verdict：不正な danger は拒否する', () => {
  for (const danger of invalidDangers) {
    const r = composeVerdict(input({ risk: { ...risk, danger } }));
    assert.equal(r.ok, false, JSON.stringify(danger));
  }
});

// ---- 定義と手順の文書

const QUESTION_TERMS = ['ゲート', '必須チェック', 'hook', 'deny', 'ラベルの権限', 'Secret', '元に戻せない', '保留', 'unsure'];

for (const path of ['.claude/agents/plan-critic.md', '.claude/agents/risk-agent.md']) {
  test(`${path} に danger の欄と危険の問いの観点がある`, () => {
    const text = read(path);
    assert.match(text, /danger/);
    for (const term of QUESTION_TERMS) assert.ok(text.includes(term), `${path} に「${term}」が無い`);
  });
}

test('plan の skill と routine.md に critique.danger、judge の skill と routine.md に risk.danger がある', () => {
  const plan = read('.claude/skills/plan/SKILL.md');
  const judge = read('.claude/skills/judge/SKILL.md');
  const routine = read('.claude/routine.md');
  assert.ok(plan.includes('critique.danger'), 'plan の SKILL.md');
  assert.ok(routine.includes('critique.danger'), 'routine.md（critique.danger）');
  assert.ok(judge.includes('risk.danger'), 'judge の SKILL.md');
  assert.ok(routine.includes('risk.danger'), 'routine.md（risk.danger）');
});

test('plan・judge の skill と routine.md の「やってはいけないこと」に agent:auto-mode がある', () => {
  for (const path of ['.claude/skills/plan/SKILL.md', '.claude/skills/judge/SKILL.md']) {
    const lines = read(path).split('\n').filter((l) => l.startsWith('- やってはいけないこと：'));
    assert.ok(lines.length > 0, `${path} に「やってはいけないこと」の行が無い`);
    assert.ok(lines.some((l) => l.includes('agent:auto-mode')), path);
  }
  const lines = read('.claude/routine.md').split('\n').filter((l) => l.includes('**やってはいけないこと**'));
  assert.ok(lines.length > 0, 'routine.md に「やってはいけないこと」の行が無い');
  assert.ok(lines.some((l) => l.includes('agent:auto-mode')), 'routine.md');
});
