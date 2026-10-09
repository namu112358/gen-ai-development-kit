// patrol の skill（.claude/skills/patrol/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #370・#388。#490 で個別の test() を表にまとめた）。
// 表（PATROL_SPEC）は1つの test() で、足りないものを全部一度に示す。frontmatter・docs へのリンク・使うコマンドの実在・
// skill の一覧（CLAUDE.md・CLAUDE.harness.md・skills の README）への載せ方は、表にせず個別の test() に残す。
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, skillProblems, type SkillSpec } from './support/skill-text.ts';

const SKILL = '.claude/skills/patrol/SKILL.md';
const OPERATIONS_LINK = '../../../docs/operations.md#見直しを-loop-で回す';
const OPERATIONS_HEADING = '## 見直しを /loop で回す';
const skill = (): string => readText(SKILL);

/** patrol の skill の構造の表 */
const PATROL_SPEC: SkillSpec = {
  path: SKILL,
  headings: ['## 入力', '## 手順', '## 出力', '## やってはいけないこと', '## 終わりの状態'],
  words: ['/loop 6h /patrol'],
  parts: [
    { section: '## 入力', words: ['--max', '--state', '--dry-run'] },
    {
      section: '## 手順',
      words: [
        // 観測と、各 skill のループの回
        'observe.ts', '--previous', 'patrol.ts previous', 'patrol.ts select', 'patrol.ts record', 'arch-review --loop', 'qa-retro --loop', 'test-prune --loop',
        // 回の要約
        '観測の差', '動かした見直し', '勧める見直し', '下書きの数',
        // 状態のファイルが壊れていたら上書きせずに止まる
        '状態のファイル', '上書きしない',
      ],
    },
    { section: '## やってはいけないこと', words: ['AskUserQuestion', 'gh issue create', 'ラベル'] },
  ],
};

/** 本文で使う `node harness/scripts/<script> <サブコマンド>` のサブコマンド */
const usedSubcommands = (text: string, script: string): string[] =>
  [...text.matchAll(new RegExp(`node harness/scripts/${script.replace(/\./g, '\\.')} ([a-z][\\w-]*)`, 'g'))].map((m) => m[1]!);

/** スクリプトの先頭の使い方のコメント（最初の `/** … *\/`）に書かれたサブコマンド */
function documentedSubcommands(script: string): Set<string> {
  const path = join(ROOT, 'harness', 'scripts', script);
  assert.ok(existsSync(path), `harness/scripts/${script} がありません`);
  const doc = readText(`harness/scripts/${script}`).match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  return new Set(usedSubcommands(doc, script));
}

test('patrol の skill の構造の表', () => {
  assert.deepEqual(skillProblems(PATROL_SPEC), []);
});

test('patrol の SKILL.md があり、frontmatter の name が patrol で description がある', () => {
  assert.ok(existsSync(join(ROOT, SKILL)), 'patrol/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'patrol');
  assert.ok(fm.description, 'description がありません');
});

test('docs/operations.md の「見直しを /loop で回す」へリンクし、リンク先の見出しがある', () => {
  assert.ok(skill().includes(`](${OPERATIONS_LINK})`), `${OPERATIONS_LINK} へのリンクがありません`);
  const lines = readText('docs/operations.md').split('\n');
  assert.ok(lines.includes(OPERATIONS_HEADING), `docs/operations.md に「${OPERATIONS_HEADING}」がありません`);
});

test('skill が使う patrol.ts のサブコマンド（previous・select・record）は、スクリプトの使い方のコメントに実在する', () => {
  const known = documentedSubcommands('patrol.ts');
  for (const sub of ['previous', 'select', 'record']) assert.ok(known.has(sub), `patrol.ts の使い方のコメントに ${sub} がありません`);
  const used = usedSubcommands(skill(), 'patrol.ts');
  for (const sub of ['previous', 'select', 'record']) assert.ok(used.includes(sub), `SKILL.md が node harness/scripts/patrol.ts ${sub} を使っていません`);
  for (const sub of used) assert.ok(known.has(sub), `patrol.ts ${sub} は使い方のコメントにありません`);
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在し、arch-review-pending を含む', () => {
  const known = documentedAgentCommands();
  const used = [...skill().matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.includes('arch-review-pending'), 'SKILL.md が node harness/scripts/agent.ts arch-review-pending を使っていません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
});

test('skill が使う qa-retro-loop.ts の pending は、スクリプトの使い方のコメントに実在する', () => {
  const known = documentedSubcommands('qa-retro-loop.ts');
  const used = usedSubcommands(skill(), 'qa-retro-loop.ts');
  assert.ok(used.includes('pending'), 'SKILL.md が node harness/scripts/qa-retro-loop.ts pending を使っていません');
  for (const sub of used) assert.ok(known.has(sub), `qa-retro-loop.ts ${sub} は使い方のコメントにありません`);
});

test('skill が使う test-prune-loop.ts の pending は、スクリプトの使い方のコメントに実在する', () => {
  const known = documentedSubcommands('test-prune-loop.ts');
  const used = usedSubcommands(skill(), 'test-prune-loop.ts');
  assert.ok(used.includes('pending'), 'SKILL.md が node harness/scripts/test-prune-loop.ts pending を使っていません');
  for (const sub of used) assert.ok(known.has(sub), `test-prune-loop.ts ${sub} は使い方のコメントにありません`);
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に patrol がある', () => {
  const row = readText('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('patrol'), `CLAUDE.md の .claude/skills/ の行に patrol がありません: ${row}`);
});

test('harness/CLAUDE.harness.md の skill の表に patrol の行がある', () => {
  const lines = readText('harness/CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [patrol](../.claude/skills/patrol/SKILL.md) |')), 'harness/CLAUDE.harness.md に patrol の行がありません');
});

test('.claude/skills/README.md の表に patrol/ の行がある', () => {
  const lines = readText('.claude/skills/README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `patrol/` |')), '.claude/skills/README.md に `patrol/` の行がありません');
});
