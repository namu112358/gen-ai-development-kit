/**
 * auto mode（Epic #339）の始まりと終わりの動作（ダッシュボードの auto mode のラベルの付け外しと停止スイッチ）。
 * 付けたら止まっている計画を判定し直し、条件を満たす PR（Jev の危険の判定で保留にならなかったもの）に auto-merge を付ける。
 * 終わったら auto mode で付けた auto-merge を外して Human Merge に戻す（委任・bypass で乗り続ける PR は引き継ぐ）。
 * apply.ts を import する側（auto-mode.ts は判断だけ）。bypass-merge.ts と同じ形。
 */
import { autoModeConfig, type AutoModeState } from '../lib/auto-mode.ts';
import { appLogin } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, isAgentPr, isSameRepoPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute, renderHumanReview, rewriteTestsCheck, writeAutoModeEnd } from './apply.ts';
import { AUTO_MODE_MERGE_END_TEXT, AUTO_MODE_SWITCH_KIND, autoModeArm, autoModeFor, type AutoModeMergeEndReason } from './auto-mode.ts';
import { bypassFor, bypassRoute } from './bypass.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';
import { reviewAutoModePlans } from './on-comment.ts';

/** auto mode を終えた後の状態（merge-route と agent/tests を Human Merge として書き直すために渡す） */
function ended(reason: string): AutoModeState {
  return { active: false, since: null, by: null, reason };
}

/**
 * auto mode で付けた auto-merge を外し、Human Merge に戻す：auto-merge を外し、merge-route と agent/tests を書き直し
 * （検出があれば Human Merge として neutral）、auto-mode-merge-end と human-review を出す（停止スイッチのときも）。
 * auto mode で付けたまま終わっていない記録（autoModeArm）の無い PR・閉じた PR には何もしない（二重に出さない）。
 * 今の差分の判定が自動 Merge の対象（autoEligible）なら、auto mode に頼っていないので何もしない（auto-merge を残す）。
 * 停止スイッチ以外で、委任で乗る PR・bypass で乗る PR は、auto-merge を外さずに引き継ぐ（auto-mode-merge-end の後に
 * delegated-merge か bypass-merge。human-review は出さない。順番は委任 → bypass）。
 */
export async function endAutoModeMerge(ctx: GateContext, stale: PullRequest, reason: AutoModeMergeEndReason): Promise<void> {
  const pr = await getPr(ctx, stale.number);
  if (pr.state !== 'open') return;
  const comments = await ctx.gh.listComments(pr.number);
  if (!autoModeArm(ctx.config, comments)) return;
  const diff = isSameRepoPr(pr, ctx.repository) ? await prDiff(ctx.gh, pr) : null;
  const current = diff === null ? null : acceptanceForPatch(ctx.config, comments, patchId(diff));
  if (current?.autoEligible) return;
  const off = ended(AUTO_MODE_MERGE_END_TEXT[reason]);
  if (reason !== 'stopped' && current && diff !== null) {
    const delegation = current.delegate?.eligible ? await delegationFor(ctx, new Date()) : null;
    if (delegation && delegatedRoute(delegation, current).ok) {
      await writeAutoModeEnd(ctx, pr, reason, '委任承認（計画＋Merge）で自動経路を続けます。');
      await applyAcceptance(ctx, pr, current, { fresh: false, diff, delegation, autoMode: off });
      return;
    }
    const bypass = current.bypass?.eligible ? await bypassFor(ctx) : null;
    if (bypass && bypassRoute(bypass, current).ok) {
      await writeAutoModeEnd(ctx, pr, reason, 'bypass モードで自動経路を続けます。');
      await applyAcceptance(ctx, pr, current, { fresh: false, diff, bypass, autoMode: off });
      return;
    }
  }
  await disableAutoMerge(ctx, pr);
  const acceptance = await refreshMergeRoute(ctx, pr, diff === null ? undefined : { patch: patchId(diff) }, undefined, undefined, off);
  const tests = acceptance && diff !== null ? await rewriteTestsCheck(ctx, pr, acceptance, diff, undefined, undefined, off) : null;
  await writeAutoModeEnd(ctx, pr, reason);
  if (acceptance) {
    await appComment(ctx, pr.number, 'human-review', renderHumanReview(ctx.gh.owner, acceptance, [`auto mode が終わりました（${AUTO_MODE_MERGE_END_TEXT[reason]}）`, ...acceptance.reasons], tests ?? undefined));
  }
}

/**
 * ダッシュボードの auto mode のラベルの付け外し。
 * - 付けた：auto mode が有効になれば、ダッシュボードに書き、止まっている計画を判定し直し（on-comment.ts の reviewAutoModePlans。失敗はログだけ）、
 *   今の差分の受け付けが auto mode で乗る開いた Agent PR に auto-merge を付ける（自動 Merge の対象・委任で乗るものは applyAcceptance が今までどおり扱う）。
 *   有効にならなければ（人以外が付けた・停止スイッチなど）理由を書いて何もしない
 * - 外した：auto mode で付けたまま終わっていない PR の auto-merge を外す（委任・bypass で乗り続ける PR は引き継ぐ）。App が外したときはコメントしない
 */
export async function onAutoModeSwitch(ctx: GateContext, number: number, labeled: boolean, sender: string | undefined, now: Date = new Date()): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  const { label } = autoModeConfig(ctx.config);
  if (labeled) {
    const state = await autoModeFor(ctx, dashboard);
    if (!state.active) {
      await appComment(ctx, number, AUTO_MODE_SWITCH_KIND, `\`${label}\` が付きましたが、auto mode は有効になりません（${state.reason}）。`);
      return;
    }
    await appComment(ctx, number, AUTO_MODE_SWITCH_KIND, `auto mode を有効にしました（@${state.by}、期限なし）。必須の条件（ブロッキング指摘が無い・範囲照合・agent/tests）を満たし、Jev の危険の判定で保留にならなかった計画と Agent PR は、Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev の自動 Merge の許可の理由を飛ばして通し、自動 Merge します。止めるときはこのラベルを外してください。`);
    try {
      await reviewAutoModePlans(ctx, now, state);
    } catch (e) {
      ctx.log(`止まっている計画の判定し直しに失敗しました: ${(e as Error).message}`);
    }
    for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
      const pr = await getPr(ctx, item.number);
      if (!isAgentPr(ctx.config, pr, ctx.repository)) continue;
      const diff = await prDiff(ctx.gh, pr);
      const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(diff));
      if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.autoMode?.eligible) {
        await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff, autoMode: state });
      }
    }
    return;
  }
  if (sender !== appLogin(ctx.config)) await appComment(ctx, number, AUTO_MODE_SWITCH_KIND, `auto mode を終えました（@${sender}）。auto mode で付けた auto-merge を外し、Human Merge に戻します（委任承認・bypass で乗り続ける PR は引き継ぎます）。`);
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open')) {
    if (!autoModeArm(ctx.config, await ctx.gh.listComments(item.number))) continue;
    await endAutoModeMerge(ctx, item, 'removed');
  }
}
