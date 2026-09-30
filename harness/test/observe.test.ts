// Issue #326：保守の観測（observe）。引数の読み取り、偽の入出力から節を組んだ JSON の形、読めない節の扱い（--offline・junit・GitHub の失敗）、GitHub に GET しか呼ばないこと、前回との差、要約、リポジトリの外への書き出しを確かめる。
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GitHub, HttpError, type RequestOptions } from '../lib/github.ts';
import {
  diffReports, itemKeys, observe, parseObserveArgs, renderSummary, writeReportFile,
  type ObserveIo, type ObserveOptions, type ObserveReport,
} from '../lib/observe.ts';
import { config, FakeGitHub } from './support/gate-fixtures.ts';

// --- parseObserveArgs ---

const DEFAULTS: ObserveOptions = { days: 30, top: 20, junit: null, runTests: false, previous: null, offline: false };

test('parseObserveArgs：引数が無ければ 30 日・上位 20 件で、GitHub も読む', () => {
  assert.deepEqual(parseObserveArgs([]), { ok: true, value: DEFAULTS });
});

test('parseObserveArgs：--days・--top・--junit・--previous・--offline を読む', () => {
  const r = parseObserveArgs(['--days', '7', '--top', '5', '--junit', 'out/junit.xml', '--previous', 'prev.json', '--offline']);
  assert.deepEqual(r, { ok: true, value: { days: 7, top: 5, junit: 'out/junit.xml', runTests: false, previous: 'prev.json', offline: true } });
  assert.deepEqual(parseObserveArgs(['--run-tests']), { ok: true, value: { ...DEFAULTS, runTests: true } });
});

test('parseObserveArgs：正の整数でない数・値の無い引数・知らない引数・2回・--junit と --run-tests の同時はエラー', () => {
  for (const args of [
    ['--days', '0'], ['--days', '-1'], ['--days', '1.5'], ['--days', 'x'], ['--days'], ['--top', '0'], ['--top'],
    ['--junit'], ['--previous'], ['--bogus'], ['--days', '1', '--days', '2'], ['--offline', '--offline'],
    ['--junit', 'a.xml', '--run-tests'],
  ]) {
    const r = parseObserveArgs(args);
    assert.equal(r.ok, false, `${args.join(' ')} を受け付けました`);
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});

// --- 偽の入出力 ---

const NOW = new Date('2026-09-30T00:00:00Z');
const HEAD = 'f'.repeat(40);

const AGENT_SOURCE = "switch (cmd) {\n  case 'claim': return 1;\n  case 'release': return 2;\n}\n";

const TEXTS: Record<string, string> = {
  'README.md': ['# README', '', '`harness/lib/gone.ts` は消えた。', '`node harness/scripts/agent.ts no-such-cmd` も無い。', '`harness/lib/x.ts` はある。', ''].join('\n'),
  'docs/a.md': '# A\n\n[README](../README.md) を読む。\n',
  'harness/lib/x.ts': 'a\nb\nc\n',
  'harness/lib/y.ts': 'a\n',
  'harness/scripts/agent.ts': AGENT_SOURCE,
  'harness/lib/config.ts': 'export interface HarnessConfig {\n  appSlug: string;\n}\n',
  'harness.config.json': JSON.stringify(config),
  'package-lock.json': 'x\n'.repeat(1000),
};

const GIT_LOG = [
  'commit aaaa',
  '3\t1\tharness/lib/x.ts',
  '1\t0\tharness/lib/y.ts',
  '100\t100\tpackage-lock.json',
  '5\t5\tharness/lib/removed.ts',
  'commit bbbb',
  '1\t1\tharness/lib/x.ts',
].join('\n');

const JUNIT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<testsuites>',
  '<testcase name="遅い" time="1.25" classname="test" file="/repo/harness/test/a.test.ts"/>',
  '<testcase name="速い" time="0.01" classname="test" file="/repo/harness/test/b.test.ts"/>',
  '</testsuites>',
].join('\n');

interface FakeIo extends ObserveIo {
  logArgs: string[][];
}

function fakeIo(patch: Partial<ObserveIo> = {}): FakeIo {
  const logArgs: string[][] = [];
  return {
    config, now: NOW,
    gitFiles: () => Object.keys(TEXTS),
    gitLog: (args) => {
      logArgs.push(args);
      return GIT_LOG;
    },
    head: () => HEAD,
    readText: (p) => TEXTS[p] ?? null,
    gh: null,
    junit: async () => JUNIT,
    logArgs,
    ...patch,
  };
}

const survived = (file: string, line: number, operator: string) => `2026-09-30T00:00:00.0000000Z survived\t${file}:${line}\t${operator}`;

/** Actions の実行が1件（mutation のログに生き残り、ci は再試行で通った）の偽の GitHub。GET 以外は unrouted で throw する */
function ciFake(): FakeGitHub {
  const run = {
    id: 10, name: 'ci', workflow_id: 1, head_sha: 'c'.repeat(40), run_attempt: 2, status: 'completed', conclusion: 'success',
    html_url: 'https://github.com/o/r/actions/runs/10', created_at: '2026-09-20T00:00:00Z', event: 'pull_request', pull_requests: [{ number: 7 }],
  };
  const logs: Record<number, string> = {
    101: [survived('harness/lib/x.ts', 2, 'flip'), survived('harness/lib/removed.ts', 1, 'flip')].join('\n'),
    110: '2026-09-20T00:00:00.1234567Z not ok 1 - 不安定なテスト',
  };
  const page1 = (p: string): boolean => Number(p.match(/[?&]page=(\d+)/)?.[1] ?? 1) === 1;
  return new FakeGitHub()
    .on('GET', /\/actions\/workflows(\?[^/]*)?$/, () => ({ total_count: 1, workflows: [{ id: 1, name: 'ci', path: '.github/workflows/ci.yml' }] }))
    .on('GET', /\/actions\/workflows\/(\d+)\/runs\?/, (m) => ({ total_count: 1, workflow_runs: page1(m.input!) ? [run] : [] }))
    .on('GET', /\/actions\/runs\/10\/attempts\/1(\?[^/]*)?$/, () => ({ ...run, run_attempt: 1, conclusion: 'failure', html_url: `${run.html_url}/attempts/1` }))
    .on('GET', /\/actions\/runs\/10\/attempts\/1\/jobs/, (m) => ({ total_count: 1, jobs: page1(m.input!) ? [{ id: 110, name: 'ci', conclusion: 'failure' }] : [] }))
    .on('GET', /\/actions\/runs\/10\/jobs/, (m) => ({
      total_count: 2, jobs: page1(m.input!) ? [{ id: 100, name: 'ci', conclusion: 'success' }, { id: 101, name: 'mutation', conclusion: 'success' }] : [],
    }))
    .on('GET', /\/actions\/jobs\/(\d+)\/logs/, (m, _body, opts: RequestOptions) => {
      const log = logs[Number(m[1])];
      if (log !== undefined) return log;
      if (opts.allow404) return null;
      throw new HttpError(404, `jobs/${m[1]}/logs -> 404`);
    });
}

// --- observe ---

test('observe：節を組んだ version 1 の JSON を返す（docs・ホットスポット・遅いテスト）', async () => {
  const io = fakeIo();
  const report = await observe(io, { ...DEFAULTS, offline: true });
  assert.equal(report.version, 1);
  assert.equal(report.head, HEAD);
  assert.equal(report.top, 20);
  assert.equal(report.period.days, 30);
  assert.equal(new Date(report.period.until).getTime(), NOW.getTime());
  assert.equal(new Date(report.period.since).getTime(), new Date('2026-08-31T00:00:00Z').getTime());
  assert.ok(Array.isArray(report.notes));
  // JSON として書き出せる
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);

  assert.ok(report.docs.available);
  const docNames = report.docs.items.map((f) => [f.kind, f.file, f.line, f.name]);
  assert.deepEqual(docNames, [['path', 'README.md', 3, 'harness/lib/gone.ts'], ['subcommand', 'README.md', 4, 'no-such-cmd']]);
  assert.equal(report.docs.total, 2);
  assert.equal(report.docs.truncated, 0);
  assert.equal(report.docs.byKind.path, 1);
  assert.equal(report.docs.byKind.subcommand, 1);

  assert.ok(report.hotspots.available);
  // 消えたファイル（harness/lib/removed.ts）と sizeExclude（package-lock.json）は出ない
  assert.deepEqual(report.hotspots.items.map((h) => [h.file, h.commits, h.lines]), [['harness/lib/x.ts', 2, 3], ['harness/lib/y.ts', 1, 1]]);
  assert.equal(io.logArgs.length, 1);
  assert.equal(io.logArgs[0]![0], 'log');
  assert.ok(io.logArgs[0]!.includes('--numstat'));

  assert.ok(report.slowTests.available);
  assert.equal(report.slowTests.totalTests, 2);
  assert.equal(report.slowTests.tests[0]!.name, '遅い');
});

test('observe：root を渡すと junit の file をそこからの相対にする', async () => {
  const report = await observe(fakeIo({ root: '/repo' }), { ...DEFAULTS, offline: true });
  assert.ok(report.slowTests.available);
  assert.deepEqual(report.slowTests.tests.map((t) => [t.name, t.file]), [['遅い', 'harness/test/a.test.ts'], ['速い', 'harness/test/b.test.ts']]);
});

test('observe：gh が null で offlineReason があれば、それを読めない理由にする', async () => {
  const report = await observe(fakeIo({ gh: null, offlineReason: 'GitHub のトークンがありません' }), DEFAULTS);
  for (const section of [report.flakyTests, report.mutants]) {
    assert.equal(section.available, false);
    if (!section.available) assert.match(section.reason, /GitHub のトークンがありません/);
  }
});

test('observe：gh が null（--offline）なら不安定なテストと生き残りは理由つきで読めない扱いにし、ほかの節は出す', async () => {
  const report = await observe(fakeIo({ gh: null }), { ...DEFAULTS, offline: true });
  for (const section of [report.flakyTests, report.mutants]) {
    assert.equal(section.available, false);
    if (!section.available) assert.ok(section.reason.length > 0);
  }
  assert.equal(report.docs.available, true);
  assert.equal(report.hotspots.available, true);
  assert.equal(report.slowTests.available, true);
});

test('observe：junit が読めなければ遅いテストは読めない理由を出し、ほかの節は出す', async () => {
  const report = await observe(fakeIo({ junit: async () => ({ reason: 'junit のファイルがありません' }) }), { ...DEFAULTS, offline: true });
  assert.equal(report.slowTests.available, false);
  if (!report.slowTests.available) assert.match(report.slowTests.reason, /junit のファイルがありません/);
  assert.equal(report.docs.available, true);
  assert.equal(report.hotspots.available, true);
});

test('observe：GitHub から生き残りと不安定なテストを読み、GET 以外を呼ばない', async () => {
  const fake = ciFake();
  const report = await observe(fakeIo({ gh: new GitHub(fake, 'o/r') }), DEFAULTS);
  assert.ok(report.mutants.available);
  // リポジトリに無いファイル（harness/lib/removed.ts）の生き残りは出ない
  assert.deepEqual(report.mutants.items.map((m) => [m.file, m.line, m.operator, m.pr]), [['harness/lib/x.ts', 2, 'flip', 7]]);
  assert.ok(report.flakyTests.available);
  assert.deepEqual(report.flakyTests.items.map((i) => [i.name, i.count]), [['不安定なテスト', 1]]);
  assert.ok(fake.calls.length > 0);
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), []);
});

test('observe：GitHub の呼び出しが throw しても、その節を理由つきで読めない扱いにしてほかの節は出す', async () => {
  const fake = new FakeGitHub().on('GET', /./, () => {
    throw new HttpError(500, 'server error');
  });
  const report = await observe(fakeIo({ gh: new GitHub(fake, 'o/r') }), DEFAULTS);
  for (const section of [report.flakyTests, report.mutants]) {
    assert.equal(section.available, false);
    if (!section.available) assert.ok(section.reason.length > 0);
  }
  assert.equal(report.docs.available, true);
  assert.equal(report.hotspots.available, true);
  assert.equal(report.slowTests.available, true);
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), []);
});

test('observe：上位 top 件で切り、切った数を出す', async () => {
  const report = await observe(fakeIo(), { ...DEFAULTS, top: 1, offline: true });
  assert.equal(report.top, 1);
  assert.ok(report.docs.available);
  assert.equal(report.docs.items.length, 1);
  assert.equal(report.docs.total, 2);
  assert.equal(report.docs.truncated, 1);
  assert.ok(report.hotspots.available);
  assert.equal(report.hotspots.items.length, 1);
  assert.equal(report.hotspots.truncated, 1);
  assert.ok(report.slowTests.available);
  assert.equal(report.slowTests.tests.length, 1);
  assert.equal(report.slowTests.truncated.tests, 1);
});

test('observe：前回の JSON を渡すと、差（diff）を付ける', async () => {
  const previous = await observe(fakeIo({ readText: (p) => (p === 'README.md' ? '# README\n' : TEXTS[p] ?? null) }), { ...DEFAULTS, offline: true });
  const report = await observe(fakeIo(), { ...DEFAULTS, offline: true }, previous);
  assert.ok(report.diff);
  assert.equal(report.diff.previousGeneratedAt, previous.generatedAt);
  assert.deepEqual(report.diff.sections.docs, {
    added: ['path README.md harness/lib/gone.ts', 'subcommand README.md no-such-cmd'],
    removed: [],
  });
  assert.equal(report.diff.sections.flakyTests, null);
  assert.equal(report.diff.sections.mutants, null);
});

// --- itemKeys・diffReports ---

function baseReport(patch: Partial<ObserveReport> = {}): ObserveReport {
  return {
    version: 1, generatedAt: '2026-09-29T00:00:00.000Z', head: HEAD,
    period: { days: 30, since: '2026-08-30T00:00:00.000Z', until: '2026-09-29T00:00:00.000Z' }, top: 20,
    docs: { available: true, total: 0, truncated: 0, byKind: {}, items: [] },
    hotspots: { available: true, total: 0, truncated: 0, items: [] },
    slowTests: { available: true, totalTests: 0, tests: [], files: [], truncated: { tests: 0, files: 0 } },
    flakyTests: { available: false, reason: '--offline で GitHub を読まない' },
    mutants: { available: false, reason: '--offline で GitHub を読まない' },
    notes: [],
    ...patch,
  };
}

const hot = (file: string) => ({ file, commits: 1, added: 1, deleted: 0, lines: 10, score: 10 });

test('itemKeys：節ごとに項目の鍵を作り、読めない節は null', () => {
  const report = baseReport({
    docs: { available: true, total: 1, truncated: 0, byKind: { label: 1 }, items: [{ kind: 'label', name: 'agent:x', file: 'docs/a.md', line: 3 }] },
    hotspots: { available: true, total: 1, truncated: 0, items: [hot('harness/lib/a.ts')] },
    slowTests: { available: true, totalTests: 2, tests: [{ name: 't1', file: 'harness/test/a.test.ts', seconds: 1 }, { name: 't2', file: null, seconds: 0.5 }], files: [], truncated: { tests: 0, files: 0 } },
    flakyTests: { available: true, runs: 1, unreadableLogs: 0, total: 1, truncated: 0, items: [{ name: '不安定', count: 1, kinds: ['rerun'], runs: ['u'] }] },
    mutants: {
      available: true, runs: 1, unreadableRuns: 0, total: 1, truncated: 0,
      items: [{ file: 'harness/lib/a.ts', line: 12, operator: 'flip', pr: 5, runUrl: 'u', headSha: 'h', createdAt: '2026-09-20T00:00:00Z' }],
    },
  });
  assert.deepEqual(itemKeys(report, 'docs'), ['label docs/a.md agent:x']);
  assert.deepEqual(itemKeys(report, 'hotspots'), ['harness/lib/a.ts']);
  assert.deepEqual(itemKeys(report, 'slowTests'), ['harness/test/a.test.ts t1', '(不明) t2']);
  assert.deepEqual(itemKeys(report, 'flakyTests'), ['不安定']);
  assert.deepEqual(itemKeys(report, 'mutants'), ['harness/lib/a.ts:12 flip']);
  assert.equal(itemKeys(baseReport(), 'mutants'), null);
});

test('diffReports：新しく出たものと消えたものを節ごとに出し、どちらかが読めない節は null', () => {
  const previous = baseReport({
    generatedAt: '2026-09-01T00:00:00.000Z',
    hotspots: { available: true, total: 2, truncated: 0, items: [hot('a.ts'), hot('b.ts')] },
  });
  const current = baseReport({
    hotspots: { available: true, total: 2, truncated: 0, items: [hot('b.ts'), hot('c.ts')] },
    slowTests: { available: false, reason: 'junit が読めない' },
  });
  const d = diffReports(previous, current);
  assert.equal(d.previousGeneratedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(d.sections.hotspots, { added: ['c.ts'], removed: ['a.ts'] });
  assert.deepEqual(d.sections.docs, { added: [], removed: [] });
  assert.equal(d.sections.slowTests, null);
  assert.equal(d.sections.flakyTests, null);
  assert.equal(d.sections.mutants, null);
});

// --- renderSummary ---

test('renderSummary：節ごとの件数・上位の項目・読めない理由・前回との差を出す', () => {
  const report = baseReport({
    docs: {
      available: true, total: 3, truncated: 2, byKind: { path: 3 },
      items: [{ kind: 'path', name: 'harness/lib/gone.ts', file: 'README.md', line: 3 }],
    },
    hotspots: { available: true, total: 1, truncated: 0, items: [hot('harness/lib/hot.ts')] },
    slowTests: { available: false, reason: 'junit のファイルがありません' },
    diff: {
      previousGeneratedAt: '2026-09-01T00:00:00.000Z',
      sections: { docs: { added: ['path README.md harness/lib/new-gone.ts'], removed: [] }, hotspots: null, slowTests: null, flakyTests: null, mutants: null },
    },
  });
  const text = renderSummary(report);
  assert.match(text, /harness\/lib\/gone\.ts/);
  assert.match(text, /README\.md/);
  assert.match(text, /3/);
  assert.match(text, /harness\/lib\/hot\.ts/);
  assert.match(text, /junit のファイルがありません/);
  assert.match(text, /--offline で GitHub を読まない/);
  assert.match(text, /new-gone\.ts/);
});

// --- writeReportFile ---

test('writeReportFile：os.tmpdir() の下（リポジトリの外）に observe.json を書き、パスを返す', () => {
  const json = JSON.stringify(baseReport());
  const file = writeReportFile(json);
  try {
    assert.equal(path.basename(file), 'observe.json');
    const tmp = path.resolve(os.tmpdir());
    assert.ok(path.resolve(file).startsWith(tmp + path.sep), `${file} が ${tmp} の下にありません`);
    const repo = path.resolve(import.meta.dirname, '..', '..');
    assert.ok(!path.resolve(file).startsWith(repo + path.sep), `${file} がリポジトリの中にあります`);
    assert.equal(readFileSync(file, 'utf8'), json);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
