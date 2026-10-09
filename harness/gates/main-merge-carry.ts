import { appLogin } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { changedLinesId, patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, prDiff, type PullRequest } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';

/**
 * main の取り込み（App の update-branch）の push で、PR 自身の変更（追加・削除の行）が前と同じなら、合格の判定を新しい patch-id に引き継ぐ（Issue #397）。
 * patch-id は文脈の行まで含めるので、main が近くを変えると値が変わる。App が PR の branch に push するのは update-branch だけなので、
 * push した人が App で、head の commit が（取り込み前の head, main）を親に持つ merge commit で、変更の行が同じときだけ引き継ぐ。
 * 人が GitHub の画面の Update branch で取り込んだ push（sender が人）は対象にせず、今までどおり Draft に戻る。
 * 引き継ぐときは前の受け付けを写し、`carriedFrom` を足した記録を kind=acceptance の App のコメントで書く。失敗は止める側（null）。
 */
export async function carryOverMainMerge(ctx: GateContext, pr: PullRequest, comments: IssueComment[], currentPatch: string, currentDiff: string): Promise<Acceptance | null> {
  if (ctx.event.sender?.login !== appLogin(ctx.config)) return null;
  const before = ctx.event.before as string | undefined;
  if (!before || !/^[0-9a-f]{40}$/.test(before) || /^0+$/.test(before)) return null;
  try {
    const commit = await ctx.gh.get<{ parents?: { sha: string }[] }>(`/commits/${pr.head.sha}`);
    if (commit.parents?.length !== 2 || commit.parents[0]?.sha !== before) return null;
    const priorDiff = await prDiff(ctx.gh, pr, before);
    const priorPatch = patchId(priorDiff);
    const prior = acceptanceForPatch(ctx.config, comments, priorPatch);
    if (!prior || !prior.reviewPass) return null;
    if (changedLinesId(priorDiff) !== changedLinesId(currentDiff)) return null;
    const carried: Acceptance = { ...prior, patchId: currentPatch, carriedFrom: { patchId: priorPatch, headSha: before } };
    await appComment(
      ctx, pr.number, 'acceptance',
      `main の取り込み（head ${before.slice(0, 7)} → ${pr.head.sha.slice(0, 7)}）で PR 自身の変更（追加・削除の行）が同じため、判定（patch-id ${priorPatch.slice(0, 12)}）を引き継ぎました。変わったのは前後の行と行番号だけです。`,
      carried,
    );
    ctx.log(`main の取り込みで PR 自身の変更が同じ。判定（patch-id ${priorPatch}）を引き継ぎました`);
    return carried;
  } catch (e) {
    ctx.log(`main の取り込みの判定の引き継ぎに失敗しました（Draft に戻す側）: ${(e as Error).message}`);
    return null;
  }
}
