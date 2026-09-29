import { appLogin, bypassMergeConfig, type HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance, BypassRecord } from '../lib/merge-route.ts';
import type { BaseKind } from '../lib/stack.ts';
import { appRecords, findDashboard, hasLabel, lastLabeled, timeline, type DashboardIssue, type TimelineEvent } from '../lib/state.ts';
import type { GateContext } from './context.ts';

/**
 * bypass モードの今の状態と、PR を bypass で自動経路に乗せるかの判断（読むだけ・判断だけ）。docs/risk-policy.md の「bypass モード」。
 * ブロッキング指摘が無く範囲照合を通れば、Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev を理由とする Human Merge を飛ばす。
 * 判断を harness/gates/ に置くのは、委任承認の除外（delegateMergeExclude の harness/gates/**）に入れ、委任で緩められないようにするため。
 * apply.ts・tests-check.ts・bypass-merge.ts・delegate-merge.ts から使う。apply.ts を import しない（循環させない）。
 */

export interface BypassState {
  active: boolean;
  /** ラベルを付けた時刻（ISO）。読めなければ null */
  since: string | null;
  /** ラベルを付けた人 */
  by: string | null;
  /** 有効・無効の理由 */
  reason: string;
}

/** bypass で auto-merge を付けた記録の kind */
export const BYPASS_MERGE_KIND = 'bypass-merge';
/** bypass で付けた auto-merge を外した（Human Merge に戻した）記録の kind */
export const BYPASS_MERGE_END_KIND = 'bypass-merge-end';
/** ダッシュボードに書く、bypass モードの始まり・終わりのコメントの kind */
export const BYPASS_SWITCH_KIND = 'bypass-merge-switch';

/** bypass で auto-merge を付けた記録（kind=bypass-merge） */
export interface BypassMergeRecord {
  version: 1;
  headSha: string;
  patchId: string;
  since: string | null;
  by: string | null;
  /** bypass で飛ばした理由（受け付けの記録の bypass.skipped） */
  skipped: string[];
}

/** removed：ラベルを外した、stopped：停止スイッチ、ineligible：bypass の条件を満たさなくなった */
export type BypassMergeEndReason = 'removed' | 'stopped' | 'ineligible';

/** bypass で付けた auto-merge を外した記録（kind=bypass-merge-end） */
export interface BypassMergeEndRecord {
  version: 1;
  headSha: string;
  reason: BypassMergeEndReason;
}

export const BYPASS_MERGE_END_TEXT: Record<BypassMergeEndReason, string> = {
  removed: 'bypass のラベルが外されました',
  stopped: '停止スイッチで自動 Merge モードが止まりました',
  ineligible: 'bypass モードの条件を満たさなくなりました',
};

/** ダッシュボードのラベルと timeline から、bypass モードが今有効かを決める。読めないものは無効（安全側）。期限は無い */
export function bypassState(dashboard: { labels: ({ name?: string } | string)[] } | null, events: TimelineEvent[], config: HarnessConfig): BypassState {
  const { label } = bypassMergeConfig(config);
  const off = (reason: string, since: string | null = null, by: string | null = null): BypassState => ({ active: false, since, by, reason });
  if (!dashboard || !hasLabel(dashboard, label)) return off('ラベルが無い');
  const labeled = lastLabeled(events, label);
  if (!labeled) return off('ラベルを付けた記録が無い');
  const by = labeled.actor?.login ?? null;
  const at = labeled.created_at ? Date.parse(labeled.created_at) : Number.NaN;
  const since = Number.isNaN(at) ? null : new Date(at).toISOString();
  if (!by || by === appLogin(config) || by.endsWith('[bot]')) return off('人以外が付けた', since, by);
  if (hasLabel(dashboard, config.autoMergeStopLabel)) return off('停止スイッチが優先', since, by);
  return { active: true, since, by, reason: `@${by} が付けています` };
}

/** 受け付けた判定が、bypass モードなら自動経路に乗せてよいか（受け付けの記録の bypass になる） */
export function bypassEligibility(parts: {
  reviewPass: boolean;
  scopeOk: boolean;
  outside: string[];
  humanMerge: string[];
  exclude: string[];
  jevGate?: { ok: boolean; reason: string };
  agent: boolean;
  base: BaseKind;
  guardrail: string[];
  risk: { ok: boolean; reasons: string[] };
}): BypassRecord {
  const reasons: string[] = [];
  if (!parts.agent) reasons.push('Agent の PR ではない');
  if (parts.base !== 'default') reasons.push('base が既定ブランチではない');
  if (!parts.reviewPass) reasons.push('Reviewer のブロッキング指摘があります');
  if (!parts.scopeOk) reasons.push(`計画の範囲外のファイルがあります: ${parts.outside.join(', ')}`);
  const skipped: string[] = [];
  if (!parts.risk.ok) skipped.push(...parts.risk.reasons);
  if (parts.guardrail.length > 0) skipped.push(`ガードレールに触れます: ${parts.guardrail.join(', ')}`);
  if (parts.humanMerge.length > 0) skipped.push(`人が Merge するパスに触れます（humanMergePaths）: ${parts.humanMerge.join(', ')}`);
  if (parts.exclude.length > 0) skipped.push(`委任しないパスに触れます（delegateMergeExclude）: ${parts.exclude.join(', ')}`);
  if (parts.jevGate && !parts.jevGate.ok) skipped.push(parts.jevGate.reason);
  return { eligible: reasons.length === 0, reasons, skipped };
}

/**
 * bypass で自動経路に乗せるか。受け付けあり・Reviewer 合格・自動 Merge の対象外・bypass が有効・受け付けの bypass.eligible、のすべてで ok。
 * 委任で乗るか・hold・自動 Merge モード・base は呼ぶ側で見る。
 */
export function bypassRoute(state: BypassState, acceptance: Acceptance | null): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!acceptance) return no('現在の差分に対して有効な判定がありません');
  if (!acceptance.reviewPass) return no('Reviewer のブロッキング指摘があります');
  if (acceptance.autoEligible) return no('自動 Merge の対象のため bypass は要りません');
  if (!state.active) return no(`bypass モードが無効: ${state.reason}`);
  if (!acceptance.bypass) return no('bypass の可否の記録がありません（古い受け付け）');
  if (!acceptance.bypass.eligible) return no(`bypass でも不可: ${acceptance.bypass.reasons.join('／')}`);
  return { ok: true };
}

/**
 * bypass モードの今の状態。ダッシュボードにラベルが無ければ timeline を読まずに無効を返す（ラベルが無ければ API の呼び出しを増やさない）。
 * dashboard を渡したときはダッシュボードを探し直さない。
 */
export async function bypassFor(ctx: GateContext, dashboard?: DashboardIssue | null): Promise<BypassState> {
  const found = dashboard === undefined ? await findDashboard(ctx.gh, ctx.config) : dashboard;
  if (!found || !hasLabel(found, bypassMergeConfig(ctx.config).label)) return bypassState(found, [], ctx.config);
  return bypassState(found, await timeline(ctx.gh, found.number), ctx.config);
}

/** App の bypass-merge／bypass-merge-end の記録のうち最新のもの */
export function latestBypassRecord(config: HarnessConfig, comments: IssueComment[]): { kind: 'bypass-merge'; value: BypassMergeRecord } | { kind: 'bypass-merge-end'; value: BypassMergeEndRecord } | null {
  const all = [
    ...appRecords<BypassMergeRecord>(config, comments, BYPASS_MERGE_KIND).map((r) => ({ kind: 'bypass-merge' as const, ...r })),
    ...appRecords<BypassMergeEndRecord>(config, comments, BYPASS_MERGE_END_KIND).map((r) => ({ kind: 'bypass-merge-end' as const, ...r })),
  ];
  const order = new Map(comments.map((c, i) => [c, i]));
  const last = all.sort((a, b) => order.get(a.comment)! - order.get(b.comment)!).at(-1);
  if (!last) return null;
  return last.kind === 'bypass-merge' ? { kind: last.kind, value: last.value as BypassMergeRecord } : { kind: last.kind, value: last.value as BypassMergeEndRecord };
}

/** bypass で付けたまま終わっていない記録（最新が bypass-merge のとき）。無ければ null */
export function bypassArm(config: HarnessConfig, comments: IssueComment[]): BypassMergeRecord | null {
  const last = latestBypassRecord(config, comments);
  return last?.kind === 'bypass-merge' ? last.value : null;
}
