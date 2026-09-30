import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';

const root = join(import.meta.dirname, '..', '..');
const SKILLS = ['plan', 'implement', 'judge', 'fix', 'sync', 'fleet'];
const HEADINGS = ['## 入力', '## 手順', '## 終わりの状態', '## 人に返す条件'];

const skillPath = (name: string): string => join(root, '.claude', 'skills', name, 'SKILL.md');
const read = (name: string): string => readFileSync(skillPath(name), 'utf8');

/** 先頭の `---` で囲まれた frontmatter を key: value で読む */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(m[1]!.split('\n').map((l) => l.match(/^([a-z-]+):\s*(.*)$/)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

/** agent.ts とサブコマンド（harness/scripts/agent/commands/）の使い方のコメントに書かれたコマンド名 */
function documentedCommands(): Set<string> {
  return documentedAgentCommands();
}

test('5つの SKILL.md がある', () => {
  for (const name of SKILLS) assert.ok(existsSync(skillPath(name)), `${name}/SKILL.md がありません`);
});

test('frontmatter の name がディレクトリ名と同じで、description がある', () => {
  for (const name of SKILLS) {
    const fm = frontmatter(read(name));
    assert.equal(fm.name, name, `${name}: name`);
    assert.ok(fm.description, `${name}: description がありません`);
  }
});

test('入力・手順・終わりの状態・人に返す条件の見出しがある', () => {
  for (const name of SKILLS) {
    const lines = read(name).split('\n');
    for (const h of HEADINGS) assert.ok(lines.includes(h), `${name}: 「${h}」がありません`);
  }
});

test('skill が使う agent.ts のコマンドは、使い方のコメントに実在する', () => {
  const known = documentedCommands();
  assert.ok(known.has('judge-input') && known.has('post-plan'), '使い方のコメントからコマンドを読めていません');
  for (const name of SKILLS) {
    const text = read(name);
    const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
    assert.ok(used.length > 0, `${name}: agent.ts のコマンドがありません`);
    for (const cmd of used) assert.ok(known.has(cmd), `${name}: agent.ts ${cmd} は使い方のコメントにありません`);
    // 完全な形（node harness/scripts/agent.ts <コマンド>）でない書き方があると、上の照合から漏れる
    assert.equal(text.split('agent.ts ').length - 1, used.length, `${name}: agent.ts のコマンドは完全な形で書く`);
  }
});
