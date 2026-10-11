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
 * 読んだ後にほかのセッションが状態のファイルを書いていたら、観測の写しも書かず、上書きせずに誤りで止まる（その回は記録されないので、もう一度 record を流す）。
 * 状態のファイルが壊れている・version が違うときは誤りで止まり、上書きしない。GitHub は読まない。決め方と状態のロジックは harness/lib/patrol.ts。読み書きは harness/lib/local-state-loop.ts。終了コードは誤りで 1。
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWithErrors as fail, loadLoopState, loopStatePath, readText, saveLoopState, type LoopResult } from '../lib/local-state-loop.ts';
import { checkObserveReport, parsePatrolArgs, parsePatrolState, recordRound, selectReviews } from '../lib/patrol.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'node harness/scripts/patrol.ts previous|select|record …（使い方はファイルの先頭のコメント）';

/** 誤りならそこで終える */
const ok = <T>(r: LoopResult<T>): { ok: true } & T => (r.ok ? r : fail(r.errors));

const loadState = (path: string) => ok(loadLoopState(path, parsePatrolState, '直すか消せば、次の回から初回として回ります')).snapshot;

function readObserve(path: string): { text: string; report: ReturnType<typeof checkObserveReport> } {
  let text: string | null = null;
  try {
    text = readText(path);
  } catch (e) {
    fail([(e as Error).message]);
  }
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
  const statePath = args.state ?? ok(loopStatePath(ROOT, 'patrol.json')).path;
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
      const state = loadState(statePath).state;
      if (state?.observe) {
        const p = join(dirname(statePath), state.observe);
        if (existsSync(p)) console.log(p);
      }
      return;
    }
    case 'select': {
      positional(1);
      noRecordFlags();
      const state = loadState(statePath).state;
      const { report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      console.log(JSON.stringify(selectReviews(state, report.report, new Date(), args.max), null, 2));
      return;
    }
    case 'record': {
      positional(1);
      const snapshot = loadState(statePath);
      const { text, report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      const observeName = `${basename(statePath).replace(/\.json$/, '')}-observe.json`;
      const observePath = join(dirname(statePath), observeName);
      const next = recordRound(snapshot.state, args.ran, args.suggested, new Date(), observeName);
      if (!next.ok) fail(next.errors);
      ok(saveLoopState(snapshot, next.state, { extra: [{ path: observePath, content: text }] }));
      console.log(JSON.stringify({ state: statePath, observe: observePath, round: next.state.rounds.at(-1) }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${args.sub || '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) main();
