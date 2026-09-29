import { appMark } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig, LABELS, reasonOf, REASON_CODES } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import { labelAuditRows, renderAuditLines } from '../lib/label-rules.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, autoMergeMode, findDashboard, hasLabel, isAgentPr, prDiff, type DashboardIssue, type PullRequest } from '../lib/state.ts';
import { classifyBase } from '../lib/stack.ts';
import { enforceBase, refreshMergeRoute, resumeFromOrphan } from './apply.ts';
import { bypassArm, bypassFor, type BypassState } from './bypass.ts';
import { appComment, disableAutoMerge, getPr, judgingHold, updateBranchIfBehind, type GateContext } from './context.ts';
import { delegatedArm, delegationFor } from './delegation.ts';
import { reviewDelegatedPlans } from './on-comment.ts';

/**
 * 定期実行：停滞検知。24 時間動きがない Issue・PR、期限切れの人の claim、コンフリクトしている PR、
 * 人の対応待ち（blocked / plan-review）、必須ラベルの不足・違反を App のダッシュボード Issue に一覧化する。
 * 遅れている Agent PR（既定ブランチ宛て）を追従させる（判定中は除く）。
 * 計画の委任（委任承認）が有効なら、ゲートの停止で止まっている計画を最初に判定し直し（on-comment.ts の reviewDelegatedPlans）、
 * 委任承認の状態と委任で Merge された PR も書く。委任承認に期限は無いので、定期実行はラベルも auto-merge も外さない。
 * bypass モードの状態と、bypass で Merge された PR も書く。
 */

interface IssueItem {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
  user: { login: string } | null;
  sub_issues_summary?: { total?: number } | null;
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
 * 委任承認（計画＋Merge）が有効な間は、受け付けの delegate.eligible が真の PR の auto-merge も外さない。
 * bypass モードが有効な間は、受け付けの bypass.eligible が真の PR の auto-merge も外さない。
 */
async function reconcileAutoMerge(ctx: GateContext, now: Date): Promise<number> {
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  let delegation: DelegateState | undefined;
  let bypass: BypassState | undefined;
  let fixed = 0;
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5)) {
    if (!item.auto_merge) continue;
    const pr = await getPr(ctx, item.number);
    const agent = isAgentPr(ctx.config, pr, ctx.repository);
    const acceptance = agent ? acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patchId(await prDiff(ctx.gh, pr))) : null;
    // base が既定ブランチでない PR（Stacked PR・orphan-base）の auto-merge は外す（stacked のイベントを取りこぼした場合の戻り道）
    const onDefault = classifyBase(pr, ctx.config.defaultBranch) === 'default';
    // 委任の状態は、委任で乗りうる受け付けがあったときだけ読む（ラベルが無ければダッシュボードを探すだけ）
    const delegated = acceptance !== null && !acceptance.autoEligible && acceptance.reviewPass && acceptance.delegate?.eligible === true
      && (delegation ??= await delegationFor(ctx, now)).active;
    // bypass の状態も、bypass で乗りうる受け付けがあったときだけ読む
    const bypassed = !delegated && acceptance !== null && !acceptance.autoEligible && acceptance.reviewPass && acceptance.bypass?.eligible === true
      && (bypass ??= await bypassFor(ctx)).active;
    if (agent && mode && !hasLabel(pr, LABELS.hold) && (acceptance?.autoEligible || delegated || bypassed) && onDefault) {
      await updateBranchIfBehind(ctx, pr);
      continue;
    }
    await disableAutoMerge(ctx, pr);
    await refreshMergeRoute(ctx, pr);
    await appComment(ctx, pr.number, 'auto-merge-removed', '自動 Merge の条件を満たさない auto-merge が付いていたため外しました（定期照合）。');
    fixed++;
  }
  return fixed;
}

/**
 * base の見直し（stacked のイベントを取りこぼした場合の戻り道）。一覧の stack・base で default でない PR だけ取り直し、
 * orphan-base なら Draft に留め、orphan-base の記録のまま orphan-base でなくなっていれば通常の流れに戻す。
 */
async function reconcileBases(ctx: GateContext, items: PullRequest[]): Promise<number> {
  let touched = 0;
  for (const item of items) {
    if (classifyBase(item, ctx.config.defaultBranch) === 'default') continue;
    const pr = await getPr(ctx, item.number);
    if (pr.state !== 'open') continue;
    const kind = classifyBase(pr, ctx.config.defaultBranch);
    if (kind === 'orphan-base') {
      await enforceBase(ctx, pr);
      touched++;
    } else if (await resumeFromOrphan(ctx, pr, kind)) {
      touched++;
    }
  }
  return touched;
}

/**
 * 定期の追従（main への push が来ない間に判定が終わった PR の戻り道）。既定ブランチ宛てで、衝突しておらず auto-merge の無い Agent PR だけ。
 * auto-merge の PR は reconcileAutoMerge が、Stacked PR の層は main への push が扱う。失敗はログに残し、定期の処理（ダッシュボードの書き換え）を落とさない
 */
async function followOnSchedule(ctx: GateContext, pr: PullRequest, now: Date): Promise<void> {
  if (pr.mergeable_state === 'dirty' || pr.auto_merge) return;
  if (classifyBase(pr, ctx.config.defaultBranch) !== 'default') return;
  try {
    await updateBranchIfBehind(ctx, pr, () => judgingHold(ctx, pr, now));
  } catch (e) {
    ctx.log(`#${pr.number} の追従を確かめられませんでした（定期）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 委任承認の状態。読めなければ null（ログだけ書く） */
async function readDelegation(ctx: GateContext, dashboard: DashboardIssue | null, now: Date): Promise<DelegateState | null> {
  try {
    return await delegationFor(ctx, now, dashboard);
  } catch (e) {
    ctx.log(`委任承認の状態を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/** ダッシュボードの委任承認の状態の行（計画＋Merge・計画のみ・無効） */
function delegateLine(ctx: GateContext, dashboard: DashboardIssue | null, state: DelegateState | null): string {
  const { planLabel, mergeLabel } = delegateConfig(ctx.config);
  const how = `このダッシュボードに \`${planLabel}\` を付けると計画ゲートの承認だけを、\`${mergeLabel}\` を付けると計画ゲートの承認と Merge を App に委ねます。docs/risk-policy.md`;
  if (!dashboard || (!hasLabel(dashboard, planLabel) && !hasLabel(dashboard, mergeLabel))) return `**委任承認: 無効**（${how}）`;
  if (!state) return '**委任承認: 状態を読めませんでした**（委任のラベルは付いています）';
  if (state.mode === 'plan+merge') return `**委任承認: 計画＋Merge**（@${state.by}、${state.since} から。このダッシュボードの \`${mergeLabel}\` を外すと終わります）`;
  if (state.mode === 'plan') return `**委任承認: 計画のみ**（@${state.by}、${state.since} から。このダッシュボードの \`${planLabel}\` を外すと終わります）`;
  return `**委任承認: 無効**（委任のラベルは付いていますが、${state.reason}）`;
}

/** ダッシュボードの bypass モードの状態の行 */
async function bypassLine(ctx: GateContext, dashboard: DashboardIssue | null): Promise<string> {
  const { label } = bypassMergeConfig(ctx.config);
  if (!dashboard || !hasLabel(dashboard, label)) {
    return `**bypass モード: 無効**（このダッシュボードに \`${label}\` を付けると、外すまで、ブロッキング指摘が無く範囲照合と agent/tests を通る Agent PR を Human Merge の理由を飛ばして自動 Merge します。docs/risk-policy.md）`;
  }
  let state: BypassState;
  try {
    state = await bypassFor(ctx, dashboard);
  } catch (e) {
    ctx.log(`bypass モードの状態を読めませんでした: ${(e as Error).message}`);
    return `**bypass モード: 状態を読めませんでした**（\`${label}\` は付いています）`;
  }
  return state.active
    ? `**bypass モード: 有効**（@${state.by}、期限なし。このダッシュボードの \`${label}\` を外すと終わります）`
    : `**bypass モード: 無効**（\`${label}\` は付いていますが、${state.reason}）`;
}

/**
 * bypass で Merge された PR（直近 staleHours 時間）。閉じた PR の一覧（1ページ）のうち、Merge が staleHours 以内で、
 * 最後の bypass の記録が bypass-merge のもの。ラベルの有無にかかわらず読む。読めなければ null。
 */
async function bypassMerged(ctx: GateContext, now: Date, staleMs: number): Promise<string[] | null> {
  try {
    const closed = await ctx.gh.paginate<PullRequest>('/pulls?state=closed&sort=updated&direction=desc', 1);
    const rows: string[] = [];
    for (const pr of closed) {
      if (!pr.merged_at || now.getTime() - new Date(pr.merged_at).getTime() > staleMs) continue;
      const arm = bypassArm(ctx.config, await ctx.gh.listComments(pr.number));
      if (arm) rows.push(`- [#${pr.number}](${pr.html_url}) ${pr.title} — Merge ${pr.merged_at}（bypass：@${arm.by}）`);
    }
    return rows;
  } catch (e) {
    ctx.log(`bypass で Merge された PR を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 委任承認（計画＋Merge）で Merge された PR（直近 staleHours 時間）。閉じた PR の一覧（1ページ）のうち、Merge が staleHours 以内で、
 * 最後の委任の記録が delegated-merge のもの。ラベルの有無にかかわらず読む（ラベルを外した後も一覧に出す）。読めなければ null。
 */
async function delegatedMerged(ctx: GateContext, now: Date, staleMs: number): Promise<string[] | null> {
  try {
    const closed = await ctx.gh.paginate<PullRequest>('/pulls?state=closed&sort=updated&direction=desc', 1);
    const rows: string[] = [];
    for (const pr of closed) {
      if (!pr.merged_at || now.getTime() - new Date(pr.merged_at).getTime() > staleMs) continue;
      const arm = delegatedArm(ctx.config, await ctx.gh.listComments(pr.number));
      if (arm) rows.push(`- [#${pr.number}](${pr.html_url}) ${pr.title} — Merge ${pr.merged_at}（委任承認：@${arm.by}、${arm.since} から）`);
    }
    return rows;
  } catch (e) {
    ctx.log(`委任承認で Merge された PR を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

export async function onSchedule(ctx: GateContext, now: Date = new Date()): Promise<void> {
  // 計画の委任が有効なら、ゲートの停止で止まっている計画を判定し直す。失敗してもダッシュボードの更新は止めない
  const delegation = await readDelegation(ctx, await findDashboard(ctx.gh, ctx.config), now);
  if (delegation?.planActive) {
    try {
      await reviewDelegatedPlans(ctx, now, delegation);
    } catch (e) {
      ctx.log(`止まっている計画の判定し直しに失敗しました: ${(e as Error).message}`);
    }
  }
  const reconciled = await reconcileAutoMerge(ctx, now);
  const staleMs = ctx.config.staleHours * 3600_000;
  const age = (iso: string) => now.getTime() - new Date(iso).getTime();
  const issues = await ctx.gh.paginate<IssueItem>('/issues?state=open', 10);
  const agentItems = issues.filter((i) => i.labels.some((l) => l.name.startsWith('agent:')) && i.title !== ctx.config.dashboardIssueTitle);

  const needsHuman = agentItems.filter((i) => i.labels.some((l) => l.name === LABELS.blocked || l.name === LABELS.planReview));
  const stale = agentItems.filter((i) => age(i.updated_at) > staleMs && !needsHuman.includes(i));
  // 人の対応待ちは理由コード別に並べる（理由が無いものは目立たせる）
  const reasons = new Map<number, string>();
  for (const i of needsHuman) {
    const comments = await ctx.gh.listComments(i.number);
    const code = [...comments].reverse().map((c) => reasonOf(c.body)).find((r) => r !== null) ?? null;
    reasons.set(i.number, code ? `${code}（${REASON_CODES[code]}）` : '理由なし（要確認）');
  }
  const byReason = [...needsHuman].sort((a, b) => reasons.get(a.number)!.localeCompare(reasons.get(b.number)!));

  const prs = await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5);
  const bases = await reconcileBases(ctx, prs);
  const conflicts: PullRequest[] = [];
  const stalePrs: PullRequest[] = [];
  for (const item of prs.filter((p) => isAgentPr(ctx.config, p, ctx.repository))) {
    const pr = await ctx.gh.get<PullRequest>(`/pulls/${item.number}`);
    if (pr.mergeable_state === 'dirty') conflicts.push(pr);
    else if (age(pr.updated_at) > staleMs) stalePrs.push(pr);
    await followOnSchedule(ctx, pr, now);
  }
  const labelProblems = renderAuditLines(labelAuditRows(ctx.config, ctx.repository, issues, prs));
  const delegatedRows = await delegatedMerged(ctx, now, staleMs);
  const bypassRows = await bypassMerged(ctx, now, staleMs);

  const line = (i: { number: number; title: string; html_url: string }, extra = '') => `- [#${i.number}](${i.html_url}) ${i.title}${extra}`;
  const section = (title: string, rows: string[]) => [`### ${title}（${rows.length}）`, '', ...(rows.length ? rows : ['なし']), ''];
  const body = [
    appMark('dashboard'),
    `最終更新: ${now.toISOString()}（${ctx.config.staleHours} 時間動きがないものを停滞とみなします）`,
    '',
    ...section('人の対応待ち（blocked / plan-review）', byReason.map((i) => line(i, ` — ${reasons.get(i.number)}`))),
    ...section('コンフリクトしている Agent PR（CI が動きません）', conflicts.map((p) => line(p))),
    ...section('停滞している Agent PR', stalePrs.map((p) => line(p))),
    ...section('停滞している Issue', stale.map((i) => line(i))),
    ...section('ラベルが足りない Issue・PR', labelProblems),
    ...(delegatedRows === null
      ? [`### 委任承認で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, '', '読めませんでした', '']
      : section(`委任承認で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, delegatedRows)),
    ...(bypassRows === null
      ? [`### bypass で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, '', '読めませんでした', '']
      : section(`bypass で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, bypassRows)),
    '失敗した Actions の実行は [Actions](../../actions?query=is%3Afailure) を確認してください。',
  ].join('\n');

  const dashboard = await ensureDashboard(ctx);
  const current = await findDashboard(ctx.gh, ctx.config);
  const stopped = !current || hasLabel(current, ctx.config.autoMergeStopLabel);
  const mode = stopped
    ? `**自動 Merge モード: 停止中**（このダッシュボードの \`${ctx.config.autoMergeStopLabel}\` ラベルを外すと有効になります。docs/operations.md）`
    : `**自動 Merge モード: 有効**（このダッシュボードに \`${ctx.config.autoMergeStopLabel}\` ラベルを付けると一斉に止まります）`;
  const withMode = body.replace(appMark('dashboard'), `${appMark('dashboard')}\n${mode}\n${delegateLine(ctx, current, delegation)}\n${await bypassLine(ctx, current)}\n`);
  const existing = (await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`)).body ?? '';
  const queueStart = existing.indexOf('<!-- agent-harness:queue:start -->');
  // queue 節は publishQueue が書く。停滞検知の書き換えで消さないよう残す
  const kept = queueStart >= 0 ? `${withMode}\n\n${existing.slice(queueStart)}` : withMode;
  await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body: kept } });
  ctx.log(`auto-merge reconciled=${reconciled}; bases reconciled=${bases}; dashboard #${dashboard} updated: blocked=${needsHuman.length} conflicts=${conflicts.length} stalePRs=${stalePrs.length} staleIssues=${stale.length} labelProblems=${labelProblems.length}`);
}
