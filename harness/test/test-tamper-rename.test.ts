/**
 * 名前だけ変えたテスト定義を「テスト定義の削除」にせず「テストの名前の変更」（renamed-test）として扱う（Issue #421、純粋関数）。
 * - 同じまとまりで組になった削除と追加の定義の行が、名前の文字列のほかは同じなら renamed-test（removed-test・assertion-changed は出さない）
 * - 組にならない定義の削除（追加の側に定義が無い・test → it・引数が足される・別の hunk・別のまとまり）は今までどおり removed-test
 * - 概要（renderTamperSummary）は「テストの名前の変更」の見出しで変更前・変更後を並べる
 * - Jev に問う材料（askableChanges・buildTamperRequest）：名前の変更とアサーションの書き換えだけなら問う。名前の変更の対だけ kind: 'test-name' を持ち（アサーションは今までどおり file・before・after だけ）、
 *   Jev に送る state は file・before・after だけで、違いは問いの文に出す。上限は 40
 * - PR #408 の形（名前の変更 11・アサーションの書き換え 23 の計 34 件）の差分で、34 組を問う
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { DEFAULT_TEST_PATTERNS, TAMPER_KIND_LABELS, detectTestTampering, renderTamperSummary, type TamperFinding } from '../lib/test-tamper.ts';
import { MAX_TAMPER_CHANGES, askableChanges, buildTamperRequest } from '../lib/test-tamper-jev.ts';

const P = DEFAULT_TEST_PATTERNS;
const FILE = 'harness/test/patrol.test.ts';

/** 1ファイル・1 hunk の差分。lines は ' ' / '-' / '+' で始まる */
const fileDiff = (path: string, lines: string[], start = 1): string => {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
};

/** 1ファイル・複数 hunk の差分 */
const multiHunkDiff = (path: string, hunks: { start: number; lines: string[] }[]): string => {
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  let shift = 0;
  for (const h of hunks) {
    const old = h.lines.filter((l) => !l.startsWith('+')).length;
    const neu = h.lines.filter((l) => !l.startsWith('-')).length;
    out.push(`@@ -${h.start},${old} +${h.start + shift},${neu} @@`, ...h.lines);
    shift += neu - old;
  }
  return [...out, ''].join('\n');
};

const kinds = (diff: string) => detectTestTampering(diff, P).map((f) => f.kind);

/** PR #408 の名前の変更の例（Issue #421 の Validation Requirements） */
const OLD_408 = "test('差あり：flakyTests の消えた項目でも差として数え、qa-retro を回し test-prune を勧める', () => {";
const NEW_408 = "test('差あり：flakyTests の消えた項目でも差として数え、qa-retro と test-prune を回す（同じ件数なら表の順）', () => {";

/**
 * PR #408 の形の差分：名前を変えたテスト 11 件と、その中のアサーションの書き換え 23 件（最初のテストに 3 件、残りに 2 件ずつ）。
 * テストごとに名前の行を書き換え、文脈の行をはさんで、アサーションの行を書き換える
 */
function diff408(): string {
  const lines: string[] = [];
  for (let i = 0; i < 11; i++) {
    lines.push(`-test('項目 ${i}：qa-retro を回し test-prune を勧める', () => {`, `+test('項目 ${i}：qa-retro と test-prune を回す（同じ件数なら表の順）', () => {`);
    lines.push(`   const r = decide(${i});`);
    const asserts = i === 0 ? 3 : 2;
    for (let j = 0; j < asserts; j++) {
      lines.push(`-  assert.equal(r.reviews[${j}], 'qa-retro-${i}-${j}');`, `+  assert.equal(r.reviews[${j}], 'test-prune-${i}-${j}');`);
      lines.push(`   // ${i}-${j}`);
    }
    lines.push(' });', ' ');
  }
  return fileDiff(FILE, lines, 90);
}

// ---- detectTestTampering：名前の変更 ----

test('PR #408 の例：同じ位置で名前だけ変えたテスト定義は、テスト定義の削除でなく名前の変更（変更前と変更後の行を持つ）', () => {
  const findings = detectTestTampering(fileDiff(FILE, [`-${OLD_408}`, `+${NEW_408}`, '   assert.ok(true);', ' });'], 97), P);
  assert.deepEqual(findings, [{ kind: 'renamed-test', file: FILE, line: 97, side: 'base', text: OLD_408, after: { line: 97, text: NEW_408 } }]);
});

test('名前の変更：it・describe、二重引用符・テンプレート、字下げの違いでも、名前のほかが同じなら名前の変更', () => {
  for (const [before, after] of [
    ['  it("a", () => {', '  it("b", () => {'],
    ["describe('まとまり', () => {", "describe('まとまり（改）', () => {"],
    ['test(`x`, async (t) => {', 'test(`y`, async (t) => {'],
    ["  test('a', () => {", "    test('b', () => {"],
  ] as const) {
    const findings = detectTestTampering(fileDiff('a.test.ts', [`-${before}`, `+${after}`], 3), P);
    assert.deepEqual(findings, [{ kind: 'renamed-test', file: 'a.test.ts', line: 3, side: 'base', text: before.trim(), after: { line: 3, text: after.trim() } }], before);
  }
});

test('名前の変更：アサーションを含む定義の行でも、アサーションの書き換えを重ねて出さない', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('a', () => assert.ok(x));", "+test('b', () => assert.ok(x));"])), ['renamed-test']);
});

test('名前の変更とアサーションの書き換え：同じテストの中なら、それぞれ renamed-test と assertion-changed（removed-test は出さない）', () => {
  const findings = detectTestTampering(
    fileDiff('a.test.ts', ["-test('前の名前', () => {", "+test('後の名前', () => {", '   const x = f();', '-  assert.equal(x, 2);', '+  assert.equal(x, 3);', ' });'], 5),
    P,
  );
  assert.deepEqual(findings, [
    { kind: 'renamed-test', file: 'a.test.ts', line: 5, side: 'base', text: "test('前の名前', () => {", after: { line: 5, text: "test('後の名前', () => {" } },
    { kind: 'assertion-changed', file: 'a.test.ts', line: 7, side: 'base', text: 'assert.equal(x, 2);', after: { line: 7, text: 'assert.equal(x, 3);' } },
  ]);
});

test('名前の変更：1つのまとまりで続けて2つ変えたら、削除と追加の k 番目どうしを組む', () => {
  const findings = detectTestTampering(fileDiff('a.test.ts', ["-test('a1', () => {});", "-test('b1', () => {});", "+test('a2', () => {});", "+test('b2', () => {});"]), P);
  assert.deepEqual(
    findings.map((f) => [f.kind, f.text, f.after?.text]),
    [
      ['renamed-test', "test('a1', () => {});", "test('a2', () => {});"],
      ['renamed-test', "test('b1', () => {});", "test('b2', () => {});"],
    ],
  );
});

// ---- detectTestTampering：組にならない定義の削除は今までどおり ----

test('組にならない：追加の側に定義が無い削除は removed-test', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', [" test('keep', () => {});", "-test('gone', () => {});"])), ['removed-test']);
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('gone', () => {", '+const x = 1;'])), ['removed-test'], '追加の行が定義でない');
});

test('組にならない：test → it のように呼び出しが変わるなら removed-test', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('a', () => {", "+it('b', () => {"])), ['removed-test']);
});

test('組にならない：引数が足される（{ skip: true } など）・行の残りが変わるなら removed-test（skip の追加も今までどおり）', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('a', () => {", "+test('b', { skip: true }, () => {"])), ['removed-test', 'skip-added']);
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('a', () => {", "+test('b', async () => {"])), ['removed-test']);
});

test('組にならない：別の hunk に足された定義は removed-test', () => {
  const diff = multiHunkDiff('a.test.ts', [
    { start: 3, lines: [' // 1', "-test('a', () => {});", ' // 2'] },
    { start: 40, lines: [' // 3', "+test('b', () => {});", ' // 4'] },
  ]);
  assert.deepEqual(kinds(diff), ['removed-test']);
});

test('組にならない：同じ hunk でも、文脈の行をはさんだ別のまとまりに足された定義は removed-test', () => {
  assert.deepEqual(kinds(fileDiff('a.test.ts', ["-test('a', () => {});", ' // 間', "+test('b', () => {});"])), ['removed-test']);
});

test('組にならない削除と名前の変更が混ざれば、それぞれ removed-test と renamed-test', () => {
  const diff = fileDiff('a.test.ts', ["-test('a', () => {});", "+test('a2', () => {});", ' // 間', "-test('gone', () => {});"]);
  assert.deepEqual(kinds(diff).sort(), ['removed-test', 'renamed-test']);
});

// ---- 概要 ----

test('概要：「テストの名前の変更」の見出しで分けて、変更前・変更後を並べる（テスト定義の削除の見出しは出さない）', () => {
  assert.equal(TAMPER_KIND_LABELS['renamed-test'], 'テストの名前の変更');
  const findings = detectTestTampering(fileDiff(FILE, [`-${OLD_408}`, `+${NEW_408}`], 97), P);
  const summary = renderTamperSummary(findings);
  assert.match(summary, /\*\*テストの名前の変更\*\*/);
  assert.doesNotMatch(summary, /\*\*テスト定義の削除\*\*/);
  const at = summary.indexOf('**テストの名前の変更**');
  const section = summary.slice(at);
  const before = section.indexOf('差あり：flakyTests の消えた項目でも差として数え、qa-retro を回し test-prune を勧める');
  const after = section.indexOf('qa-retro と test-prune を回す（同じ件数なら表の順）');
  assert.ok(before > 0 && after > before, '見出しの下に変更前、続けて変更後');
  assert.match(section, /変更前/);
  assert.match(section, /変更後/);
});

// ---- PR #408 の形 ----

test('PR #408 の形：名前の変更 11 件とアサーションの書き換え 23 件を検出し、テスト定義の削除は無い', () => {
  const findings = detectTestTampering(diff408(), P);
  assert.equal(findings.filter((f) => f.kind === 'renamed-test').length, 11);
  assert.equal(findings.filter((f) => f.kind === 'assertion-changed').length, 23);
  assert.equal(findings.length, 34);
  assert.ok(findings.every((f) => f.after), 'すべて変更後の行と組になる');
});

// ---- askableChanges ----

test('askableChanges：PR #408 の形（名前の変更 11・アサーションの書き換え 23）は 34 組を問い、名前の変更だけ kind: test-name を持つ', () => {
  const r = askableChanges(detectTestTampering(diff408(), P));
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.equal(r.changes.length, 34);
  assert.equal(r.changes.filter((c) => c.kind === 'test-name').length, 11);
  assert.equal(r.changes.filter((c) => !('kind' in c)).length, 23, 'アサーションの書き換えは kind を持たない');
  assert.deepEqual(r.changes[0], {
    kind: 'test-name',
    file: FILE,
    before: "test('項目 0：qa-retro を回し test-prune を勧める', () => {",
    after: "test('項目 0：qa-retro と test-prune を回す（同じ件数なら表の順）', () => {",
  });
  assert.deepEqual(r.changes[1], { file: FILE, before: "assert.equal(r.reviews[0], 'qa-retro-0-0');", after: "assert.equal(r.reviews[0], 'test-prune-0-0');" });
});

const renamed = (i: number): TamperFinding => ({ kind: 'renamed-test', file: FILE, line: i + 1, side: 'base', text: `test('a${i}', () => {`, after: { line: i + 1, text: `test('b${i}', () => {` } });
const changed = (i: number): TamperFinding => ({ kind: 'assertion-changed', file: FILE, line: i + 1, side: 'base', text: `assert.equal(f(${i}), 1);`, after: { line: i + 1, text: `assert.equal(f(${i}), 2);` } });

test('askableChanges：上限は 40 組。40 組までは問い、41 組は「問う組が多すぎます」で問わない', () => {
  assert.equal(MAX_TAMPER_CHANGES, 40);
  const mix = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? renamed(i) : changed(i)));
  const forty = askableChanges(mix(40));
  assert.ok(forty.ask && forty.changes.length === 40);
  const over = askableChanges(mix(41));
  assert.equal(over.ask, false);
  assert.ok(!over.ask && over.reason.includes('問う組が多すぎます'), !over.ask ? over.reason : '');
});

test('askableChanges：名前の変更だけでも問う', () => {
  const r = askableChanges([renamed(0)]);
  assert.ok(r.ask);
  assert.deepEqual(r.changes, [{ kind: 'test-name', file: FILE, before: "test('a0', () => {", after: "test('b0', () => {" }]);
});

test('askableChanges：名前の変更があっても、removed-test などが1件でもあれば問わない', () => {
  const removed: TamperFinding = { kind: 'removed-test', file: FILE, line: 50, side: 'base', text: "test('gone', () => {" };
  assert.equal(askableChanges([renamed(0), changed(1), removed]).ask, false);
  const fromDiff = detectTestTampering(fileDiff('a.test.ts', ["-test('a', () => {});", "+test('a2', () => {});", ' // 間', "-test('gone', () => {});"]), P);
  assert.equal(askableChanges(fromDiff).ask, false);
});

test('askableChanges：変更後の行が無い名前の変更は問わない', () => {
  const noAfter: TamperFinding = { kind: 'renamed-test', file: FILE, line: 3, side: 'base', text: "test('a', () => {" };
  assert.equal(askableChanges([changed(0), noAfter]).ask, false);
});

// ---- buildTamperRequest ----

const config: HarnessConfig = (() => {
  const base = loadConfig();
  return { ...base, jev: { ...base.jev, testTamper: 'enforce', thresholds: { ...base.jev.thresholds, testTamperProbability: 0.9 } } };
})();

test('buildTamperRequest：state.changes は file・before・after だけで、名前の変更にはアサーションと違う英語の問いを出す', () => {
  const r = askableChanges([renamed(0), changed(1)]);
  assert.ok(r.ask);
  const req = buildTamperRequest(config, r.changes);
  const changes = (req.state as { changes: Record<string, string>[] }).changes;
  assert.deepEqual(changes, [
    { file: FILE, before: "test('a0', () => {", after: "test('b0', () => {" },
    { file: FILE, before: 'assert.equal(f(1), 1);', after: 'assert.equal(f(1), 2);' },
  ]);
  const q0 = req.questions.change_0 as { type: string; instructions: string };
  const q1 = req.questions.change_1 as { type: string; instructions: string };
  assert.equal(q0.type, 'noul');
  assert.equal(q1.type, 'noul');
  assert.notEqual(q0.instructions, q1.instructions.replaceAll('changes[1]', 'changes[0]'), '名前の変更とアサーションで問いが違う');
  assert.match(q0.instructions, /test name/i);
  assert.match(q0.instructions, /renamed/i);
  assert.match(q0.instructions, /changes\[0\]/);
  assert.match(q1.instructions, /assertion line/);
  assert.doesNotMatch(q0.instructions, /[　-ヿ㐀-鿿＀-￯]/, '日本語を含めない');
});
