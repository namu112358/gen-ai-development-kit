// Issue #738：.claude/skills の SKILL.md の frontmatter の description が、YAML として読んだときにコメント（空白の後の #）で切れないか。
// 引用符なしの1行の値に「 #」が無いこと、二重引用符の値に '"'・'\' が無いこと、judge・fix・sync の説明文が最後まで読めること
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import * as readme from '../scripts/readme.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SKILLS = join(ROOT, '.claude', 'skills');

type SkillDescription = { name: string; content: string; line: string; raw: string };

function skillDescriptions(): SkillDescription[] {
  const out: SkillDescription[] = [];
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(SKILLS, entry.name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    if (lines[0] !== '---') continue;
    const end = lines.indexOf('---', 1);
    if (end === -1) continue;
    const line = lines.slice(1, end).find((l) => /^description:/.test(l));
    if (line === undefined) continue;
    out.push({ name: entry.name, content, line, raw: line.replace(/^description:/, '') });
  }
  return out;
}

const isFolded = (raw: string): boolean => /^[>|][-+]?$/.test(raw.trim());

test('引用符で始まらない1行の description は、空白の後の # を含まない（YAML のコメントで切れない）', () => {
  const found = skillDescriptions();
  assert.ok(found.length > 0, '.claude/skills の SKILL.md の description が1つも読めない（前提が崩れた）');
  for (const { name, raw } of found) {
    if (isFolded(raw)) continue;
    const value = raw.trimStart();
    if (value.startsWith('"') || value.startsWith("'")) continue;
    assert.ok(!/\s#/.test(raw), `${name}: description の値に空白の後の # があり、YAML ではそこからコメントになる: description:${raw}`);
  }
});

test("二重引用符で囲まれた description は、中に '\"' と '\\' を含まない", () => {
  for (const { name, raw } of skillDescriptions()) {
    if (isFolded(raw)) continue;
    const value = raw.trim();
    if (!value.startsWith('"')) continue;
    assert.ok(value.length >= 2 && value.endsWith('"'), `${name}: 二重引用符が閉じていない: ${value}`);
    const inner = value.slice(1, -1);
    assert.ok(!inner.includes('"'), `${name}: 二重引用符の中に '"' がある: ${value}`);
    assert.ok(!inner.includes('\\'), `${name}: 二重引用符の中に '\\' がある: ${value}`);
  }
});

test('judge・fix・sync の description は「PR #番号」を含み、最後の「…使う。」まで読める', () => {
  const cases = [
    { name: 'judge', tail: '実装・修正の後の段階で使う。' },
    { name: 'fix', tail: '判定の後の段階で使う。' },
    { name: 'sync', tail: 'と頼まれたときに使う。' },
  ];
  const byName = new Map(skillDescriptions().map((s) => [s.name, s]));
  for (const { name, tail } of cases) {
    const skill = byName.get(name);
    assert.ok(skill, `${name}: SKILL.md の description が無い`);
    // 実装は引用符で囲むだけなので、YAML として読んだ値（引用符を外した値）がコメントで切れていないことを、
    // 引用符なしなら # の手前で切った値、引用符ありなら parseFrontmatterDescription の値で確かめる
    const parsed = readme.parseFrontmatterDescription(skill.content);
    assert.ok(parsed !== undefined, `${name}: parseFrontmatterDescription が description を読めない`);
    const value = skill.raw.trimStart();
    const yamlValue = value.startsWith('"') || value.startsWith("'") ? parsed : value.split(/\s#/)[0]!.trim();
    assert.ok(yamlValue.includes('PR #番号'), `${name}: YAML として読んだ description に「PR #番号」が無い: ${yamlValue}`);
    assert.ok(yamlValue.endsWith(tail), `${name}: YAML として読んだ description が「${tail}」で終わらない: ${yamlValue}`);
  }
});
