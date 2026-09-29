// Issue #195：readme.ts が SKILL.md の frontmatter の折り返しの description（>・>-・|・|-、CRLF の行末も）を空白1つでつないで読み、
// 1行の形（引用符あり・なし）は今と同じに読むか。実物の .claude/skills/orca-cli/SKILL.md から README の表の行が作られるか
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as readme from '../scripts/readme.ts';

const ROOT = join(import.meta.dirname, '..', '..');

const parse = (content: string): string | undefined => readme.parseFrontmatterDescription(content);

const folded = (indicator: string, eol = '\n'): string =>
  ['---', 'name: x', `description: ${indicator}`, '  First line of the', '  description,', '    more here.', 'other: y', '---', '', '# X', ''].join(eol);

test('description: >- と字下げの複数行を、trim して空白1つでつなぐ', () => {
  assert.equal(parse(folded('>-')), 'First line of the description, more here.');
});

test('>・|・|- も同じようにつなぐ', () => {
  for (const ind of ['>', '|', '|-']) {
    assert.equal(parse(folded(ind)), 'First line of the description, more here.', ind);
  }
});

test('CRLF の行末でも折り返しの description を読む', () => {
  for (const ind of ['>-', '>', '|', '|-']) {
    assert.equal(parse(folded(ind, '\r\n')), 'First line of the description, more here.', ind);
  }
});

test('折り返しの description が frontmatter の最後のキーでも、終わりの --- まで読む', () => {
  const content = ['---', 'name: x', 'description: >-', '  Only', '  two words.', '---', 'body', ''].join('\n');
  assert.equal(parse(content), 'Only two words.');
});

test('1行の形（引用符なし・二重引用符・一重引用符）は今と同じ', () => {
  assert.equal(parse('---\nname: x\ndescription: Plain text here.\n---\n'), 'Plain text here.');
  assert.equal(parse('---\nname: x\ndescription: "Quoted text."\n---\n'), 'Quoted text.');
  assert.equal(parse("---\nname: x\ndescription: 'Single quoted.'\n---\n"), 'Single quoted.');
  assert.equal(parse('---\r\nname: x\r\ndescription: CRLF line.\r\n---\r\n'), 'CRLF line.');
});

test('frontmatter が無い・description が無いときは undefined', () => {
  assert.equal(parse('# 見出し\n\n本文\n'), undefined);
  assert.equal(parse('---\nname: x\n---\n'), undefined);
});

test('renderTable の .claude/skills の orca-cli/ の行が >- でなく description の英文になる', () => {
  const skill = readFileSync(join(ROOT, '.claude', 'skills', 'orca-cli', 'SKILL.md'), 'utf8');
  assert.match(skill, /^description: >-$/m, '実物の orca-cli の description が >- の形でない（前提が崩れた）');
  const row = readme
    .renderTable(ROOT, '.claude/skills')
    .split('\n')
    .find((l) => l.startsWith('| `orca-cli/` |'));
  assert.ok(row, 'orca-cli/ の行が無い');
  assert.ok(!row.includes('>-'), `>- が入っている: ${row}`);
  assert.ok(row.includes('Operate Orca-managed worktrees'), `description の最初の語句が無い: ${row}`);
});
