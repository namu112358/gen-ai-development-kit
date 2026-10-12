import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBlock, hasClaudeMark } from '../../../lib/blocks.ts';
import type { GitHub, IssueComment } from '../../../lib/github.ts';
import { gitCommonDir, harnessStateDir, writeLocalJson } from '../../../lib/local-state.ts';
import { digestSessionJudgments, judgmentPostable, parseDigestArgs, parseDigestState, parseSessionJudgment, weeklyPeriod, planReviewRiskOnly, renderSessionJudgment, type PlanReviewRiskOnly, type SessionJudgment } from '../../../lib/session-judgment.ts';
import { isTrustedComment, latestPlanGate, type PlanGateRecord } from '../../../lib/state.ts';
import { type AgentCommand, config, currentSession, fail, readJson } from '../cli.ts';

/**
 * セッションの判定（Issue #340）：付き添いのセッションが、人に聞かずに決めたことを Issue か PR のコメントに残す。書式は harness/docs/formats.md。
 *
 *   node harness/scripts/agent.ts plan-review-check <issue>   読むだけ。agent:plan-review を聞かずに「進める」と決めてよいかを JSON で出す
 *                                                           （riskOnly：止めた理由が想定 Risk だけで files がガードレール・delegateMergeExclude・harness.config.json に触れない、など。
 *                                                           remaining：残る理由、touches：触れる files、notes：偽の理由）
 *   node harness/scripts/agent.ts render-judgment <target> <file>  セッションの判定（JSON のオブジェクト）を検査して、コメントの本文を出す（GitHub を読まない）
 *   node harness/scripts/agent.ts session-judgment-digest [--days <n>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>] [--sample <n>] [--weekly [--state <path>]]
 *                                                           読むだけ。期間（既定は直近 7 日）のセッションの判定を基準ごとに数え、抜き取りの一覧を JSON で出す（qa-retro の skill が週1回使う）。
 *                                                           --weekly は前回の終わりから 7 日たったときだけ集計し、まだなら GitHub を読まずに { due: false, nextAt } を出す
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

/** コメントの一覧を読む上限のページ数（paginate は打ち切りを返さないので、件数が上限以上なら打ち切りとみなす） */
const MAX_PAGES = 30;

export const commands: AgentCommand[] = [
  {
    name: 'session-judgment-digest',
    run: async (args, ctx) => {
      const parsed = parseDigestArgs(args, new Date());
      if (!parsed.ok) fail(parsed.errors);
      const { sample, weekly } = parsed.value;
      let { since, until } = parsed.value;
      let statePath: string | null = null;
      if (weekly) {
        const common = parsed.value.state === null ? gitCommonDir() : null;
        statePath = parsed.value.state ?? (common === null ? null : join(harnessStateDir(common), 'session-judgment-digest.json'));
        if (statePath === null) fail(['git の共通ディレクトリが取れません。--state <path> を渡してください']);
        let text: string | null = null;
        try {
          text = readFileSync(statePath, 'utf8');
        } catch (e) {
          if ((e as { code?: string }).code !== 'ENOENT') fail([`状態のファイルを読めません: ${statePath}`]);
        }
        const st = parseDigestState(text);
        if (!st.ok) fail(st.errors);
        const period = weeklyPeriod(st.state, new Date());
        if (!period.due) {
          console.log(JSON.stringify({ due: false, nextAt: period.nextAt }, null, 2));
          return;
        }
        ({ since, until } = period);
      }
      // since は更新時刻で絞られるので、作成時刻の絞り込みは digestSessionJudgments で行う
      const path = `/issues/comments?since=${encodeURIComponent(since.toISOString())}&sort=created&direction=asc`;
      const comments = await ctx.gh().paginate<IssueComment & { issue_url?: string }>(path, MAX_PAGES);
      const notes: string[] = [];
      if (comments.length >= MAX_PAGES * 100) notes.push(`打ち切り：コメントが ${MAX_PAGES * 100} 件以上あり、${MAX_PAGES} ページで読むのをやめました。後ろの期間が数えられていない可能性があります`);
      const digest = digestSessionJudgments(comments, { since, until }, { sample });
      if (statePath !== null) writeLocalJson(statePath, { version: 1, lastUntil: until.toISOString() });
      console.log(JSON.stringify({ ...(weekly ? { due: true } : {}), ...digest, notes }, null, 2));
    },
  },
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
