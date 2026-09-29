/**
 * 委任承認：人がダッシュボードのラベルで、計画ゲートの承認（agent:delegate-plan）か、計画ゲートの承認と Merge の判断（agent:delegate-merge）を
 * App に委ねる（docs/risk-policy.md）。期限は無く、ラベルが付いている間ずっと有効。
 * ダッシュボードのラベルから委任が有効かを決め、計画ゲートを委任で通すか、受け付けた判定が委任なら自動経路に乗せてよいかをまとめる。GitHub を呼ばない。
 */
import { appLogin, delegateConfig, type HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import { GUARDRAIL_SELF } from './guardrail.ts';
import type { DelegateRecord } from './merge-route.ts';
import type { GateResult, Plan } from './plan.ts';
import { globToRegExp } from './scope.ts';
import { hasLabel, lastLabeled, type TimelineEvent } from './state.ts';
import type { BaseKind } from './stack.ts';

/** off：委任なし、plan：計画ゲートの承認だけ、plan+merge：計画ゲートの承認と Merge の判断 */
export type DelegateMode = 'off' | 'plan' | 'plan+merge';

export interface DelegateState {
  mode: DelegateMode;
  /** Merge の委任が有効か（mode が plan+merge） */
  active: boolean;
  /** 計画ゲートの委任が有効か（mode が plan か plan+merge） */
  planActive: boolean;
  /** 効いている（無効なら無効の理由になった）委任のラベル。どちらも無ければ null */
  label: string | null;
  /** ラベルを付けた時刻（ISO）。読めなければ null */
  since: string | null;
  /** ラベルを付けた人 */
  by: string | null;
  /** 有効・無効の理由 */
  reason: string;
}

/** 1つのラベルが人によって付けられ、今効いているか（停止スイッチは見ない） */
function labelState(
  dashboard: { labels: ({ name?: string } | string)[] },
  events: TimelineEvent[],
  config: HarnessConfig,
  now: Date,
  label: string,
): { present: boolean; ok: boolean; since: string | null; by: string | null; reason: string } {
  const no = (reason: string, since: string | null = null, by: string | null = null) => ({ present: true, ok: false, since, by, reason });
  if (!hasLabel(dashboard, label)) return { present: false, ok: false, since: null, by: null, reason: 'ラベルが無い' };
  const labeled = lastLabeled(events, label);
  if (!labeled) return no('ラベルを付けた記録が無い');
  const by = labeled.actor?.login ?? null;
  const at = labeled.created_at ? Date.parse(labeled.created_at) : Number.NaN;
  if (Number.isNaN(at)) return no('付けた時刻が読めない', null, by);
  const since = new Date(at).toISOString();
  if (!by || by === appLogin(config) || by.endsWith('[bot]')) return no('人以外が付けた', since, by);
  if (now.getTime() < at) return no('付けた時刻が未来', since, by);
  return { present: true, ok: true, since, by, reason: '' };
}

/**
 * ダッシュボードのラベルと timeline から、委任承認が今有効かを決める。読めないものは無効（安全側）。
 * mergeLabel が有効なら plan+merge、そうでなく planLabel が有効なら plan。停止スイッチがあればどちらも無効。
 */
export function delegateState(
  dashboard: { labels: ({ name?: string } | string)[] } | null,
  events: TimelineEvent[],
  config: HarnessConfig,
  now: Date,
): DelegateState {
  const { planLabel, mergeLabel } = delegateConfig(config);
  const off = (reason: string, label: string | null = null, since: string | null = null, by: string | null = null): DelegateState => ({ mode: 'off', active: false, planActive: false, label, since, by, reason });
  if (!dashboard) return off('ラベルが無い');
  const merge = labelState(dashboard, events, config, now, mergeLabel);
  const plan = labelState(dashboard, events, config, now, planLabel);
  if (!merge.present && !plan.present) return off('ラベルが無い');
  const [label, s] = merge.ok || (merge.present && !plan.ok) ? [mergeLabel, merge] : [planLabel, plan];
  if (!s.ok) return off(s.reason, label, s.since, s.by);
  if (hasLabel(dashboard, config.autoMergeStopLabel)) return off('停止スイッチが優先', label, s.since, s.by);
  if (merge.ok) return { mode: 'plan+merge', active: true, planActive: true, label, since: s.since, by: s.by, reason: `委任承認（計画＋Merge）、@${s.by}、${s.since} から` };
  const mergeNote = merge.present ? `。\`${mergeLabel}\` は無効（${merge.reason}）` : '';
  return { mode: 'plan', active: false, planActive: true, label, since: s.since, by: s.by, reason: `委任承認（計画のみ）、@${s.by}、${s.since} から。Merge は委ねていません${mergeNote}` };
}

/** 委任承認の段階の呼び名 */
export function delegateModeName(mode: DelegateMode): string {
  return mode === 'plan+merge' ? '計画＋Merge' : mode === 'plan' ? '計画のみ' : '無効';
}

/**
 * 計画の files のパターンのうち、委任承認でも人が承認するもの（delegateMergeExclude か harness.config.json に重なりうるもの。安全側）。
 * 一覧が無い設定ではすべて当たる。
 */
export function delegatePlanExclude(config: Pick<HarnessConfig, 'delegateMergeExclude'>, patterns: string[]): string[] {
  const uniq = [...new Set(patterns)].sort();
  if (!config.delegateMergeExclude) return uniq;
  const exclude = config.delegateMergeExclude;
  return uniq.filter((p) => patternsOverlap(p, GUARDRAIL_SELF) || exclude.some((e) => patternsOverlap(p, e)));
}

/**
 * 計画ゲートの結果に委任承認をかける。計画の委任が有効で、止めた理由が委任で飛ばせる理由（gate.skippable：ガードレール・想定 Risk）だけで、
 * split の検査で止まっておらず、files が delegateMergeExclude（と harness.config.json）に重なりえないときだけ通す。
 * Planner の申告・issue 番号の不一致・files の欠落や書式の誤り・split の不正は skippable に入らないので、委任の間も止まる。
 * 人が付けた agent:plan-review の検査は呼ぶ側で、この後に行う。
 */
export function delegatePlanGate(gate: GateResult, plan: Plan, config: HarnessConfig, state: DelegateState): GateResult {
  if (gate.pass || !state.planActive || state.mode === 'off') return gate;
  const skippable = gate.skippable ?? [];
  if (skippable.length === 0) return gate;
  const excluded = delegatePlanExclude(config, plan.files);
  const exclusion = excluded.length > 0 ? [`委任承認でも通しません（delegateMergeExclude・harness.config.json に重なりうる files）: ${excluded.join(', ')}`] : [];
  const remaining = gate.reasons.filter((r) => !skippable.includes(r));
  if (gate.splitInvalid || remaining.length > 0 || exclusion.length > 0) return { ...gate, reasons: [...gate.reasons, ...exclusion] };
  return { pass: true, reasons: [], delegated: { skipped: [...skippable], label: state.label, mode: state.mode, by: state.by, since: state.since } };
}

/** 変更ファイルのうち、委任承認（計画＋Merge）でも人が Merge するもの。harness.config.json は常に当たる。一覧が無い設定ではすべて当たる（安全側） */
export function delegateExcludeFiles(config: Pick<HarnessConfig, 'delegateMergeExclude'>, files: string[]): string[] {
  const uniq = [...new Set(files)].sort();
  if (!config.delegateMergeExclude) return uniq;
  const matchers = config.delegateMergeExclude.map(globToRegExp);
  return uniq.filter((f) => f === GUARDRAIL_SELF || matchers.some((m) => m.test(f)));
}

/** 受け付けた判定が、委任承認（計画＋Merge）なら自動経路に乗せてよいか（受け付けの記録の delegate になる） */
export function delegateEligibility(parts: {
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
}): DelegateRecord {
  const reasons: string[] = [];
  if (!parts.agent) reasons.push('Agent の PR ではない');
  if (parts.base !== 'default') reasons.push('base が既定ブランチではない');
  if (!parts.reviewPass) reasons.push('Reviewer のブロッキング指摘があります');
  if (!parts.scopeOk) reasons.push(`計画の範囲外のファイルがあります: ${parts.outside.join(', ')}`);
  if (parts.humanMerge.length > 0) reasons.push(`人が Merge するパスに触れます（humanMergePaths）: ${parts.humanMerge.join(', ')}`);
  if (parts.exclude.length > 0) reasons.push(`委任しないパスに触れます（delegateMergeExclude）: ${parts.exclude.join(', ')}`);
  if (parts.jevGate && !parts.jevGate.ok) reasons.push(parts.jevGate.reason);
  const skipped: string[] = [];
  if (parts.guardrail.length > 0) skipped.push(`ガードレールに触れます: ${parts.guardrail.join(', ')}`);
  if (!parts.risk.ok) skipped.push(...parts.risk.reasons);
  return { eligible: reasons.length === 0, reasons, skipped, scopeOk: parts.scopeOk, outside: parts.outside, exclude: parts.exclude };
}
