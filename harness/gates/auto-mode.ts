/**
 * auto mode（Epic #339）の今の状態と、計画・PR を auto mode で通してよいかの判断（Jev の危険の問いと記録の使い回し）。
 * 判断を harness/gates/ に置くのは、bypass と同じく委任承認の除外（delegateMergeExclude の harness/gates/**）に入れ、委任で緩められないようにするため。
 * 危険の判定は Jev だけ（人の決定、#382）。保留するかは harness/lib/auto-mode.ts の autoModeDanger で決める。
 * 作業したセッションの見解（authorView）があれば見解ありでも問い、記録の withView に残す（shadow。結論に使わない。#426）。
 * 見解ありの問いが問えない（diff が大きすぎる）ときは問わずに withView を skipped にし、見解なしで問い直さない（#449）。
 * auto mode で PR に auto-merge を付けた・外した記録（kind=auto-mode-merge・auto-mode-merge-end）と、auto mode で自動経路に乗せるかの判断（autoModeRoute）もここに置く。
 * on-comment.ts・apply.ts・tests-check.ts・auto-mode-merge.ts・delegate-merge.ts・bypass-merge.ts から使う。apply.ts を import しない（循環させない）。
 */
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, autoModeJevRecord, autoModePlanJevRequest, autoModePrJevRequest, autoModeState, type AutoModeJevRecord, type AutoModeJevViewRecord, type AutoModeState } from '../lib/auto-mode.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { delegatePlanExclude } from '../lib/delegate.ts';
import type { IssueComment } from '../lib/github.ts';
import { askJev } from '../lib/jev.ts';
import type { Acceptance, AutoModeRecord } from '../lib/merge-route.ts';
import type { GateResult, Plan } from '../lib/plan.ts';
import type { BaseKind } from '../lib/stack.ts';
import { appRecords, findDashboard, hasLabel, timeline, type DashboardIssue, type PlanGateRecord } from '../lib/state.ts';
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

function toViewRecord(r: AutoModeJevRecord): AutoModeJevViewRecord {
  const { status, detail, yes } = r;
  return { status, ...(detail === undefined ? {} : { detail }), ...(yes === undefined ? {} : { yes }) };
}

/**
 * 見解なしの記録が ok で見解があるときだけ、見解ありでもう1回問い（askView）、結果を withView に入れる（shadow。保留するかには使わない。#426）。
 * 見解なしが skipped・error なら見解ありは問わない
 */
async function withViewRecord(record: AutoModeJevRecord, view: string | undefined, askView: () => Promise<AutoModeJevViewRecord>): Promise<AutoModeJevRecord> {
  if (record.status !== 'ok' || view === undefined) return record;
  return { ...record, withView: await askView() };
}

/**
 * PR の見解ありの問いの結果（withView）。要求が ask: false（diff が大きすぎる）なら Jev を呼ばずに skipped にし、見解なしで問い直さない（#449）。
 * ask: true なら渡された要求で1回だけ問う
 */
export async function prViewRecord(
  viewed: ReturnType<typeof autoModePrJevRequest>,
  ask: (request: Extract<ReturnType<typeof autoModePrJevRequest>, { ask: true }>['request']) => ReturnType<typeof askJev>,
): Promise<AutoModeJevViewRecord> {
  if (!viewed.ask) return toViewRecord(viewed.record);
  return toViewRecord(autoModeJevRecord(await ask(viewed.request)));
}

/**
 * 計画の危険を Jev に問う。鍵が無ければ問わずに skipped の記録にする。
 * planBody は見解を除いた本文（planBodyWithoutView）。view（計画の authorView）があれば見解ありでも問う（withViewRecord）
 */
export async function askPlanJev(ctx: GateContext, planBody: string, files: string[], view?: string): Promise<AutoModeJevRecord> {
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return skippedRecord('JEV_API_KEY が未設定');
  const ask = ctx.askJev ?? askJev;
  const record = autoModeJevRecord(await ask(apiKey, autoModePlanJevRequest(ctx.config, planBody, files)));
  return withViewRecord(record, view, async () => toViewRecord(autoModeJevRecord(await ask(apiKey, autoModePlanJevRequest(ctx.config, planBody, files, view)))));
}

/**
 * PR の危険を Jev に問う。鍵が無い・diff が大きすぎるときは問わずに skipped の記録にする。
 * view（判定の authorView）があれば見解ありでも問い（withViewRecord）、見解ありが問えないときは withView を skipped にする（prViewRecord）
 */
export async function askPrJev(ctx: GateContext, diff: string, changedFiles: string[], view?: string): Promise<AutoModeJevRecord> {
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return skippedRecord('JEV_API_KEY が未設定');
  const built = autoModePrJevRequest(ctx.config, diff, changedFiles);
  if (!built.ask) return built.record;
  const ask = ctx.askJev ?? askJev;
  const record = autoModeJevRecord(await ask(apiKey, built.request));
  return withViewRecord(record, view, () => prViewRecord(autoModePrJevRequest(ctx.config, diff, changedFiles, view), (req) => ask(apiKey, req)));
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

/** auto mode で auto-merge を付けた記録の kind */
export const AUTO_MODE_MERGE_KIND = 'auto-mode-merge';
/** auto mode で付けた auto-merge を外した（Human Merge に戻した・ほかの乗り方に引き継いだ）記録の kind */
export const AUTO_MODE_MERGE_END_KIND = 'auto-mode-merge-end';
/** ダッシュボードに書く、auto mode の始まり・終わりのコメントの kind */
export const AUTO_MODE_SWITCH_KIND = 'auto-mode-switch';

/** auto mode で auto-merge を付けた記録（kind=auto-mode-merge） */
export interface AutoModeMergeRecord {
  version: 1;
  headSha: string;
  patchId: string;
  since: string | null;
  by: string | null;
  /** auto mode で飛ばした理由（受け付けの記録の autoMode.skipped） */
  skipped: string[];
}

/** removed：ラベルを外した、stopped：停止スイッチ、ineligible：auto mode の条件を満たさなくなった（ほかの乗り方に引き継いだときも） */
export type AutoModeMergeEndReason = 'removed' | 'stopped' | 'ineligible';

/** auto mode で付けた auto-merge を外した記録（kind=auto-mode-merge-end） */
export interface AutoModeMergeEndRecord {
  version: 1;
  headSha: string;
  reason: AutoModeMergeEndReason;
}

export const AUTO_MODE_MERGE_END_TEXT: Record<AutoModeMergeEndReason, string> = {
  removed: 'auto mode のラベルが外されました',
  stopped: '停止スイッチで自動 Merge モードが止まりました',
  ineligible: 'auto mode の条件を満たさなくなりました',
};

/**
 * auto mode で自動経路に乗せるか。受け付けあり・Reviewer 合格・自動 Merge の対象外・auto mode が有効・受け付けの autoMode.eligible、のすべてで ok。
 * ok でないときの理由には受け付けの autoMode.reasons（Jev の危険の判定で保留なら Jev の確率の1行）を載せる。
 * 委任で乗るか・hold・自動 Merge モード・base は呼ぶ側で見る。
 */
export function autoModeRoute(state: AutoModeState, acceptance: Acceptance | null): { ok: true } | { ok: false; reason: string } {
  const no = (reason: string) => ({ ok: false as const, reason });
  if (!acceptance) return no('現在の差分に対して有効な判定がありません');
  if (!acceptance.reviewPass) return no('Reviewer のブロッキング指摘があります');
  if (acceptance.autoEligible) return no('自動 Merge の対象のため auto mode は要りません');
  if (!state.active) return no(`auto mode が無効: ${state.reason}`);
  if (!acceptance.autoMode) return no('auto mode の可否の記録がありません（古い受け付け）');
  if (!acceptance.autoMode.eligible) return no(`auto mode でも不可: ${acceptance.autoMode.reasons.join('／')}`);
  return { ok: true };
}

/** App の auto-mode-merge／auto-mode-merge-end の記録のうち最新のもの */
export function latestAutoModeRecord(config: HarnessConfig, comments: IssueComment[]): { kind: 'auto-mode-merge'; value: AutoModeMergeRecord } | { kind: 'auto-mode-merge-end'; value: AutoModeMergeEndRecord } | null {
  const all = [
    ...appRecords<AutoModeMergeRecord>(config, comments, AUTO_MODE_MERGE_KIND).map((r) => ({ kind: 'auto-mode-merge' as const, ...r })),
    ...appRecords<AutoModeMergeEndRecord>(config, comments, AUTO_MODE_MERGE_END_KIND).map((r) => ({ kind: 'auto-mode-merge-end' as const, ...r })),
  ];
  const order = new Map(comments.map((c, i) => [c, i]));
  const last = all.sort((a, b) => order.get(a.comment)! - order.get(b.comment)!).at(-1);
  if (!last) return null;
  return last.kind === 'auto-mode-merge' ? { kind: last.kind, value: last.value as AutoModeMergeRecord } : { kind: last.kind, value: last.value as AutoModeMergeEndRecord };
}

/** auto mode で付けたまま終わっていない記録（最新が auto-mode-merge のとき）。無ければ null */
export function autoModeArm(config: HarnessConfig, comments: IssueComment[]): AutoModeMergeRecord | null {
  const last = latestAutoModeRecord(config, comments);
  return last?.kind === 'auto-mode-merge' ? last.value : null;
}
