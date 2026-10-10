import { readFileSync } from 'node:fs';
import { loadConfig } from '../../../lib/config.ts';
import { isValidSession } from '../../../lib/incident.ts';
import { checkIssueOverlap, listOverlapSessions, overlapStats, readOverlapLog, renderOverlapResult } from '../../../lib/issue-overlap-check.ts';
import type { OpenIssue } from '../../../lib/issue-overlap.ts';
import { type AgentCommand, fail } from '../cli.ts';

/**
 * Issue の下書きの重なりを Jev に問い、セッションの判断と並べて <セッションID>.overlap.jsonl に残す（shadow、Issue #631）。
 * 開いた Issue は GitHub から読むだけで、何も書かない。記録はリポジトリの外（incident の記録と同じディレクトリ）。
 * JEV_API_KEY が無い・off・候補なしのときは問わずに skipped で残し、終了コードは0。
 *
 *   node harness/scripts/agent.ts issue-overlap check --title <題> --body-file <ファイル> --session-duplicate <番号|none> [--session <id>] [--json]
 *                                                           下書きの重なりを問い、提案（#N へのコメントの案／新しい Issue の下書き）を出す
 *   node harness/scripts/agent.ts issue-overlap stats [--json]  全セッションの重なりの記録を集計して出す（一致率）
 */

const USAGE = 'issue-overlap check --title <題> --body-file <ファイル> --session-duplicate <番号|none> [--session <id>] [--json] / issue-overlap stats [--json]';
const VALUE_FLAGS = ['--title', '--body-file', '--session-duplicate', '--session'];

function parseArgs(args: string[]): { flags: Map<string, string>; json: boolean } {
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (VALUE_FLAGS.includes(a)) {
      const v = args[++i];
      if (v === undefined) fail([`${a} に値がありません`, USAGE]);
      flags.set(a, v);
    } else fail([`知らないオプションです: ${a}`, USAGE]);
  }
  return { flags, json };
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  pull_request?: unknown;
}

async function check(args: string[], ctx: Parameters<AgentCommand['run']>[1]): Promise<void> {
  const { flags, json } = parseArgs(args);
  const title = flags.get('--title');
  if (!title || title.trim() === '') fail(['--title が要ります', USAGE]);
  const bodyFile = flags.get('--body-file');
  if (!bodyFile) fail(['--body-file が要ります', USAGE]);
  let body: string;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch {
    fail([`--body-file を読めません: ${bodyFile}`]);
  }
  const dupRaw = flags.get('--session-duplicate');
  if (dupRaw === undefined || !(dupRaw === 'none' || /^\d+$/.test(dupRaw))) fail(['--session-duplicate は番号か none', USAGE]);
  const dup = dupRaw === 'none' ? null : Number(dupRaw);
  const session = flags.get('--session') ?? process.env.AGENT_HARNESS_SESSION;
  if (!session) fail(['セッション ID がありません（--session <id> か AGENT_HARNESS_SESSION）']);
  if (!isValidSession(session)) fail([`セッション ID は英数字と - _ だけ使えます: ${session}`]);
  const raw = await ctx.gh().paginate<RawIssue>('/issues?state=open', 10);
  const issues: OpenIssue[] = raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    labels: i.labels.map((l) => l.name),
    isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
  }));
  const r = await checkIssueOverlap(loadConfig(), process.env.JEV_API_KEY, session, { title, body }, issues, dup, process.env);
  console.log(json ? JSON.stringify(r, null, 2) : renderOverlapResult(r));
}

function stats(args: string[]): void {
  const { json } = parseArgs(args);
  const lines = listOverlapSessions(process.env).flatMap((s) => readOverlapLog(s, process.env));
  const s = overlapStats(lines);
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const pct = s.ok === 0 ? '-' : `${Math.round((s.agree / s.ok) * 100)}%`;
  console.log(`重なりの記録 ${s.total} 件：Jev の答えあり ok（一致 ${s.agree}、不一致 ${s.disagree}、一致率 ${pct}）、skipped ${s.skipped}、error ${s.error}`);
}

export const commands: AgentCommand[] = [
  {
    name: 'issue-overlap',
    run: async (args, ctx) => {
      const [sub, ...rest] = args;
      try {
        if (sub === 'check') return await check(rest, ctx);
        if (sub === 'stats') return stats(rest);
      } catch (e) {
        fail([(e as Error).message]);
      }
      fail(['issue-overlap のサブコマンドは check / stats']);
    },
  },
];
