// mutation で1か所ごとに動かすテストを、壊したファイルに関係するテストファイルだけに絞る（relatedTestFiles・testArgsFor・baselineTests・renderReport の絞り込みの行）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baselineTests,
  planMutants,
  relatedTestFiles,
  renderReport,
  runMutants,
  testArgsFor,
} from '../scripts/mutate.ts';

const ALL = ['--test', 'harness/test/**/*.test.ts'];
const noDeadline = { deadline: Infinity, now: () => 0 };

const src = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

test('直接 import しているテストは関係する', () => {
  const sources = src({
    'harness/lib/a.ts': 'export const a = 1;\n',
    'harness/test/a.test.ts': "import { a } from '../lib/a.ts';\n",
  });
  assert.deepEqual(relatedTestFiles('harness/lib/a.ts', sources, ['harness/test/a.test.ts']), ['harness/test/a.test.ts']);
});

test('テスト → a → b の推移で b が関係する', () => {
  const sources = src({
    'harness/lib/a.ts': "import { b } from './b.ts';\nexport const a = b;\n",
    'harness/lib/b.ts': 'export const b = 1;\n',
    'harness/test/a.test.ts': "import { a } from '../lib/a.ts';\n",
  });
  assert.deepEqual(relatedTestFiles('harness/lib/b.ts', sources, ['harness/test/a.test.ts']), ['harness/test/a.test.ts']);
});

test('関係の無いテストは入らない', () => {
  const sources = src({
    'harness/lib/a.ts': 'export const a = 1;\n',
    'harness/lib/c.ts': 'export const c = 1;\n',
    'harness/test/a.test.ts': "import { a } from '../lib/a.ts';\n",
    'harness/test/c.test.ts': "import { c } from '../lib/c.ts';\n",
  });
  const tests = ['harness/test/a.test.ts', 'harness/test/c.test.ts'];
  assert.deepEqual(relatedTestFiles('harness/lib/a.ts', sources, tests), ['harness/test/a.test.ts']);
  assert.deepEqual(relatedTestFiles('harness/lib/c.ts', sources, tests), ['harness/test/c.test.ts']);
  assert.deepEqual(relatedTestFiles('harness/lib/none.ts', sources, tests), []);
});

test('本文にパスが書かれていれば、import していなくても関係する', () => {
  const sources = src({
    'harness/scripts/mutate.ts': 'export {};\n',
    'harness/test/cli.test.ts': "spawnSync('node', ['harness/scripts/mutate.ts']);\n",
    'harness/test/other.test.ts': "spawnSync('node', ['harness/scripts/other.ts']);\n",
  });
  assert.deepEqual(
    relatedTestFiles('harness/scripts/mutate.ts', sources, ['harness/test/cli.test.ts', 'harness/test/other.test.ts']),
    ['harness/test/cli.test.ts'],
  );
});

test('引用符で囲んだファイル名でも関係する（単引用符・二重引用符）', () => {
  const sources = src({
    'harness/scripts/mutate.ts': 'export {};\n',
    'harness/test/q1.test.ts': "join(dir, 'mutate.ts');\n",
    'harness/test/q2.test.ts': 'join(dir, "mutate.ts");\n',
    'harness/test/q3.test.ts': "join(dir, 'other-mutate.tsx');\n",
  });
  assert.deepEqual(
    relatedTestFiles('harness/scripts/mutate.ts', sources, [
      'harness/test/q3.test.ts',
      'harness/test/q2.test.ts',
      'harness/test/q1.test.ts',
    ]),
    ['harness/test/q1.test.ts', 'harness/test/q2.test.ts'],
  );
});

test('循環 import で止まり、結果が正しい', () => {
  const sources = src({
    'harness/lib/a.ts': "import { b } from './b.ts';\nexport const a = 1;\n",
    'harness/lib/b.ts': "import { a } from './a.ts';\nimport { c } from './c.ts';\nexport const b = 1;\n",
    'harness/lib/c.ts': 'export const c = 1;\n',
    'harness/lib/d.ts': 'export const d = 1;\n',
    'harness/test/a.test.ts': "import { a } from '../lib/a.ts';\n",
  });
  const tests = ['harness/test/a.test.ts'];
  assert.deepEqual(relatedTestFiles('harness/lib/c.ts', sources, tests), ['harness/test/a.test.ts']);
  assert.deepEqual(relatedTestFiles('harness/lib/d.ts', sources, tests), []);
});

test('import・export from・動的 import の形をすべて取り出す', () => {
  const sources = src({
    'harness/lib/side.ts': 'globalThis.x = 1;\n',
    'harness/lib/re.ts': 'export const r = 1;\n',
    'harness/lib/dyn.ts': 'export const d = 1;\n',
    'harness/lib/hub.ts': "import './side.ts';\nexport { r } from './re.ts';\nexport * from './none.ts';\nconst m = await import('./dyn.ts');\n",
    'harness/test/hub.test.ts': "import '../lib/hub.ts';\n",
  });
  const tests = ['harness/test/hub.test.ts'];
  for (const t of ['harness/lib/side.ts', 'harness/lib/re.ts', 'harness/lib/dyn.ts', 'harness/lib/hub.ts']) {
    assert.deepEqual(relatedTestFiles(t, sources, tests), tests, t);
  }
});

test('node: とパッケージの import は無視する', () => {
  const sources = src({
    'harness/lib/a.ts': "import fs from 'node:fs';\nimport x from 'some-pkg';\nexport const a = 1;\n",
    'node:fs': '',
    'some-pkg': '',
    'harness/test/a.test.ts': "import assert from 'node:assert/strict';\nimport { a } from '../lib/a.ts';\n",
  });
  const tests = ['harness/test/a.test.ts'];
  assert.doesNotThrow(() => relatedTestFiles('harness/lib/a.ts', sources, tests));
  assert.deepEqual(relatedTestFiles('node:fs', sources, tests), []);
  assert.deepEqual(relatedTestFiles('some-pkg', sources, tests), []);
});

test('.. を含む相対パスを解決する（harness/test/x.test.ts から ../scripts/mutate.ts）', () => {
  const sources = src({
    'harness/scripts/mutate.ts': 'export {};\n',
    'harness/scripts/agent/commands/run.ts': "import '../../mutate.ts';\n",
    'harness/test/x.test.ts': "import { planMutants } from '../scripts/mutate.ts';\n",
    'harness/test/y.test.ts': "import '../scripts/agent/commands/run.ts';\n",
    'harness/test/z.test.ts': "import '../scripts/other.ts';\n",
  });
  assert.deepEqual(
    relatedTestFiles('harness/scripts/mutate.ts', sources, ['harness/test/z.test.ts', 'harness/test/y.test.ts', 'harness/test/x.test.ts']),
    ['harness/test/x.test.ts', 'harness/test/y.test.ts'],
  );
});

test('返り値はパスの昇順', () => {
  const sources = src({
    'harness/lib/a.ts': 'export const a = 1;\n',
    'harness/test/c.test.ts': "import '../lib/a.ts';\n",
    'harness/test/a.test.ts': "import '../lib/a.ts';\n",
    'harness/test/b.test.ts': "import '../lib/a.ts';\n",
  });
  assert.deepEqual(
    relatedTestFiles('harness/lib/a.ts', sources, ['harness/test/c.test.ts', 'harness/test/a.test.ts', 'harness/test/b.test.ts']),
    ['harness/test/a.test.ts', 'harness/test/b.test.ts', 'harness/test/c.test.ts'],
  );
});

test('testArgsFor：関係するテストがあればそのファイルだけを node --test に渡す', () => {
  assert.deepEqual(testArgsFor(['harness/test/a.test.ts', 'harness/test/b.test.ts']), [
    '--test',
    'harness/test/a.test.ts',
    'harness/test/b.test.ts',
  ]);
});

test('testArgsFor：関係するテストが無ければテスト全体', () => {
  assert.deepEqual(testArgsFor([]), ALL);
});

test('testArgsFor：100件までは絞り、101件なら全体', () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => `harness/test/t${String(i).padStart(3, '0')}.test.ts`);
  assert.deepEqual(testArgsFor(files(100)), ['--test', ...files(100)]);
  assert.deepEqual(testArgsFor(files(101)), ALL);
});

test('baselineTests：和集合をパスの昇順で返す', () => {
  const perFile = new Map([
    ['harness/lib/a.ts', ['harness/test/b.test.ts', 'harness/test/a.test.ts']],
    ['harness/lib/b.ts', ['harness/test/c.test.ts', 'harness/test/a.test.ts']],
  ]);
  assert.deepEqual(baselineTests(perFile), ['harness/test/a.test.ts', 'harness/test/b.test.ts', 'harness/test/c.test.ts']);
});

test('baselineTests：関係するテストの無いファイルが1つでもあれば [] （全体）', () => {
  const perFile = new Map([
    ['harness/lib/a.ts', ['harness/test/a.test.ts']],
    ['harness/lib/b.ts', [] as string[]],
  ]);
  assert.deepEqual(baselineTests(perFile), []);
});

test('renderReport：narrowing を渡すと、絞ったファイルと全体で試したファイルの数が出る', async () => {
  const plan = planMutants([{ file: 'a.ts', line: 1, text: 'x = a && b;' }], 10);
  const run = await runMutants(plan.mutants, () => 'caught', noDeadline);
  const md = renderReport(plan, run, { narrowed: 3, fullSuite: 2 });
  assert.match(md, /関係するテストだけで試したファイル：3/);
  assert.match(md, /関係するテストが見つからず全体で試したファイル：2/);
});

test('renderReport：narrowing を渡さなければ絞り込みの行は出ない', async () => {
  const plan = planMutants([{ file: 'a.ts', line: 1, text: 'x = a && b;' }], 10);
  const run = await runMutants(plan.mutants, () => 'caught', noDeadline);
  assert.ok(!renderReport(plan, run).includes('関係するテスト'));
});
