import { delegateMergeConfig, type HarnessConfig } from '../lib/config.ts';
import { delegateState, type DelegateState } from '../lib/delegate.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { appRecords, findDashboard, hasLabel, timeline, type DashboardIssue } from '../lib/state.ts';
import type { GateContext } from './context.ts';

/**
 * 委任 Merge の今の状態と、PR を委任で自動経路に乗せるかの判断（読むだけ・判断だけ）。docs/risk-policy.md の「委任 Merge」。
 * apply.ts・tests-check.ts・delegate-merge.ts から使う。apply.ts を import しない（循環させない）。
 * 委任で auto-merge を付けたこと・外したことは、App の記録（kind=delegated-merge・delegated-merge-end）で PR に残す。
 */

/** 委任で auto-merge を付けた記録の kind */
export const DELEGATED_MERGE_KIND = 'delegated-merge';
/** 委任で付けた auto-merge を外した（Human Merge に戻した）記録の kind */
export const DELEGATED_MERGE_END_KIND = 'delegated-merge-end';
/** ダッシュボードに書く、委任 Merge の始まり・終わりのコメントの kind */
export const DELEGATE_SWITCH_KIND = 'delegate-merge-switch';

/** 委任で auto-merge を付けた記録（kind=delegated-merge） */
export interface DelegatedMergeRecord {
  version: 1;
  headSha: string;
  patchId: string;
  since: string | null;
  until: string | null;
  by: string | null;
  /** 委任で飛ばした理由（受け付けの記録の delegate.skipped） */
  skipped: string[];
}

/** removed：ラベルを外した、expired：期限切れ、stopped：停止スイッチ、short：期限までの残りが短い、ineligible：委任の条件を満たさなくなった */
export type DelegatedMergeEndReason = 'removed' | 'expired' | 'stopped' | 'short' | 'ineligible';

/** 委任で付けた auto-merge を外した記録（kind=delegated-merge-end） */
export interface DelegatedMergeEndRecord {
  version: 1;
  headSha: string;
  reason: DelegatedMergeEndReason;
}

export const DELEGATED_MERGE_END_TEXT: Record<DelegatedMergeEndReason, string> = {
  removed: '委任のラベルが外されました',
  expired: '委任 Merge の期限が切れました',
  stopped: '停止スイッチで自動 Merge モードが止まりました',
  short: '委任 Merge の期限までの残りが短くなりました',
  ineligible: '委任 Merge の条件を満たさなくなりました',
};

/**
 * 委任 Merge の今の状態。ダッシュボードに委任のラベルが無ければ timeline を読まずに無効を返す（ラベルが無ければ API の呼び出しを増やさない）。
 * dashboard を渡したときはダッシュボードを探し直さない。
 */
export async function delegationFor(ctx: GateContext, now: Date, dashboard?: DashboardIssue | null): Promise<DelegateState> {
  const found = dashboard === undefined ? await findDashboard(ctx.gh, ctx.config) : dashboard;
  if (!found || !hasLabel(found, delegateMergeConfig(ctx.config).label)) return delegateState(found, [], ctx.config, now);
  return delegateState(found, await timeline(ctx.gh, found.number), ctx.config, now);
}

/**
 * 委任で自動経路に乗せるか。Reviewer 合格・自動 Merge の対象外・委任が有効・受け付けの delegate.eligible・
 * 期限までの残りが minRemainingMinutes 以上、のすべてで ok。hold・自動 Merge モード・base は呼ぶ側で見る。
 * short は、委任は有効だが残りが短いために乗せないとき真。
 */
export function delegatedRoute(delegation: DelegateState, acceptance: Acceptance | null, config: HarnessConfig, now: Date): { ok: true } | { ok: false; reason: string; short: boolean } {
  const no = (reason: string, short = false) => ({ ok: false as const, reason, short });
  if (!acceptance) return no('現在の差分に対して有効な判定がありません');
  if (!acceptance.reviewPass) return no('Reviewer のブロッキング指摘があります');
  if (acceptance.autoEligible) return no('自動 Merge の対象のため委任は要りません');
  if (!delegation.active) return no(`委任 Merge が無効: ${delegation.reason}`);
  if (!acceptance.delegate) return no('委任 Merge の可否の記録がありません（古い受け付け）');
  if (!acceptance.delegate.eligible) return no(`委任 Merge でも不可: ${acceptance.delegate.reasons.join('／')}`);
  const { minRemainingMinutes } = delegateMergeConfig(config);
  const remaining = Math.floor((Date.parse(delegation.until ?? '') - now.getTime()) / 60_000);
  if (Number.isNaN(remaining)) return no('委任 Merge の期限が読めません');
  if (remaining < minRemainingMinutes) return no(`委任 Merge の期限までの残りが ${remaining} 分です（${minRemainingMinutes} 分未満のため自動経路に乗せません）`, true);
  return { ok: true };
}

/** App の delegated-merge／delegated-merge-end の記録のうち最新のもの */
export function latestDelegationRecord(config: HarnessConfig, comments: IssueComment[]): { kind: 'delegated-merge'; value: DelegatedMergeRecord } | { kind: 'delegated-merge-end'; value: DelegatedMergeEndRecord } | null {
  const all = [
    ...appRecords<DelegatedMergeRecord>(config, comments, DELEGATED_MERGE_KIND).map((r) => ({ kind: 'delegated-merge' as const, ...r })),
    ...appRecords<DelegatedMergeEndRecord>(config, comments, DELEGATED_MERGE_END_KIND).map((r) => ({ kind: 'delegated-merge-end' as const, ...r })),
  ];
  const order = new Map(comments.map((c, i) => [c, i]));
  const last = all.sort((a, b) => order.get(a.comment)! - order.get(b.comment)!).at(-1);
  if (!last) return null;
  return last.kind === 'delegated-merge' ? { kind: last.kind, value: last.value as DelegatedMergeRecord } : { kind: last.kind, value: last.value as DelegatedMergeEndRecord };
}

/** 委任で付けたまま終わっていない記録（最新が delegated-merge のとき）。無ければ null */
export function delegatedArm(config: HarnessConfig, comments: IssueComment[]): DelegatedMergeRecord | null {
  const last = latestDelegationRecord(config, comments);
  return last?.kind === 'delegated-merge' ? last.value : null;
}
