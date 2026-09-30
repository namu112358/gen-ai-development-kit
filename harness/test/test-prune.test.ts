// Issue #327：減らせるテストの材料（test-prune）。V8 のカバレッジから実行された行、URL からリポジトリの相対パス、テストファイルどうしの重なり、文言を固定するテスト・子プロセスを動かすテストの見分け、テストの数、健康の JSON（--health）の読み取り、削除・統合の候補の条件の境と並び、引数の読み取りを、固定の入力で確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCandidates, countTests, coveredLines, coverageUrlToPath, detectPinned, healthForFile, isSourceTarget,
  overlapByFile, parseTestPruneArgs, readHealth, spawnsChild,
  type FileReport, type HealthInput, type TestPruneOptions, type V8Function,
} from '../lib/test-prune.ts';

// --- coveredLines ---

const SOURCE_LINES = [
  'function f(x) {', // 1
  '  if (x) {', //      2（入れ子の範囲 count 0）
  '    a();', //        3（入れ子の範囲 count 0）
  '  }', //             4（入れ子の範囲 count 0）
  '', //                5（空行）
  '  return 1;', //     6
  '}', //               7
];

function coverageFor(source: string, eol: string): V8Function[] {
  const lineStart = (n: number): number => {
    let at = 0;
    for (let i = 1; i < n; i++) at = source.indexOf(eol, at) + eol.length;
    return at;
  };
  return [
    // 入れ子の範囲を先に並べても、開始の昇順・長さの降順で塗る（入れ子が後で上書き）
    { functionName: 'f', isBlockCoverage: true, ranges: [
      { startOffset: lineStart(2), endOffset: lineStart(5), count: 0 },
      { startOffset: 0, endOffset: source.length, count: 1 },
    ] },
  ];
}

test('coveredLines：関数全体の count 1 の中の入れ子の count 0 は数えず、空行も数えない', () => {
  const source = SOURCE_LINES.join('\n') + '\n';
  assert.deepEqual(coveredLines(source, coverageFor(source, '\n')), [1, 6, 7]);
});

test('coveredLines：改行が \\r\\n でも同じ行になる', () => {
  const source = SOURCE_LINES.join('\r\n') + '\r\n';
  assert.deepEqual(coveredLines(source, coverageFor(source, '\r\n')), [1, 6, 7]);
});

test('coveredLines：count 0 だけなら空、範囲が無ければ空', () => {
  const source = SOURCE_LINES.join('\n');
  assert.deepEqual(coveredLines(source, [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }]), []);
  assert.deepEqual(coveredLines(source, []), []);
});

test('coveredLines：入れ子の count 0 の中にさらに count 2 の範囲があれば、その行は数える', () => {
  const source = 'a;\nb;\nc;\nd;';
  // a;\n = 0..3, b;\n = 3..6, c;\n = 6..9, d; = 9..11
  const fns: V8Function[] = [{ ranges: [
    { startOffset: 0, endOffset: 11, count: 1 },
    { startOffset: 3, endOffset: 9, count: 0 },
    { startOffset: 6, endOffset: 8, count: 2 },
  ] }];
  assert.deepEqual(coveredLines(source, fns), [1, 3, 4]);
});

// --- coverageUrlToPath・isSourceTarget ---

test('coverageUrlToPath：Windows の file:///C:/… をルートからの / 区切りの相対パスにする（大文字小文字は区別しない）', () => {
  assert.equal(coverageUrlToPath('file:///C:/repo/harness/lib/x.ts', 'C:\\repo'), 'harness/lib/x.ts');
  assert.equal(coverageUrlToPath('file:///c:/Repo/harness/scripts/y.ts', 'C:\\repo'), 'harness/scripts/y.ts');
});

test('coverageUrlToPath：POSIX のルートでも相対パスにする', () => {
  assert.equal(coverageUrlToPath('file:///repo/harness/lib/x.ts', '/repo'), 'harness/lib/x.ts');
});

test('coverageUrlToPath：テストファイル（support の補助を含む）・リポジトリの外・node_modules・.ts でないもの・node: は null', () => {
  const root = '/repo';
  for (const url of [
    'file:///repo/harness/test/x.test.ts',
    'file:///repo/harness/test/support/gate-fixtures.ts',
    'file:///other/harness/lib/x.ts',
    'file:///repository/harness/lib/x.ts',
    'file:///repo/node_modules/pkg/index.ts',
    'file:///repo/harness/lib/x.js',
    'node:fs',
    'node:internal/test_runner/runner',
  ]) assert.equal(coverageUrlToPath(url, root), null, url);
  assert.equal(coverageUrlToPath('file:///D:/elsewhere/x.ts', 'C:\\repo'), null);
});

test('isSourceTarget：本体の .ts だけ true', () => {
  assert.equal(isSourceTarget('harness/lib/a.ts'), true);
  assert.equal(isSourceTarget('harness/scripts/b.ts'), true);
  for (const p of ['harness/test/a.test.ts', 'harness/test/support/f.ts', 'node_modules/x/a.ts', 'harness/lib/a.js', '../a.ts', 'README.md']) {
    assert.equal(isSourceTarget(p), false, p);
  }
});

// --- spawnsChild ---

test('spawnsChild：spawn・spawnSync・execFile・execFileSync があれば true、無ければ false', () => {
  for (const src of [
    "const c = spawn(process.execPath, ['x.ts']);",
    "const r = spawnSync('node', ['x.ts']);",
    "execFile('git', ['status'], () => {});",
    "const out = execFileSync('git', ['log']);",
  ]) assert.equal(spawnsChild(src), true, src);
  assert.equal(spawnsChild("test('x', () => { assert.equal(parse('a'), 1); });"), false);
});

// --- overlapByFile ---

function lines(...xs: string[]): Set<string> {
  return new Set(xs);
}

test('overlapByFile：A の行が B に全部含まれる → A は uniqueLines 0・bestOverlap は B と 1、B は残りが独自', () => {
  const r = overlapByFile(new Map([
    ['a.test.ts', lines('x.ts:1', 'x.ts:2')],
    ['b.test.ts', lines('x.ts:1', 'x.ts:2', 'x.ts:3')],
  ]));
  assert.deepEqual(r.get('a.test.ts'), { coveredLines: 2, uniqueLines: 0, bestOverlap: { with: 'b.test.ts', ratio: 1 } });
  assert.deepEqual(r.get('b.test.ts'), { coveredLines: 3, uniqueLines: 1, bestOverlap: { with: 'a.test.ts', ratio: 2 / 3 } });
});

test('overlapByFile：重ならない → uniqueLines は行数と同じ・ratio 0、相手のファイルが無ければ null', () => {
  const r = overlapByFile(new Map([
    ['a.test.ts', lines('x.ts:1', 'x.ts:2')],
    ['c.test.ts', lines('y.ts:1')],
  ]));
  assert.deepEqual(r.get('a.test.ts'), { coveredLines: 2, uniqueLines: 2, bestOverlap: { with: 'c.test.ts', ratio: 0 } });
  const alone = overlapByFile(new Map([['a.test.ts', lines('x.ts:1')]]));
  assert.deepEqual(alone.get('a.test.ts'), { coveredLines: 1, uniqueLines: 1, bestOverlap: null });
});

test('overlapByFile：一部だけ重なるときの割合は丸めない', () => {
  const r = overlapByFile(new Map([
    ['a.test.ts', lines('x.ts:1', 'x.ts:2', 'x.ts:3', 'x.ts:4')],
    ['b.test.ts', lines('x.ts:1', 'x.ts:2', 'x.ts:3')],
    ['c.test.ts', lines('x.ts:1', 'y.ts:9')],
  ]));
  assert.deepEqual(r.get('a.test.ts'), { coveredLines: 4, uniqueLines: 1, bestOverlap: { with: 'b.test.ts', ratio: 0.75 } });
  assert.deepEqual(r.get('c.test.ts'), { coveredLines: 2, uniqueLines: 1, bestOverlap: { with: 'a.test.ts', ratio: 0.5 } });
});

test('overlapByFile：uniqueLines はほかの全ファイルの和で数え、同率の相手は名前の昇順で先', () => {
  const r = overlapByFile(new Map([
    ['a.test.ts', lines('x.ts:1', 'x.ts:2')],
    ['c.test.ts', lines('x.ts:2')],
    ['b.test.ts', lines('x.ts:1')],
  ]));
  assert.deepEqual(r.get('a.test.ts'), { coveredLines: 2, uniqueLines: 0, bestOverlap: { with: 'b.test.ts', ratio: 0.5 } });
});

test('overlapByFile：実行された行が 0 なら bestOverlap は null', () => {
  const r = overlapByFile(new Map([
    ['a.test.ts', lines()],
    ['b.test.ts', lines('x.ts:1')],
  ]));
  assert.deepEqual(r.get('a.test.ts'), { coveredLines: 0, uniqueLines: 0, bestOverlap: null });
});

// --- detectPinned ---

test('detectPinned：readFileSync で SKILL.md を読み、includes・assert.match・assert.doesNotMatch の行を数える', () => {
  const src = [
    "const text = readFileSync(path.join(root, '.claude/skills/x/SKILL.md'), 'utf8');",
    "test('a', () => {",
    "  assert.ok(text.includes('手順'));",
    '  assert.match(text, /判定/);',
    '  assert.doesNotMatch(text, /古い/);',
    "  assert.equal(1, 1);",
    '});',
  ].join('\n');
  assert.deepEqual(detectPinned(src), { targets: ['.claude/skills/x/SKILL.md'], assertions: 3 });
});

test('detectPinned：読むファイルは重複なしで出てきた順、.yml・.html・.json も対象', () => {
  const src = [
    "const a = readFileSync('README.md', 'utf8');",
    "const b = readFileSync('.github/workflows/gate.yml', 'utf8');",
    "const c = readFileSync('README.md', 'utf8');",
    "const d = readFileSync('overview.html', 'utf8');",
    "const e = readFileSync('harness.config.json', 'utf8');",
    "assert.match(a, /x/);",
  ].join('\n');
  assert.deepEqual(detectPinned(src), {
    targets: ['README.md', '.github/workflows/gate.yml', 'overview.html', 'harness.config.json'],
    assertions: 1,
  });
});

test('detectPinned：.ts を読むだけなら targets は空で assertions 0', () => {
  const src = [
    "const code = readFileSync('harness/lib/x.ts', 'utf8');",
    "assert.ok(code.includes('export'));",
    "assert.match(code, /function/);",
  ].join('\n');
  assert.deepEqual(detectPinned(src), { targets: [], assertions: 0 });
});

test('detectPinned：読むだけでアサーションが無ければ assertions 0、読まなければ targets も空', () => {
  assert.deepEqual(detectPinned("const t = readFileSync('docs/a.md', 'utf8');\nassert.equal(t.length > 0, true);"), { targets: ['docs/a.md'], assertions: 0 });
  assert.deepEqual(detectPinned("assert.ok('a.md'.includes('a'));"), { targets: [], assertions: 0 });
});

// --- countTests ---

test('countTests：test( と it( の数を数え、describe や submit( は数えない', () => {
  const src = [
    "describe('まとまり', () => {",
    "  test('a', () => {});",
    "  it('b', () => {});",
    '});',
    "test('c', () => { submit(1); });",
  ].join('\n');
  assert.equal(countTests(src), 3);
  assert.equal(countTests('const x = 1;'), 0);
});

// --- readHealth・healthForFile ---

const OBSERVE = {
  version: 1,
  slowTests: {
    available: true, totalTests: 3,
    tests: [{ name: '遅い', file: 'harness/test/a.test.ts', seconds: 2.5 }],
    files: [{ file: 'harness/test/a.test.ts', seconds: 2.5, tests: 2 }, { file: 'harness/test/b.test.ts', seconds: 0.4, tests: 1 }],
    truncated: { tests: 0, files: 0 },
  },
  flakyTests: { available: true, runs: 1, unreadableLogs: 0, total: 1, truncated: 0, items: [{ name: 'ときどき落ちるテスト', count: 2 }] },
  mutants: {
    available: true, runs: 1, unreadableRuns: 0, total: 2, truncated: 0,
    items: [{ file: 'harness/lib/x.ts', line: 3, operator: 'EqualityOperator' }, { file: 'harness/lib/x.ts', line: 9, operator: 'BooleanLiteral' }],
  },
};

test('readHealth：observe の JSON から遅いファイル・不安定なテスト・ミュータントを読む', () => {
  const r = readHealth(OBSERVE);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([...r.value.slowFiles], [['harness/test/a.test.ts', 2.5], ['harness/test/b.test.ts', 0.4]]);
  assert.deepEqual(r.value.flaky, [{ name: 'ときどき落ちるテスト', count: 2 }]);
  assert.deepEqual(r.value.mutants, [
    { file: 'harness/lib/x.ts', line: 3, operator: 'EqualityOperator' },
    { file: 'harness/lib/x.ts', line: 9, operator: 'BooleanLiteral' },
  ]);
  assert.deepEqual(r.value.notes, []);
});

test('readHealth：available:false の節は空にし、notes に理由を足す', () => {
  const r = readHealth({ ...OBSERVE, mutants: { available: false, reason: 'ログが読めません' } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.mutants, []);
  assert.equal(r.value.slowFiles.size, 2);
  assert.equal(r.value.notes.length, 1);
  assert.ok(r.value.notes[0]!.includes('ログが読めません'), r.value.notes[0]);
});

test('readHealth：オブジェクトでない・version が 1 でないときは例外にせず ok:false の reason', () => {
  for (const json of [null, 'x', 1, { ...OBSERVE, version: 2 }, {}]) {
    const r = readHealth(json);
    assert.equal(r.ok, false, JSON.stringify(json));
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test('healthForFile：遅さはファイルのパスで、不安定は本文に名前があるもの、ミュータントは実行した行に当たるものを数える', () => {
  const health: HealthInput = {
    slowFiles: new Map([['harness/test/a.test.ts', 2.5]]),
    flaky: [{ name: 'ときどき落ちるテスト', count: 2 }, { name: 'ほかのテスト', count: 1 }],
    mutants: [
      { file: 'harness/lib/x.ts', line: 3, operator: 'EqualityOperator' },
      { file: 'harness/lib/x.ts', line: 9, operator: 'BooleanLiteral' },
      { file: 'harness/lib/y.ts', line: 3, operator: 'BooleanLiteral' },
    ],
    notes: [],
  };
  const source = "test('ときどき落ちるテスト', () => {});";
  assert.deepEqual(healthForFile(health, 'harness/test/a.test.ts', source, lines('harness/lib/x.ts:3', 'harness/lib/x.ts:4')), {
    slowSeconds: 2.5, flaky: [{ name: 'ときどき落ちるテスト', count: 2 }], survivedMutants: 1,
  });
  assert.deepEqual(healthForFile(health, 'harness/test/z.test.ts', "test('x', () => {});", lines()), {
    slowSeconds: null, flaky: [], survivedMutants: 0,
  });
});

// --- buildCandidates ---

function report(path: string, over: Partial<FileReport> = {}): FileReport {
  return {
    path, tests: 1, durationMs: 10, exitCode: 0,
    coveredLines: 5, uniqueLines: 2, bestOverlap: { with: 'other.test.ts', ratio: 0.5 },
    pinned: { targets: [], assertions: 0 }, spawnsChild: false, health: null,
    ...over,
  };
}

const OPTS = { minContainment: 0.95, limit: 30 };

test('buildCandidates：contained は ratio がしきい値ちょうどで候補、未満や uniqueLines 1 は候補でない', () => {
  const { candidates, notes } = buildCandidates([
    report('edge.test.ts', { uniqueLines: 0, bestOverlap: { with: 'big.test.ts', ratio: 0.95 } }),
    report('below.test.ts', { uniqueLines: 0, bestOverlap: { with: 'big.test.ts', ratio: 0.9499 } }),
    report('unique1.test.ts', { uniqueLines: 1, bestOverlap: { with: 'big.test.ts', ratio: 1 } }),
    report('plain.test.ts'),
  ], OPTS);
  assert.deepEqual(candidates.map((c) => [c.kind, c.file, c.overlapWith, c.ratio]), [['contained', 'edge.test.ts', 'big.test.ts', 0.95]]);
  assert.ok(candidates[0]!.reasons.length > 0);
  assert.deepEqual(notes, []);
});

test('buildCandidates：実行した行が 0 で、固定のアサーションがあれば pinned、無ければ no-coverage。行があれば pinned でも候補でない', () => {
  const { candidates } = buildCandidates([
    report('pin.test.ts', { coveredLines: 0, uniqueLines: 0, bestOverlap: null, pinned: { targets: ['SKILL.md'], assertions: 1 } }),
    report('none.test.ts', { coveredLines: 0, uniqueLines: 0, bestOverlap: null, pinned: { targets: ['SKILL.md'], assertions: 0 } }),
    report('mixed.test.ts', { pinned: { targets: ['SKILL.md'], assertions: 4 } }),
  ], OPTS);
  assert.deepEqual(candidates.map((c) => [c.kind, c.file]), [
    ['pinned', 'pin.test.ts'],
    ['no-coverage', 'none.test.ts'],
  ]);
  // 実行した行が 0 なら、重なりの割合が 1 でも contained でなく no-coverage
  const zero = buildCandidates([
    report('zero.test.ts', { coveredLines: 0, uniqueLines: 0, bestOverlap: { with: 'x.test.ts', ratio: 1 } }),
  ], OPTS).candidates;
  assert.deepEqual(zero.map((c) => [c.kind, c.file]), [['no-coverage', 'zero.test.ts']]);
});

test('buildCandidates：kind の順、同じ kind は ratio 降順・時間の降順・ファイル名の昇順に並ぶ', () => {
  const contained = (path: string, ratio: number, durationMs: number): FileReport =>
    report(path, { uniqueLines: 0, bestOverlap: { with: 'big.test.ts', ratio }, durationMs });
  const zero = (path: string, durationMs: number, assertions: number): FileReport =>
    report(path, { coveredLines: 0, uniqueLines: 0, bestOverlap: null, durationMs, pinned: { targets: assertions ? ['a.md'] : [], assertions } });
  const { candidates } = buildCandidates([
    zero('n1.test.ts', 5, 0),
    contained('c-low.test.ts', 0.96, 999),
    zero('p1.test.ts', 1, 2),
    contained('c-fast.test.ts', 1, 5),
    zero('p2.test.ts', 50, 1),
    contained('c-slow-b.test.ts', 1, 50),
    contained('c-slow-a.test.ts', 1, 50),
  ], OPTS);
  assert.deepEqual(candidates.map((c) => c.file), [
    'c-slow-a.test.ts', 'c-slow-b.test.ts', 'c-fast.test.ts', 'c-low.test.ts',
    'p2.test.ts', 'p1.test.ts',
    'n1.test.ts',
  ]);
});

test('buildCandidates：limit で切り、切った数を notes に出す', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => report(`${n}.test.ts`, { coveredLines: 0, uniqueLines: 0, bestOverlap: null }));
  const { candidates, notes } = buildCandidates(files, { minContainment: 0.95, limit: 2 });
  assert.deepEqual(candidates.map((c) => c.file), ['a.test.ts', 'b.test.ts']);
  assert.equal(notes.length, 1);
  assert.ok(notes[0]!.includes('3 件を省略'), notes[0]);
  assert.ok(notes[0]!.includes('2 件で切りました'), notes[0]);
  assert.deepEqual(buildCandidates(files, { minContainment: 0.95, limit: 5 }).notes, []);
});

test('buildCandidates：重なる先のミュータントの数は contained だけに添え、渡されなければ null', () => {
  const files = [
    report('c1.test.ts', { uniqueLines: 0, bestOverlap: { with: 'big.test.ts', ratio: 1 } }),
    report('c2.test.ts', { uniqueLines: 0, bestOverlap: { with: 'other.test.ts', ratio: 1 } }),
    report('p.test.ts', { coveredLines: 0, uniqueLines: 0, bestOverlap: null, pinned: { targets: ['a.md'], assertions: 1 } }),
  ];
  const withMutants = buildCandidates(files, OPTS, new Map([['big.test.ts', 3]])).candidates;
  assert.deepEqual(withMutants.map((c) => [c.file, c.survivedMutantsInOverlap]), [['c1.test.ts', 3], ['c2.test.ts', 0], ['p.test.ts', null]]);
  assert.deepEqual(buildCandidates(files, OPTS).candidates.map((c) => c.survivedMutantsInOverlap), [null, null, null]);
});

test('buildCandidates：候補に時間と子プロセスの有無を添える', () => {
  const { candidates } = buildCandidates([
    report('c.test.ts', { uniqueLines: 0, bestOverlap: { with: 'big.test.ts', ratio: 1 }, durationMs: 1234, spawnsChild: true, coveredLines: 7 }),
  ], OPTS);
  assert.equal(candidates[0]!.durationMs, 1234);
  assert.equal(candidates[0]!.spawnsChild, true);
  assert.equal(candidates[0]!.coveredLines, 7);
});

// --- parseTestPruneArgs ---

const DEFAULTS: TestPruneOptions = { out: null, health: null, minContainment: 0.95, limit: 30, concurrency: 4, only: null };

test('parseTestPruneArgs：引数が無ければ既定（0.95・30 件・並行 4）', () => {
  assert.deepEqual(parseTestPruneArgs([]), { ok: true, value: DEFAULTS });
});

test('parseTestPruneArgs：すべての引数を読み、--min-containment は 1 も受ける', () => {
  assert.deepEqual(parseTestPruneArgs([
    '--out', 'out/prune.json', '--health', 'observe.json', '--min-containment', '1', '--limit', '5', '--concurrency', '2', '--only', 'harness/test/a.test.ts',
  ]), { ok: true, value: { out: 'out/prune.json', health: 'observe.json', minContainment: 1, limit: 5, concurrency: 2, only: 'harness/test/a.test.ts' } });
  assert.deepEqual(parseTestPruneArgs(['--min-containment', '0.8']), { ok: true, value: { ...DEFAULTS, minContainment: 0.8 } });
});

test('parseTestPruneArgs：数でない・範囲の外の値、値の無い引数、知らない引数、2回ある引数は誤り', () => {
  for (const args of [
    ['--min-containment', 'x'], ['--min-containment', '0'], ['--min-containment', '1.5'], ['--min-containment', '-0.1'],
    ['--limit', 'x'], ['--limit', '0'], ['--limit', '1.5'],
    ['--concurrency', 'x'], ['--concurrency', '0'], ['--concurrency', '2.5'],
    ['--out'], ['--health'], ['--only'], ['--limit'],
    ['--unknown'],
    ['--limit', '1', '--limit', '2'],
  ]) {
    const r = parseTestPruneArgs(args);
    assert.equal(r.ok, false, args.join(' '));
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});
