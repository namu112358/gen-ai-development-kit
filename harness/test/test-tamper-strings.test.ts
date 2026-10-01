// agent/tests の skip・only・todo の追加の検出（detectTestTampering の skip-added）が、
// 文字列リテラルの中の一致を数えず、文字列の外・コメントの中・伏せられない行の一致は今までどおり数えることを確かめる（Issue #431）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';

/** 1ファイル・1 hunk の差分。lines は ' ' / '-' / '+' で始まる */
function fileDiff(path: string, lines: string[], start = 1): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
}

const skips = (diff: string) => detectTestTampering(diff, DEFAULT_TEST_PATTERNS).filter((f) => f.kind === 'skip-added');

/** PR #428 の固定値（harness/test/gates-auto-mode-merge.test.ts の SKIP_DIFF）の行 */
const PR428_LINE = String.raw`const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";`;

test('文字列リテラルの中の skip・only・todo は数えない', () => {
  for (const line of [PR428_LINE, "const s = '.only(';", 'const s = `x.todo(`;', String.raw`const s = "a\"b.skip(c";`]) {
    assert.deepEqual(skips(fileDiff('a.test.ts', [`+${line}`])), [], line);
  }
});

test('文字列の外・コメントの中・伏せられない行の skip・only・todo は今までどおり数える', () => {
  for (const line of [
    "test.skip('a', () => {});",
    'it.only("a", () => {});',
    "xit('a', () => {});",
    "test('a', { skip: true }, () => {});",
    "const s = 'x'; test.skip('a', () => {});",
    "const s = `${test.skip('a')}`;",
    "/'/.test(x); test.skip('a', () => {});",
    '// test.skip(',
    "/* it's */ test.skip('a', () => {});",
    'const n = a / b; const s = "x.skip(";',
  ]) {
    const found = skips(fileDiff('a.test.ts', [`+  ${line}`]));
    assert.deepEqual(found.map((f) => f.text), [line], `${line}（text は生の行の trim のまま）`);
  }
});

test('行をまたぐテンプレートの中・閉じた後の一致は数える', () => {
  const after = skips(fileDiff('a.test.ts', ['+const t = `abc', "+`; test.skip('a', () => {}); const y = `"]));
  assert.deepEqual(after.map((f) => [f.line, f.text]), [[2, "`; test.skip('a', () => {}); const y = `"]]);

  const inside = skips(fileDiff('a.test.ts', [' const t = `', "+test.skip('a');", ' `;']));
  assert.deepEqual(inside.map((f) => f.line), [2], '文脈の行で開いたテンプレートの中の一致も数える');
});

test('状態は hunk の見出しごとに初めに戻す', () => {
  const diff = [
    'diff --git a/a.test.ts b/a.test.ts',
    '--- a/a.test.ts',
    '+++ b/a.test.ts',
    '@@ -1,1 +1,1 @@',
    ' const t = `abc',
    '@@ -20,0 +20,1 @@',
    "+const s = '.only(';",
    '',
  ].join('\n');
  assert.deepEqual(skips(diff), []);
});
