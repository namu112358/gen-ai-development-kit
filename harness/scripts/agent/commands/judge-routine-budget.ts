import type { GitHub, IssueComment } from '../../../lib/github.ts';
import { DAY_MS, countRoutineVerdicts, type JudgeRoutineBudget, judgeRoutineBudget, parseJudgeDailyLimit } from '../../../lib/judge-routine-budget.ts';
import { type AgentCommand, config, fail } from '../cli.ts';

/**
 * 判定の Routine の 1 日の上限（Issue #1098）。GitHub は REST の GET /issues/comments だけを読み、書き込まない。
 *
 *   node harness/scripts/agent.ts judge-routine-budget
 *                                                           直近 24 時間の Routine の判定の数を harness.config.json の routine.judgeDailyLimit と比べて
 *                                                           { ok, count, limit, truncated? } を JSON で出す。ok が偽なら上限に達している（手順が止まる）。ok の真偽に関わらず終了コード 0。
 *                                                           上限が無いときは GitHub を読まず { ok: true, count: 0, limit: null }（count は数えていない）。
 *                                                           コメントを読み切れなかった（2000 件以上）ときは ok: false と truncated: true。
 *                                                           routine.judgeDailyLimit が正の整数でないときは終了コード 2。
 */

/** コメントの一覧を読む上限のページ数（paginate は打ち切りを返さないので、件数が上限以上なら打ち切りとみなす） */
export const MAX_PAGES = 20;

export async function runJudgeRoutineBudget(gh: GitHub, routine: unknown, now: Date): Promise<JudgeRoutineBudget> {
  const parsed = parseJudgeDailyLimit(routine);
  if (!parsed.ok) fail([parsed.error]);
  if (parsed.limit === null) return { ok: true, count: 0, limit: null };
  const since = encodeURIComponent(new Date(now.getTime() - DAY_MS).toISOString());
  // since は更新時刻で絞られるので、作成時刻の絞り込みは countRoutineVerdicts で行う
  const comments = await gh.paginate<IssueComment>(`/issues/comments?since=${since}&sort=created&direction=desc`, MAX_PAGES);
  return judgeRoutineBudget({ count: countRoutineVerdicts(comments, now), limit: parsed.limit, truncated: comments.length >= MAX_PAGES * 100 });
}

export const commands: AgentCommand[] = [
  {
    name: 'judge-routine-budget',
    run: async (args, ctx) => {
      if (args.length !== 0) fail(['judge-routine-budget']);
      const routine = (config as { routine?: unknown }).routine;
      const parsed = parseJudgeDailyLimit(routine);
      if (!parsed.ok) fail([parsed.error]);
      // 上限が無いときは GitHub を使わない（gh・origin が無くても動く）
      const result = parsed.limit === null ? { ok: true, count: 0, limit: null } : await runJudgeRoutineBudget(ctx.gh(), routine, new Date());
      console.log(JSON.stringify(result, null, 2));
    },
  },
];
