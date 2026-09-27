import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TEST_PATTERNS } from '../lib/test-tamper.ts';
import {
  mutantsForLine,
  parseChangedLines,
  planMutants,
  renderReport,
  renderSkipped,
  REPORT_TITLE,
  runMutants,
  selectTargets,
  type ChangedLine,
  type Mutant,
  type Outcome,
} from '../scripts/mutate.ts';

const P = DEFAULT_TEST_PATTERNS;

/** 壊した後の行だけを並べる */
const texts = (line: string) => mutantsForLine(line).map((e) => e.text);
const ops = (line: string) => mutantsForLine(line).map((e) => e.operator);

/** 時間では止めない */
const noDeadline = { deadline: Infinity, now: () => 0 };

test('壊してもテストが落ちない変更を見つける：落ちなかった mutant だけが survived として出る', async () => {
  const targets: ChangedLine[] = [
    { file: 'src/a.ts', line: 12, text: '  if (a === b) done = true;' },
    { file: 'src/b.ts', line: 3, text: '  const n = x + y;' },
  ];
  const plan = planMutants(targets, 100);
  assert.equal(plan.truncated, null);
  assert.equal(plan.mutants.length, 3);
  const target = plan.mutants.find((m) => m.operator === '=== → !==');
  assert.ok(target);

  const seen: Mutant[] = [];
  const run = await runMutants(
    plan.mutants,
    (m): Outcome => {
      seen.push(m);
      return m === target ? 'survived' : 'caught';
    },
    noDeadline,
  );
  assert.equal(seen.length, 3, 'すべて試す');
  assert.deepEqual(run.survived, [target]);
  assert.equal(run.caught.length, 2);
  assert.equal(run.notRun, 0);
  assert.equal(run.truncated, null);

  const md = renderReport(plan, run);
  assert.ok(md.startsWith(REPORT_TITLE));
  assert.match(md, /試した数：3（壊し方の候補 3）/);
  assert.match(md, /テストが落ちた（caught）：2/);
  assert.match(md, /テストが落ちなかった（survived）：1/);
  assert.match(md, /### 壊してもテストが落ちなかった変更/);
  const rows = md.split('\n').filter((l) => l.startsWith('| src/'));
  assert.equal(rows.length, 1, 'survived の行だけが表に出る');
  assert.ok(rows[0]!.includes('src/a.ts:12'));
  assert.ok(rows[0]!.includes('`if (a === b) done = true;`'), '元の行');
  assert.ok(rows[0]!.includes('`if (a !== b) done = true;`'), '壊した後の行');
  assert.ok(!md.includes('src/b.ts:3'));
  assert.ok(!md.includes('打ち切り'));
});

test('survived が無いとき・試していないときの文言', async () => {
  const plan = planMutants([{ file: 'a.ts', line: 1, text: 'x = a && b;' }], 10);
  const run = await runMutants(plan.mutants, () => 'caught', noDeadline);
  assert.match(renderReport(plan, run), /壊してもテストが落ちなかった変更はありません。/);

  const empty = planMutants([], 10);
  assert.equal(empty.total, 0);
  assert.match(renderReport(empty, { caught: [], survived: [], notRun: 0, truncated: null }), /試した変更はありません。/);

  const skipped = renderSkipped('ベースラインが落ちた');
  assert.ok(skipped.startsWith(REPORT_TITLE));
  assert.match(skipped, /試していません：ベースラインが落ちた/);
});

test('表のセルの | はエスケープする', async () => {
  const plan = planMutants([{ file: 'a.ts', line: 5, text: 'x = a && b;' }], 10);
  const run = await runMutants(plan.mutants, () => 'survived', noDeadline);
  const md = renderReport(plan, run);
  assert.ok(md.includes('`x = a \\|\\| b;`'), md);
});

test('上限を超えたら打ち切る：数の上限で切り、各行から1つずつ順に選ぶ', () => {
  const targets: ChangedLine[] = [
    { file: 'a.ts', line: 1, text: 'x = a === b && c + d;' }, // 3 つ
    { file: 'a.ts', line: 2, text: 'y = e < f || g;' }, // 2 つ
  ];
  const all = planMutants(targets, 100);
  assert.equal(all.total, 5);
  assert.equal(all.truncated, null);
  assert.deepEqual(
    all.mutants.map((m) => `${m.line} ${m.operator}`),
    ['1 === → !==', '2 < → >=', '1 && → ||', '2 || → &&', '1 + → -'],
  );

  const cut = planMutants(targets, 3);
  assert.equal(cut.total, 5);
  assert.equal(cut.truncated, 'count');
  assert.deepEqual(
    cut.mutants.map((m) => `${m.line} ${m.operator}`),
    ['1 === → !==', '2 < → >=', '1 && → ||'],
  );
  assert.deepEqual(cut.mutants[0], { file: 'a.ts', line: 1, original: 'x = a === b && c + d;', mutated: 'x = a !== b && c + d;', operator: '=== → !==' });

  assert.equal(planMutants(targets, 5).truncated, null, 'ちょうど上限なら切らない');
  const zero = planMutants(targets, 0);
  assert.equal(zero.mutants.length, 0);
  assert.equal(zero.truncated, 'count');
});

test('上限を超えたら打ち切る：数の上限の打ち切りと残りを報告に出す', async () => {
  const targets: ChangedLine[] = [
    { file: 'a.ts', line: 1, text: 'x = a === b && c + d;' },
    { file: 'a.ts', line: 2, text: 'y = e < f || g;' },
  ];
  const plan = planMutants(targets, 3);
  const run = await runMutants(plan.mutants, () => 'caught', noDeadline);
  const md = renderReport(plan, run);
  assert.match(md, /打ち切り：壊す箇所の数の上限（3）に達しました。/);
  assert.match(md, /試さなかった残り：2/);
  assert.ok(!md.includes('時間の上限'));
});

test('上限を超えたら打ち切る：期限を過ぎたら次の mutant を始めず、試さなかった数を出す', async () => {
  const targets: ChangedLine[] = [
    { file: 'a.ts', line: 1, text: 'x = a === b && c + d;' },
    { file: 'a.ts', line: 2, text: 'y = e < f || g;' },
  ];
  const plan = planMutants(targets, 100);
  assert.equal(plan.mutants.length, 5);

  // 1回ごとに 10 進む時計。期限 15 なので 2 つ試したところで止まる
  let clock = 0;
  const started: Mutant[] = [];
  const run = await runMutants(
    plan.mutants,
    async (m) => {
      started.push(m);
      clock += 10;
      return m.line === 2 ? 'survived' : 'caught';
    },
    { deadline: 15, now: () => clock },
  );
  assert.deepEqual(started, plan.mutants.slice(0, 2), '期限の後は始めない');
  assert.equal(run.truncated, 'time');
  assert.equal(run.notRun, 3);
  assert.equal(run.caught.length, 1);
  assert.equal(run.survived.length, 1);

  const md = renderReport(plan, run);
  assert.match(md, /試した数：2（壊し方の候補 5）/);
  assert.match(md, /打ち切り：時間の上限に達しました（上限の中で 3 件を試していません）。/);
  assert.match(md, /試さなかった残り：3/);
  assert.ok(!md.includes('壊す箇所の数の上限'));

  // 最初から期限を過ぎていれば1つも始めない
  let called = 0;
  const none = await runMutants(plan.mutants, () => (called++, 'caught'), { deadline: 0, now: () => 0 });
  assert.equal(called, 0);
  assert.equal(none.notRun, 5);
  assert.equal(none.truncated, 'time');
});

test('数と時間の両方で打ち切ったときの残り', async () => {
  const targets: ChangedLine[] = [
    { file: 'a.ts', line: 1, text: 'x = a === b && c + d;' },
    { file: 'a.ts', line: 2, text: 'y = e < f || g;' },
  ];
  const plan = planMutants(targets, 3);
  let clock = 0;
  const run = await runMutants(plan.mutants, () => ((clock += 10), 'caught'), { deadline: 5, now: () => clock });
  assert.equal(run.notRun, 2);
  const md = renderReport(plan, run);
  assert.match(md, /壊す箇所の数の上限（3）/);
  assert.match(md, /上限の中で 2 件を試していません/);
  assert.match(md, /試さなかった残り：4/);
});

test('parseChangedLines：足した・変えた行の新しい側の行番号を取り、消しただけの行と消したファイルは無視する', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -2 +2 @@',
    '-const a = 1;',
    '+const a = 2;',
    '@@ -10,0 +11,2 @@',
    '+const b = x === y;',
    '+',
    '@@ -20,3 +22,0 @@',
    '-gone1',
    '-gone2',
    '-gone3',
    '@@ -30,2 +29,1 @@',
    '-old1',
    '-old2',
    '+new1',
    'diff --git a/src/b.ts b/src/b.ts',
    'deleted file mode 100644',
    'index 333..000',
    '--- a/src/b.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-const c = 1;',
    '-const d = 2;',
    'diff --git a/src/c.ts b/src/c.ts',
    'new file mode 100644',
    'index 000..444',
    '--- /dev/null',
    '+++ b/src/c.ts',
    '@@ -0,0 +1,2 @@',
    '+export const e = 1;',
    '++++x;',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');
  assert.deepEqual(parseChangedLines(diff), [
    { file: 'src/a.ts', line: 2, text: 'const a = 2;' },
    { file: 'src/a.ts', line: 11, text: 'const b = x === y;' },
    { file: 'src/a.ts', line: 12, text: '' },
    { file: 'src/a.ts', line: 29, text: 'new1' },
    { file: 'src/c.ts', line: 1, text: 'export const e = 1;' },
    { file: 'src/c.ts', line: 2, text: '+++x;' },
  ]);
  assert.deepEqual(parseChangedLines(''), []);
});

test('selectTargets：実装の行だけを残す', () => {
  const at = (file: string, text: string): ChangedLine => ({ file, line: 1, text });
  const keep = [
    at('src/a.ts', 'const x = a === b;'),
    at('src/a.js', '  return x + 1;'),
    at('harness/lib/a.ts', 'export function f(a: number): number {'),
    at('src/a.ts', 'export const g = 1;'),
    at('src/a.ts', 'const typed = 1;'),
  ];
  const drop = [
    // テストファイル
    at('harness/test/a.test.ts', 'const x = a === b;'),
    at('src/a.spec.js', 'const x = a === b;'),
    at('src/__tests__/a.ts', 'const x = a === b;'),
    at('tests/helpers.ts', 'const x = a === b;'),
    // .ts / .js 以外、.d.ts
    at('README.md', 'a === b'),
    at('src/a.tsx', 'const x = a === b;'),
    at('.github/workflows/ci.yml', 'if: a == b'),
    at('src/types.d.ts', 'declare const x: boolean;'),
    // 空行・コメントだけの行
    at('src/a.ts', ''),
    at('src/a.ts', '   '),
    at('src/a.ts', '// a === b'),
    at('src/a.ts', '  /** a === b */'),
    at('src/a.ts', '/* a && b'),
    at('src/a.ts', ' * a === b のとき'),
    at('src/a.ts', ' */'),
    // import・再 export
    at('src/a.ts', "import { a } from './a.ts';"),
    at('src/a.ts', "import type { A } from './a.ts';"),
    at('src/a.ts', "export { a, b } from './a.ts';"),
    at('src/a.ts', "export type { A } from './a.ts';"),
    at('src/a.ts', "export * from './a.ts';"),
    at('src/a.ts', "export * as ns from './a.ts';"),
    at('src/a.ts', 'export { a, b };'),
    // 型だけの行
    at('src/a.ts', 'interface A {'),
    at('src/a.ts', 'export interface A extends B {'),
    at('src/a.ts', "type K = 'a' | 'b';"),
    at('src/a.ts', 'export type Pair<T> = [T, T];'),
  ];
  assert.deepEqual(selectTargets([...keep, ...drop], P), keep);
  for (const d of drop) assert.deepEqual(selectTargets([d], P), [], `${d.file}: ${d.text}`);
});

test('mutantsForLine：比較演算子を反転する', () => {
  assert.deepEqual(texts('if (a === b) f();'), ['if (a !== b) f();']);
  assert.deepEqual(texts('if (a !== b) f();'), ['if (a === b) f();']);
  assert.deepEqual(texts('if (a == b) f();'), ['if (a != b) f();']);
  assert.deepEqual(texts('if (a != b) f();'), ['if (a == b) f();']);
  assert.deepEqual(ops('if (a === b) f();'), ['=== → !==']);
});

test('mutantsForLine：大小比較を反転する', () => {
  assert.deepEqual(texts('if (a < b) f();'), ['if (a >= b) f();']);
  assert.deepEqual(texts('if (a >= b) f();'), ['if (a < b) f();']);
  assert.deepEqual(texts('if (a > b) f();'), ['if (a <= b) f();']);
  assert.deepEqual(texts('if (a <= b) f();'), ['if (a > b) f();']);
  assert.deepEqual(ops('if (a < b) f();'), ['< → >=']);
  assert.deepEqual(ops('if (a <= b) f();'), ['<= → >']);
});

test('mutantsForLine：論理演算子と真偽値を反転する', () => {
  assert.deepEqual(texts('ok = a && b;'), ['ok = a || b;']);
  assert.deepEqual(texts('ok = a || b;'), ['ok = a && b;']);
  assert.deepEqual(texts('ok = true;'), ['ok = false;']);
  assert.deepEqual(texts('ok = false;'), ['ok = true;']);
  assert.deepEqual(texts('ok = trueish;'), [], '単語の一部は壊さない');
});

test('mutantsForLine：算術演算子を入れ替える', () => {
  assert.deepEqual(texts('n = a + b;'), ['n = a - b;']);
  assert.deepEqual(texts('n = a - b;'), ['n = a + b;']);
  assert.deepEqual(texts('n = a * b;'), ['n = a / b;']);
  assert.deepEqual(texts('n = a / b;'), ['n = a * b;']);
  assert.deepEqual(texts('i++;'), []);
});

test('mutantsForLine：戻り値を消す', () => {
  assert.deepEqual(texts('  return x;'), ['  return;']);
  assert.deepEqual(ops('  return x;'), ['return X → return']);
  assert.deepEqual(texts('  return;'), []);
});

test('mutantsForLine：1箇所ずつ壊し、行の中の位置の順に並べる', () => {
  assert.deepEqual(texts('  return a === b && c;'), ['  return;', '  return a !== b && c;', '  return a === b || c;']);
});

test('mutantsForLine：文字列・テンプレートリテラル・行末コメントの中は壊さない', () => {
  assert.deepEqual(texts("const s = 'a === b && c + d';"), []);
  assert.deepEqual(texts('const s = "a < b || true";'), []);
  assert.deepEqual(texts('const s = `${a} < ${b} === true`;'), []);
  assert.deepEqual(texts('f(x); // a === b && true'), []);
  assert.deepEqual(texts('f(x); /* a === b */'), []);
  assert.deepEqual(texts("const s = 'it\\'s a === b';"), [], 'エスケープした引用符');
  assert.deepEqual(texts("ok = a === 'x && y'; // a || b"), ["ok = a !== 'x && y'; // a || b"]);
});

test('mutantsForLine：前後に空白の無い < > （ジェネリクス・矢印関数）は壊さない', () => {
  assert.deepEqual(texts('const m = new Map<string, number>();'), []);
  assert.deepEqual(texts('const f = (x: number) => x;'), []);
  assert.deepEqual(texts('const g = (a: Array<number>) => a;'), []);
  assert.deepEqual(texts('if (a<b) f();'), []);
  assert.deepEqual(texts('const x = 1;'), []);
});

test('通しの確認：小さな関数を実際に壊し、アサーションが見ていない変更が survived として出る', async () => {
  const file = 'src/add.ts';
  const source = ['function add(base, extra) {', '  if (base < 0) return 0;', '  return base + extra;', '}'];
  // アサーションは extra = 0 のときしか見ていない（+ を - にしても気づかない）
  const check = (add: (a: number, b: number) => unknown): boolean => add(5, 0) === 5 && add(-1, 3) === 0;
  const load = (lines: string[]) => new Function(`${lines.join('\n')}\nreturn add;`)() as (a: number, b: number) => unknown;
  assert.ok(check(load(source)), '壊す前はアサーションが通る');

  const targets = selectTargets(
    source.map((text, i) => ({ file, line: i + 1, text })),
    P,
  );
  const plan = planMutants(targets, 100);
  assert.equal(plan.truncated, null);

  const runOne = (m: Mutant): Outcome => {
    const lines = source.slice();
    assert.equal(lines[m.line - 1], m.original);
    lines[m.line - 1] = m.mutated;
    try {
      return check(load(lines)) ? 'survived' : 'caught';
    } catch {
      return 'caught';
    }
  };
  const run = await runMutants(plan.mutants, runOne, noDeadline);

  assert.equal(run.caught.length + run.survived.length, plan.total);
  assert.deepEqual(
    run.survived.map((m) => `${m.line} ${m.operator}`),
    ['3 + → -'],
  );
  assert.ok(run.caught.length >= 3);

  const md = renderReport(plan, run);
  const rows = md.split('\n').filter((l) => l.startsWith(`| ${file}:`));
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.includes(`${file}:3`));
  assert.ok(rows[0]!.includes('`return base + extra;`'));
  assert.ok(rows[0]!.includes('`return base - extra;`'));
});
