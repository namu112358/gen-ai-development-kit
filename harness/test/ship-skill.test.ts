import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const SKILLS = ['plan', 'implement', 'judge', 'fix', 'sync'];
const HEADINGS = ['## 入力', '## 手順', '## 終わりの状態', '## 人に返す条件'];

const shipPath = join(root, '.claude', 'skills', 'ship', 'SKILL.md');
const claudeMd = (): string => readFileSync(join(root, 'CLAUDE.md'), 'utf8');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** agent.ts の使い方のコメントに書かれたコマンド名 */
function documentedCommands(): Set<string> {
  const source = readFileSync(join(root, 'harness', 'scripts', 'agent.ts'), 'utf8');
  const usage = source.match(/\/\*\*[\s\S]*?\*\//g)?.find((c) => c.includes('node harness/scripts/agent.ts')) ?? '';
  return new Set([...usage.matchAll(/^\s*\*\s+node harness\/scripts\/agent\.ts ([a-z][a-z-]*)/gm)].map((m) => m[1]!));
}

test('ship の SKILL.md があり、frontmatter の name が ship で description がある', () => {
  assert.ok(existsSync(shipPath), 'ship/SKILL.md がありません');
  const fm = frontmatter(readFileSync(shipPath, 'utf8'));
  assert.equal(fm.name, 'ship');
  assert.ok(fm.description, 'description がありません');
});

test('ship に入力・手順・終わりの状態・人に返す条件の見出しがある', () => {
  const lines = readFileSync(shipPath, 'utf8').split('\n');
  for (const h of HEADINGS) assert.ok(lines.includes(h), `「${h}」がありません`);
});

test('ship は5つの skill をつなぐ', () => {
  const text = readFileSync(shipPath, 'utf8');
  for (const name of SKILLS) assert.ok(text.includes(`${name} の skill`), `${name} の skill への言及がありません`);
});

test('ship が使う agent.ts のコマンドは、使い方のコメントに実在する', () => {
  const known = documentedCommands();
  assert.ok(known.has('show-plan') && known.has('worktree-remove'), '使い方のコメントからコマンドを読めていません');
  const text = readFileSync(shipPath, 'utf8');
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'agent.ts のコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形で書く');
});

test('CLAUDE.md が ship と5つの skill を案内する', () => {
  const text = claudeMd();
  assert.match(text, /Issue を進めるときは ship を使う/);
  for (const name of ['ship', ...SKILLS]) assert.ok(text.includes(`(.claude/skills/${name}/SKILL.md)`), `${name} への案内がありません`);
  assert.match(text, /\| `\.claude\/skills\/` \|/);
});

test('CLAUDE.md は Routine を将来の構想としている', () => {
  const routineLine = claudeMd().split('\n').find((l) => l.includes('.claude/routine.md') && l.includes('Routine'));
  assert.ok(routineLine, 'Routine の行がありません');
  assert.match(routineLine, /将来の構想/);
});
