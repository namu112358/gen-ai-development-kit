/**
 * App が PR に残す受け付け記録（```agent-app、kind=acceptance）と、merge-route の評価。
 * merge-route は必須チェック。auto-merge が付いていない PR は通し（Human Merge 経路）、
 * 付いている PR は現在の差分に対して有効な判定が自動 Merge 条件を満たすときだけ通す。
 * 委任承認（計画＋Merge）が有効（delegateMode）なら、自動 Merge 条件を満たさなくても、受け付けの記録の delegate.eligible が真なら判定由来の理由では止めない
 * （ガードレール・Risk だけを飛ばす。harness/lib/delegate.ts）。
 * bypass モードが有効（bypassMode）なら、自動 Merge の対象でも委任でも通らない受け付けのうち、bypass.eligible が真のものを判定由来の理由では止めない
 * （Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev を飛ばす。harness/gates/bypass.ts）。
 * auto mode が有効（autoModeMode）なら、自動 Merge の対象でも委任でも通らない受け付けのうち、autoMode.eligible が真のものを判定由来の理由では止めない
 * （Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev の自動 Merge の許可を飛ばす。Jev の危険の判定で保留なら eligible は偽。harness/gates/auto-mode.ts）。
 * 順番は 自動 Merge の対象 → 委任 → auto mode → bypass。
 * ただし auto mode が有効で受け付けが Jev の危険の判定で保留（autoModeHolds）なら、委任・bypass でも自動経路に乗せない（Issue #942）。
 */
import type { AutoModeJevRecord } from './auto-mode.ts';
import type { OverbuildJevRecord } from './overbuild-jev.ts';
import type { HumanNotes } from './verdict.ts';

/** 受け付け時にまとめる、委任承認（計画＋Merge）なら自動経路に乗せてよいか（harness/lib/delegate.ts の delegateEligibility） */
export interface DelegateRecord {
  eligible: boolean;
  /** 委任でも自動経路に乗せない理由 */
  reasons: string[];
  /** 委任なら飛ばす理由（ガードレール・Risk） */
  skipped: string[];
  /** 委任用の範囲照合（ゲートを通った計画か、ゲートの停止で止まった計画と照らす） */
  scopeOk: boolean;
  outside: string[];
  /** delegateMergeExclude に当たったファイル */
  exclude: string[];
}

/** 受け付け時にまとめる、bypass モードなら自動経路に乗せてよいか（harness/gates/bypass.ts の bypassEligibility） */
export interface BypassRecord {
  eligible: boolean;
  /** bypass でも自動経路に乗せない理由 */
  reasons: string[];
  /** bypass なら飛ばす理由（Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev） */
  skipped: string[];
}

/** 受け付け時にまとめる、auto mode なら自動経路に乗せてよいか（harness/gates/auto-mode.ts の autoModeEligibility） */
export interface AutoModeRecord {
  eligible: boolean;
  /** auto mode でも自動経路に乗せない理由（必須の条件と、Jev の危険の判定での保留） */
  reasons: string[];
  /** Jev の危険の判定で保留にしたか（無い古い記録は reasons の文頭で読む。autoModeHolds） */
  hold?: boolean;
  /** auto mode なら飛ばす理由（Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev の自動 Merge の許可） */
  skipped: string[];
  /** Jev の危険の問いの記録（問わなかったときは無い。同じ patch-id なら使い回す） */
  jev?: AutoModeJevRecord;
}

/** 受け付けの記録の autoMode.reasons で、Jev の危険の判定での保留の理由の文頭 */
export const AUTO_MODE_HOLD_REASON_PREFIX = 'auto mode の危険の判定で保留';

/** 受け付けが auto mode の Jev の危険の判定で保留か。autoMode.hold があればそれ、無い古い記録は reasons の文頭で読む */
export function autoModeHolds(acceptance: Acceptance | null): boolean {
  const a = acceptance?.autoMode;
  if (!a) return false;
  return a.hold ?? a.reasons.some((r) => r.startsWith(AUTO_MODE_HOLD_REASON_PREFIX));
}

export interface Acceptance {
  version: 1;
  verdictCommentId: number;
  verdictHeadSha: string;
  /** 受け付け時点の PR 自身の差分の patch-id */
  patchId: string;
  /** main の取り込み（App の update-branch）で判定を引き継いだ記録だけにある。前の受け付けの patch-id と取り込み前の head（harness/gates/main-merge-carry.ts） */
  carriedFrom?: { patchId: string; headSha: string };
  reviewPass: boolean;
  riskLevel: string;
  riskOk: boolean;
  scopeOk: boolean;
  outside: string[];
  /** ガードレールに当たった変更ファイル（無い記録は古い受け付け） */
  guardrail?: string[];
  /** humanMergePaths に当たった変更ファイル（無い記録は古い受け付け） */
  humanMerge?: string[];
  autoEligible: boolean;
  reasons: string[];
  jev?: JevRecord;
  /** 人にレビューを依頼するときに載せる（判定の写し） */
  humanNotes?: HumanNotes;
  riskRationale?: string;
  /** 委任承認（計画＋Merge）なら自動経路に乗せてよいか（無い古い記録は委任の対象外） */
  delegate?: DelegateRecord;
  /** bypass モードなら自動経路に乗せてよいか（無い古い記録は bypass の対象外） */
  bypass?: BypassRecord;
  /** auto mode なら自動経路に乗せてよいか（無い古い記録は auto mode の対象外） */
  autoMode?: AutoModeRecord;
  /** 判定の⑨のブロッキング指摘を Jev に問うた記録（jev.overbuild が off・⑨が0件なら無い。harness/gates/overbuild-jev.ts。古い記録には無い） */
  overbuildJev?: OverbuildJevRecord;
}

export interface JevRecord {
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
  /** 自動 Merge を許すと Jev が判定したか（閾値は harness.config.json の `jev.thresholds`、判定の式は harness/lib/jev.ts の `jevAllows`） */
  allows?: boolean;
  answers?: Record<string, Record<string, number>>;
  /** 問いの版（harness/lib/jev.ts の `JEV_QUESTION_SET`）。無い古い記録は版 1 */
  questionSet?: number;
  /**
   * Jev に送った材料の大きさ（Jev が応答したときだけ。Q90）。`chars` は state と問いを JSON にした文字数、
   * `jaRatio` はそのうち日本語の文字の割合、`inputTokens` は応答の `usage.input_tokens`（報告されなければ null）、
   * `diffChars` は diff の文字数（`jev.maxDiffChars` と比べる値）。集計は harness/lib/report.ts の `tokenRatios`
   */
  size?: { chars: number; jaRatio: number; inputTokens: number | null; diffChars?: number };
}

export interface MergeRouteInput {
  autoMergeEnabled: boolean;
  isAgentPr: boolean;
  hold: boolean;
  autoMergeMode: boolean;
  /** 現在の patch-id と一致する最新の受け付け記録 */
  acceptance: Acceptance | null;
  /** base が既定ブランチでない（Stacked PR など）。真なら自動経路を通さない（省略時は偽） */
  stacked?: boolean;
  /** 委任承認（計画＋Merge）が今有効か（harness/lib/delegate.ts の delegateState。省略時は偽） */
  delegateMode?: boolean;
  /** bypass モードが今有効か（harness/gates/bypass.ts の bypassState。省略時は偽） */
  bypassMode?: boolean;
  /** auto mode が今有効か（harness/gates/auto-mode.ts の autoModeFor。省略時は偽） */
  autoModeMode?: boolean;
}

export interface CheckOutcome {
  conclusion: 'success' | 'failure';
  title: string;
  summary: string;
}

export function evaluateMergeRoute(input: MergeRouteInput): CheckOutcome {
  if (!input.autoMergeEnabled) {
    return { conclusion: 'success', title: 'auto-merge なし（Human Merge 経路）', summary: 'auto-merge が設定されていないため通します。人が Merge します。' };
  }
  const reasons: string[] = [];
  if (!input.isAgentPr) reasons.push('Agent の PR ではありません（自動経路は Agent の PR のみ）');
  if (input.hold) reasons.push('`agent:hold` が付いています');
  if (!input.autoMergeMode) reasons.push('自動 Merge モードが無効です');
  if (input.stacked) reasons.push('base が既定ブランチではありません（Stacked PR は Human Merge）');
  const autoModeHeld = input.autoModeMode === true && autoModeHolds(input.acceptance);
  const delegated = !autoModeHeld && input.delegateMode === true && input.acceptance !== null && !input.acceptance.autoEligible && input.acceptance.delegate?.eligible === true;
  const autoModed = !delegated && input.autoModeMode === true && input.acceptance !== null && !input.acceptance.autoEligible && input.acceptance.autoMode?.eligible === true;
  const bypassed = !autoModeHeld && !delegated && !autoModed && input.bypassMode === true && input.acceptance !== null && !input.acceptance.autoEligible && input.acceptance.bypass?.eligible === true;
  if (!input.acceptance) {
    reasons.push('現在の差分に対して有効な判定がありません');
  } else if (!input.acceptance.autoEligible && !delegated && !autoModed && !bypassed) {
    reasons.push(...input.acceptance.reasons);
    if (autoModeHeld) reasons.push('auto mode の危険の判定で保留のため、委任承認・bypass でも自動経路に乗せません');
    if (input.delegateMode && input.acceptance.delegate) reasons.push(...input.acceptance.delegate.reasons.map((r) => `委任承認でも不可: ${r}`));
    if (input.autoModeMode && input.acceptance.autoMode) reasons.push(...input.acceptance.autoMode.reasons.map((r) => `auto mode でも不可: ${r}`));
    if (input.bypassMode && input.acceptance.bypass) reasons.push(...input.acceptance.bypass.reasons.map((r) => `bypass でも不可: ${r}`));
  }
  if (reasons.length === 0 && delegated) {
    return {
      conclusion: 'success',
      title: '委任承認（計画＋Merge）の条件を満たしています',
      summary: ['委任承認（計画＋Merge）が有効なため、次の理由を飛ばして自動経路に乗せます。', '', ...input.acceptance!.delegate!.skipped.map((r) => `- ${r}`)].join('\n'),
    };
  }
  if (reasons.length === 0 && autoModed) {
    return {
      conclusion: 'success',
      title: 'auto mode の条件を満たしています',
      summary: ['auto mode が有効で、Jev の危険の判定で保留にならなかったため、次の理由を飛ばして自動経路に乗せます。', '', ...input.acceptance!.autoMode!.skipped.map((r) => `- ${r}`)].join('\n'),
    };
  }
  if (reasons.length === 0 && bypassed) {
    return {
      conclusion: 'success',
      title: 'bypass モードの条件を満たしています',
      summary: ['bypass モードが有効なため、次の理由を飛ばして自動経路に乗せます。', '', ...input.acceptance!.bypass!.skipped.map((r) => `- ${r}`)].join('\n'),
    };
  }
  if (reasons.length === 0) {
    return { conclusion: 'success', title: '自動 Merge 条件を満たしています', summary: '判定・範囲照合・hold・自動 Merge モードをすべて確認しました。' };
  }
  return {
    conclusion: 'failure',
    title: 'auto-merge は許可されません',
    summary: ['auto-merge が設定されていますが、次の理由で自動経路を通しません。', '', ...reasons.map((r) => `- ${r}`)].join('\n'),
  };
}

/** 受け付け時に、自動 Merge 条件のうち判定に由来する部分をまとめる */
export function eligibility(parts: { reviewPass: boolean; risk: { ok: boolean; reasons: string[] }; scopeOk: boolean; outside: string[]; jevGate?: { ok: boolean; reason: string }; guardrail: string[]; humanMerge: string[] }): { autoEligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!parts.reviewPass) reasons.push('Reviewer のブロッキング指摘があります');
  reasons.push(...parts.risk.reasons);
  // Risk Agent の答えに関わらず、ガードレールに触れる PR は人が Merge する
  if (parts.guardrail.length > 0) reasons.push(`ガードレールに触れます（人が Merge する）: ${parts.guardrail.join(', ')}`);
  // 導入先の製品で必ず人が Merge するパス（ガードレールとは書き分ける）
  if (parts.humanMerge.length > 0) reasons.push(`人が Merge するパスに触れます（humanMergePaths）: ${parts.humanMerge.join(', ')}`);
  if (!parts.scopeOk) reasons.push(`計画の範囲外のファイルがあります: ${parts.outside.join(', ')}`);
  if (parts.jevGate && !parts.jevGate.ok) reasons.push(parts.jevGate.reason);
  return { autoEligible: reasons.length === 0, reasons };
}

/**
 * テストの改ざん検査（agent/tests）で、人が Merge する PR（Human Merge）とみなす理由。空なら Human Merge とみなさない。
 * - 変更ファイルだけで決まる条件：ガードレール・humanMergePaths に当たるファイル（どの判定でも eligibility が自動 Merge を許さない）
 * - 判定の受け付けで決まる条件：現在の差分に対する最新の受け付けが、合格かつ自動 Merge の対象外
 * Agent PR か・auto-merge の有無はゲート側で見る。
 */
export function testsHumanMergeReasons(parts: { guardrail: string[]; humanMerge: string[]; acceptance: Acceptance | null }): string[] {
  const reasons: string[] = [];
  if (parts.guardrail.length > 0) reasons.push(`ガードレールに触れます: ${parts.guardrail.join(', ')}`);
  if (parts.humanMerge.length > 0) reasons.push(`人が Merge するパスに触れます（humanMergePaths）: ${parts.humanMerge.join(', ')}`);
  const a = parts.acceptance;
  if (a && a.reviewPass && !a.autoEligible) reasons.push(...(a.reasons.length > 0 ? a.reasons : ['受け付けた判定が自動 Merge の対象外です']));
  return [...new Set(reasons)];
}

/** 自動 Merge の経路の種類（委任承認（計画＋Merge）・auto mode・bypass） */
export type AutoRoute = 'delegate' | 'autoMode' | 'bypass';

export const AUTO_ROUTE_NAME: Record<AutoRoute, string> = { delegate: '委任承認（計画＋Merge）', autoMode: 'auto mode', bypass: 'bypass モード' };

/**
 * 自動の経路があるときの、コメントに書く理由。理由の先頭の決まった書き出しだけを置き換え、後ろ（`: ファイルの一覧`）は残す。
 * 経路が無い・ほかの理由は入力のまま。記録（reasons）には使わない（コメントの本文だけ）。
 */
export function autoRouteReason(reason: string, route: AutoRoute | null): string {
  if (!route) return reason;
  const name = AUTO_ROUTE_NAME[route];
  const swaps: [string, string][] = [
    ['ガードレールに触れます（人が Merge する）', `ガードレールに触れます（${name}で App が自動 Merge する）`],
    ['ガードレールに触れます（人が実装して Merge する）', `ガードレールに触れます（付き添いのセッションで実装する。${name}が有効なので、合格すれば App が自動 Merge する）`],
    ['人が Merge するパスに触れます（humanMergePaths）', `humanMergePaths に触れます（${name}で App が自動 Merge する）`],
  ];
  for (const [from, to] of swaps) if (reason.startsWith(from)) return to + reason.slice(from.length);
  return reason;
}

/** 計画ゲートの停止で、App が自動 Merge する経路。委任承認（計画＋Merge）で計画の files が除外に重ならなければ delegate、そうでなく bypass が有効なら bypass */
export function planStopRoute(p: { delegateMergeActive: boolean; delegateExcluded: boolean; bypassActive: boolean }): 'delegate' | 'bypass' | null {
  if (p.delegateMergeActive && !p.delegateExcluded) return 'delegate';
  return p.bypassActive ? 'bypass' : null;
}

/** 停止のコメントの1行目の、「人が手元でセッションを立てて実装してください。」の代わりの文。経路が無ければ null（今の文のまま） */
export function planStopLead(route: AutoRoute | null, origin: 'gate' | 'planner'): string | null {
  if (!route) return null;
  const run = `付き添いのセッションで実装してください。${AUTO_ROUTE_NAME[route]}が有効なので、PR が計画の範囲に収まり判定に合格すれば App が自動 Merge します（Merge の経路は App が決めます）。`;
  return origin === 'planner' ? `人が進めると決めれば、${run}` : run;
}
