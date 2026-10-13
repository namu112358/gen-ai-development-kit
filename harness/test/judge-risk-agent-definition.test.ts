import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseVerdict, riskAllowsAutoMerge, RISK_QUESTIONS } from '../lib/verdict.ts';

// Issue #743：risk-agent の定義から「唯一の判定者」を外し、手順5・rationale の文言を直しても、
// 自然言語を読まない守り・unsure で止める守り・出力の書式（parseVerdict）が効き続けることを固定する
// Issue #866：質問8のガードレールを PR の base の設定から読み、harness.config.json 自身を含め続けることを固定する

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
const definition = read('.claude/agents/risk-agent.md');

/** 定義の ```json と ``` の間を JSON として読む */
function jsonTemplate(text: string): Record<string, unknown> {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, '定義に ```json の雛形が無い');
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

const template = jsonTemplate(definition);
const templateFacts = template.facts as Record<string, string>;

test('risk-agent の定義に「唯一の判定者」が無い', () => {
  assert.ok(!definition.includes('唯一の判定者'));
});

test('risk-agent の定義は自然言語の主張を読まない守りを残す', () => {
  assert.ok(definition.includes('自然言語の主張を一切読まずに'));
  const line = definition.split('\n').find((l) => l.startsWith('**読んではいけないもの**'));
  assert.ok(line, '「**読んではいけないもの**」の行が無い');
  for (const w of ['Issue 本文', 'PR のタイトル', '説明', 'コメント', 'レビュー', 'ラベル', 'コミットメッセージ', '計画コメント']) {
    assert.ok(line.includes(w), `読んではいけないものに「${w}」が無い`);
  }
});

test('手順5は迷う・確かめられない問いを unsure と答える（強調・2択の書き方は無い）', () => {
  const line = definition.split('\n').find((l) => l.startsWith('5. 8問に答える'));
  assert.ok(line, '手順5の行が無い');
  for (const w of ['unsure', '迷う', '確かめられない']) assert.ok(line.includes(w), `手順5に「${w}」が無い`);
  for (const w of ['少しでも', '**', '`yes` / `no` で答える']) assert.ok(!line.includes(w), `手順5に「${w}」がある`);
});

test('質問8は PR の base の harness.config.json から guardrailPaths を読み、harness.config.json 自身を含む。入力の base に main の既定が無い', () => {
  const line = definition.split('\n').find((l) => l.includes('質問8のガードレール'));
  assert.ok(line, '質問8のガードレールの行が無い');
  for (const w of ['guardrailPaths', '`harness.config.json` 自身', 'git show origin/<PR の base>:harness.config.json']) {
    assert.ok(line.includes(w), `質問8に「${w}」が無い`);
  }
  for (const w of ['origin/main', 'defaultBranch']) assert.ok(!line.includes(w), `質問8に「${w}」がある`);
  const input = definition.split('\n## ').find((s) => s.startsWith('入力'));
  assert.ok(input, '## 入力 の節が無い');
  assert.ok(!input.includes('渡されなければ `main`'), '入力に「渡されなければ `main`」が残っている');
});

test('rationale の説明に文の数の決まりが無い', () => {
  assert.equal(typeof template.rationale, 'string');
  assert.doesNotMatch(template.rationale as string, /\d+〜\d+文/);
});

test('出力の雛形のキーが判定の書式とそろう', () => {
  assert.deepEqual(Object.keys(template).sort(), ['answers', 'facts', 'level', 'probabilities', 'rationale'].sort());
  assert.deepEqual(Object.keys(template.answers as object).sort(), RISK_QUESTIONS.map((q) => q.key).sort());
  assert.deepEqual(Object.keys(templateFacts).sort(), ['fileKinds', 'references', 'tests'].sort());
});

/** 雛形のキーに型に合う値を入れた判定（answers は差し替えられる） */
function verdictFromTemplate(answers: Record<string, string>): unknown {
  return {
    version: 1,
    pr: 743,
    headSha: 'a'.repeat(40),
    review: { pass: true, blocking: [], nonBlocking: [] },
    risk: {
      level: 'low',
      answers,
      probabilities: template.probabilities,
      rationale: template.rationale,
    },
    facts: { references: templateFacts.references, tests: templateFacts.tests, fileKinds: templateFacts.fileKinds },
  };
}

const safeAnswers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe as string]));

test('雛形どおりの出力は parseVerdict を通り、安全側の答えなら自動 Merge を止めない', () => {
  const r = parseVerdict(verdictFromTemplate(safeAnswers));
  if (!r.ok) assert.fail(`parseVerdict が通らない：${r.errors.join(' / ')}`);
  assert.deepEqual(riskAllowsAutoMerge(r.value.risk), { ok: true, reasons: [] });
});

test('雛形どおりの出力で1問でも unsure なら、書式は通り自動 Merge は止まる', () => {
  for (const q of RISK_QUESTIONS) {
    const r = parseVerdict(verdictFromTemplate({ ...safeAnswers, [q.key]: 'unsure' }));
    if (!r.ok) assert.fail(`${q.key}=unsure で parseVerdict が通らない：${r.errors.join(' / ')}`);
    assert.equal(riskAllowsAutoMerge(r.value.risk).ok, false, `${q.key}=unsure`);
  }
});
