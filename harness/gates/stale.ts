import { autoModeConfig, autoModeDanger, type AutoModeState } from '../lib/auto-mode.ts';
import { appMark, hasClaudeMark } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig, LABELS, reasonOf, REASON_CODES } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import { labelAuditRows, renderAuditLines } from '../lib/label-rules.ts';
import type { IssueComment } from '../lib/github.ts';
import { patchId } from '../lib/patch-id.ts';
import { claimOf } from '../lib/facts.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { acceptanceForPatch, appRecords, autoMergeMode, findDashboard, hasLabel, isAgentPr, isTrustedComment, latestPlanGate, linkedIssues, prDiff, type DashboardIssue, type PullRequest } from '../lib/state.ts';
import { classifyBase } from '../lib/stack.ts';
import { renderStalledClaimLine, stalledCandidate, stalledClaimMinutes, stalledClaims, type StalledClaimInput } from '../lib/stalled-claim.ts';
import { renderUnclaimedJudgeLine, unclaimedJudgeCandidate, unclaimedJudgePrs, type UnclaimedJudgeInput } from '../lib/unclaimed-judge.ts';
import { renderUnownedConflictLine, unownedConflicts, type UnownedConflictInput } from '../lib/unowned-conflict.ts';
import { enforceBase, refreshMergeRoute, resumeFromOrphan, rewriteTestsCheck, writeAutoModeEnd } from './apply.ts';
import { AUTO_MODE_MERGE_END_TEXT, autoModeArm, autoModeFor, autoModeRoute, type AutoModeMergeEndReason } from './auto-mode.ts';
import { bypassArm, bypassFor, type BypassState } from './bypass.ts';
import { appComment, disableAutoMerge, getPr, judgingHold, updateBranchIfBehind, type GateContext } from './context.ts';
import { delegatedArm, delegationFor } from './delegation.ts';
import type { EpicUnassignedRow } from './epic-triage.ts';
import { reviewAutoModePlans, reviewDelegatedPlans } from './on-comment.ts';

/**
 * 定期実行：停滞検知。24 時間動きがない Issue・PR、期限切れの人の claim、コンフリクトしている PR、
 * 人の対応待ち（blocked / plan-review）、必須ラベルの不足・違反を App のダッシュボード Issue に一覧化する。
 * 遅れている Agent PR（既定ブランチ宛て）を追従させる（判定中は除く）。
 * 計画の委任（委任承認）が有効なら、ゲートの停止で止まっている計画を最初に判定し直し（on-comment.ts の reviewDelegatedPlans）、
 * 委任承認の状態と委任で Merge された PR も書く。委任承認に期限は無いので、定期実行はラベルも auto-merge も外さない。
 * bypass モードの状態と、bypass で Merge された PR も書く。
 * auto mode（Epic #339）が有効なら、止まっている計画を委任の後に auto mode で判定し直し（on-comment.ts の reviewAutoModePlans）、
 * auto mode で乗る PR の auto-merge を外さない（順番は 自動 Merge の対象 → 委任 → auto mode → bypass）。auto mode で付けた auto-merge を
 * 外す・ほかの乗り方に引き継ぐときは終わりの記録（auto-mode-merge-end）を書く（イベントの取りこぼしの戻り道）。
 * ダッシュボードに auto mode の状態の行と、直近 staleHours 時間に auto mode で通した計画・保留にした計画・Merge した PR・保留にした PR を書く。
 * 衝突している Agent PR のうち持ち主のいないもの（PR と Close する Issue の着手宣言が期限切れか無い）は、人の対応待ちに
 * 「引き継ぐか決める」の行でも出す（判定は lib/unowned-conflict.ts。引き継ぐかは人が決める）。
 * judge・fix・sync の着手宣言の後に routine.stalledClaimMinutes 分動きの無い Agent PR を「止まっていそうな着手宣言」の節に出す（判定は lib/stalled-claim.ts。知らせるだけ）。
 * 宣言が無く今の差分の判定の受け付けも無い Agent PR を「担当のいない判定待ちの PR」の節に出す（判定は lib/unclaimed-judge.ts。知らせるだけ。Issue #493）。
 * 引数 opts.epicUnassigned があるときだけ、Epic に入っていない Issue を Jev の一番高い Epic つきで「Epic に入っていない Issue」の節に出す（Issue #565）。
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
async function reconcileAutoMerge(ctx: GateContext, now: Date, dashboard: DashboardIssue | null, known?: AutoModeState): Promise<number> {
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  let delegation: DelegateState | undefined;
  let bypass: BypassState | undefined;
  let autoMode = known;
  let fixed = 0;
  for (const item of await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5)) {
    if (!item.auto_merge) continue;
    const pr = await getPr(ctx, item.number);
    const agent = isAgentPr(ctx.config, pr, ctx.repository);
    const comments = agent ? await ctx.gh.listComments(pr.number) : [];
    const diff = agent ? await prDiff(ctx.gh, pr) : null;
    const acceptance = diff !== null ? acceptanceForPatch(ctx.config, comments, patchId(diff)) : null;
    // auto mode で付けたまま終わっていない記録（外す・引き継ぐときに終わりの記録を書く）
    const armed = agent ? autoModeArm(ctx.config, comments) : null;
    // base が既定ブランチでない PR（Stacked PR・orphan-base）の auto-merge は外す（stacked のイベントを取りこぼした場合の戻り道）
    const onDefault = classifyBase(pr, ctx.config.defaultBranch) === 'default';
    // 委任の状態は、委任で乗りうる受け付けがあったときだけ読む（ラベルが無ければダッシュボードを探すだけ）
    const delegated = acceptance !== null && !acceptance.autoEligible && acceptance.reviewPass && acceptance.delegate?.eligible === true
      && (delegation ??= await delegationFor(ctx, now)).active;
    // auto mode の状態も、auto mode で乗りうる受け付けがあったときだけ読む（順番は 委任 → auto mode → bypass）
    const autoModed = !delegated && acceptance !== null && !acceptance.autoEligible && acceptance.reviewPass && acceptance.autoMode?.eligible === true
      && autoModeRoute((autoMode ??= await autoModeFor(ctx, dashboard)), acceptance).ok;
    // bypass の状態も、bypass で乗りうる受け付けがあったときだけ読む
    const bypassed = !delegated && !autoModed && acceptance !== null && !acceptance.autoEligible && acceptance.reviewPass && acceptance.bypass?.eligible === true
      && (bypass ??= await bypassFor(ctx)).active;
    if (agent && mode && !hasLabel(pr, LABELS.hold) && (acceptance?.autoEligible || delegated || autoModed || bypassed) && onDefault) {
      // auto mode の終わりを取りこぼし、委任か bypass で乗り続ける PR：auto-merge は残し、auto mode の終わりの記録だけ書く
      if (armed && !autoModed && !acceptance?.autoEligible) {
        await writeAutoModeEnd(ctx, pr, autoModeEndReason(ctx, mode, dashboard), delegated ? '委任承認（計画＋Merge）で自動経路を続けます。' : 'bypass モードで自動経路を続けます。');
      }
      await updateBranchIfBehind(ctx, pr);
      continue;
    }
    await disableAutoMerge(ctx, pr);
    const refreshed = await refreshMergeRoute(ctx, pr);
    await appComment(ctx, pr.number, 'auto-merge-removed', '自動 Merge の条件を満たさない auto-merge が付いていたため外しました（定期照合）。');
    if (armed) {
      // auto mode で乗る前提で書いた agent/tests を Human Merge として書き直し、終わりの記録を残す（human-review は今までの定期照合と同じく出さない）
      const reason = autoModeEndReason(ctx, mode, dashboard);
      const off: AutoModeState = { active: false, since: null, by: null, reason: AUTO_MODE_MERGE_END_TEXT[reason] };
      if (refreshed && diff !== null) await rewriteTestsCheck(ctx, pr, refreshed, diff, undefined, undefined, off);
      await writeAutoModeEnd(ctx, pr, reason);
    }
    fixed++;
  }
  return fixed;
}

/** 定期照合で auto mode の終わりの記録に書く理由：停止スイッチ → stopped、ダッシュボードに auto mode のラベルが無い → removed、ほかは ineligible */
function autoModeEndReason(ctx: GateContext, mode: boolean, dashboard: DashboardIssue | null): AutoModeMergeEndReason {
  if (!mode) return 'stopped';
  if (!dashboard || !hasLabel(dashboard, autoModeConfig(ctx.config).label)) return 'removed';
  return 'ineligible';
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

/** auto mode の状態。読めなければ null（ログだけ書く） */
async function readAutoMode(ctx: GateContext, dashboard: DashboardIssue | null): Promise<AutoModeState | null> {
  try {
    return await autoModeFor(ctx, dashboard);
  } catch (e) {
    ctx.log(`auto mode の状態を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/** ダッシュボードの auto mode の状態の行（有効・無効と付けた人・無効の理由） */
function autoModeLine(ctx: GateContext, dashboard: DashboardIssue | null, state: AutoModeState | null): string {
  const { label } = autoModeConfig(ctx.config);
  if (!dashboard || !hasLabel(dashboard, label)) {
    return `**auto mode: 無効**（このダッシュボードに \`${label}\` を付けると、外すまで計画ゲートと Merge を App に任せ、Jev が危険と答えた計画・Agent PR だけを人の判断に保留します。docs/risk-policy.md）`;
  }
  if (!state) return `**auto mode: 状態を読めませんでした**（\`${label}\` は付いています）`;
  return state.active
    ? `**auto mode: 有効**（@${state.by}、${state.since ?? '時刻不明'} から、期限なし。このダッシュボードの \`${label}\` を外すと終わります）`
    : `**auto mode: 無効**（\`${label}\` は付いていますが、${state.reason}）`;
}

/**
 * auto mode で通した計画・保留にした計画（直近 staleHours 時間）。最近更新された Issue（1ページ。PR と、agent:plan-ok・agent:plan-review の
 * どちらも無い Issue は読まない）の最新の plan-gate の記録が staleHours 以内で auto mode の記録を持つもの。Issue ごとに最新の記録だけを見るので、
 * 1つの Issue はどちらか一方にだけ出る。ラベルの有無にかかわらず読む。読めなければ null。
 */
async function autoModePlans(ctx: GateContext, now: Date, staleMs: number): Promise<{ passed: string[]; held: string[] } | null> {
  try {
    const since = new Date(now.getTime() - staleMs).toISOString();
    const items = await ctx.gh.paginate<IssueItem>(`/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}`, 1);
    const passed: string[] = [];
    const held: string[] = [];
    for (const i of items) {
      if (i.pull_request || (!hasLabel(i, LABELS.planOk) && !hasLabel(i, LABELS.planReview))) continue;
      const latest = latestPlanGate(ctx.config, await ctx.gh.listComments(i.number));
      const a = latest?.value.autoMode;
      if (!latest || !a || now.getTime() - new Date(latest.comment.created_at).getTime() > staleMs) continue;
      const head = `- [#${i.number}](${i.html_url}) ${i.title} — ${latest.comment.created_at}`;
      if (a.hold) held.push(`${head}（保留の理由: ${a.reasons.join('／')}）`);
      else if (latest.value.pass) passed.push(`${head}（auto mode：@${a.by}。飛ばした理由: ${a.skipped.join('／')}）`);
    }
    return { passed, held };
  } catch (e) {
    ctx.log(`auto mode で通した・保留にした計画を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/**
 * auto mode で Merge された PR（直近 staleHours 時間）。閉じた PR の一覧（1ページ）のうち、Merge が staleHours 以内で、
 * 最後の auto mode の記録が auto-mode-merge のもの。ラベルの有無にかかわらず読む。読めなければ null。
 */
async function autoModeMerged(ctx: GateContext, now: Date, staleMs: number): Promise<string[] | null> {
  try {
    const closed = await ctx.gh.paginate<PullRequest>('/pulls?state=closed&sort=updated&direction=desc', 1);
    const rows: string[] = [];
    for (const pr of closed) {
      if (!pr.merged_at || now.getTime() - new Date(pr.merged_at).getTime() > staleMs) continue;
      const arm = autoModeArm(ctx.config, await ctx.gh.listComments(pr.number));
      if (arm) rows.push(`- [#${pr.number}](${pr.html_url}) ${pr.title} — Merge ${pr.merged_at}（auto mode：@${arm.by}）`);
    }
    return rows;
  } catch (e) {
    ctx.log(`auto mode で Merge された PR を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/**
 * auto mode で保留にした PR（直近 staleHours 時間。auto mode が有効な間だけ呼ぶ）。開いた Agent PR のうち auto-merge が付いておらず
 * （委任・bypass でも乗っていない）、最新の受け付けの記録が staleHours 以内で、合格・自動 Merge の対象外で、Jev の危険の判定で保留のもの。読めなければ null。
 */
async function autoModeHeldPrs(ctx: GateContext, now: Date, staleMs: number, prs: PullRequest[]): Promise<string[] | null> {
  try {
    const rows: string[] = [];
    for (const pr of prs) {
      if (pr.auto_merge) continue;
      const last = appRecords<Acceptance>(ctx.config, await ctx.gh.listComments(pr.number), 'acceptance').at(-1);
      const jev = last?.value.autoMode?.jev;
      if (!last || !jev || !last.value.reviewPass || last.value.autoEligible) continue;
      if (now.getTime() - new Date(last.comment.created_at).getTime() > staleMs) continue;
      const danger = autoModeDanger(ctx.config, { jev });
      if (danger.hold) rows.push(`- [#${pr.number}](${pr.html_url}) ${pr.title} — ${last.comment.created_at}（保留の理由: ${danger.reasons.join('／')}）`);
    }
    return rows;
  } catch (e) {
    ctx.log(`auto mode で保留にした PR を読めませんでした: ${(e as Error).message}`);
    return null;
  }
}

/**
 * 衝突している PR ごとに、PR と Close する Issue の着手宣言を読む。PR のコメントは読んであれば使い回す（prComments）。
 * 読めなかった PR はログに残して飛ばす（ダッシュボードの更新は止めない）
 */
async function conflictClaims(ctx: GateContext, conflicts: PullRequest[], prComments: Map<number, IssueComment[]>): Promise<UnownedConflictInput[]> {
  const inputs: UnownedConflictInput[] = [];
  for (const pr of conflicts) {
    try {
      const issues = await linkedIssues(ctx.gh, ctx.config, pr);
      const claims = [claimOf(prComments.get(pr.number) ?? await ctx.gh.listComments(pr.number))];
      for (const n of issues) claims.push(claimOf(await ctx.gh.listComments(n)));
      inputs.push({ pr: { number: pr.number, title: pr.title, html_url: pr.html_url }, issues, claims });
    } catch (e) {
      ctx.log(`#${pr.number} の着手宣言を読めませんでした（引き継ぐか決めるの行に出しません）: ${(e as Error).message}`);
    }
  }
  return inputs;
}

/**
 * Agent PR ごとに PR の宣言を読み、judge・fix・sync の宣言で時間を過ぎた候補だけ head の commit の時刻を読む（lib/stalled-claim.ts）。
 * コメントは prComments に入れて衝突の判定でも使う。読めなかった PR・commit はログに残して出さない（ダッシュボードの更新は止めない）
 */
async function stalledClaimInputs(ctx: GateContext, prs: PullRequest[], now: Date, minutes: number, prComments: Map<number, IssueComment[]>): Promise<StalledClaimInput[]> {
  const inputs: StalledClaimInput[] = [];
  for (const pr of prs) {
    let comments: IssueComment[];
    try {
      comments = await ctx.gh.listComments(pr.number);
    } catch (e) {
      ctx.log(`#${pr.number} のコメントを読めませんでした（止まっていそうな着手宣言に出しません）: ${(e as Error).message}`);
      continue;
    }
    prComments.set(pr.number, comments);
    const claim = claimOf(comments);
    if (!stalledCandidate(claim, now, minutes)) continue;
    let headCommitAt: string | null;
    try {
      const commit = await ctx.gh.get<{ commit?: { committer?: { date?: string | null } | null } }>(`/commits/${pr.head.sha}`);
      headCommitAt = commit.commit?.committer?.date ?? null;
    } catch (e) {
      ctx.log(`#${pr.number} の head の commit を読めませんでした（止まっていそうな着手宣言に出しません）: ${(e as Error).message}`);
      continue;
    }
    if (headCommitAt === null) ctx.log(`#${pr.number} の head の commit の時刻がありません（止まっていそうな着手宣言に出しません）`);
    inputs.push({ pr: { number: pr.number, title: pr.title, html_url: pr.html_url }, claim, headCommitAt });
  }
  return inputs;
}

/**
 * Agent PR ごとに、宣言・ラベル・衝突を先に見て、残ったものだけ head の commit の時刻を読み、時間を過ぎたものだけ差分の受け付けを読む（lib/unclaimed-judge.ts）。
 * 読めなかった PR はログに残して出さない（ダッシュボードの更新は止めない）
 */
async function unclaimedJudgeInputs(ctx: GateContext, prs: PullRequest[], now: Date, minutes: number, prComments: Map<number, IssueComment[]>): Promise<UnclaimedJudgeInput[]> {
  const inputs: UnclaimedJudgeInput[] = [];
  for (const pr of prs) {
    const ref = { number: pr.number, title: pr.title, html_url: pr.html_url };
    try {
      let comments = prComments.get(pr.number);
      if (!comments) {
        comments = await ctx.gh.listComments(pr.number);
        prComments.set(pr.number, comments);
      }
      const claim = claimOf(comments);
      const labels = (pr.labels ?? []).map((l) => l.name);
      const conflicted = pr.mergeable_state === 'dirty';
      if (claim !== null || conflicted || labels.includes(LABELS.hold) || labels.includes(LABELS.blocked)) continue;
      const base: UnclaimedJudgeInput = { pr: ref, claim, labels, conflicted, headCommitAt: null, lastClaudeAt: null, accepted: null };
      const commit = await ctx.gh.get<{ commit?: { committer?: { date?: string | null } | null } }>(`/commits/${pr.head.sha}`);
      const headCommitAt = commit.commit?.committer?.date ?? null;
      const times = comments.filter((c) => hasClaudeMark(c.body) && isTrustedComment(c)).map((c) => new Date(c.created_at).getTime()).filter((t) => !Number.isNaN(t));
      const lastClaudeAt = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
      const timed = { ...base, headCommitAt, lastClaudeAt };
      if (!unclaimedJudgeCandidate(timed, now, minutes)) continue;
      const acceptance = acceptanceForPatch(ctx.config, comments, patchId(await prDiff(ctx.gh, pr)));
      inputs.push({ ...timed, accepted: acceptance !== null });
    } catch (e) {
      ctx.log(`#${pr.number} の判定の材料を読めませんでした（担当のいない判定待ちの PR に出しません）: ${(e as Error).message}`);
    }
  }
  return inputs;
}

export async function onSchedule(ctx: GateContext, now: Date = new Date(), opts: { epicUnassigned?: EpicUnassignedRow[] } = {}): Promise<void> {
  // 計画の委任が有効なら、ゲートの停止で止まっている計画を判定し直す。失敗してもダッシュボードの更新は止めない
  const found = await findDashboard(ctx.gh, ctx.config);
  const delegation = await readDelegation(ctx, found, now);
  if (delegation?.planActive) {
    try {
      await reviewDelegatedPlans(ctx, now, delegation);
    } catch (e) {
      ctx.log(`止まっている計画の判定し直しに失敗しました: ${(e as Error).message}`);
    }
  }
  // auto mode が有効なら、委任の後に、ゲートの停止で止まっている計画を auto mode で判定し直す（順番は 委任 → auto mode）
  const autoMode = await readAutoMode(ctx, found);
  if (autoMode?.active) {
    try {
      await reviewAutoModePlans(ctx, now, autoMode);
    } catch (e) {
      ctx.log(`止まっている計画の auto mode での判定し直しに失敗しました: ${(e as Error).message}`);
    }
  }
  const reconciled = await reconcileAutoMerge(ctx, now, found, autoMode ?? undefined);
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
  const agentPrs: PullRequest[] = [];
  for (const item of prs.filter((p) => isAgentPr(ctx.config, p, ctx.repository))) {
    const pr = await ctx.gh.get<PullRequest>(`/pulls/${item.number}`);
    agentPrs.push(pr);
    if (pr.mergeable_state === 'dirty') conflicts.push(pr);
    else if (age(pr.updated_at) > staleMs) stalePrs.push(pr);
    await followOnSchedule(ctx, pr, now);
  }
  const prComments = new Map<number, IssueComment[]>();
  const stalledMinutes = stalledClaimMinutes(ctx.config.routine);
  const stalled = stalledClaims(await stalledClaimInputs(ctx, agentPrs, now, stalledMinutes, prComments), now, stalledMinutes).map((r) => renderStalledClaimLine(r, now));
  const unclaimed = unclaimedJudgePrs(await unclaimedJudgeInputs(ctx, agentPrs, now, stalledMinutes, prComments), now, stalledMinutes).map((r) => renderUnclaimedJudgeLine(r, now));
  const unowned = unownedConflicts(await conflictClaims(ctx, conflicts, prComments), now, ctx.config.routine).map(renderUnownedConflictLine);
  const labelProblems = renderAuditLines(labelAuditRows(ctx.config, ctx.repository, issues, prs));
  const delegatedRows = await delegatedMerged(ctx, now, staleMs);
  const bypassRows = await bypassMerged(ctx, now, staleMs);
  const autoPlans = await autoModePlans(ctx, now, staleMs);
  const autoMergedRows = await autoModeMerged(ctx, now, staleMs);
  const autoHeldPrs = autoMode?.active ? await autoModeHeldPrs(ctx, now, staleMs, agentPrs) : null;

  const line = (i: { number: number; title: string; html_url: string }, extra = '') => `- [#${i.number}](${i.html_url}) ${i.title}${extra}`;
  const section = (title: string, rows: string[]) => [`### ${title}（${rows.length}）`, '', ...(rows.length ? rows : ['なし']), ''];
  const readable = (title: string, rows: string[] | null | undefined) => (rows == null ? [`### ${title}`, '', '読めませんでした', ''] : section(title, rows));
  const recent = `（直近 ${ctx.config.staleHours} 時間）`;
  const body = [
    appMark('dashboard'),
    `最終更新: ${now.toISOString()}（${ctx.config.staleHours} 時間動きがないものを停滞とみなします）`,
    '',
    ...section('人の対応待ち（blocked / plan-review / 引き継ぐか決める）', [...byReason.map((i) => line(i, ` — ${reasons.get(i.number)}`)), ...unowned]),
    ...section('コンフリクトしている Agent PR（CI が動きません）', conflicts.map((p) => line(p))),
    ...section('停滞している Agent PR', stalePrs.map((p) => line(p))),
    ...section(`止まっていそうな着手宣言（judge・fix・sync で ${stalledMinutes} 分動きなし）`, stalled),
    ...section(`担当のいない判定待ちの PR（宣言なしで ${stalledMinutes} 分動きなし）`, unclaimed),
    ...section('停滞している Issue', stale.map((i) => line(i))),
    ...section('ラベルが足りない Issue・PR', labelProblems),
    ...(opts.epicUnassigned
      ? section('Epic に入っていない Issue', opts.epicUnassigned.map((r) => line(r, r.epic !== null ? ` — Jev の一番高い Epic: #${r.epic}（${r.probability === null ? '-' : `${Math.round(r.probability * 100)}%`}）` : ' — 未判定')))
      : []),
    ...(delegatedRows === null
      ? [`### 委任承認で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, '', '読めませんでした', '']
      : section(`委任承認で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, delegatedRows)),
    ...(bypassRows === null
      ? [`### bypass で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, '', '読めませんでした', '']
      : section(`bypass で Merge された PR（直近 ${ctx.config.staleHours} 時間）`, bypassRows)),
    ...readable(`auto mode で通した計画${recent}`, autoPlans?.passed),
    ...readable(`auto mode で保留にした計画${recent}`, autoPlans?.held),
    ...readable(`auto mode で Merge した PR${recent}`, autoMergedRows),
    ...(autoMode?.active ? readable(`auto mode で保留にした PR${recent}`, autoHeldPrs) : [`### auto mode で保留にした PR${recent}`, '', 'auto mode が無効です', '']),
    '失敗した Actions の実行は [Actions](../../actions?query=is%3Afailure) を確認してください。',
  ].join('\n');

  const dashboard = await ensureDashboard(ctx);
  const current = await findDashboard(ctx.gh, ctx.config);
  const stopped = !current || hasLabel(current, ctx.config.autoMergeStopLabel);
  const mode = stopped
    ? `**自動 Merge モード: 停止中**（このダッシュボードの \`${ctx.config.autoMergeStopLabel}\` ラベルを外すと有効になります。docs/operations.md）`
    : `**自動 Merge モード: 有効**（このダッシュボードに \`${ctx.config.autoMergeStopLabel}\` ラベルを付けると一斉に止まります）`;
  const withMode = body.replace(appMark('dashboard'), `${appMark('dashboard')}\n${mode}\n${delegateLine(ctx, current, delegation)}\n${await bypassLine(ctx, current)}\n${autoModeLine(ctx, current, autoMode)}\n`);
  const existing = (await ctx.gh.get<{ body: string | null }>(`/issues/${dashboard}`)).body ?? '';
  const queueStart = existing.indexOf('<!-- agent-harness:queue:start -->');
  // queue 節は publishQueue が書く。停滞検知の書き換えで消さないよう残す
  const kept = queueStart >= 0 ? `${withMode}\n\n${existing.slice(queueStart)}` : withMode;
  await ctx.gh.request('PATCH', `/issues/${dashboard}`, { body: { body: kept } });
  ctx.log(`auto-merge reconciled=${reconciled}; bases reconciled=${bases}; dashboard #${dashboard} updated: blocked=${needsHuman.length} conflicts=${conflicts.length} unowned=${unowned.length} stalePRs=${stalePrs.length} stalledClaims=${stalled.length} unclaimedJudge=${unclaimed.length} staleIssues=${stale.length} labelProblems=${labelProblems.length} autoModeHeld=${(autoPlans?.held.length ?? 0) + (autoHeldPrs?.length ?? 0)}`);
}
