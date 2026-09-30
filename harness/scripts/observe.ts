/**
 * 保守の観測（docs の照合・ホットスポット・テストの健康）を、人が指示したときに1回分だけ出す（LLM を呼ばない決まる集計）。
 *
 *   node harness/scripts/observe.ts [--days <n>] [--top <n>] [--junit <path> | --run-tests] [--previous <前回の JSON>] [--offline]
 *
 * - --days：ホットスポットと CI の実行を見る期間（既定 30 日）。--top：各節の件数の上限（既定 20。切った数は truncated に出る）
 * - --junit：遅いテストに使う Node の junit の出力。--run-tests：このリポジトリのテスト（harness/test/**\/*.test.ts）を junit で動かして使う。
 *   どちらも無ければ遅いテストの節は読めない旨を出す
 * - --previous：前回の JSON。節ごとに「新しく出たもの」「消えたもの」の差を足す
 * - --offline：GitHub を読まない（不安定なテスト・生き残ったミュータントの節は読めない旨を出す）
 *
 * 標準出力に人が読む要約を出し、最後の行に JSON（harness/lib/observe.ts の ObserveReport）のパスを出す。
 * JSON は OS の一時ディレクトリに書く。リポジトリにも GitHub にも書かない（GitHub は gh の認証で GET だけ）。
 * 集計のロジックは harness/lib/observe.ts・observe-docs.ts・hotspot.ts・test-health.ts。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { observe, parseObserveArgs, renderSummary, writeReportFile, type ObserveOptions, type ObserveReport } from '../lib/observe.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} が失敗しました: ${(r.stderr ?? '').trim()}`);
  return r.stdout ?? '';
}

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(['remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
}

function readText(path: string): string | null {
  try {
    return readFileSync(join(ROOT, path), 'utf8');
  } catch {
    return null;
  }
}

async function junit(opts: ObserveOptions): Promise<string | { reason: string }> {
  if (opts.junit) {
    try {
      return readFileSync(opts.junit, 'utf8');
    } catch (e) {
      return { reason: `--junit のファイルを読めません：${(e as Error).message}` };
    }
  }
  if (!opts.runTests) return { reason: '--junit も --run-tests も無いので、テストの時間を読んでいません' };
  if (!existsSync(join(ROOT, 'harness/test'))) return { reason: 'harness/test がありません（導入先では --junit で junit の出力を渡してください）' };
  const dest = join(mkdtempSync(join(tmpdir(), 'agent-harness-observe-junit-')), 'junit.xml');
  console.error('テストを junit で動かしています（harness/test/**/*.test.ts）…');
  spawnSync(process.execPath, ['--test', '--test-reporter=junit', `--test-reporter-destination=${dest}`, 'harness/test/**/*.test.ts'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  try {
    return readFileSync(dest, 'utf8');
  } catch {
    return { reason: 'テストを動かしましたが junit の出力がありません' };
  }
}

async function main(): Promise<void> {
  const parsed = parseObserveArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(['引数の誤り:', ...parsed.errors.map((e) => `- ${e}`)].join('\n'));
    process.exit(1);
  }
  const opts = parsed.value;
  let previous: ObserveReport | null = null;
  if (opts.previous) {
    try {
      previous = JSON.parse(readFileSync(opts.previous, 'utf8')) as ObserveReport;
    } catch (e) {
      console.error(`--previous の JSON を読めません: ${(e as Error).message}`);
      process.exit(1);
    }
    if (previous?.version !== 1) {
      console.error('--previous の JSON の version が 1 ではありません');
      process.exit(1);
    }
  }
  let gh: GitHub | null = null;
  let offlineReason: string | undefined;
  if (!opts.offline) {
    try {
      gh = new GitHub(transportFromEnv(), repository());
    } catch (e) {
      offlineReason = `GitHub を読めません：${(e as Error).message}`;
    }
  }
  const report = await observe(
    {
      config: loadConfig(),
      now: new Date(),
      root: ROOT,
      gitFiles: () => git(['ls-files', '-z']).split('\0').filter((f) => f !== ''),
      gitLog: (args) => git(args),
      head: () => git(['rev-parse', 'HEAD']).trim(),
      readText,
      gh,
      ...(offlineReason ? { offlineReason } : {}),
      junit: () => junit(opts),
    },
    opts,
    previous,
  );
  console.log(renderSummary(report));
  console.log('');
  console.log(writeReportFile(JSON.stringify(report, null, 2)));
}

await main();
