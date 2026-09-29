// Issue #185：品質の振り返り（qa-retro）の skill の書式と、置き場所の一覧（CLAUDE.md・skills の README・risk-policy）への載せ方を確かめる。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const HEADINGS = ['## 入力', '## 集計', '## 判断', '## 出力', '## やってはいけないこと'];

const skillPath = join(root, '.claude', 'skills', 'qa-retro', 'SKILL.md');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = (): string => readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む（skills.test.ts と同じ） */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** agent.ts の使い方のコメントに書かれたコマンド名（skills.test.ts と同じ） */
function documentedCommands(): Set<string> {
  const source = readFileSync(join(root, 'harness', 'scripts', 'agent.ts'), 'utf8');
  const usage = source.match(/\/\*\*[\s\S]*?\*\//g)?.find((c) => c.includes('node harness/scripts/agent.ts')) ?? '';
  return new Set([...usage.matchAll(/^\s*\*\s+node harness\/scripts\/agent\.ts ([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

/** 見出し（`## ` で始まる行）から次の同じ深さの見出しまでの本文。見出しが無ければ null */
function section(text: string, heading: string): string | null {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

test('qa-retro の SKILL.md があり、frontmatter の name が qa-retro で description がある', () => {
  assert.ok(existsSync(skillPath), 'qa-retro/SKILL.md がありません');
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'qa-retro');
  assert.ok(fm.description, 'description がありません');
});

test('入力・集計・判断・出力・やってはいけないことの見出しがある', () => {
  const lines = skill().split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

test('skill が使う agent.ts のコマンドは使い方のコメントに実在し、qa-retro-data を含む', () => {
  const known = documentedCommands();
  assert.ok(known.has('qa-retro-data'), 'agent.ts の使い方のコメントに qa-retro-data がありません');
  const text = skill();
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.includes('qa-retro-data'), 'SKILL.md が qa-retro-data を使っていません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  // 完全な形（node harness/scripts/agent.ts <コマンド>）でない書き方があると、上の照合から漏れる
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形で書く');
});

test('作る Issue に agent:ready を付けないと書かれている', () => {
  const lines = skill().split('\n');
  assert.ok(lines.some((l) => l.includes('agent:ready') && l.includes('付けない')), '`agent:ready` を含み「付けない」がある行がありません');
});

test('Issue は人が選んだものだけを作ると書かれている', () => {
  assert.ok(skill().includes('人が選んだものだけ'), '「人が選んだものだけ」がありません');
});

test('集計の結果を reviewer・risk-agent に渡さないと書かれている', () => {
  const lines = skill().split('\n');
  assert.ok(
    lines.some((l) => l.includes('reviewer') && l.includes('risk-agent') && l.includes('渡さない')),
    '「reviewer」「risk-agent」「渡さない」を同じ行に含む行がありません',
  );
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に qa-retro がある', () => {
  const row = readRoot('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/` |'));
  assert.ok(row, 'CLAUDE.md に `.claude/skills/` の行がありません');
  assert.ok(row.includes('qa-retro'), `CLAUDE.md の .claude/skills/ の行に qa-retro がありません: ${row}`);
});

test('harness/CLAUDE.harness.md の skill の表に qa-retro の行がある', () => {
  const lines = readRoot('harness', 'CLAUDE.harness.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| [qa-retro](../.claude/skills/qa-retro/SKILL.md) |')), 'harness/CLAUDE.harness.md に qa-retro の行がありません');
});

test('.claude/skills/README.md の表に qa-retro/ の行がある', () => {
  const lines = readRoot('.claude', 'skills', 'README.md').split('\n');
  assert.ok(lines.some((l) => l.startsWith('| `qa-retro/` |')), '.claude/skills/README.md に `qa-retro/` の行がありません');
});

test('docs/risk-policy.md に見直しの手順の節があり、その中で qa-retro を案内している', () => {
  const body = section(readRoot('docs', 'risk-policy.md'), '## 見直しの手順');
  assert.ok(body !== null, 'docs/risk-policy.md に「## 見直しの手順」がありません');
  assert.ok(body.includes('qa-retro'), '「## 見直しの手順」の節に qa-retro がありません');
});
