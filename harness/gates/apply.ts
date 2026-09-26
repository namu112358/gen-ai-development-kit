import { appLogin, CHECKS, LABELS } from '../lib/config.ts';
import { evaluateMergeRoute, type Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, autoMergeMode, hasLabel, isAgentPr, prDiff, type PullRequest, type Review } from '../lib/state.ts';
import { appComment, enableAutoMerge, markReady, writeCheck, type GateContext } from './context.ts';

/**
 * 受け付けた判定を PR に反映する。順序が安全性の要：
 * 1. Ready 化と auto-merge の設定
 * 2. merge-route（auto-merge の有無を見て書く）
 * 3. agent/risk（常に success、結果はサマリー）
 * 4. agent/review（必須チェック。これが書かれるまで Merge されない）
 */
export async function applyAcceptance(ctx: GateContext, pr: PullRequest, acceptance: Acceptance, opts: { fresh: boolean }): Promise<void> {
  const hold = hasLabel(pr, LABELS.hold);
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  if (acceptance.reviewPass) {
    await dismissFixRequests(ctx, pr.number);
    await markReady(ctx, pr);
    if (acceptance.autoEligible && mode && !hold) {
      await enableAutoMerge(ctx, pr);
    } else if (opts.fresh) {
      const why = [...acceptance.reasons, ...(hold ? ['`agent:hold` が付いています'] : []), ...(!mode ? ['自動 Merge モードが無効です'] : [])];
      await appComment(ctx, pr.number, 'human-review', [`@${ctx.gh.owner} レビューをお願いします（Human Merge）。`, '', ...why.map((r) => `- ${r}`)].join('\n'));
    }
  }
  await writeMergeRoute(ctx, pr, acceptance, mode);
  await writeCheck(ctx, pr.head.sha, CHECKS.risk, {
    conclusion: 'success',
    title: `Risk: ${acceptance.riskLevel}${acceptance.riskOk ? '' : '（自動 Merge 不可）'}`,
    summary: [
      `Claude の判定: ${acceptance.riskLevel}`,
      `Jev: ${acceptance.jev?.status ?? '-'} ${acceptance.jev?.detail ?? ''}`,
      '',
      '```json',
      JSON.stringify(acceptance.jev?.answers ?? {}, null, 2),
      '```',
    ].join('\n'),
  });
  await writeCheck(ctx, pr.head.sha, CHECKS.review, acceptance.reviewPass
    ? { conclusion: 'success', title: 'Reviewer 合格', summary: `判定コメント ${acceptance.verdictCommentId} を patch-id ${acceptance.patchId} で受け付けました。` }
    : { conclusion: 'failure', title: 'ブロッキング指摘あり', summary: '変更要求レビューを参照してください。' });
}

async function writeMergeRoute(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, mode: boolean): Promise<void> {
  const outcome = evaluateMergeRoute({
    autoMergeEnabled: pr.auto_merge !== null && pr.auto_merge !== undefined,
    isAgentPr: isAgentPr(ctx.config, pr, ctx.repository),
    hold: hasLabel(pr, LABELS.hold),
    autoMergeMode: mode,
    acceptance,
  });
  await writeCheck(ctx, pr.head.sha, CHECKS.mergeRoute, outcome);
}

/** 現在の差分に対する受け付け記録を探して merge-route を書き直す */
export async function refreshMergeRoute(ctx: GateContext, pr: PullRequest, known?: { patch: string }): Promise<Acceptance | null> {
  const agent = isAgentPr(ctx.config, pr, ctx.repository);
  let acceptance: Acceptance | null = null;
  if (agent) {
    const patch = known?.patch ?? patchId(await prDiff(ctx.gh, pr));
    acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patch);
  }
  await writeMergeRoute(ctx, pr, acceptance, await autoMergeMode(ctx.gh, ctx.config));
  return acceptance;
}

/** 合格した判定を受け付けたら、App が以前に出した変更要求レビューを解除する（回数は解除済みも数える） */
async function dismissFixRequests(ctx: GateContext, number: number): Promise<void> {
  const reviews = await ctx.gh.paginate<Review>(`/pulls/${number}/reviews`);
  for (const r of reviews) {
    if (r.state !== 'CHANGES_REQUESTED' || r.user?.login !== appLogin(ctx.config)) continue;
    await ctx.gh.request('PUT', `/pulls/${number}/reviews/${r.id}/dismissals`, {
      body: { message: '修正後の判定で Reviewer が合格としたため解除します。', event: 'DISMISS' },
    });
  }
}
