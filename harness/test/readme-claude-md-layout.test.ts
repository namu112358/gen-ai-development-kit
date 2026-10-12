// CLAUDE.md の構成の表の `.claude/skills/`・`.claude/agents/` の行に、実際にある skill（直下のディレクトリ）と
// agent（直下の *.md。README.md を除く）の名前がすべて載っているかを確かめる（Issue #745）。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..', '..');
const lines = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8').split('\n');

/** 名前の前後が英数字・ハイフンでないところで当たるか */
const mentions = (line: string, name: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`).test(line);

/** 表の行（`| \`path\` |` で始まる行）に載っていない名前 */
const missingFrom = (path: string, names: string[]): string[] => {
  const row = lines.find((l) => l.startsWith(`| \`${path}\` |`));
  return row === undefined ? names : names.filter((n) => !mentions(row, n));
};

test('CLAUDE.md の構成の表の .claude/skills/ の行に、直下の skill のディレクトリがすべて載っている', () => {
  const names = readdirSync(join(ROOT, '.claude', 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  assert.ok(names.length > 0);
  const missing = missingFrom('.claude/skills/', names);
  assert.deepEqual(missing, []);
});

test('CLAUDE.md の構成の表の .claude/agents/ の行に、直下の agent の定義（*.md、README.md を除く）がすべて載っている', () => {
  const names = readdirSync(join(ROOT, '.claude', 'agents'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
    .map((e) => e.name.slice(0, -'.md'.length))
    .sort();
  assert.ok(names.length > 0);
  const missing = missingFrom('.claude/agents/', names);
  assert.deepEqual(missing, []);
});
