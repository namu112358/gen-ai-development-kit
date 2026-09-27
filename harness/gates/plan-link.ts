import { CHECKS, PLAN_EXEMPT_LABEL } from '../lib/config.ts';
import { hasLabel, planLinkedIssues, type PullRequest } from '../lib/state.ts';
import { getPr, writeCheck, type GateContext } from './context.ts';

/**
 * 必須チェック agent/plan-link：PR が計画のある Issue を Closes しているか。人の PR にも求める。
 * 例外は人だけが付ける plan:exempt（付け外しは App が記録する）。
 */
export async function writePlanLink(ctx: GateContext, prOrNumber: PullRequest | number): Promise<void> {
  const pr = typeof prOrNumber === 'number' ? await getPr(ctx, prOrNumber) : prOrNumber;
  if (pr.state !== 'open') return;
  if (hasLabel(pr, PLAN_EXEMPT_LABEL)) {
    await writeCheck(ctx, pr.head.sha, CHECKS.planLink, { conclusion: 'success', title: '例外（plan:exempt）', summary: '人が例外として通しました。' });
    return;
  }
  const { linked, unplanned } = await planLinkedIssues(ctx.gh, ctx.config, pr.number);
  if (linked.length > 0) {
    await writeCheck(ctx, pr.head.sha, CHECKS.planLink, { conclusion: 'success', title: `計画のある Issue に紐付いています（${linked.map((n) => `#${n}`).join(', ')}）`, summary: '' });
    return;
  }
  await writeCheck(ctx, pr.head.sha, CHECKS.planLink, {
    conclusion: 'failure',
    title: '計画のある Issue に紐付いていません',
    summary: [
      unplanned.length > 0 ? `Closes している Issue（${unplanned.map((n) => `#${n}`).join(', ')}）に計画がありません。計画を投稿してください。` : 'PR 本文に `Closes #番号` がありません。',
      '',
      'Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書いてください。緊急の例外は、人が `plan:exempt` を付けます。',
    ].join('\n'),
  });
}
