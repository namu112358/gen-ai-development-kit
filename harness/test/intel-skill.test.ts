// intel の skill（.claude/skills/intel/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #394。#490 で個別の test() を表にまとめた）。
// 表（INTEL_SPEC）は1つの test() で、足りないものを全部一度に示す。frontmatter・使うコマンドの実在・skill の一覧
// （CLAUDE.md・CLAUDE.harness.md・skills の README・overview.html）への載せ方は、表にせず個別の test() に残す。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, skillProblems, type SkillSpec } from './support/skill-text.ts';

const SKILL = '.claude/skills/intel/SKILL.md';
const skill = (): string => readText(SKILL);

/** intel の skill の構造の表 */
const INTEL_SPEC: SkillSpec = {
  path: SKILL,
  headings: ['## 入力', '## 手順', '## やってはいけないこと', '## 終わりの状態'],
  parts: [
    {
      section: '## 手順',
      words: [
        // 気づきを控える
        'memo.md', '日時', '出どころ',
        // 似たものをまとめる
        '似たもの', 'まとめ',
        // 既存の Issue と照らす
        'gh issue list', '#177', '#186', 'コメントの案', 'AC 案',
        // 下書きを一覧で示して止まり、承認で作っても計画には進まない
        '一覧', '止まる', '作って', '計画には進まない', '承認', '下書き',
        // 人の質問に根拠つきで答える
        '根拠', 'ファイルと行', 'panes.ts hq',
        // 名前・受け取りの返事・進め方の話は hq に回す
        'ListAgents', '受け取った', 'hq のタブで伝えてください',
      ],
    },
    { section: '## やってはいけないこと', words: ['AskUserQuestion', 'ラベル', '着手宣言', 'PR', 'fleet に指示しない'] },
  ],
};

test('intel の skill の構造の表', () => {
  assert.deepEqual(skillProblems(INTEL_SPEC), []);
});

test('intel の SKILL.md があり、frontmatter の name が intel で description がある', () => {
  assert.ok(existsSync(join(ROOT, SKILL)), 'intel/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'intel');
  assert.ok(fm.description, 'description がありません');
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在する', () => {
  const known = documentedAgentCommands();
  const used = [...skill().matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
});

test('harness/CLAUDE.harness.md の skill の表に intel の行がある', () => {
  const lines = readText('harness/CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [intel](../.claude/skills/intel/SKILL.md) |')), 'harness/CLAUDE.harness.md に intel の行がありません');
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に intel がある', () => {
  const row = readText('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('intel'), `CLAUDE.md の .claude/skills/ の行に intel がありません: ${row}`);
});

test('.claude/skills/README.md の表に intel/ の行がある', () => {
  const lines = readText('.claude/skills/README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `intel/` |')), '.claude/skills/README.md に `intel/` の行がありません');
});

test('overview.html の Claude の card（<section class="card claude">）に intel がある', () => {
  const html = readText('overview.html');
  const start = html.indexOf('<section class="card claude">');
  assert.ok(start >= 0, 'overview.html に <section class="card claude"> がありません');
  const end = html.indexOf('</section>', start);
  assert.ok(end > start, 'overview.html の <section class="card claude"> が閉じていません');
  assert.ok(html.slice(start, end).includes('intel'), 'overview.html の Claude の card に intel がありません');
});
