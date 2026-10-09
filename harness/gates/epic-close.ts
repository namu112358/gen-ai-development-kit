import { appComment, type GateContext } from './context.ts';

/**
 * 子課題が全部閉じた Epic を App が閉じる。閉じた子の今の親（on-issue.ts）と、定期実行の照合（付け替え・外しの後に残ったもの）の両方から使う。
 */

/** 閉じる書き込み（コメントと state_reason=completed）。どの経路でも同じ閉じ方にする */
export async function closeAsDone(ctx: GateContext, number: number): Promise<void> {
  await appComment(ctx, number, 'parent-closed', 'Sub-issues がすべて閉じたため、この Issue を閉じます。');
  await ctx.gh.request('PATCH', `/issues/${number}`, { body: { state: 'closed', state_reason: 'completed' } });
}

/** GraphQL で子の状態を読み直し、開いていて子が1件以上あり全部 CLOSED なら閉じる。閉じたら true */
export async function closeIfSubIssuesDone(ctx: GateContext, number: number): Promise<boolean> {
  const data = await ctx.gh.graphql<{ repository: { issue: { state: string; repository: { nameWithOwner: string }; subIssues: { totalCount: number; nodes: { state: string }[] } } | null } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){
      state repository{nameWithOwner} subIssues(first:100){totalCount nodes{state}}}}}`,
    { owner: ctx.gh.owner, repo: ctx.gh.repo, n: number },
  );
  const issue = data.repository.issue;
  if (!issue || issue.state !== 'OPEN' || issue.repository.nameWithOwner !== ctx.repository) return false;
  const { totalCount, nodes } = issue.subIssues;
  if (totalCount < 1 || totalCount > nodes.length) return false;
  if (!nodes.every((s) => s.state === 'CLOSED')) return false;
  await closeAsDone(ctx, number);
  return true;
}

interface OpenIssue {
  number: number;
  title: string;
  pull_request?: unknown;
  sub_issues_summary?: { total?: number; completed?: number } | null;
}

/** 定期実行：開いた Issue のうち子が全部閉じているものを閉じる。1件の失敗はほかを止めず、最後にまとめて投げる。閉じた件数を返す */
export async function closeDoneEpics(ctx: GateContext): Promise<number> {
  const failures: string[] = [];
  let closed = 0;
  const issues = await ctx.gh.paginate<OpenIssue>('/issues?state=open', 10);
  for (const i of issues) {
    if (i.pull_request || i.title === ctx.config.dashboardIssueTitle) continue;
    const total = i.sub_issues_summary?.total ?? 0;
    if (total < 1 || i.sub_issues_summary?.completed !== total) continue;
    try {
      if (await closeIfSubIssuesDone(ctx, i.number)) closed++;
    } catch (e) {
      failures.push(`#${i.number}: ${(e as Error).message}`);
    }
  }
  ctx.log(`epic-close: closed=${closed} failures=${failures.length}`);
  if (failures.length > 0) throw new Error(`Epic の Close に失敗しました: ${failures.join('; ')}`);
  return closed;
}
