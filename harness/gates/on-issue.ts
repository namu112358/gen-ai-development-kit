import { appLogin, bypassMergeConfig, delegateMergeConfig, LABELS, PRIORITY_LABELS, priorityRank, reasonMark } from '../lib/config.ts';
import { parseIssueBody, type IssueContract } from '../lib/issue-form.ts';
import { parseTitle } from '../lib/title.ts';
import { buildTriageRequest, renderTriage, summarizeTriage } from '../lib/issue-triage.ts';
import { askJev, flattenAnswers } from '../lib/jev.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, findDashboard, hasLabel, isAgentPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute, writeDelegationEnd } from './apply.ts';
import { bypassArm, bypassFor, bypassRoute } from './bypass.ts';
import { endBypassMerge, onBypassSwitch } from './bypass-merge.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';
import { onDelegateSwitch, sweepExpiredDelegation } from './delegate-merge.ts';
import { delegatedArm, delegatedRoute, delegationFor } from './delegation.ts';
import { applyAppLabels, triageLabels } from './label-apply.ts';

/**
 * Issue の出来事ごとの処理。
 */

const PRIORITY_VALUES: string[] = Object.values(PRIORITY_LABELS);

/**
 * issues：
 * - 作成とタイトルの編集で、足りない type:*（と子を持つ Issue の epic）を付ける。App が前に付けた type:* だけ付け替える（label-apply.ts）
 * - agent:ready が付いたら Issue 本文を読み、読めなければ agent:blocked（静かに止めない）
 * - agent:plan-ok を App 以外が付けたら外す
 * - agent:hold が外されたら記録
 * - Close されたら依存解消（agent:waiting を外す）と親 Issue の Close
 * - ダッシュボードの停止スイッチ・委任のラベルの付け外し（delegate-merge.ts）・bypass のラベルの付け外し（bypass-merge.ts）
 * 処理に入る出来事では、その前に委任 Merge の期限切れを掃除する（API を呼ばない出来事では掃除しない）
 */
export async function onIssue(ctx: GateContext): Promise<void> {
  const action = ctx.event.action as string;
  const issue = ctx.event.issue as { number: number; body: string | null; labels: { name: string }[]; state: string };
  const sender = ctx.event.sender?.login as string | undefined;
  const label = ctx.event.label?.name as string | undefined;
  const sweep = () => sweepExpiredDelegation(ctx, new Date());

  if (action === 'opened' || (action === 'edited' && ctx.event.changes?.title)) {
    const { title, sub_issues_summary } = ctx.event.issue as { title: string; sub_issues_summary?: { total?: number } | null };
    if (title === ctx.config.dashboardIssueTitle || issue.state !== 'open') return;
    await sweep();
    const target = { kind: 'issue' as const, title, labels: issue.labels.map((l) => l.name), subIssues: sub_issues_summary?.total ?? 0 };
    await applyAppLabels(ctx, issue.number, target, () => ctx.gh.listComments(issue.number));
    return;
  }

  if (action === 'labeled' && label === LABELS.ready) {
    await sweep();
    const title = (ctx.event.issue as { title: string }).title;
    const body = parseIssueBody(issue.body);
    const titleCheck = parseTitle(title);
    const parsed = titleCheck.ok || title === ctx.config.dashboardIssueTitle ? body : { ok: false as const, errors: [...(body.ok ? [] : body.errors), titleCheck.ok ? '' : titleCheck.error].filter(Boolean) };
    if (parsed.ok) await triageIssue(ctx, issue, title, parsed.contract);
    if (!parsed.ok) {
      await ctx.gh.addLabels(issue.number, [LABELS.blocked]);
      await appComment(ctx, issue.number, 'form-error', [reasonMark('form-error'), 'Issue のタイトルか本文が書式に合いません。`agent:blocked` にしました。直してから `agent:blocked` を外してください。', '', ...parsed.errors.map((e) => `- ${e}`)].join('\n'));
    }
    return;
  }
  if (action === 'labeled' && label === LABELS.planOk && sender !== appLogin(ctx.config)) {
    await sweep();
    await ctx.gh.removeLabel(issue.number, LABELS.planOk);
    await appComment(ctx, issue.number, 'plan-ok-removed', `\`agent:plan-ok\` は App だけが付けられます。@${sender} が付けたため外しました。`);
    return;
  }
  if (action === 'unlabeled' && label === LABELS.hold) {
    await sweep();
    await appComment(ctx, issue.number, 'hold-removed', `\`agent:hold\` が @${sender} により外されました（記録）。`);
    return;
  }
  const priorities = issue.labels.map((l) => l.name).filter((n) => PRIORITY_VALUES.includes(n));
  if (action === 'labeled' && label?.startsWith('priority:') && priorities.length >= 2) {
    await sweep();
    const top = PRIORITY_VALUES[priorityRank(priorities)]!;
    await appComment(ctx, issue.number, 'priority-conflict', `${priorities.map((p) => `\`${p}\``).join('・')} が付いています。queue は最も高い \`${top}\` として扱います。1つにしてください。`);
    return;
  }
  if ((action === 'labeled' || action === 'unlabeled') && label === ctx.config.autoMergeStopLabel) {
    await sweep();
    await onAutoMergeSwitch(ctx, issue.number, action === 'labeled', sender);
    return;
  }
  if ((action === 'labeled' || action === 'unlabeled') && label === delegateMergeConfig(ctx.config).label) {
    await sweep();
    await onDelegateSwitch(ctx, issue.number, action === 'labeled', sender);
    return;
  }
  if ((action === 'labeled' || action === 'unlabeled') && label === bypassMergeConfig(ctx.config).label) {
    await sweep();
    await onBypassSwitch(ctx, issue.number, action === 'labeled', sender);
    return;
  }
  if (action === 'closed') {
    await sweep();
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

/**
 * 停止スイッチ（ダッシュボードの停止ラベル）の切り替え。止めたら auto-merge を外し（委任で付けたものには delegated-merge-end を残し、
 * bypass で付けたものには bypass-merge-end と human-review を出す）、再開したら条件を満たす PR（自動 Merge の対象と、
 * 委任が有効なら委任で乗るもの、bypass が有効なら bypass で乗るもの）に付け直す
 */
async function onAutoMergeSwitch(ctx: GateContext, number: number, stopped: boolean, sender: string | undefined): Promise<void> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (dashboard?.number !== number) return;
  await appComment(ctx, number, 'auto-merge-switch', `自動 Merge モードを${stopped ? '停止' : '再開'}しました（@${sender}）。`);
  const now = new Date();
  const delegation = stopped ? null : await delegationFor(ctx, now, dashboard);
  const bypass = stopped ? null : await bypassFor(ctx, dashboard);
  const open = await ctx.gh.paginate<PullRequest>('/pulls?state=open');
  for (const item of open) {
    const pr = await getPr(ctx, item.number);
    if (stopped) {
      const hadAuto = Boolean(pr.auto_merge);
      await disableAutoMerge(ctx, pr);
      await refreshMergeRoute(ctx, pr);
      // 委任で付けた auto-merge を外したことを残す（human-review は出さない。再開すれば付け直す）
      if (hadAuto && delegatedArm(ctx.config, await ctx.gh.listComments(pr.number))) await writeDelegationEnd(ctx, pr, 'stopped');
      // bypass で付けた auto-merge は、記録と人へのレビュー依頼を出す（Requirements。委任の stopped とはここが違う）
      if (hadAuto && bypassArm(ctx.config, await ctx.gh.listComments(pr.number))) await endBypassMerge(ctx, pr, 'stopped');
      continue;
    }
    if (!isAgentPr(ctx.config, pr, ctx.repository)) continue;
    const diff = await prDiff(ctx.gh, pr);
    const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(diff));
    const delegated = delegation !== null && delegatedRoute(delegation, acceptance, ctx.config, now).ok;
    const bypassed = bypass !== null && bypassRoute(bypass, acceptance).ok;
    if (acceptance && (acceptance.autoEligible || delegated || bypassed)) {
      await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff, ...(delegation ? { delegation } : {}), ...(bypass ? { bypass } : {}) });
    }
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

/**
 * Jev に Issue を分類させる（失敗してもゲートは止めない）。
 * - shadow：提案をコメントする（ラベルは付けない）
 * - label：提案のコメントを続け、そのうえで足りない priority:*・area:* だけを付ける（記録は label-triage 1つ）。問い済みなら何もしない
 */
async function triageIssue(ctx: GateContext, issue: { number: number; body: string | null; labels: { name: string }[] }, title: string, contract: IssueContract): Promise<void> {
  if (ctx.config.classification.issueTriage === 'label') {
    if (!ctx.secrets.jevApiKey) return;
    try {
      await triageLabels(ctx, { number: issue.number, title, body: issue.body, labels: issue.labels.map((l) => l.name) }, await ctx.gh.listComments(issue.number), { proposal: true });
    } catch (e) {
      ctx.log(`Issue の分類に失敗しました: ${(e as Error).message}`);
    }
    return;
  }
  const number = issue.number;
  if (ctx.config.classification.issueTriage !== 'shadow' || !ctx.secrets.jevApiKey) return;
  const r = await (ctx.askJev ?? askJev)(ctx.secrets.jevApiKey, buildTriageRequest(ctx.config, title, contract));
  if (r.status !== 'ok') {
    ctx.log(`Issue の分類に失敗しました: ${r.detail}`);
    return;
  }
  const summary = summarizeTriage(r.answers);
  await appComment(ctx, number, 'issue-triage', renderTriage(summary), { version: 1, model: r.model, answers: flattenAnswers(r.answers) });
}
