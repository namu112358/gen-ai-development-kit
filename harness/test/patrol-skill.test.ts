// Issue #370：patrol の skill の書き方（入力・手順・要約・やってはいけないこと・/loop の例・リンク・使うコマンドの実在）と、skill の一覧（CLAUDE.md・CLAUDE.harness.md・skills の README）への載せ方を確かめる。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const HEADINGS = ['## 入力', '## 手順', '## 出力', '## やってはいけないこと', '## 終わりの状態'];
const OPERATIONS_LINK = '../../../docs/operations.md#見直しを-loop-で回す';
const OPERATIONS_HEADING = '## 見直しを /loop で回す';

const skillPath = join(root, '.claude', 'skills', 'patrol', 'SKILL.md');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = (): string => readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む（qa-retro-skill.test.ts と同じ） */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** 見出し（`## ` で始まる行）から次の同じ深さの見出しまでの本文。見出しが無ければ null（qa-retro-skill.test.ts と同じ） */
function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function mustSection(heading: string): string {
  const body = section(skill(), heading);
  assert.ok(body !== null, `SKILL.md に「${heading}」がありません`);
  return body;
}

/** 本文で使う `node harness/scripts/<script> <サブコマンド>` のサブコマンド */
const usedSubcommands = (text: string, script: string): string[] =>
  [...text.matchAll(new RegExp(`node harness/scripts/${script.replace(/\./g, '\\.')} ([a-z][\\w-]*)`, 'g'))].map((m) => m[1]!);

/** スクリプトの先頭の使い方のコメント（最初の `/** … *\/`）に書かれたサブコマンド */
function documentedSubcommands(script: string): Set<string> {
  const path = join(root, 'harness', 'scripts', script);
  assert.ok(existsSync(path), `harness/scripts/${script} がありません`);
  const doc = readRoot('harness', 'scripts', script).match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
  return new Set(usedSubcommands(doc, script));
}

test('patrol の SKILL.md があり、frontmatter の name が patrol で description がある', () => {
  assert.ok(existsSync(skillPath), 'patrol/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'patrol');
  assert.ok(fm.description, 'description がありません');
});

test('入力・手順・出力・やってはいけないこと・終わりの状態の見出しがある', () => {
  const lines = skill().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

test('入力に --max・--state・--dry-run がある', () => {
  const body = mustSection('## 入力');
  for (const word of ['--max', '--state', '--dry-run']) assert.ok(body.includes(word), `「## 入力」に ${word} がありません`);
});

test('手順に観測（observe.ts・--previous）・patrol.ts の previous・select・record・各 skill のループの回・test-prune の勧めがある', () => {
  const body = mustSection('## 手順');
  for (const word of ['observe.ts', '--previous', 'patrol.ts previous', 'patrol.ts select', 'patrol.ts record', 'arch-review --loop', 'qa-retro --loop', '/test-prune']) {
    assert.ok(body.includes(word), `「## 手順」に ${word} がありません`);
  }
});

test('手順の回の要約に、観測の差・動かした見直し・勧める見直し・下書きの数がある', () => {
  const body = mustSection('## 手順');
  for (const word of ['観測の差', '動かした見直し', '勧める見直し', '下書きの数']) assert.ok(body.includes(word), `「## 手順」に「${word}」がありません`);
});

test('手順に、状態のファイルが壊れていたら上書きせずに止まることがある', () => {
  const body = mustSection('## 手順');
  assert.ok(body.includes('状態のファイル'), '「## 手順」に「状態のファイル」がありません');
  assert.ok(body.includes('上書きしない'), '「## 手順」に「上書きしない」がありません');
});

test('/loop の例（/loop 6h /patrol）がある', () => {
  assert.ok(skill().includes('/loop 6h /patrol'), '`/loop 6h /patrol` がありません');
});

test('やってはいけないことに、AskUserQuestion・gh issue create・ラベルがある', () => {
  const body = mustSection('## やってはいけないこと');
  for (const word of ['AskUserQuestion', 'gh issue create', 'ラベル']) assert.ok(body.includes(word), `「## やってはいけないこと」に「${word}」がありません`);
});

test('docs/operations.md の「見直しを /loop で回す」へリンクし、リンク先の見出しがある', () => {
  assert.ok(skill().includes(`](${OPERATIONS_LINK})`), `${OPERATIONS_LINK} へのリンクがありません`);
  const lines = readRoot('docs', 'operations.md').split('\n');
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

test('CLAUDE.md の構成の表の .claude/skills/ の行に patrol がある', () => {
  const row = readRoot('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('patrol'), `CLAUDE.md の .claude/skills/ の行に patrol がありません: ${row}`);
});

test('harness/CLAUDE.harness.md の skill の表に patrol の行がある', () => {
  const lines = readRoot('harness', 'CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [patrol](../.claude/skills/patrol/SKILL.md) |')), 'harness/CLAUDE.harness.md に patrol の行がありません');
});

test('.claude/skills/README.md の表に patrol/ の行がある', () => {
  const lines = readRoot('.claude', 'skills', 'README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `patrol/` |')), '.claude/skills/README.md に `patrol/` の行がありません');
});
