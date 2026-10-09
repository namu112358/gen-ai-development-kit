// qa-retro の skill（.claude/skills/qa-retro/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #185。#490 で個別の test() を表にまとめた）。
// 表（QA_RETRO_SPEC）は1つの test() で、足りないものを全部一度に示す。frontmatter・使うコマンドの実在と書き方・
// 置き場所の一覧（CLAUDE.md・CLAUDE.harness.md・skills の README・risk-policy）への載せ方は、表にせず個別の test() に残す。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, section, skillProblems, type SkillSpec } from './support/skill-text.ts';

const SKILL = '.claude/skills/qa-retro/SKILL.md';
const skill = (): string => readText(SKILL);

/** qa-retro の skill の構造の表 */
const QA_RETRO_SPEC: SkillSpec = {
  path: SKILL,
  headings: ['## 入力', '## 集計', '## 判断', '## 出力', '## やってはいけないこと'],
  words: ['人が選んだものだけ'],
  parts: [
    // 作る Issue に agent:ready を付けない・集計の結果を reviewer・risk-agent に渡さない
    { section: '## やってはいけないこと', words: ['`agent:ready` を付けない', 'reviewer', 'risk-agent', '渡さない'] },
  ],
};

test('qa-retro の skill の構造の表', () => {
  assert.deepEqual(skillProblems(QA_RETRO_SPEC), []);
});

test('qa-retro の SKILL.md があり、frontmatter の name が qa-retro で description がある', () => {
  assert.ok(existsSync(join(ROOT, SKILL)), 'qa-retro/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'qa-retro');
  assert.ok(fm.description, 'description がありません');
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在し、qa-retro-data を含む', () => {
  const known = documentedAgentCommands();
  assert.ok(known.has('qa-retro-data'), 'agent.ts の使い方のコメントに qa-retro-data がありません');
  const text = skill();
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.includes('qa-retro-data'), 'SKILL.md が qa-retro-data を使っていません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  // 完全な形（node harness/scripts/agent.ts <コマンド>）でない書き方があると、上の照合から漏れる
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形で書く');
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に qa-retro がある', () => {
  const row = readText('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('qa-retro'), `CLAUDE.md の .claude/skills/ の行に qa-retro がありません: ${row}`);
});

test('harness/CLAUDE.harness.md の skill の表に qa-retro の行がある', () => {
  const lines = readText('harness/CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [qa-retro](../.claude/skills/qa-retro/SKILL.md) |')), 'harness/CLAUDE.harness.md に qa-retro の行がありません');
});

test('.claude/skills/README.md の表に qa-retro/ の行がある', () => {
  const lines = readText('.claude/skills/README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `qa-retro/` |')), '.claude/skills/README.md に `qa-retro/` の行がありません');
});

test('docs/risk-policy.md に見直しの手順の節があり、その中で qa-retro を案内している', () => {
  const body = section(readText('docs/risk-policy.md'), '## 見直しの手順');
  assert.ok(body !== '', 'docs/risk-policy.md に「## 見直しの手順」がありません');
  assert.ok(body.includes('qa-retro'), '「## 見直しの手順」の節に qa-retro がありません');
});
