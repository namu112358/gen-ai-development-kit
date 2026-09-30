/**
 * auto mode（Epic #339）の今の状態と、計画・PR を auto mode で通してよいかの判断（Jev の危険の問いと記録の使い回し）。
 * 判断を harness/gates/ に置くのは、bypass と同じく委任承認の除外（delegateMergeExclude の harness/gates/**）に入れ、委任で緩められないようにするため。
 * 危険の判定は Jev だけ（人の決定、#382）。保留するかは harness/lib/auto-mode.ts の autoModeDanger で決める。
 * on-comment.ts から使う。apply.ts を import しない（循環させない）。
 */
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, autoModeJevRecord, autoModePlanJevRequest, autoModePrJevRequest, autoModeState, type AutoModeJevRecord, type AutoModeState } from '../lib/auto-mode.ts';
import { delegatePlanExclude } from '../lib/delegate.ts';
import { askJev } from '../lib/jev.ts';
import type { AutoModeRecord } from '../lib/merge-route.ts';
import type { GateResult, Plan } from '../lib/plan.ts';
import type { BaseKind } from '../lib/stack.ts';
import { findDashboard, hasLabel, timeline, type DashboardIssue, type PlanGateRecord } from '../lib/state.ts';
import type { GateContext } from './context.ts';

/**
 * auto mode の今の状態。ダッシュボードに auto mode のラベルが無ければ timeline を読まずに無効を返す（ラベルが無ければ API の呼び出しを増やさない）。
 * dashboard を渡したときはダッシュボードを探し直さない。
 */
export async function autoModeFor(ctx: GateContext, dashboard?: DashboardIssue | null): Promise<AutoModeState> {
  const found = dashboard === undefined ? await findDashboard(ctx.gh, ctx.config) : dashboard;
  if (!found || !hasLabel(found, autoModeConfig(ctx.config).label)) return autoModeState(found, [], ctx.config);
  return autoModeState(found, await timeline(ctx.gh, found.number), ctx.config);
}

/**
 * 計画ゲートの元の結果（委任をかける前）のうち、auto mode なら飛ばす理由。飛ばせないときは null。
 * 飛ばすのは gate.skippable（ガードレール・想定 Risk high / critical）と、委任なら止める delegateMergeExclude・harness.config.json に重なりうる files だけ。
 * ほかの理由（Planner の申告・issue の不一致・files の欠落や書式の誤り）が1つでも残る、または split の不正なら null。
 * 人の印・分け直し・批評の関所は呼ぶ側で、この後に見る。
 */
export function autoModePlanSkips(gate: GateResult, plan: Plan, config: Parameters<typeof delegatePlanExclude>[0]): string[] | null {
  if (gate.pass || gate.splitInvalid) return null;
  const skippable = gate.skippable ?? [];
  if (skippable.length === 0) return null;
  if (gate.reasons.some((r) => !skippable.includes(r))) return null;
  const excluded = delegatePlanExclude(config, plan.files);
  return [...skippable, ...(excluded.length > 0 ? [`委任承認でも通さない files（delegateMergeExclude・harness.config.json に重なりうる）: ${excluded.join(', ')}`] : [])];
}

/** 計画の Jev の記録を使い回せるか：同じ計画コメント・同じ本文の sha256 の、ok で今の問いの版の記録（error・skipped は使い回さない） */
export function reusablePlanJev(previous: (PlanGateRecord & { planBodySha256?: string }) | undefined, planCommentId: number, bodySha256: string): AutoModeJevRecord | null {
  const jev = previous?.autoMode?.jev;
  if (!previous || previous.planCommentId !== planCommentId || previous.planBodySha256 !== bodySha256) return null;
  return jev?.status === 'ok' && jev.questionSet === AUTO_MODE_JEV_QUESTION_SET ? jev : null;
}

/** PR の Jev の記録を使い回せるか：同じ patch-id の受け付けの記録の autoMode.jev が ok で今の問いの版のもの */
export function reusablePrJev(previous: { autoMode?: AutoModeRecord } | null): AutoModeJevRecord | null {
  const jev = previous?.autoMode?.jev;
  return jev?.status === 'ok' && jev.questionSet === AUTO_MODE_JEV_QUESTION_SET ? jev : null;
}

const skippedRecord = (detail: string): AutoModeJevRecord => ({ status: 'skipped', detail, questionSet: AUTO_MODE_JEV_QUESTION_SET });

/** 計画の危険を Jev に問う。鍵が無ければ問わずに skipped の記録にする */
export async function askPlanJev(ctx: GateContext, planBody: string, files: string[]): Promise<AutoModeJevRecord> {
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return skippedRecord('JEV_API_KEY が未設定');
  return autoModeJevRecord(await (ctx.askJev ?? askJev)(apiKey, autoModePlanJevRequest(ctx.config, planBody, files)));
}

/** PR の危険を Jev に問う。鍵が無い・diff が大きすぎるときは問わずに skipped の記録にする */
export async function askPrJev(ctx: GateContext, diff: string, changedFiles: string[]): Promise<AutoModeJevRecord> {
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return skippedRecord('JEV_API_KEY が未設定');
  const built = autoModePrJevRequest(ctx.config, diff, changedFiles);
  if (!built.ask) return built.record;
  return autoModeJevRecord(await (ctx.askJev ?? askJev)(apiKey, built.request));
}

/** Jev の危険の問いより前に決まる、auto mode でも自動経路に乗せない理由（必須の条件） */
export function autoModeRequired(parts: { agent: boolean; base: BaseKind; reviewPass: boolean; scopeOk: boolean; outside: string[] }): string[] {
  const reasons: string[] = [];
  if (!parts.agent) reasons.push('Agent の PR ではない');
  if (parts.base !== 'default') reasons.push('base が既定ブランチではない');
  if (!parts.reviewPass) reasons.push('Reviewer のブロッキング指摘があります');
  if (!parts.scopeOk) reasons.push(`計画の範囲外のファイルがあります: ${parts.outside.join(', ')}`);
  return reasons;
}

/**
 * 受け付けた判定が、auto mode なら自動経路に乗せてよいか（受け付けの記録の autoMode になる）。
 * 必須の条件（required）と Jev の危険の判定（hold なら保留の理由）が reasons、飛ばす理由（Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev の自動 Merge の許可）が skipped。
 * jev は問わなかったとき（必須の条件を満たさない）は undefined。
 */
export function autoModeEligibility(parts: {
  required: string[];
  danger: { hold: boolean; reasons: string[] } | null;
  jev?: AutoModeJevRecord;
  humanMerge: string[];
  exclude: string[];
  jevGate?: { ok: boolean; reason: string };
  guardrail: string[];
  risk: { ok: boolean; reasons: string[] };
}): AutoModeRecord {
  const reasons = [...parts.required];
  if (parts.danger === null && reasons.length === 0) reasons.push('auto mode の危険の判定をしていません（自動 Merge の対象）');
  if (parts.danger?.hold) reasons.push(`auto mode の危険の判定で保留: ${parts.danger.reasons.join('／')}`);
  const skipped: string[] = [];
  if (!parts.risk.ok) skipped.push(...parts.risk.reasons);
  if (parts.guardrail.length > 0) skipped.push(`ガードレールに触れます: ${parts.guardrail.join(', ')}`);
  if (parts.humanMerge.length > 0) skipped.push(`人が Merge するパスに触れます（humanMergePaths）: ${parts.humanMerge.join(', ')}`);
  if (parts.exclude.length > 0) skipped.push(`委任しないパスに触れます（delegateMergeExclude）: ${parts.exclude.join(', ')}`);
  if (parts.jevGate && !parts.jevGate.ok) skipped.push(parts.jevGate.reason);
  return { eligible: reasons.length === 0 && parts.danger !== null && !parts.danger.hold, reasons, skipped, ...(parts.jev ? { jev: parts.jev } : {}) };
}
