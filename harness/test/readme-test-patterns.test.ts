/**
 * harness/test/README.md の表をファイル名のパターンで書く形の検査（Issue #389）。
 * uncoveredTests がどのパターンにも当たらない .test.ts だけを返すこと、checkAll がそれを uncoveredTests に出すこと、
 * 実リポジトリのテストファイルがすべてどれかのパターンに当たり、表に個々のテストファイル名が無いことを確かめる。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkAll, directChildren, namesInTable, uncoveredTests } from '../scripts/readme.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- 単体：uncoveredTests ----

test('uncoveredTests：どのパターンにも当たらない .test.ts だけを返す', () => {
  const patterns = ['gates-*.test.ts', 'readme-*.test.ts'];
  const children = ['gates-plan.test.ts', 'readme-index.test.ts', 'orphan.test.ts', 'another-new.test.ts'];
  assert.deepEqual(uncoveredTests(patterns, children).sort(), ['another-new.test.ts', 'orphan.test.ts']);
});

test('uncoveredTests：support/ などのディレクトリと、README.md など .test.ts 以外は見ない', () => {
  const patterns = ['gates-*.test.ts'];
  const children = ['README.md', 'support/', 'helper.ts', 'gates-pr.test.ts'];
  assert.deepEqual(uncoveredTests(patterns, children), []);
});

test('uncoveredTests：全部を覆うパターン（*.test.ts・**.test.ts・**/*.test.ts）は数えない', () => {
  const children = ['gates-pr.test.ts', 'orphan.test.ts'];
  for (const all of ['*.test.ts', '**.test.ts', '**/*.test.ts']) {
    assert.deepEqual(
      uncoveredTests([all, 'gates-*.test.ts'], children),
      ['orphan.test.ts'],
      `${all} で全部が覆われたことにしてはいけない`,
    );
  }
});

test('uncoveredTests：既にあるパターンに当たる新しいファイルを足しても空のまま（Validation の代わり）', () => {
  const patterns = ['gates-*.test.ts', 'dashboard-*.test.ts', 'support/'];
  const before = ['gates-plan.test.ts', 'dashboard-cards.test.ts', 'support/'];
  assert.deepEqual(uncoveredTests(patterns, before), []);
  const after = [...before, 'gates-brand-new-handler.test.ts', 'dashboard-new-card.test.ts'];
  assert.deepEqual(uncoveredTests(patterns, after), []);
});

// ---- 一時ディレクトリ（git 管理外。fs のフォールバック）で checkAll ----

test('checkAll：harness/test の表のどのパターンにも当たらないファイル名を uncoveredTests に出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readme-test-patterns-'));
  try {
    const testDir = join(dir, 'harness', 'test');
    mkdirSync(join(testDir, 'support'), { recursive: true });
    writeFileSync(
      join(testDir, 'README.md'),
      [
        '# harness/test/',
        '',
        '| 種類 | 内容 |',
        '| --- | --- |',
        '| `gates-*.test.ts` | ゲートのテスト |',
        '| `support/` | 補助 |',
        '',
      ].join('\n'),
    );
    writeFileSync(join(testDir, 'gates-plan.test.ts'), '// x\n');
    writeFileSync(join(testDir, 'orphan.test.ts'), '// x\n');
    writeFileSync(join(testDir, 'support', 'helper.ts'), '// x\n');

    const result = checkAll(dir);
    assert.ok(Array.isArray(result.uncoveredTests), 'CheckResult に uncoveredTests が無い');
    const joined = result.uncoveredTests.join('\n');
    assert.match(joined, /orphan\.test\.ts/);
    assert.doesNotMatch(joined, /gates-plan\.test\.ts/);
    assert.doesNotMatch(joined, /helper\.ts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAll：すべてがパターンに当たれば uncoveredTests は空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readme-test-patterns-'));
  try {
    const testDir = join(dir, 'harness', 'test');
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'README.md'),
      ['| 種類 | 内容 |', '| --- | --- |', '| `gates-*.test.ts` | ゲート |', '| `readme-*.test.ts` | README |', ''].join('\n'),
    );
    writeFileSync(join(testDir, 'gates-plan.test.ts'), '// x\n');
    writeFileSync(join(testDir, 'readme-new.test.ts'), '// x\n');
    assert.deepEqual(checkAll(dir).uncoveredTests, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 実リポジトリ ----

const readmeText = (): string => readFileSync(join(root, 'harness', 'test', 'README.md'), 'utf8');

test('実リポジトリ：harness/test のテストファイルはすべて README の表のどれかのパターンに当たる（AC3）', () => {
  assert.deepEqual(checkAll(root).uncoveredTests, []);
});

test('実リポジトリ：uncoveredTests を直接呼んでも、今あるテストファイルに当たらないものが無い（AC3）', () => {
  const names = namesInTable(readmeText());
  assert.deepEqual(uncoveredTests(names, directChildren(root, 'harness/test')), []);
});

test('実リポジトリ：README の表の1列目は、* を含むパターンか support/ だけ（AC1）', () => {
  const names = namesInTable(readmeText());
  assert.ok(names.length > 0, '表の1列目に名前が無い');
  const bad = names.filter((n) => !n.includes('*') && n !== 'support/');
  assert.deepEqual(bad, [], `パターンでない名前がある: ${bad.join(', ')}`);
});

test('実リポジトリ：README の表のどの列にも、* を含まない個々のテストファイル名が無い（AC1）', () => {
  const found: string[] = [];
  for (const line of readmeText().split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const name = m[1]!;
      // 実在しうるファイル名の形（英数字・-・_・.）だけを数える。`<機能名>.test.ts` のような書き方の例は数えない
      if (/^[\w.-]+\.test\.ts$/.test(name) && !name.includes('*')) found.push(name);
    }
  }
  assert.deepEqual(found, [], `表に個々のテストファイル名がある: ${found.join(', ')}`);
});
