// Issue #326：テストの健康（test-health）。junit から遅いテスト、mutation のログから生き残ったミュータント、不安定な実行の記録から不安定なテストを集計し、collectCiHealth が偽の GitHub から GET だけで読むことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub, HttpError, type RequestOptions } from '../lib/github.ts';
import type { FlakyCiRun } from '../lib/qa-retro.ts';
import {
  collectCiHealth, flakyTests, parseJunit, parseSurvivedMutants, slowTests, survivedMutants,
  type JunitCase, type MutationRunLog,
} from '../lib/test-health.ts';
import { config, FakeGitHub } from './support/gate-fixtures.ts';

// --- parseJunit ---

const JUNIT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites>',
  '\t<testcase name="parseX：&quot;a&quot; &amp; &lt;b&gt; &apos;c&apos; &#12354;" time="0.001204" classname="test" file="C:\\repo\\harness\\test\\x.test.ts"/>',
  '\t<testsuite name="まとまり" time="2.000000" disabled="0" errors="0" tests="1" failures="1" skipped="0" hostname="h">',
  '\t\t<testcase name="遅いテスト" time="1.500000" classname="test" file="C:\\repo\\harness\\test\\y.test.ts">',
  '\t\t\t<failure type="testCodeFailure" message="x">詳しく</failure>',
  '\t\t</testcase>',
  '\t</testsuite>',
  '\t<testcase name="ファイルの無いテスト" time="0.200000" classname="test"/>',
  '</testsuites>',
].join('\n');

test('parseJunit：自己終了と子要素ありの testcase を読み、名前のエンティティを戻し、file を root からの相対にする', () => {
  assert.deepEqual(parseJunit(JUNIT, 'C:\\repo'), [
    { name: 'parseX："a" & <b> \'c\' あ', file: 'harness/test/x.test.ts', seconds: 0.001204 },
    { name: '遅いテスト', file: 'harness/test/y.test.ts', seconds: 1.5 },
    { name: 'ファイルの無いテスト', file: null, seconds: 0.2 },
  ]);
});

test('parseJunit：root が無ければ file の \\ を / にするだけ', () => {
  assert.equal(parseJunit(JUNIT)[0]!.file, 'C:/repo/harness/test/x.test.ts');
});

test('parseJunit：testcase が無ければ空', () => {
  assert.deepEqual(parseJunit('<?xml version="1.0"?><testsuites></testsuites>'), []);
});

// --- slowTests ---

const cases: JunitCase[] = [
  { name: 'a1', file: 'harness/test/a.test.ts', seconds: 0.5 },
  { name: 'a2', file: 'harness/test/a.test.ts', seconds: 0.6 },
  { name: 'b1', file: 'harness/test/b.test.ts', seconds: 2 },
  { name: 'c1', file: 'harness/test/c.test.ts', seconds: 0.01 },
  { name: 'n1', file: null, seconds: 0.3 },
];

test('slowTests：テストごとの遅い順とファイルごとの合計の遅い順を、上位で切って出す', () => {
  const r = slowTests(cases, 2);
  assert.equal(r.available, true);
  assert.equal(r.totalTests, 5);
  assert.deepEqual(r.tests, [
    { name: 'b1', file: 'harness/test/b.test.ts', seconds: 2 },
    { name: 'a2', file: 'harness/test/a.test.ts', seconds: 0.6 },
  ]);
  assert.equal(r.files.length, 2);
  assert.deepEqual(r.files[0], { file: 'harness/test/b.test.ts', seconds: 2, tests: 1 });
  assert.equal(r.files[1]!.file, 'harness/test/a.test.ts');
  assert.ok(Math.abs(r.files[1]!.seconds - 1.1) < 1e-9);
  assert.equal(r.files[1]!.tests, 2);
  assert.deepEqual(r.truncated, { tests: 3, files: 2 });
});

test('slowTests：file の無いテストは (不明) にまとめる', () => {
  const r = slowTests(cases, 10);
  assert.deepEqual(r.files.find((f) => f.file === '(不明)'), { file: '(不明)', seconds: 0.3, tests: 1 });
  assert.deepEqual(r.truncated, { tests: 0, files: 0 });
});

// --- parseSurvivedMutants ---

test('parseSurvivedMutants：時刻の前置きと色を外し、survived の行だけを読む', () => {
  const log = [
    '2026-09-30T01:02:03.1234567Z ##[group]Run node harness/scripts/mutate.ts',
    '2026-09-30T01:02:03.1234567Z \u001b[33msurvived\tharness/lib/a.ts:12\tflip-comparison\u001b[0m',
    '2026-09-30T01:02:04.1234567Z caught\tharness/lib/a.ts:13\tnegate',
    'survived\tharness/lib/b.ts:3\tremove-not',
    '2026-09-30T01:02:05.1234567Z | harness/lib/c.ts:9 | `x` | `a` | `b` |',
  ].join('\n');
  assert.deepEqual(parseSurvivedMutants(log), [
    { file: 'harness/lib/a.ts', line: 12, operator: 'flip-comparison' },
    { file: 'harness/lib/b.ts', line: 3, operator: 'remove-not' },
  ]);
});

test('parseSurvivedMutants：生き残りが無ければ空', () => {
  assert.deepEqual(parseSurvivedMutants('2026-09-30T01:02:03.1234567Z caught\tharness/lib/a.ts:1\tx'), []);
});

// --- survivedMutants ---

const survived = (file: string, line: number, operator: string) => `2026-09-30T00:00:00.0000000Z survived\t${file}:${line}\t${operator}`;

function mutationRun(runId: number, createdAt: string, pr: number | null, log: string | null): MutationRunLog {
  return { runId, url: `https://github.com/o/r/actions/runs/${runId}`, headSha: `${runId}`.padEnd(40, '0'), createdAt, pr, log };
}

const RUNS: MutationRunLog[] = [
  mutationRun(1, '2026-09-20T00:00:00Z', 5, [survived('harness/lib/a.ts', 12, 'flip'), survived('harness/lib/gone.ts', 1, 'flip')].join('\n')),
  mutationRun(2, '2026-09-25T00:00:00Z', 6, [survived('harness/lib/b.ts', 3, 'negate'), survived('harness/lib/a.ts', 12, 'flip')].join('\n')),
  mutationRun(3, '2026-09-22T00:00:00Z', null, survived('harness/lib/c.ts', 7, 'negate')),
  mutationRun(4, '2026-09-26T00:00:00Z', 8, null),
];
const exists = (f: string): boolean => f !== 'harness/lib/gone.ts';

test('survivedMutants：同じ箇所は新しい実行だけ残し、無いファイルは除き、新しい順（同じなら file・line の順）に並べる', () => {
  const r = survivedMutants(RUNS, exists, 10);
  assert.equal(r.available, true);
  assert.equal(r.runs, 4);
  assert.equal(r.unreadableRuns, 1);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, 0);
  assert.deepEqual(r.items.map((m) => [m.file, m.line, m.operator, m.pr]), [
    ['harness/lib/a.ts', 12, 'flip', 6],
    ['harness/lib/b.ts', 3, 'negate', 6],
    ['harness/lib/c.ts', 7, 'negate', null],
  ]);
  assert.deepEqual(r.items[0], {
    file: 'harness/lib/a.ts', line: 12, operator: 'flip', pr: 6,
    runUrl: 'https://github.com/o/r/actions/runs/2', headSha: '2'.padEnd(40, '0'), createdAt: '2026-09-25T00:00:00Z',
  });
});

test('survivedMutants：上位で切り、切った数を truncated に出す', () => {
  const r = survivedMutants(RUNS, exists, 1);
  assert.equal(r.items.length, 1);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, 2);
});

test('survivedMutants：ログがすべて読めなければ、読めない実行の数だけを出す', () => {
  const r = survivedMutants([mutationRun(9, '2026-09-20T00:00:00Z', 1, null)], exists, 10);
  assert.deepEqual({ runs: r.runs, unreadableRuns: r.unreadableRuns, total: r.total, items: r.items }, { runs: 1, unreadableRuns: 1, total: 0, items: [] });
});

// --- flakyTests ---

function flakyRun(kind: FlakyCiRun['kind'], url: string, jobs: FlakyCiRun['jobs']): FlakyCiRun {
  return {
    kind, workflow: 'ci', headSha: 'a'.repeat(40),
    failed: { runId: 1, attempt: 1, url }, passed: { runId: 1, attempt: 2, url: `${url}-passed` }, jobs,
  };
}

test('flakyTests：テスト名ごとに出た実行の数をまとめ、回数の多い順（同じなら名前の順）に並べる', () => {
  const flaky = [
    flakyRun('rerun', 'u1', [{ name: 'ci', id: 1, testNames: ['A', 'B'] }, { name: 'ci2', id: 2, testNames: ['A'] }]),
    flakyRun('separate-run', 'u2', [{ name: 'ci', id: 3, testNames: ['A'] }, { name: 'ci2', id: 4, testNames: null }]),
    flakyRun('rerun', 'u3', [{ name: 'ci', id: 5, testNames: ['C'] }]),
  ];
  const r = flakyTests(flaky, 1, 10);
  assert.equal(r.available, true);
  assert.equal(r.runs, 3);
  assert.equal(r.unreadableLogs, 1);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, 0);
  assert.deepEqual(r.items.map((i) => [i.name, i.count]), [['A', 2], ['B', 1], ['C', 1]]);
  assert.deepEqual([...r.items[0]!.kinds].sort(), ['rerun', 'separate-run']);
  assert.deepEqual([...r.items[0]!.runs].sort(), ['u1', 'u2']);
  assert.deepEqual(r.items[1]!.kinds, ['rerun']);
  assert.deepEqual(r.items[1]!.runs, ['u1']);
});

test('flakyTests：上位で切り、切った数を truncated に出す', () => {
  const flaky = [flakyRun('rerun', 'u1', [{ name: 'ci', id: 1, testNames: ['A', 'B', 'C'] }])];
  const r = flakyTests(flaky, 0, 2);
  assert.equal(r.items.length, 2);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, 1);
});

// --- collectCiHealth ---

const runUrl = (id: number): string => `https://github.com/o/r/actions/runs/${id}`;

interface RunSpec {
  id: number;
  headSha: string;
  attempt?: number;
  conclusion: string;
  createdAt: string;
  pr?: number;
  jobs: { id: number; name: string; conclusion: string }[];
  attempts?: Record<number, { conclusion: string; jobs: { id: number; name: string; conclusion: string }[] }>;
}

/** qa-retro.test.ts の retroFake の Actions の部分だけ。GET 以外の呼び出しは unrouted で throw する */
function ciFake(runs: RunSpec[], logs: Record<number, string>): FakeGitHub {
  const runOf = (id: string | undefined): RunSpec => {
    const found = runs.find((r) => r.id === Number(id));
    if (!found) throw new HttpError(404, `runs/${id}`);
    return found;
  };
  const runItem = (r: RunSpec) => ({
    id: r.id, name: 'ci', workflow_id: 1, head_sha: r.headSha, run_attempt: r.attempt ?? 1, status: 'completed', conclusion: r.conclusion,
    html_url: runUrl(r.id), created_at: r.createdAt, event: 'pull_request', pull_requests: r.pr ? [{ number: r.pr }] : [],
  });
  const page1 = (path: string): boolean => Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 1) === 1;
  return new FakeGitHub()
    .on('GET', /\/actions\/workflows(\?[^/]*)?$/, () => ({ total_count: 1, workflows: [{ id: 1, name: 'ci', path: '.github/workflows/ci.yml' }] }))
    .on('GET', /\/actions\/workflows\/(\d+)\/runs\?/, (m) => ({ total_count: runs.length, workflow_runs: page1(m.input!) ? runs.map(runItem) : [] }))
    .on('GET', /\/actions\/runs\/(\d+)\/attempts\/(\d+)(\?[^/]*)?$/, (m) => {
      const r = runOf(m[1]);
      const n = Number(m[2]);
      if (n === (r.attempt ?? 1)) return runItem(r);
      const a = r.attempts?.[n];
      if (!a) throw new HttpError(404, `runs/${r.id}/attempts/${n}`);
      return { ...runItem(r), run_attempt: n, conclusion: a.conclusion, html_url: `${runUrl(r.id)}/attempts/${n}` };
    })
    .on('GET', /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, (m) => {
      const r = runOf(m[1]);
      const n = Number(m[2]);
      const jobs = n === (r.attempt ?? 1) ? r.jobs : (r.attempts?.[n]?.jobs ?? []);
      return { total_count: jobs.length, jobs: page1(m.input!) ? jobs : [] };
    })
    .on('GET', /\/actions\/runs\/(\d+)\/jobs/, (m) => {
      const jobs = runOf(m[1]).jobs;
      return { total_count: jobs.length, jobs: page1(m.input!) ? jobs : [] };
    })
    .on('GET', /\/actions\/jobs\/(\d+)\/logs/, (m, _body, opts: RequestOptions) => {
      const log = logs[Number(m[1])];
      if (log !== undefined) return log;
      if (opts.allow404) return null;
      throw new HttpError(404, `jobs/${m[1]}/logs -> 404`);
    });
}

const PERIOD = { since: new Date('2026-09-01T00:00:00Z'), until: new Date('2026-09-30T00:00:00Z') };

const CI_RUNS: RunSpec[] = [
  {
    id: 10, headSha: 'c'.repeat(40), conclusion: 'success', createdAt: '2026-09-20T00:00:00Z', pr: 7,
    jobs: [{ id: 100, name: 'ci', conclusion: 'success' }, { id: 101, name: 'mutation', conclusion: 'success' }],
  },
  {
    id: 11, headSha: 'd'.repeat(40), attempt: 2, conclusion: 'success', createdAt: '2026-09-22T00:00:00Z', pr: 8,
    jobs: [{ id: 112, name: 'ci', conclusion: 'success' }, { id: 111, name: 'mutation', conclusion: 'success' }],
    attempts: { 1: { conclusion: 'failure', jobs: [{ id: 110, name: 'ci', conclusion: 'failure' }] } },
  },
];

const CI_LOGS: Record<number, string> = {
  101: [survived('harness/lib/a.ts', 12, 'flip'), survived('harness/lib/gone.ts', 1, 'flip')].join('\n'),
  // 111（run 11 の mutation）はログが読めない
  110: ['2026-09-22T00:00:00.1234567Z not ok 3 - 不安定なテスト', '2026-09-22T00:00:00.1234567Z ok 4 - 通るテスト'].join('\n'),
};

test('collectCiHealth：mutation ジョブのログから生き残りを読み、不安定な実行をテスト名ごとにまとめる', async () => {
  const fake = ciFake(CI_RUNS, CI_LOGS);
  const r = await collectCiHealth(new GitHub(fake, 'o/r'), config, PERIOD, { top: 10, exists });
  assert.equal(r.mutants.available, true);
  assert.equal(r.mutants.runs, 2);
  assert.equal(r.mutants.unreadableRuns, 1);
  assert.deepEqual(r.mutants.items, [{
    file: 'harness/lib/a.ts', line: 12, operator: 'flip', pr: 7, runUrl: runUrl(10), headSha: 'c'.repeat(40), createdAt: '2026-09-20T00:00:00Z',
  }]);
  assert.equal(r.flaky.available, true);
  assert.equal(r.flaky.runs, 1);
  assert.deepEqual(r.flaky.items.map((i) => [i.name, i.count, i.kinds]), [['不安定なテスト', 1, ['rerun']]]);
  assert.deepEqual(r.truncated, []);
});

test('collectCiHealth：GET 以外を呼ばず、実行の一覧は1回だけ取る', async () => {
  const fake = ciFake(CI_RUNS, CI_LOGS);
  await collectCiHealth(new GitHub(fake, 'o/r'), config, PERIOD, { top: 10, exists });
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), []);
  assert.equal(fake.calls.filter((c) => /\/actions\/workflows\/\d+\/runs\?/.test(c.path)).length, 1);
  assert.equal(fake.calls.filter((c) => /\/actions\/workflows(\?[^/]*)?$/.test(c.path)).length, 1);
});
