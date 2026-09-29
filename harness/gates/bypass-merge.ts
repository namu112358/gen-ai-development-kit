import { appLogin, bypassMergeConfig } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, isAgentPr, isSameRepoPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute, renderHumanReview, rewriteTestsCheck, writeBypassEnd } from './apply.ts';
import { BYPASS_MERGE_END_TEXT, BYPASS_SWITCH_KIND, bypassArm, bypassFor, type BypassMergeEndReason, type BypassState } from './bypass.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';

/**
 * bypass モードの始まりと終わりの動作（ダッシュボードのラベルの付け外しと停止スイッチ）。docs/risk-policy.md の「bypass モード」。
 * 付けたら条件を満たす PR に auto-merge を付け、終わったら bypass で付けた auto-merge を外して Human Merge に戻す。
 * apply.ts を import する側（bypass.ts は判断だけ）。
 */

/** bypass を終えた後の状態（merge-route と agent/tests を Human Merge として書き直すために渡す） */
function ended(reason: string): BypassState {
  return { active: false, since: null, by: null, reason };
}

/**
 * bypass で付けた auto-merge を外し、Human Merge に戻す：auto-merge を外し、merge-route と agent/tests を書き直し
 * （検出があれば Human Merge として neutral）、bypass-merge-end と human-review を出す（停止スイッチのときも）。
 * bypass で付けたまま終わっていない記録（bypassArm）の無い PR・閉じた PR には何もしない（二重に出さない）。
 * 今の差分の判定が自動 Merge の対象（autoEligible）なら、bypass に頼っていないので何もしない（auto-merge を残す）。
 * 委任が有効で委任で乗る PR は、auto-merge を外さずに委任に引き継ぐ（bypass-merge-end の後に delegated-merge。human-review は出さない）。
 */
export async function endBypassMerge(ctx: GateContext, stale: PullRequest, reason: BypassMergeEndReason): Promise<void> {
  const pr = await getPr(ctx, stale.number);
  if (pr.state !== 'open') return;
  const comments = await ctx.gh.listComments(pr.number);
  if (!bypassArm(ctx.config, comments)) return;
  const diff = isSameRepoPr(pr, ctx.repository) ? await prDiff(ctx.gh, pr) : null;
  const current = diff === null ? null : acceptanceForPatch(ctx.config, comments, patchId(diff));
  if (current?.autoEligible) return;
  const off = ended(BYPASS_MERGE_END_TEXT[reason]);
  if (reason !== 'stopped' && current && diff !== null) {
    const now = new Date();
    const delegation = current.delegate?.eligible ? await delegationFor(ctx, now) : null;
    if (delegation && delegatedRoute(delegation, current, ctx.config, now).ok) {
      await writeBypassEnd(ctx, pr, reason, '委任 Merge で自動経路を続けます。');
      await applyAcceptance(ctx, pr, current, { fresh: false, diff, delegation, bypass: off });
      return;
    }
  }
  await disableAutoMerge(ctx, pr);
  const acceptance = await refreshMergeRoute(ctx, pr, diff === null ? undefined : { patch: patchId(diff) }, undefined, off);
  const tests = acceptance && diff !== null ? await rewriteTestsCheck(ctx, pr, acceptance, diff, undefined, off) : null;
  await writeBypassEnd(ctx, pr, reason);
  if (acceptance) {
    await appComment(ctx, pr.number, 'human-review', renderHumanReview(ctx.gh.owner, acceptance, [`bypass モードが終わりました（${BYPASS_MERGE_END_TEXT[reason]}）`, ...acceptance.reasons], tests ?? undefined));
  }
}

/**
 * ダッシュボードの bypass のラベルの付け外し。
 * - 付けた：bypass が有効なら、今の差分の受け付けが bypass で乗る開いた Agent PR に auto-merge を付ける（自動 Merge の対象・委任で乗るものは applyAcceptance が今までどおり扱う）。
 *   有効でなければ理由を書いて何もしない
 * - 外した：bypass で付けたまま終わっていない PR の auto-merge を外す
 */
export async function onBypassSwitch(ctx: GateContext, number: number, labeled: boolean, sender: string | undefined): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  const { label } = bypassMergeConfig(ctx.config);
  if (labeled) {
    const bypass = await bypassFor(ctx, dashboard);
    if (!bypass.active) {
      await appComment(ctx, number, BYPASS_SWITCH_KIND, `\`${label}\` が付きましたが、bypass モードは有効になりません（${bypass.reason}）。`);
      return;
    }
    await appComment(ctx, number, BYPASS_SWITCH_KIND, `bypass モードを有効にしました（@${bypass.by}、期限なし）。ブロッキング指摘が無く範囲照合と agent/tests を通る Agent PR は、Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev の理由を飛ばして自動 Merge します。止めるときはこのラベルを外してください。`);
    for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
      const pr = await getPr(ctx, item.number);
      if (!isAgentPr(ctx.config, pr, ctx.repository)) continue;
      const diff = await prDiff(ctx.gh, pr);
      const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(diff));
      if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.bypass?.eligible) {
        await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff, bypass });
      }
    }
    return;
  }
  if (sender !== appLogin(ctx.config)) await appComment(ctx, number, BYPASS_SWITCH_KIND, `bypass モードを終えました（@${sender}）。bypass で付けた auto-merge を外し、Human Merge に戻します。`);
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
    if (!bypassArm(ctx.config, await ctx.gh.listComments(item.number))) continue;
    await endBypassMerge(ctx, item, 'removed');
  }
}
