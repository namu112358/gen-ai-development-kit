/**
 * test-prune を付き添いのセッションの `/loop` から回すときの、回の記録と下書きの採用（test-prune の skill の「/loop で回すとき」が使う）。
 *
 *   node harness/scripts/test-prune-loop.ts record <集計の JSON> [--drafts <下書きの JSON>] [--state <path>]
 *       報告を出した後に回を記録する。集計の JSON は test-prune.ts の出力。前回の回の集計より新しくなければ誤り（状態は変えない）。
 *       下書きは3件まで、ラベルなし。すでにある下書きと同じタイトルは記録せず duplicates に残す
 *   node harness/scripts/test-prune-loop.ts pending [--state <path>]
 *       未採用の下書きと、下書きの数・採用された数を JSON で出す
 *   node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> [--state <path>]
 *       人が選んで作った Issue の番号を下書きに書き戻す
 *
 * --state の既定は `git rev-parse --path-format=absolute --git-common-dir` の下の agent-harness/test-prune-loop.json（worktree をまたいで同じ。作業ツリーにも GitHub にも書かない）。
 * 状態の書き込みは一時ファイルに書いてから名前を変える。読んだ後にほかのセッションが状態のファイルを書いていたら、上書きせずに誤りで止まる（もう一度流せば読み直してやり直す）。
 * GitHub は読まない。Issue は作らない。
 * 状態のロジックは harness/lib/test-prune-loop.ts（pending・adopt は harness/lib/qa-retro-loop.ts と同じ関数）。読み書きは harness/lib/local-state-loop.ts。終了コードは誤りで 1。
 */
import { fileURLToPath } from 'node:url';
import { exitWithErrors as fail, loadLoopState, loopStatePath, parseLoopArgs, readJsonFile, saveLoopState, type LoopResult } from '../lib/local-state-loop.ts';
import { adoptDraft, pendingDrafts } from '../lib/qa-retro-loop.ts';
import { parseTestPruneLoopState, recordTestPruneRound, type TestPruneLoopState } from '../lib/test-prune-loop.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'node harness/scripts/test-prune-loop.ts record|pending|adopt …（使い方はファイルの先頭のコメント）';

/** 誤りならそこで終える */
const ok = <T>(r: LoopResult<T>): { ok: true } & T => (r.ok ? r : fail(r.errors));

const jsonFile = (path: string, what: string): unknown => ok(readJsonFile(path, what)).value;
const loadState = (path: string) => ok(loadLoopState(path, parseTestPruneLoopState)).snapshot;
const saveState = (snapshot: { path: string; text: string | null }, state: TestPruneLoopState): void => {
  ok(saveLoopState(snapshot, state));
};

function main(): void {
  const [sub, ...rest] = process.argv.slice(2);
  const parsed = ok(parseLoopArgs(rest, ['--state', '--drafts']));
  const positionalArgs = parsed.positional;
  const draftsPath = parsed.values['--drafts'];
  const statePath = parsed.values['--state'] ?? ok(loopStatePath(ROOT, 'test-prune-loop.json')).path;
  const positional = (n: number): void => {
    if (positionalArgs.length !== n) fail([`${sub} の位置引数は ${n} 個です（${positionalArgs.length} 個）`, USAGE]);
  };
  const noDrafts = (): void => {
    if (draftsPath !== undefined) fail([`${sub} は --drafts を取りません`]);
  };
  switch (sub) {
    case 'record': {
      positional(1);
      const snapshot = loadState(statePath);
      const report = jsonFile(positionalArgs[0]!, '集計の JSON ');
      const drafts = draftsPath === undefined ? undefined : jsonFile(draftsPath, '下書きの JSON ');
      const next = recordTestPruneRound(snapshot.state, report, drafts, new Date());
      if (!next.ok) fail(next.errors);
      saveState(snapshot, next.state);
      const round = next.state.rounds.at(-1)!;
      console.log(JSON.stringify({ state: statePath, round: next.state.rounds.length, generatedAt: round.generatedAt, candidates: round.candidates, drafts: round.drafts.length, duplicates: round.duplicates }, null, 2));
      return;
    }
    case 'pending': {
      positional(0);
      noDrafts();
      console.log(JSON.stringify(pendingDrafts(loadState(statePath).state), null, 2));
      return;
    }
    case 'adopt': {
      positional(3);
      noDrafts();
      const [round, draft, issue] = positionalArgs.map((v) => (/^\d+$/.test(v) ? Number(v) : NaN)) as [number, number, number];
      const snapshot = loadState(statePath);
      const next = adoptDraft(snapshot.state, round, draft, issue);
      if (!next.ok) fail(next.errors);
      saveState(snapshot, next.state);
      console.log(JSON.stringify({ state: statePath, round, draft, created: issue }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${sub ?? '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) main();
