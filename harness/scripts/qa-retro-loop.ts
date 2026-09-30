/**
 * qa-retro を付き添いのセッションの `/loop` から回すときの、期間の決め方・進め方と下書きの記録（qa-retro の skill の「/loop で回すとき」が使う）。
 *
 *   node harness/scripts/qa-retro-loop.ts data [--state <path>]
 *       状態から今回の期間（前回の回の終わり〜今の 7 日前。初回は 14 日幅）を決め、collectQaRetro で集計した JSON を OS の一時ディレクトリに書き、パスを出す。
 *       見る期間が無ければ JSON を書かずにその旨を出す（終了コード 0）
 *   node harness/scripts/qa-retro-loop.ts advance <集計の JSON> [--drafts <下書きの JSON>] [--state <path>]
 *       報告を出した後に期間を進める。JSON の period.since が状態の until と一致しなければ誤り（状態は変えない）。下書きは3件まで、ラベルなし
 *   node harness/scripts/qa-retro-loop.ts pending [--state <path>]
 *       未採用の下書きと、下書きの数・採用された数を JSON で出す
 *   node harness/scripts/qa-retro-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号> [--state <path>]
 *       人が選んで作った Issue の番号を下書きに書き戻す（期間は変えない）
 *
 * --state の既定は `git rev-parse --path-format=absolute --git-common-dir` の下の agent-harness/qa-retro-loop.json（worktree をまたいで同じ。作業ツリーにも GitHub にも書かない）。
 * 状態の書き込みは一時ファイルに書いてから名前を変える。GitHub は gh の認証で読むだけ。Issue は作らない。
 * 期間と状態のロジックは harness/lib/qa-retro-loop.ts。終了コードは誤りで 1。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { collectQaRetro } from '../lib/qa-retro.ts';
import { adoptDraft, advanceLoopState, loopPeriod, parseLoopState, pendingDrafts, QA_RETRO_LOOP_LAG_DAYS, type LoopState } from '../lib/qa-retro-loop.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function fail(errors: string[]): never {
  console.error(['誤り:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(1);
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail([`git ${args[0]} が失敗しました: ${(r.stderr ?? '').trim()}`]);
  return r.stdout ?? '';
}

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(['remote', 'get-url', 'origin']).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) fail([`origin から owner/repo を判別できません: ${url}`]);
  return m[1]!;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    fail([`${path} を読めません: ${(e as Error).message}`]);
  }
}

function readJsonFile(path: string, what: string): unknown {
  const text = readText(path);
  if (text === null) fail([`${what}のファイルがありません: ${path}`]);
  try {
    return JSON.parse(text);
  } catch (e) {
    fail([`${what}のファイルが JSON として読めません: ${(e as Error).message}`]);
  }
}

function loadState(path: string): LoopState | null {
  const parsed = parseLoopState(readText(path));
  if (!parsed.ok) fail([`状態のファイル（${path}）を読めません。上書きしません`, ...parsed.errors]);
  return parsed.state;
}

function saveState(path: string, state: LoopState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 位置引数と --state・--drafts を分ける */
function parseArgs(args: string[]): { positional: string[]; state?: string; drafts?: string } {
  const out: { positional: string[]; state?: string; drafts?: string } = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--state' || a === '--drafts') {
      const v = args[++i];
      if (v === undefined) fail([`${a} の値がありません`]);
      if (out[a === '--state' ? 'state' : 'drafts'] !== undefined) fail([`${a} が2回あります`]);
      out[a === '--state' ? 'state' : 'drafts'] = v;
    } else if (a.startsWith('--')) fail([`知らない引数です: ${a}`]);
    else out.positional.push(a);
  }
  return out;
}

const USAGE = 'node harness/scripts/qa-retro-loop.ts data|advance|pending|adopt …（使い方はファイルの先頭のコメント）';

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const statePath = args.state ?? join(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'agent-harness', 'qa-retro-loop.json');
  const positional = (n: number): void => {
    if (args.positional.length !== n) fail([`${sub} の位置引数は ${n} 個です（${args.positional.length} 個）`, USAGE]);
  };
  switch (sub) {
    case 'data': {
      positional(0);
      if (args.drafts !== undefined) fail(['data は --drafts を取りません']);
      const period = loopPeriod(loadState(statePath), new Date());
      if (period.empty) {
        console.log(`まだ見る期間がありません（前回の回の終わり ${period.since.toISOString()} が、今の ${QA_RETRO_LOOP_LAG_DAYS} 日前 ${period.until.toISOString()} より後か同じ）`);
        return;
      }
      console.error(`期間：${period.since.toISOString()} 〜 ${period.until.toISOString()}${period.first ? '（初回）' : ''}`);
      const data = await collectQaRetro(new GitHub(transportFromEnv(), repository()), loadConfig(), period);
      const path = join(mkdtempSync(join(tmpdir(), 'agent-harness-')), 'qa-retro-loop.json');
      writeFileSync(path, JSON.stringify(data, null, 2));
      console.log(path);
      return;
    }
    case 'advance': {
      positional(1);
      const state = loadState(statePath);
      const data = readJsonFile(args.positional[0]!, '集計の JSON ');
      const drafts = args.drafts === undefined ? undefined : readJsonFile(args.drafts, '下書きの JSON ');
      const next = advanceLoopState(state, data, drafts, new Date());
      if (!next.ok) fail(next.errors);
      saveState(statePath, next.state);
      const round = next.state.rounds.at(-1)!;
      console.log(JSON.stringify({ state: statePath, round: next.state.rounds.length, since: round.since, until: round.until, prs: round.prs, drafts: round.drafts.length }, null, 2));
      return;
    }
    case 'pending': {
      positional(0);
      if (args.drafts !== undefined) fail(['pending は --drafts を取りません']);
      console.log(JSON.stringify(pendingDrafts(loadState(statePath)), null, 2));
      return;
    }
    case 'adopt': {
      positional(3);
      if (args.drafts !== undefined) fail(['adopt は --drafts を取りません']);
      const [round, draft, issue] = args.positional.map((v) => (/^\d+$/.test(v) ? Number(v) : NaN)) as [number, number, number];
      const next = adoptDraft(loadState(statePath), round, draft, issue);
      if (!next.ok) fail(next.errors);
      saveState(statePath, next.state);
      console.log(JSON.stringify({ state: statePath, round, draft, created: issue }, null, 2));
      return;
    }
    default:
      fail([`知らないサブコマンドです: ${sub ?? '（無し）'}`, USAGE]);
  }
}

if (import.meta.main) await main();
