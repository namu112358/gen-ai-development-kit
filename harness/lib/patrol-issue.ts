import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeMark, extractBlock, renderBlock } from './blocks.ts';
import type { HarnessConfig } from './config.ts';
import type { GitHub } from './github.ts';
import { writeLocalJson } from './local-state.ts';
import { parsePatrolState, type PatrolRound, type PatrolState } from './patrol.ts';
import { parseLoopState, type LoopDraft, type LoopState } from './qa-retro-loop.ts';
import { patrolIssueTitle } from './state.ts';
import { parseTestPruneLoopState, type TestPruneLoopState } from './test-prune-loop.ts';

/**
 * patrol のまとめの Issue の本文の状態（patrol-state）と、pull したディレクトリ（<dir>）の読み書き・縮め方・題名の照らし・回のコメント。
 * patrol・qa-retro-loop・test-prune-loop の3つの状態と下書きは、/loop からも Routine からも1件のまとめの Issue（題は harness/lib/state.ts の patrolIssueTitle）の本文に置く。
 * patrol-pull（harness/scripts/agent/commands/patrol-issue.ts）が本文を <dir> に写し、3つのスクリプトが --dir で <dir> を読み書きし、patrol-push が本文に書き戻す。
 * 上書きの防ぎは patrol-push の本文の比べ（patrolBodyChanged）。--dir なしの読むだけのサブコマンドは readPatrolIssueState で本文を REST で読む（書かない・作らない）。
 *
 * 本文の書式：人が読む短い説明と、<details> の中の ```patrol-state（agent- で始まらない。gate.yml の if: に当たらない）：
 *   { "version": 1, "patrol": <PatrolState | null>, "qaRetro": <LoopState | null>, "testPrune": <TestPruneLoopState | null> }
 * 部分の状態の形は、それぞれ harness/lib/patrol.ts・qa-retro-loop.ts・test-prune-loop.ts の loop の状態（<dir> の各ファイル）と同じ。
 */

/** 本文の上限（GitHub の Issue の本文の上限） */
export const PATROL_ISSUE_BODY_MAX = 65536;
/** 本文に残す patrol の回の数（手元の状態の PATROL_MAX_ROUNDS より少なくする） */
export const PATROL_ISSUE_ROUNDS = 10;

export interface PatrolIssueState {
  version: 1;
  patrol: PatrolState | null;
  qaRetro: LoopState | null;
  testPrune: TestPruneLoopState | null;
}

/** 読めれば first: false と状態。読めなければ初回として扱い、理由を返す */
export type PatrolIssueParse = { first: false; state: PatrolIssueState } | { first: true; reason: string };

export interface PatrolNewDraft { source: 'qa-retro' | 'test-prune'; title: string; body: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const PARTS = [
  { key: 'patrol', name: 'patrol', parse: parsePatrolState },
  { key: 'qaRetro', name: 'qa-retro', parse: parseLoopState },
  { key: 'testPrune', name: 'test-prune', parse: parseTestPruneLoopState },
] as const;

/** まとめの Issue の本文を読む。ブロックが無い・JSON が壊れている・version が違う・部分の状態が読めないなら初回（first: true）と理由 */
export function parsePatrolIssueBody(body: string | null | undefined): PatrolIssueParse {
  if (!body) return { first: true, reason: '本文がありません' };
  const block = extractBlock(body, 'patrol-state');
  if (!block.found) return { first: true, reason: 'patrol-state ブロックがありません' };
  if (!block.ok) return { first: true, reason: block.error };
  const v = block.value;
  if (!isObject(v)) return { first: true, reason: 'patrol-state はオブジェクトではありません' };
  if (v.version !== 1) return { first: true, reason: `patrol-state の version が 1 ではありません：${JSON.stringify(v.version)}` };
  for (const { key, name, parse } of PARTS) {
    if (v[key] === undefined) return { first: true, reason: `${key} がありません` };
    if (v[key] === null) continue;
    const r = parse(JSON.stringify(v[key]));
    if (!r.ok) return { first: true, reason: `${name} の状態が読めません：${r.errors.join('、')}` };
  }
  return { first: false, state: { version: 1, patrol: v.patrol, qaRetro: v.qaRetro, testPrune: v.testPrune } as PatrolIssueState };
}

/** まとめの Issue の本文（説明と <details> の中の ```patrol-state）。縮めない（縮めるのは呼び出し側）。null なら3つとも null の状態 */
export function renderPatrolIssueBody(state: PatrolIssueState | null): string {
  const value: PatrolIssueState = state ?? { version: 1, patrol: null, qaRetro: null, testPrune: null };
  return [
    'patrol の Routine が、見直し（arch-review・qa-retro・test-prune）の状態と下書きを置くまとめの Issue です。',
    '本文は patrol-push が書き換えるので、手で直さないでください。回ごとの結果はコメントに残ります。',
    '下書きは「patrol の下書きを選ぶ」と頼むと選べます（arch-review の下書きはダッシュボード Issue の記録から選びます）。',
    '',
    '<details><summary>状態（機械可読）</summary>',
    '',
    renderBlock('patrol-state', value),
    '',
    '</details>',
  ].join('\n');
}

/** 本文の長さの誤り（上限を超える）。誤りが無ければ空 */
export function patrolIssueBodyErrors(body: string): string[] {
  return body.length > PATROL_ISSUE_BODY_MAX
    ? [`まとめの Issue の本文が ${body.length} 文字で、上限（${PATROL_ISSUE_BODY_MAX} 文字）を超えます`]
    : [];
}

const compactDrafts = (drafts: LoopDraft[]): LoopDraft[] => drafts.map((d) => (d.created !== null ? { ...d, body: '' } : d));

/** 本文に置く前に縮めた状態（元の状態は変えない）。採用済みの下書きの body を空にし、patrol の rounds を直近 PATROL_ISSUE_ROUNDS 件にする。回は落とさない */
export function compactPatrolIssueState(state: PatrolIssueState): PatrolIssueState {
  return {
    version: 1,
    patrol: state.patrol && { ...state.patrol, rounds: state.patrol.rounds.slice(-PATROL_ISSUE_ROUNDS) },
    qaRetro: state.qaRetro && { ...state.qaRetro, rounds: state.qaRetro.rounds.map((r) => ({ ...r, drafts: compactDrafts(r.drafts) })) },
    testPrune: state.testPrune && { ...state.testPrune, rounds: state.testPrune.rounds.map((r) => ({ ...r, drafts: compactDrafts(r.drafts) })) },
  };
}

/** 題名を照らすための形（前後の空白を除き、連続する空白を1つにし、小文字にする） */
export function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 開いた Issue と同じ題名の下書きを除き（removed に Issue 番号つき。同じ題名が複数なら番号の小さいもの）、残りの先頭から max 件を kept にする。
 * max で切った分は removed に入れない
 */
export function dedupeDrafts<D extends { title: string }>(drafts: D[], openIssues: { number: number; title: string }[], max: number): {
  kept: D[];
  removed: { title: string; issue: number }[];
} {
  const issues = new Map<string, number>();
  for (const i of openIssues) {
    const key = normalizeTitle(i.title);
    const seen = issues.get(key);
    if (seen === undefined || i.number < seen) issues.set(key, i.number);
  }
  const kept: D[] = [];
  const removed: { title: string; issue: number }[] = [];
  for (const d of drafts) {
    const issue = issues.get(normalizeTitle(d.title));
    if (issue !== undefined) removed.push({ title: d.title, issue });
    else kept.push(d);
  }
  return { kept: kept.slice(0, Math.max(0, max)), removed };
}

/** pull 時の回の数より後の回の下書き（qa-retro → test-prune の順）。状態が null なら回は無い */
export function newDraftsSince(state: PatrolIssueState, rounds: { qaRetro: number; testPrune: number }): PatrolNewDraft[] {
  const pick = (source: PatrolNewDraft['source'], all: { drafts: LoopDraft[] }[] | undefined, since: number): PatrolNewDraft[] =>
    (all ?? []).slice(since).flatMap((r) => r.drafts.map((d) => ({ source, title: d.title, body: d.body })));
  return [...pick('qa-retro', state.qaRetro?.rounds, rounds.qaRetro), ...pick('test-prune', state.testPrune?.rounds, rounds.testPrune)];
}

/** 回のコメントの本文（目印、patrol の最後の回、増えた下書き、要約、arch-review の記録の URL） */
export function renderPatrolRoundComment(opts: {
  session: string | null;
  patrolRound: PatrolRound | null;
  drafts: PatrolNewDraft[];
  summary: string | null;
  archReviewUrl: string | null;
}): string {
  const list = (names: string[]): string => (names.length > 0 ? names.join('、') : 'なし');
  const lines = [claudeMark(opts.session), 'patrol の回の結果です。', ''];
  if (opts.patrolRound) lines.push(`- 回した見直し：${list(opts.patrolRound.ran)}`, `- 勧めた見直し：${list(opts.patrolRound.suggested)}`);
  else lines.push('patrol の回はありません。');
  lines.push('', '新しい下書き：');
  if (opts.drafts.length === 0) lines.push('- 新しい下書きはありません');
  else for (const d of opts.drafts) lines.push('', `<details><summary>${d.source}：${d.title}</summary>`, '', d.body, '', '</details>');
  if (opts.summary) lines.push('', opts.summary);
  if (opts.archReviewUrl) lines.push('', `arch-review の記録：${opts.archReviewUrl}（arch-review の下書きはダッシュボードの記録から選びます）`);
  return lines.join('\n');
}

export type LoopResult<T> = ({ ok: true } & T) | { ok: false; errors: string[] };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 誤りを出して終わる（終了コード 1） */
export function exitWithErrors(errors: string[]): never {
  console.error(['誤り:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(1);
}

/** ファイルの本文。無ければ null、ほかの理由で読めなければ Error を投げる */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path} を読めません: ${message(e)}`, { cause: e });
  }
}

/** JSON のファイルを読む。what は誤りの文に入れる名前 */
export function readJsonFile(path: string, what: string): LoopResult<{ value: unknown }> {
  let text: string | null;
  try {
    text = readText(path);
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }
  if (text === null) return { ok: false, errors: [`${what}のファイルがありません: ${path}`] };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, errors: [`${what}のファイルが JSON として読めません: ${message(e)}`] };
  }
}

/** まとめの Issue の題（ダッシュボード Issue の題と同じなら誤り） */
export function patrolIssueTitleChecked(config: HarnessConfig): LoopResult<{ title: string }> {
  const title = patrolIssueTitle(config);
  if (title === config.dashboardIssueTitle) return { ok: false, errors: [`patrolIssueTitle がダッシュボード Issue の題（${title}）と同じです。別の題にしてください`] };
  return { ok: true, title };
}

/** pull したディレクトリの中の、部分の状態のファイル名（patrol-pull・patrol-push・3つのスクリプトで同じ） */
export const PATROL_DIR_FILES = { patrol: 'patrol.json', qaRetro: 'qa-retro-loop.json', testPrune: 'test-prune-loop.json' } as const;
export type PatrolDirKey = keyof typeof PATROL_DIR_FILES;

interface IssueRow { number: number; title: string; body?: string | null; pull_request?: unknown }

/** 開いた Issue（PR を除く） */
export async function openIssues(gh: GitHub): Promise<IssueRow[]> {
  return (await gh.paginate<IssueRow>('/issues?state=open')).filter((i) => !i.pull_request);
}

/** 題が一致する開いた Issue のうち番号の最小（作成者は問わない） */
export async function findPatrolIssue(gh: GitHub, title: string): Promise<{ number: number; title: string; body?: string | null } | null> {
  const found = (await openIssues(gh)).filter((i) => i.title === title).sort((a, b) => a.number - b.number);
  return found[0] ?? null;
}

/** ブロックが読めてオブジェクトで、version が 1 でない数ならその数 */
export function newerPatrolStateVersion(body: string): number | null {
  const block = extractBlock(body, 'patrol-state');
  if (!block.found || !block.ok) return null;
  const v = block.value as { version?: unknown } | null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return typeof v.version === 'number' && v.version !== 1 ? v.version : null;
}

/** version が新しいときの誤りの文 */
export const patrolNewerVersionError = (v: number): string => `まとめの Issue の patrol-state の version が ${v} です。この kit は 1 だけを読みます。kit を更新してください`;
/**
 * まとめの Issue を探して本文の状態を読む（--dir なしの読むだけのサブコマンド用。書かない・Issue を作らない）。
 * Issue が無い・本文が初回扱いなら state: null。version が 1 より新しければ ok: false
 */
export async function readPatrolIssueState(
  gh: GitHub,
  title: string,
): Promise<{ ok: true; issue: number | null; state: PatrolIssueState | null } | { ok: false; errors: string[] }> {
  const issue = await findPatrolIssue(gh, title);
  if (!issue) return { ok: true, issue: null, state: null };
  const body = issue.body ?? '';
  const newer = newerPatrolStateVersion(body);
  if (newer !== null) return { ok: false, errors: [patrolNewerVersionError(newer)] };
  const parsed = parsePatrolIssueBody(body);
  return { ok: true, issue: issue.number, state: parsed.first ? null : parsed.state };
}

/** <dir> の部分の状態を読む。ファイルが無ければ null。読めない・形が違えば ok: false */
export function readDirPart<T>(
  dir: string,
  key: PatrolDirKey,
  parse: (text: string | null) => { ok: true; state: T | null } | { ok: false; errors: string[] },
): { ok: true; state: T | null } | { ok: false; errors: string[] } {
  const file = join(dir, PATROL_DIR_FILES[key]);
  let text: string | null;
  try {
    text = readText(file);
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }
  if (text === null) return { ok: true, state: null };
  const r = parse(text);
  if (!r.ok) return { ok: false, errors: [`${file} が読めません：${r.errors.join('、')}`] };
  return { ok: true, state: r.state };
}

/** <dir> の部分の状態を書く（2字下げの JSON と末尾の改行。local-state.ts の writeLocalJson） */
export function writeDirPart(dir: string, key: PatrolDirKey, state: unknown): void {
  writeLocalJson(join(dir, PATROL_DIR_FILES[key]), state);
}

/** 本文の sha256（pull したときの本文を控える） */
export const patrolBodySha256 = (body: string): string => createHash('sha256').update(body).digest('hex');

/** pull したときから本文が変わったか（patrol-push が書かずに止まる条件。上書きの防ぎ） */
export function patrolBodyChanged(currentBody: string, pulledSha256: string): boolean {
  return patrolBodySha256(currentBody) !== pulledSha256;
}
