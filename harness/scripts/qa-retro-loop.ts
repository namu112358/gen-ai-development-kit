/**
 * qa-retro を付き添いのセッションの `/loop` から回すときの、期間の決め方・進め方と下書きの記録（qa-retro の skill の「/loop で回すとき」が使う）。
 *
 *   node harness/scripts/qa-retro-loop.ts data [--dir <dir>]
 *       状態から今回の期間（前回の回の終わり〜今の 7 日前。初回は 14 日幅）を決め、collectQaRetro で集計した JSON を OS の一時ディレクトリに書き、パスを出す。
 *       見る期間が無ければ JSON を書かずにその旨を出す（終了コード 0）
 *   node harness/scripts/qa-retro-loop.ts advance <集計の JSON> [--drafts <下書きの JSON>] --dir <dir>
 *       報告を出した後に期間を進める。JSON の period.since が状態の until と一致しなければ誤り（状態は変えない）。下書きは3件まで、ラベルなし
 *   node harness/scripts/qa-retro-loop.ts pending [--dir <dir>]
 *       未採用の下書きと、下書きの数・採用された数を JSON で出す
 *   node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> --dir <dir>
 *       人が選んで作った Issue の番号を下書きに書き戻す（期間は変えない）
 *
 * <dir> は patrol-pull（node harness/scripts/agent.ts patrol-pull --dir <dir>）がまとめの Issue の本文の状態を写したディレクトリで、状態は <dir>/qa-retro-loop.json。
 * 書く advance・adopt は --dir が要り、書いた状態は patrol-push が本文に書き戻す（pull の後に本文が変わっていれば push が止まる）。
 * --dir の無い data・pending は、まとめの Issue の本文の状態（qaRetro）を REST で読む（書かない・Issue を作らない。Issue が無ければ初回）。
 * GitHub は読むだけ。Issue は作らない。
 * 期間と状態のロジックは harness/lib/qa-retro-loop.ts。<dir> と本文の読み方は harness/lib/patrol-issue.ts。終了コードは誤りで 1。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { exitWithErrors as fail, PATROL_DIR_FILES, patrolIssueTitleChecked, readDirPart, readJsonFile, readPatrolIssueState, writeDirPart, type LoopResult } from '../lib/patrol-issue.ts';
import { collectQaRetro } from '../lib/qa-retro.ts';
import { adoptDraft, advanceLoopState, loopPeriod, parseLoopState, pendingDrafts, QA_RETRO_LOOP_LAG_DAYS, type LoopState } from '../lib/qa-retro-loop.ts';
import { resolveRepository } from '../lib/repository.ts';
import { splitArgs } from '../lib/session-inputs.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

/** 誤りならそこで終える */
const ok = <T>(r: LoopResult<T>): { ok: true } & T => (r.ok ? r : fail(r.errors));

const jsonFile = (path: string, what: string): unknown => ok(readJsonFile(path, what)).value;
const github = (): GitHub => new GitHub(transportFromEnv(), repository());
const loadState = (dir: string): LoopState | null => ok(readDirPart(dir, 'qaRetro', parseLoopState)).state;

/** 読むだけのサブコマンドの状態。--dir があれば <dir>、無ければまとめの Issue の本文（書かない・作らない） */
async function readState(dir: string | undefined): Promise<LoopState | null> {
  if (dir !== undefined) return loadState(dir);
  const title = ok(patrolIssueTitleChecked(loadConfig())).title;
  return ok(await readPatrolIssueState(github(), title)).state?.qaRetro ?? null;
}

const USAGE = 'node harness/scripts/qa-retro-loop.ts data|advance|pending|adopt …（使い方はファイルの先頭のコメント）';

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const parsed = splitArgs(rest, ['--dir', '--drafts']);
  if (!parsed.ok) fail([...parsed.errors, USAGE]);
  const positionalArgs = parsed.value.positional;
  const draftsPath = parsed.value.options['--drafts'];
  const dir = parsed.value.options['--dir'];
  /** 書くサブコマンドの <dir>（無ければ、位置引数を読む前・GitHub を作る前に止まる） */
  const writeDir = (): string => dir ?? fail([`${sub} は --dir が要ります（patrol-pull で写したディレクトリ）`, USAGE]);
  const positional = (n: number): void => {
    if (positionalArgs.length !== n) fail([`${sub} の位置引数は ${n} 個です（${positionalArgs.length} 個）`, USAGE]);
  };
  switch (sub) {
    case 'data': {
      positional(0);
      if (draftsPath !== undefined) fail(['data は --drafts を取りません']);
      const period = loopPeriod(await readState(dir), new Date());
      if (period.empty) {
        console.log(`まだ見る期間がありません（前回の回の終わり ${period.since.toISOString()} が、今の ${QA_RETRO_LOOP_LAG_DAYS} 日前 ${period.until.toISOString()} より後か同じ）`);
        return;
      }
      console.error(`期間：${period.since.toISOString()} 〜 ${period.until.toISOString()}${period.first ? '（初回）' : ''}`);
      const data = await collectQaRetro(github(), loadConfig(), period);
      const path = join(mkdtempSync(join(tmpdir(), 'agent-harness-')), 'qa-retro-loop.json');
      writeFileSync(path, JSON.stringify(data, null, 2));
      console.log(path);
      return;
    }
    case 'advance': {
      const dir = writeDir();
      positional(1);
      const state = loadState(dir);
      const data = jsonFile(positionalArgs[0]!, '集計の JSON ');
      const drafts = draftsPath === undefined ? undefined : jsonFile(draftsPath, '下書きの JSON ');
      const next = advanceLoopState(state, data, drafts, new Date());
      if (!next.ok) fail(next.errors);
      writeDirPart(dir, 'qaRetro', next.state);
      const round = next.state.rounds.at(-1)!;
      console.log(JSON.stringify({ state: join(dir, PATROL_DIR_FILES.qaRetro), round: next.state.rounds.length, since: round.since, until: round.until, prs: round.prs, drafts: round.drafts.length }, null, 2));
      return;
    }
    case 'pending': {
      positional(0);
      if (draftsPath !== undefined) fail(['pending は --drafts を取りません']);
      console.log(JSON.stringify(pendingDrafts(await readState(dir)), null, 2));
      return;
    }
    case 'adopt': {
      const dir = writeDir();
      positional(3);
      if (draftsPath !== undefined) fail(['adopt は --drafts を取りません']);
      const [round, draft, issue] = positionalArgs.map((v) => (/^\d+$/.test(v) ? Number(v) : NaN)) as [number, number, number];
      const next = adoptDraft(loadState(dir), round, draft, issue);
      if (!next.ok) fail(next.errors);
      writeDirPart(dir, 'qaRetro', next.state);
      console.log(JSON.stringify({ state: join(dir, PATROL_DIR_FILES.qaRetro), round, draft, created: issue }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${sub ?? '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) await main();
