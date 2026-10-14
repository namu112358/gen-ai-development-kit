import { extractBlock, hasClaudeMark } from './blocks.ts';
import type { IssueComment } from './github.ts';
import { isTrustedComment } from './state.ts';

/**
 * 判定の Routine の 1 日の上限（Issue #1098）。
 * 直近 24 時間に Routine が出した判定（信頼できる Claude の `agent-verdict` で、`metrics.judgedBy` が `routine` で始まるもの）を作成時刻で数え、
 * `routine.judgeDailyLimit` と比べる。GitHub も設定のファイルも読まない純粋関数。
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface JudgeRoutineBudget {
  ok: boolean;
  count: number;
  limit: number | null;
  truncated?: true;
}

/** now の 24 時間前以降に作られた、Routine の判定のコメントの数（更新時刻ではなく作成時刻で見る） */
export function countRoutineVerdicts(comments: Pick<IssueComment, 'body' | 'author_association' | 'created_at'>[], now: Date): number {
  return comments.filter((c) => {
    if (!isTrustedComment(c) || !hasClaudeMark(c.body)) return false;
    const at = Date.parse(c.created_at);
    if (!Number.isFinite(at) || at > now.getTime() || now.getTime() - at > DAY_MS) return false;
    const b = extractBlock(c.body, 'agent-verdict');
    if (!b.found || !b.ok) return false;
    const judgedBy = (b.value as { metrics?: { judgedBy?: unknown } } | null)?.metrics?.judgedBy;
    return typeof judgedBy === 'string' && judgedBy.startsWith('routine');
  }).length;
}

/** 上限と比べる。limit が null なら上限なし。読み切れていない（truncated）ときは数えきれていないので ok: false */
export function judgeRoutineBudget(input: { count: number; limit: number | null; truncated: boolean }): JudgeRoutineBudget {
  const { count, limit, truncated } = input;
  if (truncated) return { ok: false, count, limit, truncated: true };
  return { ok: limit === null || count < limit, count, limit };
}

/** `config.routine.judgeDailyLimit` を読む。無ければ上限なし（null）、正の整数ならその値、それ以外は誤り */
export function parseJudgeDailyLimit(routine: unknown): { ok: true; limit: number | null } | { ok: false; error: string } {
  if (typeof routine !== 'object' || routine === null) return { ok: true, limit: null };
  const value = (routine as { judgeDailyLimit?: unknown }).judgeDailyLimit;
  if (value === undefined) return { ok: true, limit: null };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return { ok: true, limit: value };
  return { ok: false, error: `routine.judgeDailyLimit は正の整数（今の値: ${JSON.stringify(value)}）` };
}
