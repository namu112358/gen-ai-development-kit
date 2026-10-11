import { extractBlock, hasClaudeMark } from '../../../lib/blocks.ts';
import type { GitHub } from '../../../lib/github.ts';
import { judgmentPostable, parseSessionJudgment, planReviewRiskOnly, renderSessionJudgment, type PlanReviewRiskOnly, type SessionJudgment } from '../../../lib/session-judgment.ts';
import { isTrustedComment, latestPlanGate, type PlanGateRecord } from '../../../lib/state.ts';
import { type AgentCommand, config, currentSession, fail, readJson } from '../cli.ts';

/**
 * セッションの判定（Issue #340）：付き添いのセッションが、人に聞かずに決めたことを Issue か PR のコメントに残す。書式は docs/formats.md。
 *
 *   node harness/scripts/agent.ts plan-review-check <issue>   読むだけ。agent:plan-review を聞かずに「進める」と決めてよいかを JSON で出す
 *                                                           （riskOnly：止めた理由が想定 Risk だけで files がガードレール・delegateMergeExclude・harness.config.json に触れない、など。
 *                                                           remaining：残る理由、touches：触れる files、notes：偽の理由）
 *   node harness/scripts/agent.ts render-judgment <target> <file>  セッションの判定（JSON のオブジェクト）を検査して、コメントの本文を出す（GitHub を読まない）
 *   node harness/scripts/agent.ts post-judgment <target> <file>    同じ検査の後にコメントを投稿し、URL を出す（ラベルは変えない）。
 *                                                           basis が risk-only なら、投稿の前に plan-review-check と同じ検査をかけ、riskOnly が偽なら投稿せずに止める
 */

/** 判定を読んで、target が合うことを確かめる。誤りは fail（終了コード 2） */
function readJudgment(target: string | undefined, file: string | undefined, usage: string): { n: number; judgment: SessionJudgment } {
  if (!target || !file || !/^\d+$/.test(target)) fail([usage]);
  const n = Number(target);
  const parsed = parseSessionJudgment(readJson(file));
  if (!parsed.ok) fail(parsed.errors);
  if (parsed.value.target !== n) fail([`judgment.target（${parsed.value.target}）が #${n} と一致しません`]);
  return { n, judgment: parsed.value };
}

async function planReviewCheck(gh: GitHub, n: number): Promise<PlanReviewRiskOnly> {
  const issue = await gh.get<{ labels: { name: string }[] }>(`/issues/${n}`);
  const comments = await gh.listComments(n);
  const latestPlan = [...comments].reverse().find((c) => isTrustedComment(c) && hasClaudeMark(c.body) && extractBlock(c.body, 'agent-plan').found) ?? null;
  const gate = latestPlanGate(config, comments) as { value: PlanGateRecord & { plan?: unknown } } | null;
  return planReviewRiskOnly(gate?.value ?? null, config, { issue: n, labels: issue.labels.map((l) => l.name), latestPlanCommentId: latestPlan?.id ?? null });
}

export const commands: AgentCommand[] = [
  {
    name: 'plan-review-check',
    run: async (args, ctx) => {
      const usage = 'plan-review-check <issue>';
      if (args.length !== 1 || !/^\d+$/.test(args[0]!)) fail([usage]);
      console.log(JSON.stringify(await planReviewCheck(ctx.gh(), Number(args[0])), null, 2));
    },
  },
  {
    name: 'render-judgment',
    run: async (args) => {
      const { judgment } = readJudgment(args[0], args[1], 'render-judgment <target> <file>');
      console.log(renderSessionJudgment(judgment, currentSession()));
    },
  },
  {
    name: 'post-judgment',
    run: async (args, ctx) => {
      const { n, judgment } = readJudgment(args[0], args[1], 'post-judgment <target> <file>');
      const check = judgment.basis === 'risk-only' ? await planReviewCheck(ctx.gh(), n) : null;
      const postable = judgmentPostable(judgment, check);
      if (!postable.ok) fail(postable.reasons);
      const posted = await ctx.gh().comment(n, renderSessionJudgment(judgment, currentSession()));
      console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
    },
  },
];
