import { appMark } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, autoMergeMode, findDashboard, hasLabel, isAgentPr, prDiff, type PullRequest } from '../lib/state.ts';
import { refreshMergeRoute } from './apply.ts';
import { appComment, disableAutoMerge, getPr, type GateContext } from './context.ts';

/**
 * 定期実行：停滞検知。24 時間動きがない Issue・PR、期限切れの人の claim、コンフリクトしている PR、
 * 人の対応待ち（blocked / plan-review）を App のダッシュボード Issue に一覧化する。
 */

interface IssueItem {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
  user: { login: string } | null;
}

/** ダッシュボード Issue を用意する。新規作成時は自動 Merge モードを停止した状態で作る（安全側） */
export async function ensureDashboard(ctx: GateContext): Promise<number> {
  const found = await findDashboard(ctx.gh, ctx.config);
  if (found) return found.number;
  const created = await ctx.gh.request<{ number: number }>('POST', '/issues', {
    body: {
      title: ctx.config.dashboardIssueTitle,
      body: `${appMark('dashboard')}\n準備中`,
      labels: [ctx.config.autoMergeStopLabel],
    },
  });
  return created.number;
}

/**
 * auto-merge が付いた PR を照合し直す。自動 Merge の条件を満たさないものは auto-merge を外し、merge-route を書き直す。
 * GITHUB_TOKEN による auto-merge の設定は workflow を起動しないため、イベントだけでは拾えない。
 */
async function reconcileAutoMerge(ctx: GateContext): Promise<number> {
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  let fixed = 0;
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5)) {
    if (!item.auto_merge) continue;
    const pr = await getPr(ctx, item.number);
    const agent = isAgentPr(ctx.config, pr, ctx.repository);
    const acceptance = agent ? acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(await prDiff(ctx.gh, pr))) : null;
    if (agent && mode && !hasLabel(pr, LABELS.hold) && acceptance?.autoEligible) continue;
    await disableAutoMerge(ctx, pr);
    await refreshMergeRoute(ctx, pr);
    await appComment(ctx, pr.number, 'auto-merge-removed', '自動 Merge の条件を満たさない auto-merge が付いていたため外しました（定期照合）。');
    fixed++;
  }
  return fixed;
}

export async function onSchedule(ctx: GateContext, now: Date = new Date()): Promise<void> {
  const reconciled = await reconcileAutoMerge(ctx);
  const staleMs = ctx.config.staleHours * 3600_000;
  const humanClaimMs = ctx.config.routine.humanClaimStaleHours * 3600_000;
  const age = (iso: string) => now.getTime() - new Date(iso).getTime();
  const issues = await ctx.gh.paginate<IssueItem>('/issues?state=open', 10);
  const agentItems = issues.filter((i) => i.labels.some((l) => l.name.startsWith('agent:')) && i.title !== ctx.config.dashboardIssueTitle);

  const needsHuman = agentItems.filter((i) => i.labels.some((l) => l.name === LABELS.blocked || l.name === LABELS.planReview));
  const stale = agentItems.filter((i) => age(i.updated_at) > staleMs && !needsHuman.includes(i));
  const humanClaims = agentItems.filter((i) => i.labels.some((l) => l.name === LABELS.working) && age(i.updated_at) > humanClaimMs);

  const prs = await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5);
  const conflicts: PullRequest[] = [];
  const stalePrs: PullRequest[] = [];
  for (const item of prs.filter((p) => isAgentPr(ctx.config, p, ctx.repository))) {
    const pr = await ctx.gh.get<PullRequest>(`/pulls/${item.number}`);
    if (pr.mergeable_state === 'dirty') conflicts.push(pr);
    else if (age(pr.updated_at) > staleMs) stalePrs.push(pr);
  }

  const line = (i: { number: number; title: string; html_url: string }, extra = '') => `- [#${i.number}](${i.html_url}) ${i.title}${extra}`;
  const section = (title: string, rows: string[]) => [`### ${title}（${rows.length}）`, '', ...(rows.length ? rows : ['なし']), ''];
  const body = [
    appMark('dashboard'),
    `最終更新: ${now.toISOString()}（${ctx.config.staleHours} 時間動きがないものを停滞とみなします）`,
    '',
    ...section('人の対応待ち（blocked / plan-review）', needsHuman.map((i) => line(i, ` — ${i.labels.map((l) => `\`${l.name}\``).join(' ')}`))),
    ...section('コンフリクトしている Agent PR（CI が動きません）', conflicts.map((p) => line(p))),
    ...section('停滞している Agent PR', stalePrs.map((p) => line(p))),
    ...section('停滞している Issue', stale.map((i) => line(i))),
    ...section(`${ctx.config.routine.humanClaimStaleHours} 時間以上進展のない着手（agent:working）`, humanClaims.map((i) => line(i))),
    '失敗した Actions の実行は [Actions](../../actions?query=is%3Afailure) を確認してください。',
  ].join('\n');

  const dashboard = await ensureDashboard(ctx);
  const current = await findDashboard(ctx.gh, ctx.config);
  const stopped = !current || hasLabel(current, ctx.config.autoMergeStopLabel);
  const mode = stopped
    ? `**自動 Merge モード: 停止中**（このダッシュボードの \`${ctx.config.autoMergeStopLabel}\` ラベルを外すと有効になります。docs/operations.md）`
    : `**自動 Merge モード: 有効**（このダッシュボードに \`${ctx.config.autoMergeStopLabel}\` ラベルを付けると一斉に止まります）`;
  const withMode = body.replace(appMark('dashboard'), `${appMark('dashboard')}\n${mode}\n`);
  const existing = (await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`)).body ?? '';
  const queueStart = existing.indexOf('<!-- agent-harness:queue:start -->');
  // queue 節は publishQueue が書く。停滞検知の書き換えで消さないよう残す
  const kept = queueStart >= 0 ? `${withMode}\n\n${existing.slice(queueStart)}` : withMode;
  await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body: kept } });
  ctx.log(`auto-merge reconciled=${reconciled}; dashboard #${dashboard} updated: blocked=${needsHuman.length} conflicts=${conflicts.length} stalePRs=${stalePrs.length} staleIssues=${stale.length}`);
}
