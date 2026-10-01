// Issue #439：hq の書き込みの範囲（リポジトリの中で書くのは印のファイルだけ、リポジトリの外の控えは書く）が、
// harness/CLAUDE.harness.md・hq の skill・docs/operations.md の hq の箇所に書かれ、「唯一の書き込み」の言い方が残っていないことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

/** 行の頭が prefix の行から、次の番号の行・箇条・見出し・空行の前までを切り出す */
function part(path: string, prefix: string): string {
  const lines = readFileSync(join(root, path), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(start >= 0, `${path} に「${prefix}」で始まる箇所がありません`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^(\d+\. |- |#+ )/.test(l) || l.trim() === '');
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const PLACES: { path: string; prefix: string }[] = [
  { path: 'harness/CLAUDE.harness.md', prefix: '- hq は' },
  { path: '.claude/skills/hq/SKILL.md', prefix: '2. ' },
  { path: 'docs/operations.md', prefix: '- hq は Orca のプライマリ' },
];

test('hq の書き込みの範囲：リポジトリの中は印のファイルだけ、リポジトリの外の控えは書く（「唯一の書き込み」と言わない）', () => {
  for (const { path, prefix } of PLACES) {
    const text = part(path, prefix);
    for (const word of ['リポジトリの中で書くのは印のファイルだけ', 'リポジトリの外の控え']) {
      assert.ok(text.includes(word), `${path} の「${prefix}」の箇所に「${word}」がありません`);
    }
    assert.ok(!text.includes('唯一の書き込み'), `${path} の「${prefix}」の箇所に「唯一の書き込み」が残っています`);
  }
});
