/**
 * test-prune を付き添いのセッションの `/loop` から回すときの、回の記録と下書きの採用（test-prune の skill の「/loop で回すとき」が使う）。
 *
 *   node harness/scripts/test-prune-loop.ts record <集計の JSON> [--drafts <下書きの JSON>] --dir <dir>
 *       報告を出した後に回を記録する。集計の JSON は test-prune.ts の出力。前回の回の集計より新しくなければ誤り（状態は変えない）。
 *       下書きは3件まで、ラベルなし。すでにある下書きと同じタイトルは記録せず duplicates に残す
 *   node harness/scripts/test-prune-loop.ts pending [--dir <dir>]
 *       未採用の下書きと、下書きの数・採用された数を JSON で出す
 *   node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <dir>
 *       人が選んで作った Issue の番号を下書きに書き戻す
 *
 * <dir> は patrol-pull（node harness/scripts/agent.ts patrol-pull --dir <dir>）がまとめの Issue の本文の状態を写したディレクトリで、状態は <dir>/test-prune-loop.json。
 * 書く record・adopt は --dir が要り、書いた状態は patrol-push が本文に書き戻す（pull の後に本文が変わっていれば push が止まる）。
 * --dir の無い pending は、まとめの Issue の本文の状態（testPrune）を REST で読む（書かない・Issue を作らない。Issue が無ければ初回）。
 * 状態のロジックは harness/lib/test-prune-loop.ts（pending・adopt は harness/lib/qa-retro-loop.ts と同じ関数）。<dir> と本文の読み方は harness/lib/patrol-issue.ts。終了コードは誤りで 1。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { exitWithErrors as fail, PATROL_DIR_FILES, patrolIssueTitleChecked, readDirPart, readJsonFile, readPatrolIssueState, writeDirPart, type LoopResult } from '../lib/patrol-issue.ts';
import { adoptDraft, pendingDrafts } from '../lib/qa-retro-loop.ts';
import { resolveRepository } from '../lib/repository.ts';
import { splitArgs } from '../lib/session-inputs.ts';
import { parseTestPruneLoopState, recordTestPruneRound, type TestPruneLoopState } from '../lib/test-prune-loop.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'node harness/scripts/test-prune-loop.ts record|pending|adopt …（使い方はファイルの先頭のコメント）';

/** 誤りならそこで終える */
const ok = <T>(r: LoopResult<T>): { ok: true } & T => (r.ok ? r : fail(r.errors));

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail([`git ${args[0]} が失敗しました: ${(r.stderr ?? '').trim()}`]);
  return r.stdout ?? '';
}

function repository(): string {
  const r = resolveRepository(process.env.GITHUB_REPOSITORY, () => git(['remote', 'get-url', 'origin']).trim());
  if (!r.ok) fail([r.error]);
  return r.repository;
}

const jsonFile = (path: string, what: string): unknown => ok(readJsonFile(path, what)).value;
const loadState = (dir: string): TestPruneLoopState | null => ok(readDirPart(dir, 'testPrune', parseTestPruneLoopState)).state;

/** 読むだけのサブコマンドの状態。--dir があれば <dir>、無ければまとめの Issue の本文（書かない・作らない） */
async function readState(dir: string | undefined): Promise<TestPruneLoopState | null> {
  if (dir !== undefined) return loadState(dir);
  const title = ok(patrolIssueTitleChecked(loadConfig())).title;
  return ok(await readPatrolIssueState(new GitHub(transportFromEnv(), repository()), title)).state?.testPrune ?? null;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const parsed = splitArgs(rest, ['--dir', '--drafts']);
  if (!parsed.ok) fail([...parsed.errors, USAGE]);
  const positionalArgs = parsed.value.positional;
  const draftsPath = parsed.value.options['--drafts'];
  const dir = parsed.value.options['--dir'];
  /** 書くサブコマンドの <dir>（無ければ、位置引数を読む前に止まる） */
  const writeDir = (): string => dir ?? fail([`${sub} は --dir が要ります（patrol-pull で写したディレクトリ）`, USAGE]);
  const positional = (n: number): void => {
    if (positionalArgs.length !== n) fail([`${sub} の位置引数は ${n} 個です（${positionalArgs.length} 個）`, USAGE]);
  };
  const noDrafts = (): void => {
    if (draftsPath !== undefined) fail([`${sub} は --drafts を取りません`]);
  };
  switch (sub) {
    case 'record': {
      const dir = writeDir();
      positional(1);
      const state = loadState(dir);
      const report = jsonFile(positionalArgs[0]!, '集計の JSON ');
      const drafts = draftsPath === undefined ? undefined : jsonFile(draftsPath, '下書きの JSON ');
      const next = recordTestPruneRound(state, report, drafts, new Date());
      if (!next.ok) fail(next.errors);
      writeDirPart(dir, 'testPrune', next.state);
      const round = next.state.rounds.at(-1)!;
      console.log(JSON.stringify({ state: join(dir, PATROL_DIR_FILES.testPrune), round: next.state.rounds.length, generatedAt: round.generatedAt, candidates: round.candidates, drafts: round.drafts.length, duplicates: round.duplicates }, null, 2));
      return;
    }
    case 'pending': {
      positional(0);
      noDrafts();
      console.log(JSON.stringify(pendingDrafts(await readState(dir)), null, 2));
      return;
    }
    case 'adopt': {
      const dir = writeDir();
      positional(3);
      noDrafts();
      const [round, draft, issue] = positionalArgs.map((v) => (/^\d+$/.test(v) ? Number(v) : NaN)) as [number, number, number];
      const next = adoptDraft(loadState(dir), round, draft, issue);
      if (!next.ok) fail(next.errors);
      writeDirPart(dir, 'testPrune', next.state);
      console.log(JSON.stringify({ state: join(dir, PATROL_DIR_FILES.testPrune), round, draft, created: issue }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${sub ?? '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) await main();
