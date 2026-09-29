/**
 * 委任 Merge：人が期限つきで Merge の判断を App に委ねる（docs/risk-policy.md）。
 * ダッシュボードのラベルから委任が有効かを決め、受け付けた判定が委任なら自動経路に乗せてよいかをまとめる。GitHub を呼ばない。
 */
import { appLogin, delegateMergeConfig, type HarnessConfig } from './config.ts';
import { GUARDRAIL_SELF } from './guardrail.ts';
import type { DelegateRecord } from './merge-route.ts';
import { globToRegExp } from './scope.ts';
import { hasLabel, lastLabeled, type TimelineEvent } from './state.ts';
import type { BaseKind } from './stack.ts';

export interface DelegateState {
  active: boolean;
  /** ラベルを付けた時刻（ISO）。読めなければ null */
  since: string | null;
  /** 期限（ISO）。読めなければ null */
  until: string | null;
  /** ラベルを付けた人 */
  by: string | null;
  /** 有効・無効の理由 */
  reason: string;
}

/** ダッシュボードのラベルと timeline から、委任 Merge が今有効かを決める。読めないものは無効（安全側） */
export function delegateState(
  dashboard: { labels: ({ name?: string } | string)[] } | null,
  events: TimelineEvent[],
  config: HarnessConfig,
  now: Date,
): DelegateState {
  const { label, hours } = delegateMergeConfig(config);
  const off = (reason: string, since: string | null = null, until: string | null = null, by: string | null = null): DelegateState => ({ active: false, since, until, by, reason });
  if (!dashboard || !hasLabel(dashboard, label)) return off('ラベルが無い');
  const labeled = lastLabeled(events, label);
  if (!labeled) return off('ラベルを付けた記録が無い');
  const by = labeled.actor?.login ?? null;
  const at = labeled.created_at ? Date.parse(labeled.created_at) : Number.NaN;
  if (Number.isNaN(at)) return off('付けた時刻が読めない', null, null, by);
  const since = new Date(at).toISOString();
  const until = new Date(at + hours * 3600_000).toISOString();
  if (!by || by === appLogin(config) || by.endsWith('[bot]')) return off('人以外が付けた', since, until, by);
  if (hasLabel(dashboard, config.autoMergeStopLabel)) return off('停止スイッチが優先', since, until, by);
  if (now.getTime() < at) return off('付けた時刻が未来', since, until, by);
  if (now.getTime() >= at + hours * 3600_000) return off('期限切れ', since, until, by);
  return { active: true, since, until, by, reason: `期限 ${until} まで（@${by}）` };
}

/** 変更ファイルのうち、委任 Merge でも人が Merge するもの。harness.config.json は常に当たる。一覧が無い設定ではすべて当たる（安全側） */
export function delegateExcludeFiles(config: Pick<HarnessConfig, 'delegateMergeExclude'>, files: string[]): string[] {
  const uniq = [...new Set(files)].sort();
  if (!config.delegateMergeExclude) return uniq;
  const matchers = config.delegateMergeExclude.map(globToRegExp);
  return uniq.filter((f) => f === GUARDRAIL_SELF || matchers.some((m) => m.test(f)));
}

/** 受け付けた判定が、委任 Merge なら自動経路に乗せてよいか（受け付けの記録の delegate になる） */
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
