import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkIssueDrafts } from '../../../lib/arch-review.ts';
import { extractBlock } from '../../../lib/blocks.ts';
import { GitHub } from '../../../lib/github.ts';
import { parsePatrolState } from '../../../lib/patrol.ts';
import {
  compactPatrolIssueState,
  dedupeDrafts,
  newDraftsSince,
  parsePatrolIssueBody,
  patrolIssueBodyErrors,
  type PatrolIssueState,
  renderPatrolIssueBody,
  renderPatrolRoundComment,
} from '../../../lib/patrol-issue.ts';
import { parseLoopState, QA_RETRO_LOOP_MAX_DRAFTS } from '../../../lib/qa-retro-loop.ts';
import { splitArgs } from '../../../lib/session-inputs.ts';
import { patrolIssueTitle } from '../../../lib/state.ts';
import { parseTestPruneLoopState } from '../../../lib/test-prune-loop.ts';
import { type AgentCommand, type CommandContext, config, currentSession, fail } from '../cli.ts';

/**
 * patrol のまとめの Issue（題は patrolIssueTitle）に、状態と下書きを置く・読む・重複を除く。GitHub は REST だけで読み書きする（GraphQL・ラベル・下書きの Issue の作成は使わない）。
 *
 *   node harness/scripts/agent.ts patrol-pull --dir <dir>
 *                                                           まとめの Issue（無ければ作る）の本文の patrol-state を <dir>/patrol.json・qa-retro-loop.json・test-prune-loop.json に写す
 *                                                           （null の部分は書かず、既にあれば消す）。<dir>/pulled.json に { issue, bodySha256, rounds } を書き、標準出力に { issue, created, first, reason? }
 *   node harness/scripts/agent.ts patrol-push --dir <dir> [--arch-review <URL>] [--summary <ファイル>]
 *                                                           <dir> の3つの状態を縮めて本文に書き戻し（PATCH）、増えた回・下書き・要約があれば回のコメントを投稿する。
 *                                                           pull の後に本文が変わっていたら止まる。標準出力に { issue, comment }
 *   node harness/scripts/agent.ts patrol-dedupe <下書きの JSON> --out <パス> [--max <n>]
 *                                                           下書きを開いた Issue の題と照らし、同じ題のものを除いて先頭から n 件（既定 3）を --out に書く。標準出力に { kept, removed }
 */

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const FILES = { patrol: 'patrol.json', qaRetro: 'qa-retro-loop.json', testPrune: 'test-prune-loop.json' } as const;

interface IssueRow { number: number; title: string; body?: string | null; pull_request?: unknown }

/** 開いた Issue（PR を除く） */
async function openIssues(gh: GitHub): Promise<IssueRow[]> {
  return (await gh.paginate<IssueRow>('/issues?state=open')).filter((i) => !i.pull_request);
}

/** 題が一致する開いた Issue のうち番号の最小（作成者は問わない） */
async function findPatrolIssue(gh: GitHub, title: string): Promise<IssueRow | null> {
  const found = (await openIssues(gh)).filter((i) => i.title === title).sort((a, b) => a.number - b.number);
  return found[0] ?? null;
}

/** ブロックが読めてオブジェクトで、version が 1 でない数ならその数 */
function newerVersion(body: string): number | null {
  const block = extractBlock(body, 'patrol-state');
  if (!block.found || !block.ok) return null;
  const v = block.value as { version?: unknown } | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return typeof v.version === 'number' && v.version !== 1 ? v.version : null;
}

function checkTitle(): string {
  const title = patrolIssueTitle(config);
  if (title === config.dashboardIssueTitle) fail([`patrolIssueTitle がダッシュボード Issue の題（${title}）と同じです。別の題にしてください`]);
  return title;
}

function parseDirArgs(args: string[], valueOptions: string[], usage: string): Record<string, string> {
  const a = splitArgs(args, valueOptions);
  if (!a.ok) fail([...a.errors, usage]);
  const { positional, options } = a.value;
  const errors = [
    ...(positional.length > 0 ? [`余分な引数：${positional.join(' ')}`] : []),
    ...(options['--dir'] ? [] : ['--dir が必要です']),
  ];
  if (errors.length > 0) fail([...errors, usage]);
  return options;
}

async function patrolPull(args: string[], ctx: CommandContext): Promise<void> {
  const usage = 'patrol-pull --dir <dir>';
  const dir = parseDirArgs(args, ['--dir'], usage)['--dir']!;
  const title = checkTitle();
  const gh = ctx.gh();
  let issue = await findPatrolIssue(gh, title);
  let created = false;
  let body: string;
  if (!issue) {
    const initial = renderPatrolIssueBody(null);
    const res = await gh.request<{ number: number; body?: string | null }>('POST', '/issues', { body: { title, body: initial } });
    issue = { number: res.number, title };
    body = res.body ?? initial;
    created = true;
  } else body = issue.body ?? '';
  const newer = newerVersion(body);
  if (newer !== null) fail([`まとめの Issue の patrol-state の version が ${newer} です。この kit は 1 だけを読みます。kit を更新してください`]);
  const parsed = parsePatrolIssueBody(body);
  mkdirSync(dir, { recursive: true });
  const state = parsed.first ? null : parsed.state;
  for (const key of ['patrol', 'qaRetro', 'testPrune'] as const) {
    const file = join(dir, FILES[key]);
    const part = state?.[key] ?? null;
    if (part === null) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(part, null, 2) + '\n');
  }
  const rounds = { qaRetro: state?.qaRetro?.rounds.length ?? 0, testPrune: state?.testPrune?.rounds.length ?? 0 };
  writeFileSync(join(dir, 'pulled.json'), JSON.stringify({ issue: issue.number, bodySha256: sha256(body), rounds }, null, 2) + '\n');
  console.log(JSON.stringify({ issue: issue.number, created, first: parsed.first, ...(parsed.first ? { reason: parsed.reason } : {}) }));
}

interface Pulled { issue: number; bodySha256: string; rounds: { qaRetro: number; testPrune: number } }

function readPulled(dir: string): Pulled {
  const file = join(dir, 'pulled.json');
  if (!existsSync(file)) fail([`${file} がありません。patrol-pull を先に実行してください`]);
  let v: any;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return fail([`${file} の JSON が壊れています：${(e as Error).message}。patrol-pull からやり直してください`]);
  }
  const count = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0;
  if (!Number.isInteger(v?.issue) || v.issue <= 0 || typeof v.bodySha256 !== 'string' || !count(v.rounds?.qaRetro) || !count(v.rounds?.testPrune)) {
    fail([`${file} の形が正しくありません。patrol-pull からやり直してください`]);
  }
  return v as Pulled;
}

function readPart<T>(dir: string, key: keyof typeof FILES, parse: (text: string | null) => { ok: true; state: T | null } | { ok: false; errors: string[] }): T | null {
  const file = join(dir, FILES[key]);
  if (!existsSync(file)) return null;
  const r = parse(readFileSync(file, 'utf8'));
  if (!r.ok) fail([`${file} が読めません：${r.errors.join('、')}`]);
  return r.state;
}

async function patrolPush(args: string[], ctx: CommandContext): Promise<void> {
  const usage = 'patrol-push --dir <dir> [--arch-review <URL>] [--summary <ファイル>]';
  const options = parseDirArgs(args, ['--dir', '--arch-review', '--summary'], usage);
  const dir = options['--dir']!;
  checkTitle();
  const pulled = readPulled(dir);
  let summary: string | null = null;
  if (options['--summary'] !== undefined) {
    try {
      summary = readFileSync(options['--summary'], 'utf8').trim() || null;
    } catch (e) {
      fail([`--summary のファイルが読めません：${(e as Error).message}`, usage]);
    }
  }
  const gh = ctx.gh();
  const current = await gh.get<{ body?: string | null }>(`/issues/${pulled.issue}`);
  const currentBody = current.body ?? '';
  if (sha256(currentBody) !== pulled.bodySha256) fail(['pull の後にまとめの Issue の本文が変わりました。patrol-pull からやり直してください']);

  const state: PatrolIssueState = {
    version: 1,
    patrol: readPart(dir, 'patrol', parsePatrolState),
    qaRetro: readPart(dir, 'qaRetro', parseLoopState),
    testPrune: readPart(dir, 'testPrune', parseTestPruneLoopState),
  };
  const drafts = newDraftsSince(state, pulled.rounds);
  const body = renderPatrolIssueBody(compactPatrolIssueState(state));
  const tooLong = patrolIssueBodyErrors(body);
  if (tooLong.length > 0) fail(tooLong);

  const before = parsePatrolIssueBody(currentBody);
  const beforeLast = before.first ? undefined : before.state.patrol?.rounds.at(-1)?.at;
  const nowRounds = state.patrol?.rounds ?? [];
  const lastRound = nowRounds.at(-1) ?? null;
  const newPatrolRound = lastRound !== null && lastRound.at !== beforeLast;
  const newLoopRounds = (state.qaRetro?.rounds.length ?? 0) > pulled.rounds.qaRetro || (state.testPrune?.rounds.length ?? 0) > pulled.rounds.testPrune;
  const unreadable = before.first && extractBlock(currentBody, 'patrol-state').found ? before.reason : null;
  if (unreadable !== null) {
    const note = `前の本文の patrol-state は読めなかったので（${unreadable}）、初回として書き直しました。前の本文は Issue の編集履歴に残ります`;
    summary = summary ? `${note}\n\n${summary}` : note;
  }

  await gh.request('PATCH', `/issues/${pulled.issue}`, { body: { body } });

  let comment: string | null = null;
  if (newPatrolRound || newLoopRounds || drafts.length > 0 || summary !== null || options['--arch-review'] !== undefined) {
    const text = renderPatrolRoundComment({
      session: currentSession(),
      patrolRound: newPatrolRound ? lastRound : null,
      drafts,
      summary,
      archReviewUrl: options['--arch-review'] ?? null,
    });
    comment = (await gh.comment(pulled.issue, text)).html_url;
  }
  console.log(JSON.stringify({ issue: pulled.issue, comment }));
}

async function patrolDedupe(args: string[], ctx: CommandContext): Promise<void> {
  const usage = 'patrol-dedupe <下書きの JSON> --out <パス> [--max <n>]';
  const a = splitArgs(args, ['--out', '--max']);
  if (!a.ok) fail([...a.errors, usage]);
  const { positional, options } = a.value;
  const max = options['--max'] === undefined ? QA_RETRO_LOOP_MAX_DRAFTS : /^\d+$/.test(options['--max']) ? Number(options['--max']) : null;
  const errors = [
    ...(positional.length !== 1 ? ['下書きの JSON のファイルを1つ渡してください'] : []),
    ...(options['--out'] ? [] : ['--out が必要です']),
    ...(max === null ? ['--max は0以上の整数'] : []),
  ];
  if (errors.length > 0 || max === null) fail([...errors, usage]);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(positional[0]!, 'utf8'));
  } catch (e) {
    fail([`下書きの JSON が読めません：${(e as Error).message}`, usage]);
  }
  const checked = checkIssueDrafts(value);
  if (!checked.ok) fail(checked.errors);
  const { kept, removed } = dedupeDrafts(value as { title: string }[], await openIssues(ctx.gh()), max);
  writeFileSync(options['--out']!, JSON.stringify(kept, null, 2) + '\n');
  console.log(JSON.stringify({ kept: kept.length, removed }));
}

export const commands: AgentCommand[] = [
  { name: 'patrol-pull', run: (args, ctx) => patrolPull(args, ctx) },
  { name: 'patrol-push', run: (args, ctx) => patrolPush(args, ctx) },
  { name: 'patrol-dedupe', run: (args, ctx) => patrolDedupe(args, ctx) },
];
