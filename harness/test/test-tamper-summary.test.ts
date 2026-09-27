import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS, detectTestTampering, renderTamperSummary, type TamperFinding } from '../lib/test-tamper.ts';

const P = DEFAULT_TEST_PATTERNS;

/** 1ファイル・1 hunk の差分。lines は ' ' / '-' / '+' で始まる */
function fileDiff(path: string, lines: string[], start = 1): string {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
}

/** after を除いた finding（変更前からある項目だけ） */
const core = (fs: TamperFinding[]) => fs.map(({ kind, file, line, side, text }) => ({ kind, file, line, side, text }));
const afters = (diff: string) => detectTestTampering(diff, P).filter((f) => f.kind === 'assertion-changed').map((f) => [f.line, f.after?.line, f.after?.text]);

const DELETED = "diff --git a/a.test.ts b/a.test.ts\ndeleted file mode 100644\n--- a/a.test.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-test('x', () => {\n-});\n";
const RENAMED = 'diff --git a/test/a.ts b/lib/a.ts\nsimilarity index 100%\nrename from test/a.ts\nrename to lib/a.ts\n';
const REMOVED_TEST = fileDiff('x.test.ts', [" test('a', () => {", '-  it("b", () => {});', ' });'], 10);
const SKIP = fileDiff('s.test.ts', ["-test('a', () => {});", "+test.skip('a', () => {});"]);
const CHANGED = fileDiff('a.test.ts', ['-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);'], 5);
/** 2つのまとまり。1つ目は数が合わない（削除 3・追加 1）。移動として相殺される行と、アサーションでない行を含む */
const MIXED = fileDiff('m.test.ts', [
  '-  const a = 1;',
  '-  assert.equal(a, 1);',
  '-  assert.ok(b);',
  '+  const a = 2;',
  ' ',
  '-  assert.ok(moved);',
  '-  assert.equal(c, 3);',
  '+  assert.equal(c, 4);',
  '+  assert.ok(moved);',
], 20);
/** 追加が先にあり、削除だけのまとまりが後に続く（対にならない） */
const ADD_THEN_REMOVE = fileDiff('r.test.ts', ['+  assert.ok(x);', ' const y = 1;', '-  assert.ok(z);']);

test('同じ差分で、finding の件数と種類（と行・本文）が変更前と同じ', () => {
  const found = core(detectTestTampering(DELETED + RENAMED + REMOVED_TEST + SKIP + CHANGED + MIXED + ADD_THEN_REMOVE, P));
  assert.deepEqual(found, [
    { kind: 'deleted-file', file: 'a.test.ts', line: undefined, side: undefined, text: undefined },
    { kind: 'renamed-away', file: 'test/a.ts → lib/a.ts', line: undefined, side: undefined, text: undefined },
    { kind: 'removed-test', file: 'x.test.ts', line: 11, side: 'base', text: 'it("b", () => {});' },
    { kind: 'skip-added', file: 's.test.ts', line: 1, side: 'head', text: "test.skip('a', () => {});" },
    { kind: 'assertion-changed', file: 'a.test.ts', line: 5, side: 'base', text: 'assert.equal(f(), 2);' },
    { kind: 'assertion-changed', file: 'm.test.ts', line: 21, side: 'base', text: 'assert.equal(a, 1);' },
    { kind: 'assertion-changed', file: 'm.test.ts', line: 22, side: 'base', text: 'assert.ok(b);' },
    { kind: 'assertion-changed', file: 'm.test.ts', line: 25, side: 'base', text: 'assert.equal(c, 3);' },
    { kind: 'assertion-changed', file: 'r.test.ts', line: 2, side: 'base', text: 'assert.ok(z);' },
  ]);
});

test('同じまとまりの削除と追加を、k 番目どうしで対にする', () => {
  assert.deepEqual(afters(CHANGED), [[5, 5, 'assert.equal(f(), 3);']]);
});

test('数が合わない・アサーションでない行が混ざる・移動として相殺された行は、残った行の位置どおりに組む', () => {
  // 1つ目のまとまり：const a の削除が const a の追加と組み、assert の2行は余る
  // 2つ目のまとまり：assert.ok(moved) は相殺されるので、assert.equal(c, 3) と assert.equal(c, 4) が組む
  assert.deepEqual(afters(MIXED), [[21, undefined, undefined], [22, undefined, undefined], [25, 22, 'assert.equal(c, 4);']]);
});

test('削除の前にある追加や、削除だけのまとまりは対にしない', () => {
  assert.deepEqual(afters(ADD_THEN_REMOVE), [[2, undefined, undefined]]);
  assert.deepEqual(afters(fileDiff('d.test.ts', ['-  assert.ok(1);', ' x', '+  assert.ok(2);'])), [[1, undefined, undefined]]);
});

test('概要の先頭に、見張っているもの・止まった理由・人が確かめること・通し方の説明が入る', () => {
  const s = renderTamperSummary(detectTestTampering(CHANGED, P));
  const at = (re: RegExp) => s.search(re);
  assert.ok(s.startsWith('### 何を見張っているか'), '説明が先頭にある');
  assert.match(s, /採点基準/);
  assert.match(s, /中身に関わらず止め/);
  assert.match(s, /期待する結果/);
  assert.match(s, /テストが消えたり/);
  assert.match(s, /`test:exempt`/);
  assert.match(s, /付け直/, 'ラベルのあとに push したら付け直すことを書く');
  assert.ok(at(/人が確かめること/) < at(/通し方/) && at(/通し方/) < at(/検出したもの/));
});

test('検出の種類ごとに一言の説明を付ける（5種）', () => {
  const s = renderTamperSummary(detectTestTampering(DELETED + RENAMED + REMOVED_TEST + SKIP + CHANGED, P));
  for (const re of [/テストのファイルがまるごと消えて/, /テストとして扱われない/, /テストの項目.*消えて/, /テストを飛ばす/, /採点基準の行.*書き換わって/]) assert.match(s, re);
  const one = renderTamperSummary(detectTestTampering(SKIP, P));
  assert.doesNotMatch(one, /まるごと消えて/, '検出の無い種類の説明は出さない');
});

test('書き換えは変更前と変更後の行を並べ、対の無いものは今のまま1行で出す', () => {
  const s = renderTamperSummary(detectTestTampering(CHANGED + ADD_THEN_REMOVE, P));
  assert.match(s, /`a\.test\.ts:5（変更前）` → `:5（変更後）`\n {2}- 変更前：`assert\.equal\(f\(\), 2\);`\n {2}- 変更後：`assert\.equal\(f\(\), 3\);`/);
  assert.match(s, /- `r\.test\.ts:2（変更前）` — `assert\.ok\(z\);`/);
});

test('件数の上限を超えたら「ほか N 件」に丸める', () => {
  const s = renderTamperSummary(detectTestTampering(MIXED, P), 2);
  assert.match(s, /m\.test\.ts:22/);
  assert.doesNotMatch(s, /m\.test\.ts:25/);
  assert.match(s, /ほか 1 件/);
});
