/**
 * Issue #477：名前と中身を一緒に直したテストを「テストの中身の書き換え」（rewritten-test）として、前と後の本体を Jev に問う（純粋関数）。
 * - テスト定義の組は定義の行どうしで作る（間に足したコメントで組がずれない）。PR #476 の形は removed-test でなく rewritten-test で、body に前後の本体を持つ
 * - 名前を変えて本体のアサーションでない行を入れ替えたら、名前の変更の1問（test-name）だけでは済まず test-body の組を問う
 * - 本体が後ろの hunk まで続き、後ろの hunk で本体の行が入れ替わるなら body を持たず問わない。後ろの hunk がアサーションの書き換えだけなら今までどおり renamed-test
 * - 上限：本体は1件 MAX_TAMPER_BODY_CHARS（4000）まで、全部の組の before＋after の合計は maxStateChars まで。超えたら一部だけ問わずに問わない
 * - test-body の問いは名前の変更・アサーションの問いと違う英語の文で、state は file・before・after だけ
 * 名前の変更・アサーションの書き換え・組の上限 40 は test-tamper-rename.test.ts・test-tamper-jev.test.ts が受け持つ。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { DEFAULT_TEST_PATTERNS, TAMPER_KIND_LABELS, detectTestTampering, type TamperFinding } from '../lib/test-tamper.ts';
import { MAX_TAMPER_BODY_CHARS, askableChanges, buildTamperRequest } from '../lib/test-tamper-jev.ts';

const P = DEFAULT_TEST_PATTERNS;
const FILE = 'harness/test/hq-intel-skill.test.ts';

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

const kinds = (diff: string) =>
  detectTestTampering(diff, P)
    .map((f) => f.kind)
    .sort();

// ---- AC1：PR #476 の形（2aec712 の hq-intel-skill.test.ts、@@ -72,12 +73,17 @@ の定義の行から `});` まで） ----

const OLD_476 =
  "test('fleet の skill「Orca の worker として動くとき」：範囲の外の気づきを hq を通さず SendMessage（to: intel）で送り、worker_done に intel への送信を含める', () => {";
const NEW_476 =
  "test('fleet の skill「Orca の worker として動くとき」の手順9：範囲の外の気づきを hq を通さず SendMessage（to: intel）で送り、人の判断が要るか迷ったら hq に上げ、混ざるときは分ける。手順4に intel への送信がある', () => {";

const diff476 = (): string =>
  fileDiff(
    FILE,
    [
      `-${OLD_476}`,
      '+// #432：節の全体ではなく手順9の中だけを見る（手順9を消すと落ちる）。',
      '+// `hq に上げる` は前からの文にもあるので、#432 の文（迷ったら hq に上げる・混ざるときは分ける）が消えたら落ちることは',
      '+// `迷ったら`・`混ざる`・`分け` が受け持つ。',
      `+${NEW_476}`,
      "+  const worker = section(fleetSkill(), '## Orca の worker として動くとき');",
      '   assertWords(',
      "-    section(fleetSkill(), '## Orca の worker として動くとき'),",
      "-    ['範囲の外の気づき', 'SendMessage', 'to: intel', 'hq を通さず', 'worker_done', 'intel への送信'],",
      "-    'fleet の skill の「Orca の worker として動くとき」',",
      '+    step(worker, 9),',
      "+    ['範囲の外の気づき', 'SendMessage', 'to: intel', 'hq を通さず', 'worker_done', '迷ったら', 'hq に上げる', '混ざる', '分け'],",
      "+    'fleet の skill の「Orca の worker として動くとき」の手順9',",
      '   );',
      "+  assertWords(step(worker, 4), ['intel への送信'], 'fleet の skill の「Orca の worker として動くとき」の手順4');",
      ' });',
    ],
    75,
  );

test('PR #476 の形：名前と中身を一緒に直したテストは removed-test でなく rewritten-test になり、前と後の本体が Jev に test-body の組で渡る', () => {
  const findings = detectTestTampering(diff476(), P);
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['rewritten-test'],
    'removed-test を出さない',
  );
  assert.equal(TAMPER_KIND_LABELS['rewritten-test'], 'テストの中身の書き換え');
  const [f] = findings;
  assert.equal(f!.text, OLD_476);
  assert.equal(f!.after?.text, NEW_476);
  const body = f!.body;
  assert.ok(body, 'body に前後の本体を持つ');
  assert.equal(body.before.split('\n')[0], OLD_476, '本体の先頭は定義の行');
  assert.equal(body.after.split('\n')[0], NEW_476);
  assert.ok(body.before.includes('section(fleetSkill()'), body.before);
  assert.ok(!body.before.includes('step(worker'), body.before);
  assert.ok(body.after.includes('step(worker, 9)'), body.after);
  assert.ok(body.after.includes('step(worker, 4)'), '本体の最後の行まで入る');
  assert.ok(!body.after.includes('#432'), '定義の前のコメントは本体に入れない');

  const r = askableChanges(findings);
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.deepEqual(r.changes, [{ kind: 'test-body', file: FILE, before: body.before, after: body.after }]);
});

// ---- 定義の行どうしで組む ----

test('名前だけ変え、消えた定義と新しい定義の間にコメントを足しても、定義の行どうしで組んで renamed-test', () => {
  const diff = fileDiff('a.test.ts', ["-test('a', () => {", '+// 足したコメント', "+test('b', () => {", '   const x = f();', '   assert.equal(x, 1);', ' });']);
  assert.deepEqual(kinds(diff), ['renamed-test']);
});

// ---- AC2：中身の入れ替えは名前の変更の1問だけでは通らない ----

test('名前を変え、アサーションでない本体の行を入れ替えたら rewritten-test になり、test-body の組を問う（test-name だけでは済まない）', () => {
  const diff = fileDiff('a.test.ts', ["-test('a', () => {", "+test('b', () => {", '-  const x = f(1);', '+  const x = g(2);', '   assert.equal(x, 1);', ' });']);
  const findings = detectTestTampering(diff, P);
  assert.deepEqual(
    findings.map((f) => f.kind),
    ['rewritten-test'],
  );
  assert.ok(findings[0]!.body?.before.includes('f(1)'));
  assert.ok(findings[0]!.body?.after.includes('g(2)'));
  const r = askableChanges(findings);
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.ok(
    r.changes.some((c) => c.kind === 'test-body'),
    'test-body の組がある',
  );
  assert.ok(!r.changes.every((c) => c.kind === 'test-name'));
});

test('本体が定義の hunk の中で閉じず、後ろの hunk でアサーションでない本体の行を入れ替えたら、body の無い rewritten-test で問わない', () => {
  const diff = multiHunkDiff('a.test.ts', [
    { start: 3, lines: ["-test('a', () => {", "+test('b', () => {", '   const x = f(1);', '   // 1', '   // 2'] },
    { start: 40, lines: ['   // 3', '-  const y = h(1);', '+  const y = k(2);', '   assert.equal(y, 1);', ' });'] },
  ]);
  const findings = detectTestTampering(diff, P);
  const rewritten = findings.filter((f) => f.kind === 'rewritten-test');
  assert.equal(rewritten.length, 1, findings.map((f) => f.kind).join(','));
  assert.equal(rewritten[0]!.body, undefined, '見える範囲だけの本体を渡さない');
  assert.ok(!findings.some((f) => f.kind === 'renamed-test'));
  const r = askableChanges(findings);
  assert.equal(r.ask, false);
  assert.ok(!r.ask && r.reason.includes('hunk の外まで続き'), !r.ask ? r.reason : '');
});

test('本体が定義の hunk の中で閉じず、後ろの hunk でアサーションの行だけ書き換えたら、renamed-test と assertion-changed で問う', () => {
  const diff = multiHunkDiff('a.test.ts', [
    { start: 3, lines: ["-test('a', () => {", "+test('b', () => {", '   const x = f(1);', '   // 1', '   // 2'] },
    { start: 40, lines: ['   // 3', '-  assert.equal(x, 1);', '+  assert.equal(x, 2);', ' });'] },
  ]);
  const findings = detectTestTampering(diff, P);
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['assertion-changed', 'renamed-test']);
  const r = askableChanges(findings);
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.ok(r.changes.some((c) => c.kind === 'test-name'));
  assert.ok(!r.changes.some((c) => c.kind === 'test-body'));
});

// ---- 上限：超えたら一部だけ問わずに問わない ----

const rewritten = (before: string, after: string): TamperFinding => ({
  kind: 'rewritten-test',
  file: 'a.test.ts',
  line: 3,
  side: 'base',
  text: "test('a', () => {",
  after: { line: 3, text: "test('b', () => {" },
  body: { before, after },
});

test('上限：本体は1件 MAX_TAMPER_BODY_CHARS（4000）文字まで問い、超えれば切り詰めずに問わない', () => {
  assert.equal(MAX_TAMPER_BODY_CHARS, 4000);
  const at = 'x'.repeat(MAX_TAMPER_BODY_CHARS);
  const r = askableChanges([rewritten(at, at)]);
  assert.ok(r.ask, r.ask ? '' : r.reason);
  assert.equal(r.changes[0]!.before, at, '切り詰めない');
  assert.equal(askableChanges([rewritten(`${at}x`, 'y')]).ask, false, '変更前が超える');
  assert.equal(askableChanges([rewritten('y', `${at}x`)]).ask, false, '変更後が超える');
});

test('上限：maxStateChars を渡すと、全部の組（中身の書き換え・アサーションの書き換え）の before＋after の合計が超えるとき「材料が大きすぎます」で問わない', () => {
  const assertion: TamperFinding = { kind: 'assertion-changed', file: 'a.test.ts', line: 9, side: 'base', text: 'assert.ok(a);', after: { line: 9, text: 'assert.ok(b);' } };
  const findings = [rewritten('test(\'a\', () => {\nf(1);\n});', "test('b', () => {\ng(2);\n});"), assertion];
  const total = findings.reduce((n, f) => n + (f.body ? f.body.before.length + f.body.after.length : f.text!.length + f.after!.text.length), 0);
  assert.ok(askableChanges(findings, total).ask, '合計と同じなら問う');
  const over = askableChanges(findings, total - 1);
  assert.equal(over.ask, false);
  assert.ok(!over.ask && over.reason.includes('材料が大きすぎます'), !over.ask ? over.reason : '');
});

// ---- buildTamperRequest ----

const config: HarnessConfig = (() => {
  const base = loadConfig();
  return { ...base, jev: { ...base.jev, testTamper: 'enforce', thresholds: { ...base.jev.thresholds, testTamperProbability: 0.9 } } };
})();

test('buildTamperRequest：test-body の組は名前の変更・アサーションと違う英語の問いで、state は file・before・after だけ', () => {
  const req = buildTamperRequest(config, [
    { kind: 'test-body', file: FILE, before: "test('a', () => {\nf(1);\n});", after: "test('b', () => {\ng(2);\n});" },
    { kind: 'test-name', file: FILE, before: "test('a', () => {", after: "test('b', () => {" },
    { file: FILE, before: 'assert.ok(a);', after: 'assert.ok(b);' },
  ]);
  const changes = (req.state as { changes: Record<string, string>[] }).changes;
  assert.deepEqual(changes[0], { file: FILE, before: "test('a', () => {\nf(1);\n});", after: "test('b', () => {\ng(2);\n});" });
  const q = (i: number) => (req.questions[`change_${i}`] as { type: string; instructions: string }).instructions.replaceAll(`changes[${i}]`, 'changes[N]');
  assert.equal((req.questions.change_0 as { type: string }).type, 'noul');
  assert.notEqual(q(0), q(1), '名前の変更と違う問い');
  assert.notEqual(q(0), q(2), 'アサーションと違う問い');
  assert.match(q(0), /changes\[N\]/);
  assert.doesNotMatch(q(0), /[　-ヿ㐀-鿿＀-￯]/, '日本語を含めない');
});
