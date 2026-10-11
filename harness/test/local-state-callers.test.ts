// Issue #653：段階・見張り・loaded・hq の控え・panes の書き込みと git の共通ディレクトリの探し方が、
// harness/lib/local-state.ts の1か所を通るか（ファイルの本文を読んで確かめる）。各パスの関数の戻り値は既存のテストに任せる。
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readText, ROOT } from './support/skill-text.ts';

const WRITERS = [
  'harness/lib/stage-file.ts',
  'harness/lib/fleet-watch.ts',
  'harness/lib/harness-drift.ts',
  'harness/scripts/hq-state.ts',
  'harness/scripts/panes.ts',
];

test('段階・見張り・loaded・hq の控え・panes の書き込みは local-state.ts から import し、renameSync・writeFileSync を直接呼ばない', () => {
  const problems: string[] = [];
  for (const file of WRITERS) {
    const text = readText(file);
    if (!/from '(\.\.?\/)+(lib\/)?local-state\.ts'/.test(text)) problems.push(`${file}: local-state.ts からの import が無い`);
    for (const call of ['renameSync(', 'writeFileSync(']) if (text.includes(call)) problems.push(`${file}: ${call} を直接呼んでいる`);
  }
  assert.deepEqual(problems, []);
});

test("'--git-common-dir' をコードで持つのは harness/lib・harness/scripts の中で harness/lib/local-state.ts だけ", () => {
  const found: string[] = [];
  for (const base of ['harness/lib', 'harness/scripts']) {
    for (const rel of readdirSync(join(ROOT, base), { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue;
      const file = `${base}/${rel.replace(/\\/g, '/')}`;
      const text = readText(file);
      if (text.includes("'--git-common-dir'") || text.includes('"--git-common-dir"')) found.push(file);
    }
  }
  assert.deepEqual(found.sort(), ['harness/lib/local-state.ts']);
});
