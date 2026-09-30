/**
 * 減らせるテストの材料を、人が指示したときに1回分だけ集める（LLM を呼ばない決まる集計）。test-prune の skill が使う。
 *
 *   node harness/scripts/test-prune.ts [--out <file>] [--health <file>] [--min-containment 0.95] [--limit 30] [--concurrency 4] [--only <glob>]
 *
 * - テストファイル（harness/test/**\/*.test.ts のうち harness.config.json の testPatterns に当たるもの。support/ は除く）を
 *   1本ずつ NODE_V8_COVERAGE 付きの `node --test <file>` で動かし、本体（テストでない .ts）の実行された行・所要時間を集める
 * - --health：保守の観測（node harness/scripts/observe.ts）の JSON。遅いテスト・不安定なテスト・生き残ったミュータントを候補に添える
 * - --min-containment：contained の候補にする重なりの割合の下限。--limit：候補の上限。--concurrency：同時に動かすテストファイルの数
 * - --only：対象のテストファイルを絞る glob（例 `harness/test/gates-*.test.ts`）
 *
 * 出力は JSON（version 1）。--out が無ければ OS の一時ディレクトリに書き、最後の行にパスを出す。リポジトリにも GitHub にも書かない。
 * 終了コードは引数・設定の誤りだけ 1。テストの失敗では 0（失敗したファイルは files[].exitCode と notes に出す）。
 * 集計のロジックは harness/lib/test-prune.ts。CLI の部分は `import.meta.main` の中だけで動く。
 */
import { spawn, spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { DEFAULT_TEST_PATTERNS, isTestFile } from '../lib/test-tamper.ts';
import {
  buildCandidates,
  countTests,
  coverageUrlToPath,
  coveredLines,
  detectPinned,
  healthForFile,
  overlapByFile,
  parseTestPruneArgs,
  readHealth,
  spawnsChild,
  type FileReport,
  type HealthInput,
  type TestPruneOptions,
  type V8Script,
} from '../lib/test-prune.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** 1ファイルの上限（超えたら止めて exitCode null） */
const FILE_TIMEOUT_MS = 5 * 60 * 1000;

interface RunResult {
  path: string;
  durationMs: number;
  exitCode: number | null;
  lines: Set<string>;
  coverageErrors: number;
}

function readSource(cache: Map<string, string | null>, rel: string): string | null {
  if (!cache.has(rel)) {
    try {
      cache.set(rel, readFileSync(join(ROOT, rel), 'utf8'));
    } catch {
      cache.set(rel, null);
    }
  }
  return cache.get(rel)!;
}

function runOne(path: string, sources: Map<string, string | null>): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-test-prune-'));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', path], { cwd: ROOT, env: { ...process.env, NODE_V8_COVERAGE: dir }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), FILE_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const lines = new Set<string>();
      let coverageErrors = 0;
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
        let scripts: V8Script[];
        try {
          scripts = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { result: V8Script[] }).result;
        } catch {
          coverageErrors++;
          continue;
        }
        for (const s of scripts) {
          const rel = coverageUrlToPath(s.url, ROOT);
          if (rel === null) continue;
          const src = readSource(sources, rel);
          if (src === null) continue;
          for (const l of coveredLines(src, s.functions, { skipModuleScope: true })) lines.add(`${rel}:${l}`);
        }
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ path, durationMs, exitCode: code, lines, coverageErrors });
    });
  });
}

async function runAll(files: string[], concurrency: number): Promise<RunResult[]> {
  const sources = new Map<string, string | null>();
  const results: RunResult[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const f = files[next++]!;
      results.push(await runOne(f, sources));
      done++;
      if (done % 10 === 0 || done === files.length) console.error(`${done}/${files.length} 本を動かしました`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function testFiles(opts: TestPruneOptions, patterns: string[]): string[] {
  return globSync('harness/test/**/*.test.ts', { cwd: ROOT })
    .map((f) => f.replace(/\\/g, '/'))
    .filter((f) => !f.startsWith('harness/test/support/') && isTestFile(patterns, f))
    .filter((f) => opts.only === null || matchesGlob(f, opts.only))
    .sort();
}

async function main(): Promise<void> {
  const parsed = parseTestPruneArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(['引数の誤り:', ...parsed.errors.map((e) => `- ${e}`)].join('\n'));
    process.exit(1);
  }
  const opts = parsed.value;
  let patterns: string[];
  try {
    patterns = loadConfig().testPatterns ?? DEFAULT_TEST_PATTERNS;
  } catch (e) {
    console.error(`harness.config.json を読めません: ${(e as Error).message}`);
    process.exit(1);
  }
  const notes: string[] = [];
  let health: HealthInput | null = null;
  if (opts.health === null) notes.push('--health が渡されていないので、テストの健康（遅い・不安定・生き残ったミュータント）を添えていません');
  else {
    try {
      const r = readHealth(JSON.parse(readFileSync(opts.health, 'utf8')));
      if (r.ok) {
        health = r.value;
        notes.push(...r.value.notes);
      } else notes.push(r.reason);
    } catch (e) {
      notes.push(`--health のファイルを読めません：${(e as Error).message.split('\n')[0]}`);
    }
  }

  const files = testFiles(opts, patterns);
  if (files.length === 0) notes.push('対象のテストファイルがありません');
  console.error(`テストファイル ${files.length} 本をカバレッジ付きで1本ずつ動かしています（同時に ${opts.concurrency} 本）…`);
  const results = await runAll(files, opts.concurrency);
  const overlap = overlapByFile(new Map(results.map((r) => [r.path, r.lines])));
  const reports: FileReport[] = results.map((r) => {
    const src = readFileSync(join(ROOT, r.path), 'utf8');
    const o = overlap.get(r.path)!;
    if (r.exitCode !== 0) notes.push(`${r.path} は終了コード ${r.exitCode ?? 'null（上限の時間で止めた）'} で終わりました`);
    if (r.coverageErrors > 0) notes.push(`${r.path} のカバレッジのファイル ${r.coverageErrors} 個を読めませんでした`);
    return {
      path: r.path,
      tests: countTests(src),
      durationMs: r.durationMs,
      exitCode: r.exitCode,
      coveredLines: o.coveredLines,
      uniqueLines: o.uniqueLines,
      bestOverlap: o.bestOverlap,
      pinned: detectPinned(src),
      spawnsChild: spawnsChild(src),
      health: health ? healthForFile(health, r.path, src, r.lines) : null,
    };
  });
  const spawning = reports.filter((f) => f.spawnsChild).length;
  if (spawning > 0) notes.push(`${spawning} 本が子プロセスを起動します（子に env を明示して渡すとカバレッジが欠け、contained・no-coverage を誤って出しうる）`);
  const overlapMutants = health ? new Map(results.map((r) => [r.path, health!.mutants.filter((m) => r.lines.has(`${m.file}:${m.line}`)).length])) : undefined;
  const { candidates, notes: candidateNotes } = buildCandidates(reports, { minContainment: opts.minContainment, limit: opts.limit }, overlapMutants);
  notes.push(...candidateNotes);

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    headSha: head.status === 0 ? head.stdout.trim() : null,
    options: { minContainment: opts.minContainment, limit: opts.limit, concurrency: opts.concurrency, only: opts.only, health: opts.health },
    files: reports,
    candidates,
    notes,
  };
  const out = opts.out ?? join(mkdtempSync(join(tmpdir(), 'agent-harness-test-prune-out-')), 'test-prune.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  const byKind = (k: string): number => candidates.filter((c) => c.kind === k).length;
  console.log(`テストファイル ${reports.length} 本、候補 ${candidates.length} 件（contained ${byKind('contained')}・pinned ${byKind('pinned')}・no-coverage ${byKind('no-coverage')}）`);
  console.log(out);
}

if (import.meta.main) await main();
