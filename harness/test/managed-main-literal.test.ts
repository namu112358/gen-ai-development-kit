// 配布物（harness/managed.json の managed から exclude を除いたもの）の .ts・.yml・.json に、既定ブランチの main の直書きが無いことを確かめる（Issue #868）。
// 導入先の既定ブランチは harness.config.json の defaultBranch で決まるので、配るものは main を前提にしない。
// 行全体（文字列リテラルとコメントを分けない）を1つの正規表現で見る。コメントの手順の例（git push origin main など）も導入先では誤りになるため。
// 例外は harness/templates/harness.config.json の defaultBranch の値の1か所だけ：これは直書きではなく、ほかが引く設定の値そのもの（導入先の初回の既定値）。
// ブランチ名でない main（function main・import.meta.main）は、型が引用符・/・: を要るので当たらない。harness/test は配布物でないので見ない。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isManaged, type ManagedJson } from '../lib/sync.ts';

const root = join(import.meta.dirname, '..', '..');

/** origin/main・--base main・branches: [main]・blob/main/・(refs/)heads/main・引用符で囲んだ main・deny の * main) と :main) */
const MAIN_LITERAL = /origin\/main(?![\w./-])|--base[= ]main(?![\w./-])|branches:\s*\[\s*main\s*\]|blob\/main\/|heads\/main(?![\w./-])|(['"`])main\1|\* main\)|:main\)/;

const isAllowed = (path: string, line: string): boolean => path === 'harness/templates/harness.config.json' && /^\s*"defaultBranch":\s*"main",?\s*$/.test(line);

test('配布物の .ts・.yml・.json に既定ブランチの main の直書きが無い（雛形の harness.config.json の defaultBranch の値を除く）', () => {
  const m = JSON.parse(readFileSync(join(root, 'harness/managed.json'), 'utf8')) as ManagedJson;
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((p) => /\.(ts|ya?ml|json)$/.test(p) && isManaged(m.managed, m.exclude ?? [], p));
  assert.ok(files.includes('.claude/hooks/guard.ts') && files.includes('harness/templates/harness.config.json'), '配布物の一覧が読めていない');
  const found: string[] = [];
  for (const p of files) {
    readFileSync(join(root, p), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (MAIN_LITERAL.test(line) && !isAllowed(p, line)) found.push(`${p}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, [], `配布物に main の直書きがある:\n${found.join('\n')}`);
});
