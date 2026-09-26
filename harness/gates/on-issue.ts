import { appLogin, LABELS } from '../lib/config.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, hasLabel, isAgentPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute } from './apply.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';

/**
 * issues：
 * - agent:ready が付いたら Issue 本文を読み、読めなければ agent:blocked（静かに止めない）
 * - agent:plan-ok を App 以外が付けたら外す
 * - agent:hold が外されたら記録
 * - Close されたら依存解消（agent:waiting を外す）と親 Issue の Close
 */
export async function onIssue(ctx: GateContext): Promise<void> {
  const action = ctx.event.action as string;
  const issue = ctx.event.issue as { number: number; body: string | null; labels: { name: string }[]; state: string };
  const sender = ctx.event.sender?.login as string | undefined;
  const label = ctx.event.label?.name as string | undefined;

  if (action === 'labeled' && label === LABELS.ready) {
    const parsed = parseIssueBody(issue.body);
    if (!parsed.ok) {
      await ctx.gh.addLabels(issue.number, [LABELS.blocked]);
      await appComment(ctx, issue.number, 'form-error', ['Issue 本文を Issue Form の書式として読めませんでした。`agent:blocked` にしました。本文を直して `agent:blocked` を外してください。', '', ...parsed.errors.map((e) => `- ${e}`)].join('\n'));
    }
    return;
  }
  if (action === 'labeled' && label === LABELS.planOk && sender !== appLogin(ctx.config)) {
    await ctx.gh.removeLabel(issue.number, LABELS.planOk);
    await appComment(ctx, issue.number, 'plan-ok-removed', `\`agent:plan-ok\` は App だけが付けられます。@${sender} が付けたため外しました。`);
    return;
  }
  if (action === 'unlabeled' && label === LABELS.hold) {
    await appComment(ctx, issue.number, 'hold-removed', `\`agent:hold\` が @${sender} により外されました（記録）。`);
    return;
  }
  if ((action === 'labeled' || action === 'unlabeled') && label === ctx.config.autoMergeStopLabel) {
    await onAutoMergeSwitch(ctx, issue.number, action === 'labeled', sender);
    return;
  }
  if (action === 'closed') {
    await resolveDependents(ctx, issue.number);
    await closeParentIfDone(ctx, issue.number);
  }
}

/** 停止スイッチ（ダッシュボードの停止ラベル）の切り替え。止めたら auto-merge を外し、再開したら条件を満たす PR に付け直す */
async function onAutoMergeSwitch(ctx: GateContext, number: number, stopped: boolean, sender: string | undefined): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  await appComment(ctx, number, 'auto-merge-switch', `自動 Merge モードを${stopped ? '停止' : '再開'}しました（@${sender}）。`);
  const open = await ctx.gh.paginate<PullRequest>('/pulls?state=open');
  for (const item of open) {
    const pr = await getPr(ctx, item.number);
    if (stopped) {
      await disableAutoMerge(ctx, pr);
      await refreshMergeRoute(ctx, pr);
      continue;
    }
    if (!isAgentPr(ctx.config, pr, ctx.repository)) continue;
    const patch = patchId(await prDiff(ctx.gh, pr));
    const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patch);
    if (acceptance?.autoEligible) await applyAcceptance(ctx, pr, acceptance, { fresh: false });
  }
}

interface IssueNode {
  number: number;
  state: 'OPEN' | 'CLOSED';
  labels?: { nodes: { name: string }[] };
  blockedBy?: { nodes: { number: number; state: 'OPEN' | 'CLOSED' }[] };
}

async function resolveDependents(ctx: GateContext, number: number): Promise<void> {
  const data = await ctx.gh.graphql<{ repository: { issue: { blocking: { nodes: IssueNode[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){
      blocking(first:50){nodes{number state labels(first:30){nodes{name}} blockedBy(first:50){nodes{number state}}}}}}}`,
    { owner: ctx.gh.owner, repo: ctx.gh.repo, n: number },
  );
  for (const dep of data.repository.issue.blocking.nodes) {
    if (dep.state !== 'OPEN') continue;
    if (!hasLabel({ labels: dep.labels?.nodes ?? [] }, LABELS.waiting)) continue;
    const open = (dep.blockedBy?.nodes ?? []).filter((b) => b.state === 'OPEN');
    if (open.length > 0) continue;
    await ctx.gh.removeLabel(dep.number, LABELS.waiting);
    await appComment(ctx, dep.number, 'unblocked', `blocker（#${number} ほか）がすべて閉じたため \`agent:waiting\` を外しました。次の Routine の実行で再開します。`);
  }
}

async function closeParentIfDone(ctx: GateContext, number: number): Promise<void> {
  const data = await ctx.gh.graphql<{ repository: { issue: { parent: { number: number; state: string; subIssues: { totalCount: number; nodes: { state: string }[] } } | null } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){
      parent{number state subIssues(first:100){totalCount nodes{state}}}}}}`,
    { owner: ctx.gh.owner, repo: ctx.gh.repo, n: number },
  );
  const parent = data.repository.issue.parent;
  if (!parent || parent.state !== 'OPEN') return;
  if (parent.subIssues.totalCount > parent.subIssues.nodes.length) return;
  if (!parent.subIssues.nodes.every((s) => s.state === 'CLOSED')) return;
  await appComment(ctx, parent.number, 'parent-closed', 'Sub-issues がすべて閉じたため、この Issue を閉じます。');
  await ctx.gh.request('PATCH', `/issues/${parent.number}`, { body: { state: 'closed', state_reason: 'completed' } });
}
