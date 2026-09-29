import { CHECKS, PLAN_EXEMPT_LABEL } from '../lib/config.ts';
import { classifyBase, stackOf } from '../lib/stack.ts';
import { appRecords, bodyIssueRefs, hasLabel, planLinkedIssues, type PullRequest } from '../lib/state.ts';
import { appComment, getPr, writeCheck, type GateContext } from './context.ts';

/**
 * 必須チェック agent/plan-link：PR が計画のある Issue に紐付いているか（本文の `Closes #N`、Stacked PR の層は `Refs #N` も）。人の PR にも求める。
 * 例外は人だけが付ける plan:exempt（付け外しは App が記録する）。
 * - Stacked PR の層（一番下が既定ブランチ宛て）は、層の位置に関わらず本文の `Refs #N`・`Closes #N` を受け付け、1層＝1 Issue にする
 * - 層を紐付けたら、App が紐付けの記録（kind=stack-link）を PR に残す（Merge の後に Issue を閉じるため。on-main-push.ts）
 */
export async function writePlanLink(ctx: GateContext, prOrNumber: PullRequest | number): Promise<void> {
  const pr = typeof prOrNumber === 'number' ? await getPr(ctx, prOrNumber) : prOrNumber;
  if (pr.state !== 'open') return;
  if (hasLabel(pr, PLAN_EXEMPT_LABEL)) {
    await writeCheck(ctx, pr.head.sha, CHECKS.planLink, { conclusion: 'success', title: '例外（plan:exempt）', summary: '人が例外として通しました。' });
    return;
  }
  const layer = classifyBase(pr, ctx.config.defaultBranch) === 'stacked';
  const refs = bodyIssueRefs(pr.body);
  if (layer && refs.length > 1) {
    await writeCheck(ctx, pr.head.sha, CHECKS.planLink, {
      conclusion: 'failure',
      title: 'Stacked PR の層が複数の Issue に紐付いています',
      summary: `Stacked PR の層は1つの Issue にだけ紐付けます（\`Refs #N\` か \`Closes #N\` を1つだけ書く）。今の本文：${refs.map((r) => `#${r.number}`).join(', ')}`,
    });
    return;
  }
  const { linked, unplanned } = await planLinkedIssues(ctx.gh, ctx.config, pr);
  if (linked.length > 0) {
    await writeCheck(ctx, pr.head.sha, CHECKS.planLink, { conclusion: 'success', title: `計画のある Issue に紐付いています（${linked.map((n) => `#${n}`).join(', ')}）`, summary: '' });
    if (layer) await recordStackLink(ctx, pr, linked);
    return;
  }
  const issues = unplanned.map((n) => `#${n}`).join(', ');
  const refsOnly = !layer && refs.some((r) => r.keyword === 'refs') && !refs.some((r) => r.keyword === 'closes');
  const first = layer
    ? unplanned.length > 0 ? `紐付けた Issue（${issues}）に計画がありません。計画を投稿してください。` : 'PR 本文に `Refs #番号` か `Closes #番号` がありません。'
    : unplanned.length > 0 ? `Closes している Issue（${issues}）に計画がありません。計画を投稿してください。` : 'PR 本文に `Closes #番号` がありません。';
  await writeCheck(ctx, pr.head.sha, CHECKS.planLink, {
    conclusion: 'failure',
    title: '計画のある Issue に紐付いていません',
    summary: [
      first,
      ...(refsOnly ? ['`Refs #番号` で紐付くのは Stacked PR の層だけです。`Closes #番号` を書いてください。'] : []),
      '',
      layer
        ? 'Issue を立てて計画を投稿し、PR 本文に `Refs #番号` か `Closes #番号` を1つ書いてください。緊急の例外は、人が `plan:exempt` を付けます。'
        : 'Issue を立てて計画を投稿し、PR 本文に `Closes #番号` を書いてください。緊急の例外は、人が `plan:exempt` を付けます。',
    ].join('\n'),
  });
}

/** App の紐付けの記録（kind=stack-link）。層が既定ブランチに Merge されたら、App が issues を閉じる */
export interface StackLinkRecord {
  version: 1;
  issues: number[];
  stack: number;
}

/** スタックの層を紐付けた記録を PR に残す。最新の App の記録と issues・stack が同じなら書かない（push・編集のたびに増やさない） */
async function recordStackLink(ctx: GateContext, pr: PullRequest, issues: number[]): Promise<void> {
  const stack = stackOf(pr);
  if (stack === null || stack === 'malformed') return;
  const latest = appRecords<StackLinkRecord>(ctx.config, await ctx.gh.listComments(pr.number), 'stack-link').at(-1)?.value;
  if (latest && latest.stack === stack.number && JSON.stringify(latest.issues) === JSON.stringify(issues)) return;
  const text = `Stacked PR の層（スタック #${stack.number}）を ${issues.map((n) => `#${n}`).join(', ')} に紐付けました。この PR が既定ブランチに Merge されたら、App がこの Issue を閉じます。`;
  await appComment(ctx, pr.number, 'stack-link', text, { version: 1, issues, stack: stack.number } satisfies StackLinkRecord);
}
