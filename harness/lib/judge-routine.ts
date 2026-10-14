/**
 * 判定の Routine の1回分（`/judge --routine`。Issue #786）の入力の検査。純粋関数だけで、GitHub も git も呼ばない。
 *
 * - parseJudgeRoutineInput：起動時のテキスト（コードブロックに入った JSON でもよい）を { pr, head, base, dryRun } に読む。
 * - checkJudgeRoutineInput：PR の今の状態と照らして judge か skip かを決める。open でない・base が違う・
 *   head が違い PR 自身の差分（patch-id）も違う、は skip（理由つき）。head が違っても patch-id が同じなら今の head を判定する。
 */

import { type ClaimAge, claimStale } from './fleet.ts';
import type { Claim } from './queue.ts';

export type JudgeRoutineInput = { pr: number; head: string; base: string; dryRun: boolean };

export type JudgeRoutineDecision =
  | { action: 'judge'; pr: number; head: string; inputHead: string; dryRun: boolean }
  | { action: 'skip'; reason: string };

export type JudgeRoutinePr = { state: string; merged?: boolean; headSha: string; baseRef: string; draft: boolean };

const KEYS = new Set(['pr', 'head', 'base', 'dryRun']);

/** 最初の `{` から最後の `}` までを JSON として読み、形を確かめる */
export function parseJudgeRoutineInput(text: string): { ok: true; value: JudgeRoutineInput } | { ok: false; reason: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, reason: '入力に JSON の { } が見つかりません' };
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { ok: false, reason: `入力の JSON を読めません: ${(e as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, reason: '入力はオブジェクトの JSON でなければなりません' };
  const o = data as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.has(k));
  if (extra.length > 0) return { ok: false, reason: `知らないキーがあります: ${extra.join(', ')}` };
  if (typeof o.pr !== 'number' || !Number.isInteger(o.pr) || o.pr <= 0) return { ok: false, reason: 'pr は正の整数でなければなりません' };
  if (typeof o.head !== 'string' || !/^[0-9a-f]{40}$/.test(o.head)) return { ok: false, reason: 'head は40桁の16進（小文字）でなければなりません' };
  if (typeof o.base !== 'string' || o.base.trim() === '') return { ok: false, reason: 'base は空でない文字列でなければなりません' };
  if (o.dryRun !== undefined && typeof o.dryRun !== 'boolean') return { ok: false, reason: 'dryRun は真偽値でなければなりません' };
  return { ok: true, value: { pr: o.pr, head: o.head, base: o.base, dryRun: o.dryRun === true } };
}

/** PR の今の状態と入力から judge か skip かを決める。samePatch は head が違うときだけ、入力の head で呼ぶ */
export function checkJudgeRoutineInput(input: JudgeRoutineInput, pr: JudgeRoutinePr, samePatch: (judgedHead: string) => boolean): JudgeRoutineDecision {
  if (pr.state !== 'open' || pr.merged === true) {
    return { action: 'skip', reason: `PR #${input.pr} は open ではありません（${pr.merged === true ? 'merged' : pr.state}）` };
  }
  if (!pr.draft) return { action: 'skip', reason: `not-draft: PR #${input.pr} は Draft ではありません` };
  if (input.base !== pr.baseRef) {
    return { action: 'skip', reason: `入力の base（${input.base}）が PR の base（${pr.baseRef}）と違います` };
  }
  if (input.head === pr.headSha) return { action: 'judge', pr: input.pr, head: pr.headSha, inputHead: input.head, dryRun: input.dryRun };
  if (samePatch(input.head)) return { action: 'judge', pr: input.pr, head: pr.headSha, inputHead: input.head, dryRun: input.dryRun };
  return { action: 'skip', reason: `入力の head（${input.head}）が今の head（${pr.headSha}）と違い、PR 自身の差分（patch-id）も違います` };
}

/** 最新の判定の head が今の head と同じか、PR 自身の差分（patch-id）が同じなら skip（already-judged）。判定が無ければ null。samePatch は head が違うときだけ呼ぶ */
export function judgedSkip(headSha: string, latestVerdictHead: string | null, samePatch: (judged: string) => boolean): JudgeRoutineDecision | null {
  if (latestVerdictHead === null) return null;
  if (latestVerdictHead !== headSha && !samePatch(latestVerdictHead)) return null;
  return { action: 'skip', reason: `already-judged: 最新の判定（${latestVerdictHead.slice(0, 7)}）と PR 自身の差分が同じです` };
}

/** checkout の HEAD が既定ブランチの祖先でない、または判定する PR の head と同じなら skip（head-checkout）。どちらでもなければ null */
export function checkoutDecision(c: { headIsAncestorOfDefault: boolean; checkoutHead: string; prHead: string }): JudgeRoutineDecision | null {
  if (!c.headIsAncestorOfDefault) {
    return { action: 'skip', reason: `head-checkout: checkout の HEAD（${c.checkoutHead.slice(0, 7)}）が既定ブランチの祖先ではありません` };
  }
  if (c.checkoutHead === c.prHead) {
    return { action: 'skip', reason: `head-checkout: checkout の HEAD が判定する PR の head（${c.prHead.slice(0, 7)}）と同じです` };
  }
  return null;
}

/** 入力が無いときの引き当ての候補（コマンドが一覧とコメントから作る） */
export type RoutineCandidate = {
  number: number;
  headSha: string;
  headRef: string;
  draft: boolean;
  updatedAt: string;
  claim: Claim | null;
  latestVerdictHead: string | null;
  samePatchAsVerdict: boolean;
};

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * 判定する PR を1つ選ぶ。Draft で head のブランチが `claude/` で始まり、判定が無いか patch-id が違い、有効な judge の宣言
 * （claim の stage が judge で、解除されておらず、期限（claimStale）も過ぎていない）が無いものを、updatedAt の古い順（同じなら番号の小さい順）に並べた先頭。無ければ null
 */
export function selectRoutineCandidate(prs: RoutineCandidate[], age: ClaimAge): RoutineCandidate | null {
  const eligible = prs.filter((p) => {
    if (!p.draft || !p.headRef.startsWith('claude/')) return false;
    if (p.latestVerdictHead !== null && p.samePatchAsVerdict) return false;
    const c = p.claim;
    return !(c !== null && c.stage === 'judge' && c.released !== true && !claimStale(c, age));
  });
  eligible.sort((a, b) => timeOf(a.updatedAt) - timeOf(b.updatedAt) || a.number - b.number);
  return eligible[0] ?? null;
}
