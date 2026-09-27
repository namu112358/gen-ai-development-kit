import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #132：README の表に、直下に実在しない名前が書かれていないこと（AC1）
//
// namesInTable は生成の目印（<!-- readme:generated start/end -->）の中だけを見る（無ければファイル全文）。
// harness/test・harness/test/support は生成の対象外（Non-goal）で目印を持たないため、全文から名前を拾う。
import { namesInTable, staleNames, directChildren, readmeFileFor, TARGET_DIRS } from '../scripts/readme.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- 単体：表の名前列からの抽出 ----

test('namesInTable：バッククォートで囲んだ名前を取り出す', () => {
  const table = ['| 名前 | 内容 | ガードレール |', '| --- | --- | --- |', '| `a.ts` | a の説明 | |', '| `lib/` | lib の説明 | ○ |'].join('\n');
  assert.deepEqual(namesInTable(table), ['a.ts', 'lib/']);
});

test('namesInTable：説明列のバッククォートは名前として見ない', () => {
  const table = ['| 名前 | 内容 | ガードレール |', '| --- | --- | --- |', '| `a.ts` | `agent:ready` を扱う | |'].join('\n');
  assert.deepEqual(namesInTable(table), ['a.ts']);
});

test('namesInTable：1セルに複数の名前がある場合は ・ 区切りをすべて拾う', () => {
  const table = ['| 名前 | 内容 | ガードレール |', '| --- | --- | --- |', '| `review:exempt`・`plan:exempt`・`test:exempt` | 例外ラベル | |'].join('\n');
  assert.deepEqual(namesInTable(table), ['review:exempt', 'plan:exempt', 'test:exempt']);
});

// ---- 単体：staleNames ----

test('staleNames：直下に無い名前を報告する', () => {
  const missing = staleNames(['a.ts', 'nothere.ts'], ['a.ts', 'b.ts']);
  assert.deepEqual(missing, ['nothere.ts']);
});

test('staleNames：`名前/` のディレクトリ表記は children の `名前/` と比べる', () => {
  assert.deepEqual(staleNames(['lib/'], ['lib/', 'a.ts']), []);
  assert.deepEqual(staleNames(['missing/'], ['lib/', 'a.ts']), ['missing/']);
});

test('staleNames：* を含む名前は直下に1つ以上前方一致で当たれば良い', () => {
  assert.deepEqual(staleNames(['risk:*'], ['risk:low.yml', 'risk:high.yml']), []);
  assert.deepEqual(staleNames(['risk:*'], ['other.yml']), ['risk:*']);
});

// ---- 実リポジトリに対する検査（AC1） ----

// .github は README.md を持たず readmeFileFor が root の README.md を指す
test('実リポジトリ：14 のディレクトリの README（.github は root の節。harness/test を含む）に、実在しない名前が無い（AC1）', () => {
  const problems: string[] = [];
  for (const dir of TARGET_DIRS) {
    const path = readmeFileFor(root, dir);
    assert.ok(existsSync(path), `${path} が無い`);
    const names = namesInTable(readFileSync(path, 'utf8'));
    const children = directChildren(root, dir);
    const missing = staleNames(names, children);
    if (missing.length > 0) problems.push(`${dir}: ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `実在しない名前がある: ${problems.join(' / ')}`);
});

test('対象ディレクトリの一覧に harness/test（生成の対象外＝Non-goal）が含まれる', () => {
  assert.ok(TARGET_DIRS.includes('harness/test'));
});
