import { appLogin, delegateConfig } from '../lib/config.ts';
import { delegateModeName, type DelegateState } from '../lib/delegate.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, isAgentPr, isSameRepoPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute, renderHumanReview, rewriteTestsCheck, writeDelegationEnd } from './apply.ts';
import { autoModeFor, autoModeRoute } from './auto-mode.ts';
import { bypassFor, bypassRoute } from './bypass.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';
import { DELEGATE_SWITCH_KIND, DELEGATED_MERGE_END_TEXT, delegatedArm, delegationFor } from './delegation.ts';
import { reviewDelegatedPlans } from './on-comment.ts';

/**
 * 委任承認の始まりと終わりの動作（ダッシュボードの agent:delegate-plan・agent:delegate-merge の付け外し）。docs/risk-policy.md の「委任承認」。
 * 付けたら、ゲートの停止で止まっている計画を判定し直し、委任承認（計画＋Merge）なら条件を満たす PR に auto-merge を付ける。
 * agent:delegate-merge を外したら、委任で付けた auto-merge を外して Human Merge に戻す。委任で付けた agent:plan-ok は外さない。
 * 期限は無い（ラベルが付いている間ずっと有効）。apply.ts を import する側（delegation.ts は判断だけ）。
 */

/** 委任を終えた後の状態（merge-route と agent/tests を Human Merge として書き直すために渡す） */
function ended(reason: string): DelegateState {
  return { mode: 'off', active: false, planActive: false, label: null, since: null, by: null, reason };
}

/**
 * 委任で付けた auto-merge を外し、Human Merge に戻す：auto-merge を外し、merge-route と agent/tests を書き直し
 * （検出があれば Human Merge として neutral）、delegated-merge-end と human-review を出す。
 * 委任で付けたまま終わっていない記録（delegatedArm）の無い PR・閉じた PR には何もしない（二重に出さない）。
 * 委任で付けた後に今の差分の判定が自動 Merge の対象（autoEligible）になった PR も、委任に頼っていないので何もしない（auto-merge を残す）。
 * auto mode で乗る PR・bypass モードで乗る PR は、auto-merge を外さずに引き継ぐ（delegated-merge-end の後に auto-mode-merge か bypass-merge。
 * human-review は出さない。順番は auto mode → bypass）。
 */
export async function endDelegatedMerge(ctx: GateContext, stale: PullRequest, reason: 'removed'): Promise<void> {
  const pr = await getPr(ctx, stale.number);
  if (pr.state !== 'open') return;
  const comments = await ctx.gh.listComments(pr.number);
  if (!delegatedArm(ctx.config, comments)) return;
  const diff = isSameRepoPr(pr, ctx.repository) ? await prDiff(ctx.gh, pr) : null;
  const current = diff === null ? null : acceptanceForPatch(ctx.config, comments, patchId(diff));
  if (current?.autoEligible) return;
  const text = DELEGATED_MERGE_END_TEXT[reason];
  const off = ended(text);
  if (current?.autoMode?.eligible && diff !== null) {
    const autoMode = await autoModeFor(ctx);
    if (autoModeRoute(autoMode, current).ok) {
      await writeDelegationEnd(ctx, pr, reason, 'auto mode で自動経路を続けます。');
      await applyAcceptance(ctx, pr, current, { fresh: false, diff, delegation: off, autoMode });
      return;
    }
  }
  if (current?.bypass?.eligible && diff !== null) {
    const bypass = await bypassFor(ctx);
    if (bypassRoute(bypass, current).ok) {
      await writeDelegationEnd(ctx, pr, reason, 'bypass モードで自動経路を続けます。');
      await applyAcceptance(ctx, pr, current, { fresh: false, diff, delegation: off, bypass });
      return;
    }
  }
  await disableAutoMerge(ctx, pr);
  const acceptance = await refreshMergeRoute(ctx, pr, diff === null ? undefined : { patch: patchId(diff) }, off);
  const tests = acceptance && diff !== null ? await rewriteTestsCheck(ctx, pr, acceptance, diff, off) : null;
  await writeDelegationEnd(ctx, pr, reason);
  if (acceptance) {
    await appComment(ctx, pr.number, 'human-review', renderHumanReview(ctx.gh.owner, acceptance, [`委任承認（計画＋Merge）が終わりました（${text}）`, ...acceptance.reasons], tests ?? undefined));
  }
}

/**
 * ダッシュボードの委任のラベル（label。省略時は agent:delegate-merge）の付け外し。
 * - 付けた：そのラベルの委任が有効になれば、ダッシュボードに書き、ゲートの停止で止まっている計画を判定し直す（on-comment.ts の reviewDelegatedPlans）。
 *   agent:delegate-merge なら、今の差分の受け付けが委任で乗る開いた Agent PR に auto-merge を付ける。有効にならなければ理由を書いて何もしない
 * - 外した：agent:delegate-merge なら委任で付けたまま終わっていない PR の auto-merge を外す。agent:delegate-plan なら終わったことだけを書く。
 *   どちらも、委任で付けた agent:plan-ok は外さない。App が外したときはコメントしない
 */
export async function onDelegateSwitch(ctx: GateContext, number: number, labeled: boolean, sender: string | undefined, now: Date = new Date(), label?: string): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  const { planLabel, mergeLabel } = delegateConfig(ctx.config);
  const changed = label ?? mergeLabel;
  const isMerge = changed === mergeLabel;
  const delegation = await delegationFor(ctx, now, dashboard);
  if (labeled) {
    if (!(isMerge ? delegation.active : delegation.planActive)) {
      await appComment(ctx, number, DELEGATE_SWITCH_KIND, `\`${changed}\` が付きましたが、委任承認（${isMerge ? '計画＋Merge' : '計画のみ'}）は有効になりません（${delegation.reason}）。`);
      return;
    }
    const what = delegation.active
      ? '計画ゲートでガードレール・Risk だけで止まる計画を通し、条件を満たす Agent PR はガードレール・Risk の理由を飛ばして自動 Merge します。'
      : '計画ゲートでガードレール・Risk だけで止まる計画を通します（Merge は委ねません）。';
    await appComment(ctx, number, DELEGATE_SWITCH_KIND, `委任承認（${delegateModeName(delegation.mode)}）を有効にしました（\`${delegation.label}\`、@${delegation.by}、${delegation.since} から）。${what}止めるときはこのラベルを外してください。`);
    try {
      await reviewDelegatedPlans(ctx, now, delegation);
    } catch (e) {
      ctx.log(`止まっている計画の判定し直しに失敗しました: ${(e as Error).message}`);
    }
    if (!isMerge) return;
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
  const byHuman = sender !== appLogin(ctx.config);
  if (!isMerge) {
    if (byHuman) {
      const rest = delegation.active ? `\`${mergeLabel}\` が残っているので、委任承認（計画＋Merge）は続きます。` : '';
      await appComment(ctx, number, DELEGATE_SWITCH_KIND, `委任承認（計画のみ）を終えました（@${sender}）。${rest}委任で付けた \`agent:plan-ok\` は外しません。`);
    }
    return;
  }
  if (byHuman) {
    const rest = delegation.planActive ? `\`${planLabel}\` が残っているので、計画の委任は続きます。` : '';
    await appComment(ctx, number, DELEGATE_SWITCH_KIND, `委任承認（計画＋Merge）を終えました（@${sender}）。委任で付けた auto-merge を外し、Human Merge に戻します。${rest}委任で付けた \`agent:plan-ok\` は外しません。`);
  }
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
    if (!delegatedArm(ctx.config, await ctx.gh.listComments(item.number))) continue;
    await endDelegatedMerge(ctx, item, 'removed');
  }
}
