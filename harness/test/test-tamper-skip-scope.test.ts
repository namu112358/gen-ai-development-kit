// agent/tests の skip の検出（detectTestTampering の skip-added）の範囲を確かめる（Issue #607）：
// 型の書き方・普通のオブジェクトの skip と、新しいテストファイルの skip・todo は数えず、既存のファイルの skip と新しいファイルの only は今までどおり数える
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';

/** 既存のファイルの1 hunk の差分。lines は ' ' / '-' / '+' で始まる */
function fileDiff(path: string, lines: string[], start = 1): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
}

/** 新しく足したファイルの差分。lines は '+' を付けない中身の行 */
function newFileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

const skips = (diff: string) => detectTestTampering(diff, DEFAULT_TEST_PATTERNS).filter((f) => f.kind === 'skip-added');

/** PR #587 の harness/test/mod-version.test.ts の3行 */
const PR587_TYPE = 'function modVersionProblem(cwd: string, baseRef: string): { skip: string } | { problem: string } | null {';
const PR587_RETURN = '  if (!base) return { skip: `${baseRef} との merge-base が取れない（履歴が無い）` };';
const PR587_T_SKIP = '    t.skip(r.skip);';

test('PR #587 の3行を新しいテストファイルで足しても skip-added にならない', () => {
  assert.deepEqual(skips(newFileDiff('harness/test/mod-version.test.ts', [PR587_TYPE, PR587_RETURN, PR587_T_SKIP])), []);
});

test('型の書き方と return { skip: … } は、既存のテストファイルに足しても skip-added にならない', () => {
  for (const line of [PR587_TYPE, PR587_RETURN]) {
    assert.deepEqual(skips(fileDiff('harness/test/mod-version.test.ts', [`+${line}`])), [], line);
  }
});

test('既存のテストファイルに足した { skip: true }・.skip( は今までどおり skip-added になる', () => {
  for (const line of ["test('x', { skip: true }, () => {});", "test.skip('x', () => {});"]) {
    const found = skips(fileDiff('harness/test/a.test.ts', [`+${line}`]));
    assert.deepEqual(found.map((f) => f.text), [line], line);
  }
});

test('新しいテストファイルの only は今までどおり skip-added になる', () => {
  for (const line of ["test.only('x', () => {});", "test('x', { only: true }, () => {});"]) {
    const found = skips(newFileDiff('harness/test/new.test.ts', [line]));
    assert.deepEqual(found.map((f) => f.text), [line], line);
  }
});

test('新しいテストファイルの skip・todo は skip-added にならない', () => {
  for (const line of ["test.skip('x', () => {});", "test.todo('x');", "test('x', { todo: 'later' }, () => {});"]) {
    assert.deepEqual(skips(newFileDiff('harness/test/new.test.ts', [line])), [], line);
  }
});
