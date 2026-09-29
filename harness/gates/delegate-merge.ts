import { appLogin, delegateMergeConfig } from '../lib/config.ts';
import { delegateState, type DelegateState } from '../lib/delegate.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, hasLabel, isAgentPr, isSameRepoPr, prDiff, timeline, type DashboardIssue, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute, renderHumanReview, rewriteTestsCheck, writeDelegationEnd } from './apply.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';
import { DELEGATE_SWITCH_KIND, DELEGATED_MERGE_END_TEXT, delegatedArm, delegationFor } from './delegation.ts';

/**
 * 委任 Merge の始まりと終わりの動作（ダッシュボードのラベルの付け外しと期限切れ）。docs/risk-policy.md の「委任 Merge」。
 * 付けたら条件を満たす PR に auto-merge を付け、終わったら委任で付けた auto-merge を外して Human Merge に戻す。
 * apply.ts を import する側（delegation.ts は判断だけ）。
 */

/** 委任を終えた後の状態（merge-route と agent/tests を Human Merge として書き直すために渡す） */
function ended(reason: string): DelegateState {
  return { active: false, since: null, until: null, by: null, reason };
}

/**
 * 委任で付けた auto-merge を外し、Human Merge に戻す：auto-merge を外し、merge-route と agent/tests を書き直し
 * （検出があれば Human Merge として neutral）、delegated-merge-end と human-review を出す。
 * 委任で付けたまま終わっていない記録（delegatedArm）の無い PR・閉じた PR には何もしない（二重に出さない）。
 * 委任で付けた後に今の差分の判定が自動 Merge の対象（autoEligible）になった PR も、委任に頼っていないので何もしない（auto-merge を残す）。
 */
export async function endDelegatedMerge(ctx: GateContext, stale: PullRequest, reason: 'removed' | 'expired'): Promise<void> {
  const pr = await getPr(ctx, stale.number);
  if (pr.state !== 'open') return;
  const comments = await ctx.gh.listComments(pr.number);
  if (!delegatedArm(ctx.config, comments)) return;
  const diff = isSameRepoPr(pr, ctx.repository) ? await prDiff(ctx.gh, pr) : null;
  if (diff !== null && acceptanceForPatch(ctx.config, comments, patchId(diff))?.autoEligible) return;
  const text = DELEGATED_MERGE_END_TEXT[reason];
  const off = ended(text);
  await disableAutoMerge(ctx, pr);
  const acceptance = await refreshMergeRoute(ctx, pr, diff === null ? undefined : { patch: patchId(diff) }, off);
  const tests = acceptance && diff !== null ? await rewriteTestsCheck(ctx, pr, acceptance, diff, off) : null;
  await writeDelegationEnd(ctx, pr, reason);
  if (acceptance) {
    await appComment(ctx, pr.number, 'human-review', renderHumanReview(ctx.gh.owner, acceptance, [`委任 Merge が終わりました（${text}）`, ...acceptance.reasons], tests ?? undefined));
  }
}

/**
 * 記録の期限を過ぎた委任の auto-merge を外す（PR・Issue のイベントと定期実行のたびに呼ぶ）。
 * ダッシュボードに委任のラベルがあるときだけ、auto-merge の付いた開いた PR の delegated-merge の記録の期限を見る。
 * 失敗してもイベントの本来の処理は止めない（merge-route は書くたびに今の委任の状態で守る）。
 */
export async function sweepExpiredDelegation(ctx: GateContext, now: Date, dashboard?: DashboardIssue | null): Promise<void> {
  try {
    const found = dashboard === undefined ? await findDashboard(ctx.gh, ctx.config) : dashboard;
    if (!found || !hasLabel(found, delegateMergeConfig(ctx.config).label)) return;
    for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5)) {
      if (!item.auto_merge) continue;
      const arm = delegatedArm(ctx.config, await ctx.gh.listComments(item.number));
      if (!arm || (arm.until !== null && Date.parse(arm.until) > now.getTime())) continue;
      await endDelegatedMerge(ctx, item, 'expired');
    }
  } catch (e) {
    ctx.log(`委任 Merge の期限切れの掃除に失敗しました: ${(e as Error).message}`);
  }
}

/**
 * ダッシュボードの委任のラベルの付け外し。
 * - 付けた：委任が有効なら、今の差分の受け付けが委任で乗る開いた Agent PR に auto-merge を付ける。有効でなければ理由を書いて何もしない
 * - 外した：委任で付けたまま終わっていない PR の auto-merge を外す。App が外した（期限切れ）ときはコメントしない（定期実行が書いた）
 */
export async function onDelegateSwitch(ctx: GateContext, number: number, labeled: boolean, sender: string | undefined, now: Date = new Date()): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  const { label } = delegateMergeConfig(ctx.config);
  if (labeled) {
    const delegation = await delegationFor(ctx, now, dashboard);
    if (!delegation.active) {
      await appComment(ctx, number, DELEGATE_SWITCH_KIND, `\`${label}\` が付きましたが、委任 Merge は有効になりません（${delegation.reason}）。`);
      return;
    }
    await appComment(ctx, number, DELEGATE_SWITCH_KIND, `委任 Merge を有効にしました（期限 ${delegation.until}、@${delegation.by}）。条件を満たす Agent PR は、ガードレール・Risk の理由を飛ばして自動 Merge します。止めるときはこのラベルを外してください。`);
    for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
      const pr = await getPr(ctx, item.number);
      if (!isAgentPr(ctx.config, pr, ctx.repository)) continue;
      const diff = await prDiff(ctx.gh, pr);
      const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(diff));
      if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.delegate?.eligible) {
        await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff, delegation });
      }
    }
    return;
  }
  if (sender !== appLogin(ctx.config)) await appComment(ctx, number, DELEGATE_SWITCH_KIND, `委任 Merge を終えました（@${sender}）。委任で付けた auto-merge を外し、Human Merge に戻します。`);
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
    if (!delegatedArm(ctx.config, await ctx.gh.listComments(item.number))) continue;
    await endDelegatedMerge(ctx, item, 'removed');
  }
}

/**
 * 定期実行：委任の期限が切れていれば、先に委任で付けた auto-merge を外し（expired）、その後でラベルを外してダッシュボードに書く。
 * ラベルを外せなかったときはログだけ書き、次の定期実行でもう一度試す（掃除済みの PR には何もしない）。
 */
export async function expireDelegation(ctx: GateContext, now: Date): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  const { label } = delegateMergeConfig(ctx.config);
  if (!dashboard || !hasLabel(dashboard, label)) return;
  const state = delegateState(dashboard, await timeline(ctx.gh, dashboard.number), ctx.config, now);
  await sweepExpiredDelegation(ctx, now, dashboard);
  if (state.reason !== '期限切れ') return;
  try {
    await ctx.gh.removeLabel(dashboard.number, label);
  } catch (e) {
    ctx.log(`委任のラベルを外せませんでした（次の定期実行でもう一度試します）: ${(e as Error).message}`);
    return;
  }
  await appComment(ctx, dashboard.number, DELEGATE_SWITCH_KIND, `委任 Merge の期限（${state.until}）を過ぎたため、\`${label}\` を外しました。委任で付けた auto-merge は外し、Human Merge に戻しました。`);
}
