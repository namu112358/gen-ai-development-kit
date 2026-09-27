import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS, detectTestTampering, isTestFile, renderTamperSummary } from '../lib/test-tamper.ts';

const P = DEFAULT_TEST_PATTERNS;

/** 1ファイル・1 hunk の差分。lines は ' ' / '-' / '+' で始まる */
function fileDiff(path: string, lines: string[], start = 1): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
}

const kinds = (diff: string) => detectTestTampering(diff, P).map((f) => f.kind);

test('テストファイルをパターンで見分ける', () => {
  assert.ok(isTestFile(P, 'harness/test/scope.test.ts'));
  assert.ok(isTestFile(P, 'src/a.spec.js'));
  assert.ok(isTestFile(P, 'test/helpers.ts'));
  assert.ok(isTestFile(P, 'pkg/__tests__/x.ts'));
  assert.ok(!isTestFile(P, 'harness/lib/scope.ts'));
  assert.ok(!isTestFile(P, 'docs/testing.md'));
});

test('テストの削除：ファイルの削除、リネームによる消失、テスト定義の削除', () => {
  const deleted = 'diff --git a/a.test.ts b/a.test.ts\ndeleted file mode 100644\n--- a/a.test.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-test(\'x\', () => {\n-});\n';
  assert.deepEqual(detectTestTampering(deleted, P), [{ kind: 'deleted-file', file: 'a.test.ts' }]);

  const renamed = 'diff --git a/test/a.ts b/lib/a.ts\nsimilarity index 100%\nrename from test/a.ts\nrename to lib/a.ts\n';
  assert.deepEqual(kinds(renamed), ['renamed-away']);
  const moved = 'diff --git a/test/a.ts b/tests/a.ts\nsimilarity index 100%\nrename from test/a.ts\nrename to tests/a.ts\n';
  assert.deepEqual(kinds(moved), [], 'テストのパスどうしのリネームは数えない');

  const removed = detectTestTampering(fileDiff('x.test.ts', [" test('a', () => {", '-  it("b", () => {});', ' });'], 10), P);
  assert.deepEqual(removed, [{ kind: 'removed-test', file: 'x.test.ts', line: 11, side: 'base', text: 'it("b", () => {});' }]);
});

test('skip・only・todo の追加', () => {
  for (const line of ["test.skip('a', () => {});", "it.only('a', () => {});", "xit('a', () => {});", "test('a', { skip: true }, () => {});", "test('a', { todo: 'later' }, () => {});", '  t.skip();', "describe.todo('a');"]) {
    assert.deepEqual(kinds(fileDiff('a.test.ts', [`+${line}`])), ['skip-added'], line);
  }
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["+test('a', { skip: false }, () => {});"])), [], 'skip: false は数えない');
  assert.deepEqual(kinds(fileDiff('lib/a.ts', ['+x.skip(1);'])), [], 'テスト以外のファイルは見ない');
});

test('期待値の変更：アサーションの行の削除・書き換え（整形だけでも）', () => {
  const changed = detectTestTampering(fileDiff('a.test.ts', ['-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);'], 5), P);
  assert.deepEqual(changed, [{ kind: 'assertion-changed', file: 'a.test.ts', line: 5, side: 'base', text: 'assert.equal(f(), 2);', after: { line: 5, text: 'assert.equal(f(), 3);' } }]);
  assert.deepEqual(kinds(fileDiff('a.spec.js', ['-  expect(x).toBe(1);'])), ['assertion-changed']);
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-  assert.equal(f(), 'a');", '+  assert.equal(f(), "a");'])), ['assertion-changed'], '整形だけでも検出する');
  assert.deepEqual(kinds(fileDiff('a.test.ts', ['-assert.ok(x);', '+    assert.ok(x);'])), [], 'インデントだけの違いは移動とみなす');
});

test('移動：同じファイルで同じ名前の定義・同じ内容の行が足されていれば数えない', () => {
  const diff = fileDiff('a.test.ts', ["-test('a', () => {", '-  assert.ok(f());', '-});', ' const x = 1;', "+test('a', () => {", '+  assert.ok(f());', '+});']);
  assert.deepEqual(kinds(diff), []);
  const renamedBody = fileDiff('a.test.ts', ["-test('a', () => {", "+test('a', async () => {"]);
  assert.deepEqual(kinds(renamedBody), [], '同じ名前の定義なら書き換えても数えない');
});

test('テストの追加だけ、テスト以外だけの差分は検出しない', () => {
  const add = fileDiff('a.test.ts', [' import { test } from "node:test";', "+test('new', () => {", '+  assert.equal(f(), 1);', '+});']);
  const newFile = 'diff --git a/b.test.ts b/b.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.test.ts\n@@ -0,0 +1,1 @@\n+test(\'b\', () => assert.ok(1));\n';
  const lib = fileDiff('harness/lib/a.ts', ['-  assert(x);', '+  return;']);
  assert.deepEqual(detectTestTampering(add + newFile + lib, P), []);
});

test('hunk の中の `--- ` で始まる削除行を見出しと取り違えない', () => {
  const diff = fileDiff('a.test.ts', ['--- assert(x) ---', '+ok']);
  assert.deepEqual(kinds(diff), ['assertion-changed']);
});

test('要約はファイルと行を一覧にし、多すぎれば件数に丸める', () => {
  const f = detectTestTampering(fileDiff('a.test.ts', ['-assert.ok(1);', '-assert.ok(2);', '-assert.ok(3);']), P);
  const s = renderTamperSummary(f, 2);
  assert.match(s, /`a\.test\.ts:1（変更前）`/);
  assert.match(s, /ほか 1 件/);
});

test('引用符付きのパスの見出しがあっても、前後のファイルの検出を失わない', () => {
  const quotedHeader = 'diff --git "a/x\\"y.md" "b/x\\"y.md"\n--- "a/x\\"y.md"\n+++ "b/x\\"y.md"\n@@ -1 +1 @@\n-a\n+b\n';
  const before = fileDiff('b.test.ts', ['-  assert.ok(1);']);
  assert.deepEqual(kinds(before + quotedHeader), ['assertion-changed'], '直前のテストファイルの検出が残る');
  const quotedTestDeleted = 'diff --git "a/t/\\303\\251.test.ts" "b/t/\\303\\251.test.ts"\ndeleted file mode 100644\n--- "a/t/\\303\\251.test.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-test(\'x\', () => {});\n';
  const found = detectTestTampering(quotedTestDeleted, P);
  assert.deepEqual(found.map((f) => [f.kind, f.file]), [['deleted-file', 't/é.test.ts']], '先頭が引用符付きのテストファイルの削除でも検出し、8 進のバイト列を戻す');
});

test('import assert の行の削除はアサーションの変更とみなさない', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-import assert from 'node:assert/strict';", "+import assert from 'node:assert';"])), []);
});

test('空白を含むパスのバイナリのテストファイルの削除も検出する', () => {
  const diff = 'diff --git a/test/a b.snap b/test/a b.snap\ndeleted file mode 100644\nBinary files a/test/a b.snap and /dev/null differ\n';
  assert.deepEqual(detectTestTampering(diff, P).map((f) => [f.kind, f.file]), [['deleted-file', 'test/a b.snap']]);
});
