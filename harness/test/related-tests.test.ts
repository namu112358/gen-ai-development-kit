// 変更ファイルの一覧から流すテストを決める純粋関数（changedTestPlan・changedSummaryLine）。関係するテストが分からない変更は全体に倒す
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedSummaryLine, changedTestPlan, type ChangedTestPlan } from '../lib/related-tests.ts';

const src = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

// foo.ts を直接・推移的に使うテストと、無関係のテストがある木
const sources = src({
  'harness/lib/foo.ts': 'export const foo = 1;\n',
  'harness/lib/a.ts': "import { foo } from './foo.ts';\nexport const a = foo;\n",
  'harness/lib/bar.ts': 'export const bar = 1;\n',
  'harness/lib/orphan.ts': 'export const orphan = 1;\n',
  'harness/test/foo.test.ts': "import { foo } from '../lib/foo.ts';\n",
  'harness/test/a.test.ts': "import { a } from '../lib/a.ts';\n",
  'harness/test/bar.test.ts': "import { bar } from '../lib/bar.ts';\n",
  'harness/test/support/x.ts': 'export const x = 1;\n',
});
const testFiles = ['harness/test/foo.test.ts', 'harness/test/a.test.ts', 'harness/test/bar.test.ts'];

const subsetTests = (plan: ChangedTestPlan): string[] => {
  assert.equal(plan.mode, 'subset', JSON.stringify(plan));
  return plan.mode === 'subset' ? plan.tests : [];
};

test('直接 import しているテストだけが選ばれ、無関係のテストは選ばれない', () => {
  const plan = changedTestPlan(['harness/lib/bar.ts'], sources, testFiles);
  assert.deepEqual(subsetTests(plan), ['harness/test/bar.test.ts']);
  assert.deepEqual(plan.changed, ['harness/lib/bar.ts']);
});

test('推移的な import（test → lib/a.ts → lib/foo.ts）も選ばれ、和集合はパスの昇順', () => {
  const plan = changedTestPlan(['harness/lib/foo.ts'], sources, testFiles);
  assert.deepEqual(subsetTests(plan), ['harness/test/a.test.ts', 'harness/test/foo.test.ts']);
});

test('テストファイル自身の変更はそのまま一覧に入り、コードの変更の関係するテストと合わせる', () => {
  assert.deepEqual(subsetTests(changedTestPlan(['harness/test/bar.test.ts'], sources, testFiles)), ['harness/test/bar.test.ts']);
  assert.deepEqual(
    subsetTests(changedTestPlan(['harness/test/bar.test.ts', 'harness/lib/foo.ts'], sources, testFiles)),
    ['harness/test/a.test.ts', 'harness/test/bar.test.ts', 'harness/test/foo.test.ts'],
  );
});

test('コード以外（.md など）は無視し、コードの変更と一緒なら絞る', () => {
  const plan = changedTestPlan(['docs/x.md', 'harness/lib/bar.ts'], sources, testFiles);
  assert.deepEqual(subsetTests(plan), ['harness/test/bar.test.ts']);
});

// 守り：関係するテストが分からない変更は、必ず全体に倒す（境界と拒否の場合を省かない）
const fullCases: { name: string; changed: string[]; reason?: RegExp }[] = [
  { name: '変更なし', changed: [], reason: /変更なし/ },
  { name: 'docs・skill（.md）だけ', changed: ['docs/x.md', '.claude/skills/implement/SKILL.md'], reason: /コードの変更なし/ },
  { name: '関係するテストが見つからないファイル', changed: ['harness/lib/orphan.ts'] },
  { name: '関係するテストが見つからないファイルが1つでも混じる', changed: ['harness/lib/bar.ts', 'harness/lib/orphan.ts'] },
  { name: 'sources に無い（消えた）コードのファイル', changed: ['harness/lib/gone.ts'] },
  { name: '消えたファイルが1つでも混じる', changed: ['harness/lib/bar.ts', 'harness/lib/gone.ts'] },
  { name: 'package.json', changed: ['package.json'] },
  { name: 'package.json がコードの変更と一緒', changed: ['harness/lib/bar.ts', 'package.json'] },
  { name: 'package-lock.json', changed: ['package-lock.json'] },
  { name: 'tsconfig.json', changed: ['tsconfig.json'] },
  { name: 'harness.config.json', changed: ['harness.config.json'] },
  { name: '.node-version', changed: ['.node-version'] },
  { name: 'harness/test/support/ の下', changed: ['harness/test/support/x.ts'] },
  { name: 'harness/test/support/ の下がテストの変更と一緒', changed: ['harness/test/bar.test.ts', 'harness/test/support/x.ts'] },
];

for (const c of fullCases) {
  test(`全体に倒す：${c.name}`, () => {
    const plan = changedTestPlan(c.changed, sources, testFiles);
    assert.equal(plan.mode, 'all', JSON.stringify(plan));
    if (plan.mode === 'all') {
      assert.ok(plan.reason.length > 0);
      if (c.reason) assert.match(plan.reason, c.reason);
    }
  });
}

test('関係するテストが 100 件までは絞り、101 件なら全体', () => {
  const many = (n: number) => {
    const s = src({ 'harness/lib/foo.ts': 'export const foo = 1;\n' });
    const tests: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = `harness/test/t${String(i).padStart(3, '0')}.test.ts`;
      s.set(t, "import '../lib/foo.ts';\n");
      tests.push(t);
    }
    return changedTestPlan(['harness/lib/foo.ts'], s, tests);
  };
  assert.equal(many(100).mode, 'subset');
  assert.equal(many(101).mode, 'all');
});

test('changedSummaryLine：絞ったときは件数と変更ファイルの数、全体のときは理由', () => {
  const subset = changedTestPlan(['harness/lib/bar.ts'], sources, testFiles);
  assert.equal(changedSummaryLine(subset), '流すテスト：1 件（変更 1 ファイル）');
  const all = changedTestPlan(['docs/x.md'], sources, testFiles);
  assert.equal(all.mode, 'all');
  if (all.mode === 'all') assert.equal(changedSummaryLine(all), `流すテスト：全体（${all.reason}）`);
});
