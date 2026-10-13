// skill の参照用のファイル（.claude/skills/<名前>/references/*.md）を確かめる（Issue #999。Epic #994 で長い SKILL.md の節を分けた）。
// 各ファイルを SKILL.md が Markdown のリンクで指し、配る一覧（harness/managed.json）に入っていること、fleet の SKILL.md の字数の上限、
// 文を確かめるテストが SKILL.md と参照用のファイルを1つの本文として読む support/skill-text.ts の skillText を見る。
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { isManaged } from '../lib/sync.ts';
import { ROOT, readText, skillText } from './support/skill-text.ts';

const SKILLS = '.claude/skills';

/** 根からの相対パスで、skill の名前ごとの参照用のファイル（名前の順）。references が無い skill は入れない */
function referenceFiles(): { skill: string; files: string[] }[] {
  const out: { skill: string; files: string[] }[] = [];
  for (const entry of readdirSync(join(ROOT, SKILLS), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(ROOT, SKILLS, entry.name, 'references');
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    out.push({ skill: entry.name, files: files.map((f) => `${SKILLS}/${entry.name}/references/${f}`) });
  }
  return out;
}

const fleetRefs = (): string[] => referenceFiles().find((r) => r.skill === 'fleet')?.files ?? [];

test('skills-references：参照用のファイルはどれも、その skill の SKILL.md が Markdown のリンクで指す（コード表記は数えない）', () => {
  const missing: string[] = [];
  for (const { skill, files } of referenceFiles()) {
    // コード表記（`...`）の中は数えないので、先に取り除く
    const body = readText(`${SKILLS}/${skill}/SKILL.md`).replace(/`[^`\n]*`/g, '');
    for (const f of files) {
      const name = f.split('/').pop()!;
      if (!body.includes(`](references/${name})`)) missing.push(f);
    }
  }
  assert.deepEqual(missing, [], 'SKILL.md からリンクされていない参照用のファイル');
});

test('skills-references：参照用のファイルはどれも harness/managed.json の配る一覧に入る（isManaged が真）', () => {
  const m = JSON.parse(readText('harness/managed.json')) as { managed: string[]; exclude?: string[] };
  const notManaged = referenceFiles()
    .flatMap((r) => r.files)
    .filter((f) => !isManaged(m.managed, m.exclude ?? [], f));
  assert.deepEqual(notManaged, [], '配る一覧に入らない参照用のファイル');
});

test('skills-references：fleet に参照用のファイルが1つ以上ある', () => {
  assert.ok(fleetRefs().length > 0, `${SKILLS}/fleet/references/*.md がありません`);
});

test('skills-references：fleet の SKILL.md は 20,954 字以下', () => {
  const length = [...readText(`${SKILLS}/fleet/SKILL.md`)].length;
  assert.ok(length <= 20954, `fleet の SKILL.md が ${length} 字（上限 20,954 字）`);
});

test('skills-references：skillText は SKILL.md の本文の後に references の本文を名前の順に含み、references の無い skill と SKILL.md でないパスは readText と同じ', () => {
  const fleet = `${SKILLS}/fleet/SKILL.md`;
  const joined = skillText(fleet);
  assert.ok(joined.startsWith(readText(fleet)), 'skillText が SKILL.md の本文で始まらない');
  let from = readText(fleet).length;
  for (const f of fleetRefs()) {
    const at = joined.indexOf(readText(f), from);
    assert.ok(at >= 0, `skillText に ${f} の本文が名前の順で入っていない`);
    from = at + readText(f).length;
  }
  for (const path of [`${SKILLS}/plan/SKILL.md`, 'docs/setup.md']) {
    assert.equal(skillText(path), readText(path), `${path} の skillText が readText と違う`);
  }
});
