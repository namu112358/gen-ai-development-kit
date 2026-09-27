import { appLogin, LABELS, PRIORITY_LABELS, reasonMark } from '../lib/config.ts';
import { parseIssueBody, type IssueContract } from '../lib/issue-form.ts';
import { buildTriageRequest, renderTriage, summarizeTriage } from '../lib/issue-triage.ts';
import { askJev, flattenAnswers } from '../lib/jev.ts';
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
    if (parsed.ok) await triageIssue(ctx, issue.number, (ctx.event.issue as { title: string }).title, parsed.contract);
    if (!parsed.ok) {
      await ctx.gh.addLabels(issue.number, [LABELS.blocked]);
      await appComment(ctx, issue.number, 'form-error', [reasonMark('form-error'), 'Issue 本文を Issue Form の書式として読めませんでした。`agent:blocked` にしました。本文を直して `agent:blocked` を外してください。', '', ...parsed.errors.map((e) => `- ${e}`)].join('\n'));
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
  if (action === 'labeled' && label?.startsWith('priority:') && hasLabel(issue, PRIORITY_LABELS.high) && hasLabel(issue, PRIORITY_LABELS.low)) {
    await appComment(ctx, issue.number, 'priority-conflict', `\`${PRIORITY_LABELS.high}\` と \`${PRIORITY_LABELS.low}\` が両方付いています。queue は \`${PRIORITY_LABELS.high}\` として扱います。どちらかを外してください。`);
    return;
  }
  if ((action === 'labeled' || action === 'unlabeled') && label === ctx.config.autoMergeStopLabel) {
    await onAutoMergeSwitch(ctx, issue.number, action === 'labeled', sender);
    return;
  }
  if (action === 'closed') {
    await clearStateLabels(ctx, issue);
    await resolveDependents(ctx, issue.number);
    await closeParentIfDone(ctx, issue.number);
  }
}

/** 閉じた Issue に進み具合のラベルを残さない（hold は人の意思なので残す） */
async function clearStateLabels(ctx: GateContext, issue: { number: number; labels: { name: string }[] }): Promise<void> {
  const keep = new Set<string>([LABELS.hold, ctx.config.autoMergeStopLabel]);
  for (const l of issue.labels) {
    if (l.name.startsWith('agent:') && !keep.has(l.name)) await ctx.gh.removeLabel(issue.number, l.name);
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
  repository: { nameWithOwner: string };
  state: 'OPEN' | 'CLOSED';
  labels?: { nodes: { name: string }[] };
  blockedBy?: { nodes: { number: number; state: 'OPEN' | 'CLOSED' }[] };
}

async function resolveDependents(ctx: GateContext, number: number): Promise<void> {
  const data = await ctx.gh.graphql<{ repository: { issue: { blocking: { nodes: IssueNode[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){
      blocking(first:100){nodes{number state repository{nameWithOwner} labels(first:50){nodes{name}} blockedBy(first:100){nodes{number state}}}}}}}`,
    { owner: ctx.gh.owner, repo: ctx.gh.repo, n: number },
  );
  for (const dep of data.repository.issue.blocking.nodes) {
    if (dep.state !== 'OPEN' || dep.repository.nameWithOwner !== ctx.repository) continue;
    if (!hasLabel({ labels: dep.labels?.nodes ?? [] }, LABELS.waiting)) continue;
    const open = (dep.blockedBy?.nodes ?? []).filter((b) => b.state === 'OPEN');
    if (open.length > 0) continue;
    await ctx.gh.removeLabel(dep.number, LABELS.waiting);
    await appComment(ctx, dep.number, 'unblocked', `blocker（#${number} ほか）がすべて閉じたため \`agent:waiting\` を外しました。次の Routine の実行で再開します。`);
  }
}

async function closeParentIfDone(ctx: GateContext, number: number): Promise<void> {
  const data = await ctx.gh.graphql<{ repository: { issue: { parent: { number: number; state: string; repository: { nameWithOwner: string }; subIssues: { totalCount: number; nodes: { state: string }[] } } | null } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){
      parent{number state repository{nameWithOwner} subIssues(first:100){totalCount nodes{state}}}}}}`,
    { owner: ctx.gh.owner, repo: ctx.gh.repo, n: number },
  );
  const parent = data.repository.issue.parent;
  // 親が別リポジトリなら同じ番号のローカル Issue を閉じてしまわないよう何もしない
  if (!parent || parent.state !== 'OPEN' || parent.repository.nameWithOwner !== ctx.repository) return;
  if (parent.subIssues.totalCount > parent.subIssues.nodes.length) return;
  if (!parent.subIssues.nodes.every((s) => s.state === 'CLOSED')) return;
  await appComment(ctx, parent.number, 'parent-closed', 'Sub-issues がすべて閉じたため、この Issue を閉じます。');
  await ctx.gh.request('PATCH', `/issues/${parent.number}`, { body: { state: 'closed', state_reason: 'completed' } });
}

/** Jev に Issue を分類させ、提案をコメントする（シャドー。ラベルは付けない。失敗してもゲートは止めない） */
async function triageIssue(ctx: GateContext, number: number, title: string, contract: IssueContract): Promise<void> {
  if (ctx.config.classification.issueTriage !== 'shadow' || !ctx.secrets.jevApiKey) return;
  const r = await askJev(ctx.secrets.jevApiKey, buildTriageRequest(ctx.config, title, contract));
  if (r.status !== 'ok') {
    ctx.log(`Issue の分類に失敗しました: ${r.detail}`);
    return;
  }
  const summary = summarizeTriage(r.answers);
  await appComment(ctx, number, 'issue-triage', renderTriage(summary), { version: 1, model: r.model, answers: flattenAnswers(r.answers) });
}
