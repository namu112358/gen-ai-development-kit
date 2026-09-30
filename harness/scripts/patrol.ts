/**
 * 見直しのまとめ役（patrol の skill）が、付き添いのセッションの `/loop` の1回分で使う、前回の観測の読み出し・今回まわす見直しの決定・回の記録。
 *
 *   node harness/scripts/patrol.ts previous [--state <path>]
 *       前回の観測の写し（observe.ts の JSON）のパスを出す。写しが無ければ何も出さない（初回）
 *   node harness/scripts/patrol.ts select <観測の JSON> [--max <n>] [--state <path>]
 *       観測の差と前回からの経過で今回まわす見直しを決め、JSON（run・suggest・skipped・reasons）を出す。状態は変えない
 *   node harness/scripts/patrol.ts record <観測の JSON> [--ran <名前>]... [--suggested <名前>]... [--state <path>]
 *       回した見直しの lastRunAt・勧めた見直しの lastSuggestedAt を今の時刻にし、観測の JSON を状態と同じディレクトリに写す（次の回の --previous）
 *
 * --state の既定は `git rev-parse --path-format=absolute --git-common-dir` の下の agent-harness/patrol.json（worktree をまたいで同じ。作業ツリーにも GitHub にも書かない）。
 * 観測の写しは状態のファイルと同じディレクトリの <状態のファイル名>-observe.json。書き込みは一時ファイルに書いてから名前を変える。
 * 状態のファイルが壊れている・version が違うときは誤りで止まり、上書きしない。GitHub は読まない。決め方と状態のロジックは harness/lib/patrol.ts。終了コードは誤りで 1。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkObserveReport, parsePatrolArgs, parsePatrolState, recordRound, selectReviews, type PatrolState } from '../lib/patrol.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'node harness/scripts/patrol.ts previous|select|record …（使い方はファイルの先頭のコメント）';

function fail(errors: string[]): never {
  console.error(['誤り:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(1);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail([`${path} を読めません: ${(e as Error).message}`]);
  }
}

function defaultStatePath(): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail([`git rev-parse が失敗しました: ${(r.stderr ?? '').trim()}`]);
  return join(r.stdout.trim(), 'agent-harness', 'patrol.json');
}

function loadState(path: string): PatrolState | null {
  const parsed = parsePatrolState(readText(path));
  if (!parsed.ok) fail([`状態のファイル（${path}）を読めません。上書きしません（直すか消せば、次の回から初回として回ります）`, ...parsed.errors]);
  return parsed.state;
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function readObserve(path: string): { text: string; report: ReturnType<typeof checkObserveReport> } {
  const text = readText(path);
  if (text === null) fail([`観測の JSON がありません: ${path}`]);
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    fail([`観測の JSON が JSON として読めません: ${(e as Error).message}`]);
  }
  return { text, report: checkObserveReport(v) };
}

function main(): void {
  const args = parsePatrolArgs(process.argv.slice(2));
  if (!args.ok) fail([...args.errors, USAGE]);
  const statePath = args.state ?? defaultStatePath();
  const positional = (n: number): void => {
    if (args.positional.length !== n) fail([`${args.sub} の位置引数は ${n} 個です（${args.positional.length} 個）`, USAGE]);
  };
  const noRecordFlags = (): void => {
    if (args.ran.length || args.suggested.length) fail([`${args.sub} は --ran・--suggested を取りません`]);
  };
  switch (args.sub) {
    case 'previous': {
      positional(0);
      noRecordFlags();
      const state = loadState(statePath);
      if (state?.observe) {
        const p = join(dirname(statePath), state.observe);
        if (existsSync(p)) console.log(p);
      }
      return;
    }
    case 'select': {
      positional(1);
      noRecordFlags();
      const state = loadState(statePath);
      const { report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      console.log(JSON.stringify(selectReviews(state, report.report, new Date(), args.max), null, 2));
      return;
    }
    case 'record': {
      positional(1);
      const state = loadState(statePath);
      const { text, report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      const observeName = `${basename(statePath).replace(/\.json$/, '')}-observe.json`;
      const next = recordRound(state, args.ran, args.suggested, new Date(), observeName);
      if (!next.ok) fail(next.errors);
      writeAtomic(join(dirname(statePath), observeName), text);
      writeAtomic(statePath, `${JSON.stringify(next.state, null, 2)}\n`);
      console.log(JSON.stringify({ state: statePath, observe: join(dirname(statePath), observeName), round: next.state.rounds.at(-1) }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${args.sub || '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) main();
