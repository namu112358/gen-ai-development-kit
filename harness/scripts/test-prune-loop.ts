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
 * 状態の書き込みは一時ファイルに書いてから名前を変える。GitHub は読まない。Issue は作らない。
 * 状態のロジックは harness/lib/test-prune-loop.ts（pending・adopt は harness/lib/qa-retro-loop.ts と同じ関数）。終了コードは誤りで 1。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptDraft, pendingDrafts } from '../lib/qa-retro-loop.ts';
import { parseTestPruneLoopState, recordTestPruneRound, type TestPruneLoopState } from '../lib/test-prune-loop.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const USAGE = 'node harness/scripts/test-prune-loop.ts record|pending|adopt …（使い方はファイルの先頭のコメント）';

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

function readJsonFile(path: string, what: string): unknown {
  const text = readText(path);
  if (text === null) fail([`${what}のファイルがありません: ${path}`]);
  try {
    return JSON.parse(text);
  } catch (e) {
    fail([`${what}のファイルが JSON として読めません: ${(e as Error).message}`]);
  }
}

function loadState(path: string): TestPruneLoopState | null {
  const parsed = parseTestPruneLoopState(readText(path));
  if (!parsed.ok) fail([`状態のファイル（${path}）を読めません。上書きしません`, ...parsed.errors]);
  return parsed.state;
}

function saveState(path: string, state: TestPruneLoopState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

function defaultStatePath(): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) fail([`git rev-parse が失敗しました: ${(r.stderr ?? '').trim()}`]);
  return join(r.stdout.trim(), 'agent-harness', 'test-prune-loop.json');
}

/** 位置引数と --state・--drafts を分ける */
function parseArgs(args: string[]): { positional: string[]; state?: string; drafts?: string } {
  const out: { positional: string[]; state?: string; drafts?: string } = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--state' || a === '--drafts') {
      const v = args[++i];
      if (v === undefined) fail([`${a} の値がありません`]);
      const key = a === '--state' ? 'state' : 'drafts';
      if (out[key] !== undefined) fail([`${a} が2回あります`]);
      out[key] = v;
    } else if (a.startsWith('--')) fail([`知らない引数です: ${a}`]);
    else out.positional.push(a);
  }
  return out;
}

function main(): void {
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const statePath = args.state ?? defaultStatePath();
  const positional = (n: number): void => {
    if (args.positional.length !== n) fail([`${sub} の位置引数は ${n} 個です（${args.positional.length} 個）`, USAGE]);
  };
  const noDrafts = (): void => {
    if (args.drafts !== undefined) fail([`${sub} は --drafts を取りません`]);
  };
  switch (sub) {
    case 'record': {
      positional(1);
      const state = loadState(statePath);
      const report = readJsonFile(args.positional[0]!, '集計の JSON ');
      const drafts = args.drafts === undefined ? undefined : readJsonFile(args.drafts, '下書きの JSON ');
      const next = recordTestPruneRound(state, report, drafts, new Date());
      if (!next.ok) fail(next.errors);
      saveState(statePath, next.state);
      const round = next.state.rounds.at(-1)!;
      console.log(JSON.stringify({ state: statePath, round: next.state.rounds.length, generatedAt: round.generatedAt, candidates: round.candidates, drafts: round.drafts.length, duplicates: round.duplicates }, null, 2));
      return;
    }
    case 'pending': {
      positional(0);
      noDrafts();
      console.log(JSON.stringify(pendingDrafts(loadState(statePath)), null, 2));
      return;
    }
    case 'adopt': {
      positional(3);
      noDrafts();
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

if (import.meta.main) main();
