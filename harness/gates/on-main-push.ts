import { appLogin } from '../lib/config.ts';
import { isAgentPr, type PullRequest } from '../lib/state.ts';
import { refreshMergeRoute } from './apply.ts';
import { appComment, disableAutoMerge, getPr, updateBranchIfBehind, type GateContext } from './context.ts';
import { ensureDashboard } from './stale.ts';

/**
 * main への push：
 * - 自動 Merge された PR の revert を検知したら自動 Merge モードを切る（人が戻すまで再開しない）
 * - Agent PR を main に追従させる（差分が同じなら判定は引き継がれる。衝突したものは Routine が解消する）
 */
export async function onMainPush(ctx: GateContext): Promise<void> {
  const commits = (ctx.event.commits ?? []) as { id: string; message: string }[];
  const reverted = new Set<number>();
  for (const c of commits) {
    for (const n of revertedPrNumbers(c.message)) reverted.add(n);
    for (const sha of revertedShas(c.message)) {
      const prs = await ctx.gh.get<{ number: number }[]>(`/commits/${sha}/pulls`).catch(() => []);
      for (const p of prs) reverted.add(p.number);
    }
  }
  const autoMerged: number[] = [];
  for (const n of reverted) {
    const pr = await ctx.gh.get<PullRequest & { merged_by: { login: string } | null }>(`/pulls/${n}`);
    if (pr.merged_by?.login === appLogin(ctx.config)) autoMerged.push(n);
  }
  if (autoMerged.length > 0) await stopAutoMerge(ctx, autoMerged);
  await updateWaitingBranches(ctx);
}

export function revertedPrNumbers(message: string): number[] {
  return [...message.matchAll(/Reverts [\w.-]+\/[\w.-]+#(\d+)/g)].map((m) => Number(m[1]));
}

export function revertedShas(message: string): string[] {
  return [...message.matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]!);
}

async function stopAutoMerge(ctx: GateContext, prs: number[]): Promise<void> {
  const dashboard = await ensureDashboard(ctx);
  await ctx.gh.addLabels(dashboard, [ctx.config.autoMergeStopLabel]);
  const open = await ctx.gh.paginate<PullRequest>('/pulls?state=open');
  for (const pr of open) {
    if (!pr.auto_merge) continue;
    await disableAutoMerge(ctx, pr);
    await refreshMergeRoute(ctx, await getPr(ctx, pr.number));
  }
  await appComment(
    ctx,
    dashboard,
    'auto-merge-stopped',
    [
      `自動 Merge された PR（${prs.map((n) => `#${n}`).join(', ')}）が revert されたため、自動 Merge モードを切りました。`,
      '',
      `原因を確認したら、このダッシュボードの \`${ctx.config.autoMergeStopLabel}\` ラベルを外して再開してください（docs/operations.md）。`,
    ].join('\n'),
  );
}

async function updateWaitingBranches(ctx: GateContext): Promise<void> {
  const open = await ctx.gh.paginate<PullRequest>('/pulls?state=open');
  for (const item of open) {
    // auto-merge 待ちに限らず、すべての Agent PR を早めに追従させる（衝突を小さいうちに見つけ、Routine が解消する）
    if (!isAgentPr(ctx.config, item, ctx.repository)) continue;
    await updateBranchIfBehind(ctx, await getPr(ctx, item.number));
  }
}
