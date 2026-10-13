/**
 * 判定の Routine の1回分（`/judge --routine`。Issue #786）の入力の検査。純粋関数だけで、GitHub も git も呼ばない。
 *
 * - parseJudgeRoutineInput：起動時のテキスト（コードブロックに入った JSON でもよい）を { pr, head, base, dryRun } に読む。
 * - checkJudgeRoutineInput：PR の今の状態と照らして judge か skip かを決める。open でない・base が違う・
 *   head が違い PR 自身の差分（patch-id）も違う、は skip（理由つき）。head が違っても patch-id が同じなら今の head を判定する。
 */

export type JudgeRoutineInput = { pr: number; head: string; base: string; dryRun: boolean };

export type JudgeRoutineDecision =
  | { action: 'judge'; pr: number; head: string; inputHead: string; dryRun: boolean }
  | { action: 'skip'; reason: string };

export type JudgeRoutinePr = { state: string; merged?: boolean; headSha: string; baseRef: string };

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
  if (input.base !== pr.baseRef) {
    return { action: 'skip', reason: `入力の base（${input.base}）が PR の base（${pr.baseRef}）と違います` };
  }
  if (input.head === pr.headSha) return { action: 'judge', pr: input.pr, head: pr.headSha, inputHead: input.head, dryRun: input.dryRun };
  if (samePatch(input.head)) return { action: 'judge', pr: input.pr, head: pr.headSha, inputHead: input.head, dryRun: input.dryRun };
  return { action: 'skip', reason: `入力の head（${input.head}）が今の head（${pr.headSha}）と違い、PR 自身の差分（patch-id）も違います` };
}
