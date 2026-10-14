/**
 * 見直しのまとめ役（patrol の skill）が、付き添いのセッションの `/loop` の1回分で使う、前回の観測の読み出し・今回まわす見直しの決定・回の記録。
 *
 *   node harness/scripts/patrol.ts previous --dir <dir>
 *       前回の観測の写し（observe.ts の JSON）のパスを出す。写しが無ければ何も出さない（初回）
 *   node harness/scripts/patrol.ts select <観測の JSON> [--max <n>] --dir <dir>
 *       観測の差と前回からの経過で今回まわす見直しを決め、JSON（run・suggest・skipped・reasons・alerts・alertsNote）を出す。状態は変えない
 *   node harness/scripts/patrol.ts record <観測の JSON> [--ran <名前>]... [--suggested <名前>]... --dir <dir>
 *       回した見直しの lastRunAt・勧めた見直しの lastSuggestedAt を今の時刻にし、観測の JSON を <dir>/patrol-observe.json に写す（次の回の --previous）
 *
 * <dir> は patrol-pull（node harness/scripts/agent.ts patrol-pull --dir <dir>）がまとめの Issue の本文の状態を写したディレクトリで、状態は <dir>/patrol.json。
 * 3つとも --dir が要る（観測の写しは <dir> の中にしか無く、本文には入らない）。書いた状態は patrol-push が本文に書き戻す（pull の後に本文が変わっていれば push が止まる）。
 * 状態のファイルが壊れている・version が違うときは誤りで止まり、上書きしない。GitHub は読まない。決め方と状態のロジックは harness/lib/patrol.ts。<dir> の読み書きは harness/lib/patrol-issue.ts。終了コードは誤りで 1。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeLocalFile } from '../lib/local-state.ts';
import { checkObserveReport, parsePatrolArgs, parsePatrolState, recordRound, selectReviews } from '../lib/patrol.ts';
import { exitWithErrors as fail, PATROL_DIR_FILES, readDirPart, readText, writeDirPart, type LoopResult } from '../lib/patrol-issue.ts';

const OBSERVE_NAME = 'patrol-observe.json';
const USAGE = 'node harness/scripts/patrol.ts previous|select|record …（使い方はファイルの先頭のコメント）';

/** 誤りならそこで終える */
const ok = <T>(r: LoopResult<T>): { ok: true } & T => (r.ok ? r : fail(r.errors));

const loadState = (dir: string) => ok(readDirPart(dir, 'patrol', parsePatrolState)).state;

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
  if (args.dir === null) fail(['--dir が要ります（patrol-pull で写したディレクトリ）', USAGE]);
  const dir = args.dir;
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
      const state = loadState(dir);
      if (state?.observe) {
        const p = join(dir, state.observe);
        if (existsSync(p)) console.log(p);
      }
      return;
    }
    case 'select': {
      positional(1);
      noRecordFlags();
      const state = loadState(dir);
      const { report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      console.log(JSON.stringify(selectReviews(state, report.report, new Date(), args.max), null, 2));
      return;
    }
    case 'record': {
      positional(1);
      const state = loadState(dir);
      const { text, report } = readObserve(args.positional[0]!);
      if (!report.ok) fail(report.errors);
      const observePath = join(dir, OBSERVE_NAME);
      const next = recordRound(state, args.ran, args.suggested, new Date(), OBSERVE_NAME);
      if (!next.ok) fail(next.errors);
      writeLocalFile(observePath, text);
      writeDirPart(dir, 'patrol', next.state);
      console.log(JSON.stringify({ state: join(dir, PATROL_DIR_FILES.patrol), observe: observePath, round: next.state.rounds.at(-1) }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${args.sub || '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) main();
