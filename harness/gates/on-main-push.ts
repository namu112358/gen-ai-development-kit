import { appLogin } from '../lib/config.ts';
import { appRecords, bodyIssueRefs, isAgentPr, type PullRequest } from '../lib/state.ts';
import { refreshMergeRoute } from './apply.ts';
import { appComment, disableAutoMerge, getPr, judgingHold, updateBranchIfBehind, type GateContext } from './context.ts';
import type { StackLinkRecord } from './plan-link.ts';
import { ensureDashboard } from './stale.ts';

/**
 * main に push されたときの処理。
 * - 自動 Merge された PR の revert を検知したら自動 Merge モードを切る（人が戻すまで再開しない）
 * - Agent PR を main に追従させる（差分が同じなら判定は引き継がれる。衝突したものは Routine が解消する）。
 *   判定中（着手宣言の段階が judge）の PR は判定の後まで待つ（auto-merge の PR は除く）
 * - Stacked PR の層が Merge されたら、App の stack-link の記録の Issue を閉じる（層の Closes は GitHub が閉じない見込みのため）
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
  await closeStackedIssues(ctx, commits);
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
    // 1本の失敗（取得・compare・コメントの読み取り）で、残りの PR の追従と Stacked PR の Issue の Close を止めない
    try {
      const pr = await getPr(ctx, item.number);
      await updateBranchIfBehind(ctx, pr, () => judgingHold(ctx, pr));
    } catch (e) {
      ctx.log(`#${item.number} の追従を確かめられませんでした: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * push のコミットから Merge された PR を引き、App の stack-link の記録の Issue のうち開いているものを閉じる。
 * 記録の Issue のうち、Merge された PR の今の本文にもあるものだけを閉じる（記録の後に本文を書き換えた PR で、古い記録の Issue を閉じないため）。
 * PR の取得に失敗したコミットは飛ばす（取りこぼしは Issue が開いたまま残る側に倒れる）。
 */
async function closeStackedIssues(ctx: GateContext, commits: { id: string }[]): Promise<void> {
  const seen = new Set<number>();
  for (const c of commits) {
    let prs: PullRequest[];
    try {
      prs = await ctx.gh.get<PullRequest[]>(`/commits/${c.id}/pulls`);
    } catch (e) {
      ctx.log(`コミット ${c.id.slice(0, 7)} の PR を読めませんでした（Stacked PR の Issue の Close を飛ばします）: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const pr of prs) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      if (!pr.merged_at) continue;
      const record = appRecords<StackLinkRecord>(ctx.config, await ctx.gh.listComments(pr.number), 'stack-link').at(-1)?.value;
      if (!record || !Array.isArray(record.issues)) continue;
      const inBody = new Set(bodyIssueRefs(pr.body).map((r) => r.number));
      for (const n of record.issues.filter((i) => inBody.has(i))) {
        const issue = await ctx.gh.get<{ state: string; pull_request?: unknown }>(`/issues/${n}`);
        if (issue.pull_request || issue.state !== 'open') continue;
        await ctx.gh.request('PATCH', `/issues/${n}`, { body: { state: 'closed', state_reason: 'completed' } });
        await appComment(ctx, n, 'stack-closed', `Stacked PR #${pr.number}（スタック #${record.stack}）が既定ブランチに Merge されたため閉じました。`);
      }
    }
  }
}
