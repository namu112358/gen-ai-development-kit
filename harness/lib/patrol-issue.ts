import { claudeMark, extractBlock, renderBlock } from './blocks.ts';
import { parsePatrolState, type PatrolRound, type PatrolState } from './patrol.ts';
import { parseLoopState, type LoopDraft, type LoopState } from './qa-retro-loop.ts';
import { parseTestPruneLoopState, type TestPruneLoopState } from './test-prune-loop.ts';

/**
 * patrol のまとめの Issue の本文に置く状態（patrol-state）の読み書き・縮め方・題名の照らし・回のコメント（純粋関数）。
 * patrol の Routine が、patrol・qa-retro-loop・test-prune-loop の3つの状態と下書きを1件のまとめの Issue（題は harness/lib/state.ts の patrolIssueTitle）の本文に置く。
 * コマンドは #704 で harness/scripts/agent/commands/patrol-issue.ts に足す（Epic #634）。
 *
 * 本文の書式：人が読む短い説明と、<details> の中の ```patrol-state（agent- で始まらない。gate.yml の if: に当たらない）：
 *   { "version": 1, "patrol": <PatrolState | null>, "qaRetro": <LoopState | null>, "testPrune": <TestPruneLoopState | null> }
 * 部分の状態の形は、それぞれ harness/lib/patrol.ts・qa-retro-loop.ts・test-prune-loop.ts の手元の状態のファイルと同じ。
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
