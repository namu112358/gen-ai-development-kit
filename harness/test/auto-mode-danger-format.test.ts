// auto mode の危険の判定を Jev だけにした後の書式：critique.danger・risk.danger のある古い計画・判定も読め、値は捨てる。compose-verdict は danger を拒否し、定義と手順の文書に Claude の危険の判定が無い（Issue #382）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePlan } from '../lib/plan.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, RISK_QUESTIONS, type Verdict } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

// 古い書式（#343）の正しい形と不正な形
const oldDangers: unknown[] = [
  { answer: 'yes', reason: 'ゲートの判定を変える' },
  { answer: 'unsure', reason: '判断できない' },
  'yes',
  null,
  { answer: 'maybe', reason: 'x' },
  { answer: 'yes', reason: '' },
];

// ---- 計画の critique.danger

const planBase = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['src/lib/foo.ts'] };
const critique = { verdict: 'go', rounds: 1 };

test('計画：critique.danger のある古い計画も読め、critique に danger は入らない', () => {
  for (const danger of oldDangers) {
    const r = parsePlan({ ...planBase, critique: { ...critique, danger } });
    assert.ok(r.ok, `${JSON.stringify(danger)}: ${JSON.stringify(!r.ok && r.errors)}`);
    assert.ok(r.value.critique !== undefined && !('danger' in r.value.critique), JSON.stringify(danger));
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

test('判定：risk.danger のある古い判定コメントも読め、risk に danger は入らない', () => {
  for (const danger of oldDangers) {
    const r = parseVerdict({ ...verdict, risk: { ...verdict.risk, danger } });
    assert.ok(r.ok, `${JSON.stringify(danger)}: ${JSON.stringify(!r.ok && r.errors)}`);
    assert.ok(!('danger' in r.value.risk), JSON.stringify(danger));
  }
});

// ---- compose-verdict

const risk = { level: 'low', answers: safeAnswers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' }, ...patch,
});

test('compose-verdict：Risk Agent の出力の danger は未知のキーとして拒否する', () => {
  const r = composeVerdict(input({ risk: { ...risk, danger: { answer: 'no', reason: 'docs のみ' } } }));
  assert.equal(r.ok, false);
});

test('compose-verdict：要約に危険の判定の行は出ない', () => {
  const r = composeVerdict(input());
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  assert.ok(!r.value.includes('危険の判定（auto mode）'));
});

// ---- 定義と手順の文書

const DOCS = [
  '.claude/skills/plan/SKILL.md',
  '.claude/skills/judge/SKILL.md',
  '.claude/routine.md',
  '.claude/agents/plan-critic.md',
  '.claude/agents/risk-agent.md',
];
// 英語の danger の語そのものでは検査しない（--dangerously-skip-permissions などに当たる）
const FORBIDDEN = ['critique.danger', 'risk.danger', '危険の判定（auto mode）', '"danger"'];

for (const path of DOCS) {
  test(`${path} に Claude の危険の判定（danger を写す手順・危険の問い・出力の danger）が無い`, () => {
    const text = read(path);
    for (const term of FORBIDDEN) assert.ok(!text.includes(term), `${path} に「${term}」がある`);
  });
}

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
