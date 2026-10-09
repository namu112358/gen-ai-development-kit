/**
 * Issue #530：名前だけ変えたテストの本体が定義の hunk の外まで続くとき、後ろの hunk はテストの本体に入りうる行（境目より前）だけを数える（純粋関数）。
 * - 境目は、字下げが名前を変えた定義以下の次のテスト定義の行と、字下げ 0 の定義なら見出しの関数の文脈が別の名前のテスト定義の hunk
 * - 境目より後ろの別のテストの変更・末尾へのテストの追加があっても renamed-test として Jev に test-name で問う
 * - 境目より前で本体のアサーションでない行が入れ替わる・見出しを境目にできない・子の定義の行は、今までどおり body の無い rewritten-test で止める
 * 本体が後ろの hunk まで続くときの基本の扱いは test-tamper-rewrite.test.ts が受け持つ。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';
import { askableChanges } from '../lib/test-tamper-jev.ts';

const P = DEFAULT_TEST_PATTERNS;

/** 1ファイル・複数 hunk の差分。section は hunk の見出しの `@@ … @@` の後ろ（関数の文脈） */
const multiHunkDiff = (hunks: { start: number; lines: string[]; section?: string }[]): string => {
  const out = ['diff --git a/a.test.ts b/a.test.ts', '--- a/a.test.ts', '+++ b/a.test.ts'];
  let shift = 0;
  for (const h of hunks) {
    const old = h.lines.filter((l) => !l.startsWith('+')).length;
    const neu = h.lines.filter((l) => !l.startsWith('-')).length;
    out.push(`@@ -${h.start},${old} +${h.start + shift},${neu} @@${h.section ? ` ${h.section}` : ''}`, ...h.lines);
    shift += neu - old;
  }
  return [...out, ''].join('\n');
};

/** 名前を 'a' から 'b' に変え、本体が hunk の中で閉じない定義の hunk（indent は定義の行の字下げ） */
const renameHunk = (indent = '', def = 'test') => ({
  start: 3,
  lines: [`-${indent}${def}('a', () => {`, `+${indent}${def}('b', () => {`, ` ${indent}  const x = f(1);`, ` ${indent}  // 1`, ` ${indent}  // 2`],
});

const assertRenamed = (diff: string) => {
  const findings = detectTestTampering(diff, P);
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['renamed-test'],
  );
  const r = askableChanges(findings);
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.ok(r.changes.length > 0 && r.changes.every((c) => c.kind === 'test-name'));
};

const assertStopped = (diff: string, msg = '') => {
  const findings = detectTestTampering(diff, P);
  const rewritten = findings.filter((f) => f.kind === 'rewritten-test');
  assert.equal(rewritten.length, 1, `${msg} ${findings.map((f) => f.kind).join(',')}`);
  assert.equal(rewritten[0]!.body, undefined, msg);
  assert.ok(!findings.some((f) => f.kind === 'renamed-test'), msg);
  assert.equal(askableChanges(findings).ask, false, msg);
};

/** 後ろの hunk：別のテスト（または名前を変えたテストの続き）のアサーションでない行を入れ替える */
const bodyChange = (indent = '') => [`-${indent}  const y = h(1);`, `+${indent}  const y = k(2);`, ` ${indent}  assert.equal(y, 1);`, ` ${indent}});`];

// ---- AC1：境目より後ろの変更は数えず、名前の変更として問う ----

// PR #516 のレビューで挙がった形：長いテストの名前だけを変え、同じファイルの末尾にテストを足す
test('長いテストの名前だけを変え、ファイルの末尾にテストを足しても、renamed-test として test-name で問う', () => {
  const tail = { start: 60, section: "test('a', () => {", lines: ['   assert.equal(x, 1);', ' });', ' ', "+test('new', () => {", '+  const z = f();', '+  assert.equal(z, 1);', '+});'] };
  assertRenamed(multiHunkDiff([renameHunk(), tail]));
});

test('describe の中の it の名前を変え、後ろの hunk の兄弟の it の後ろで別のテストの本体を変えても renamed-test', () => {
  const later = { start: 40, section: "describe('d', () => {", lines: ['     assert.equal(x, 1);', '   });', "   it('c', () => {", ...bodyChange('  ')] };
  assertRenamed(multiHunkDiff([renameHunk('  ', 'it'), later]));
});

test('後ろの hunk の見出しが別のテスト定義なら、その hunk で別のテストの本体を変えても renamed-test', () => {
  assertRenamed(multiHunkDiff([renameHunk(), { start: 40, section: "test('other', () => {", lines: ['   const w = 0;', ...bodyChange()] }]));
});

// ---- 要件2：テストを弱めうる変更は今までどおり止める ----

test('境目より前で名前を変えたテストの本体のアサーションでない行を入れ替えたら、境目が同じ hunk の後ろにあっても止める', () => {
  const later = { start: 40, lines: ['   // 3', ...bodyChange(), ' ', " test('c', () => {"] };
  assertStopped(multiHunkDiff([renameHunk(), later]));
});

test('見出しが名前を変えたテスト自身（前の名前・後の名前）か、名前が途中で切れているなら、見出しを境目にせず止める', () => {
  for (const section of ["test('a', () => {", "test('b', () => {", "test('a very long name that is cu"]) {
    assertStopped(multiHunkDiff([renameHunk(), { start: 40, section, lines: ['   // 3', ...bodyChange()] }]), section);
  }
});

test('字下げのある定義では、見出しが親の describe でも境目にせず止める', () => {
  assertStopped(multiHunkDiff([renameHunk('  ', 'it'), { start: 40, section: "describe('d', () => {", lines: ['     // 3', ...bodyChange('  ')] }]));
});

test('名前を変えた定義より字下げが深い（子の）テスト定義の行は境目にせず、その後ろの本体の書き換えで止める', () => {
  assertStopped(multiHunkDiff([renameHunk('', 'describe'), { start: 40, lines: ["   it('child', () => {", ...bodyChange('  ')] }]));
});

// ---- 見出しの関数の文脈に行の区切りに見える文字があっても、hunk を読み飛ばさない ----

test('hunk の見出しの関数の文脈に U+2028・U+2029・行の途中の CR があっても、アサーションの削除を見逃さない', () => {
  const diffWith = (section: string) => multiHunkDiff([{ start: 10, section, lines: [' const x = f(1);', '-  assert.equal(x, 1);', ' });'] }]);
  const expected = detectTestTampering(diffWith("test('plain', () => {"), P).map((f) => f.kind);
  assert.ok(expected.length > 0);
  for (const sep of ['\u2028', '\u2029', '\r']) {
    const kinds = detectTestTampering(diffWith(`test('a${sep}b', () => {`), P).map((f) => f.kind);
    assert.deepEqual(kinds, expected, JSON.stringify(sep));
  }
});
