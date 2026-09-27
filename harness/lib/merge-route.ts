/**
 * App が PR に残す受け付け記録（```agent-app、kind=acceptance）と、merge-route の評価。
 * merge-route は必須チェック。auto-merge が付いていない PR は通し（Human Merge 経路）、
 * 付いている PR は現在の差分に対して有効な判定が自動 Merge 条件を満たすときだけ通す。
 */

export interface Acceptance {
  version: 1;
  verdictCommentId: number;
  verdictHeadSha: string;
  /** 受け付け時点の PR 自身の差分の patch-id */
  patchId: string;
  reviewPass: boolean;
  riskLevel: string;
  riskOk: boolean;
  scopeOk: boolean;
  outside: string[];
  autoEligible: boolean;
  reasons: string[];
  jev?: JevRecord;
  /** 人にレビューを依頼するときに載せる（判定の写し） */
  humanNotes?: { concerns: string[]; checkPoints: string[] };
  riskRationale?: string;
}

export interface JevRecord {
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
  /** 自動 Merge を許すと Jev が判定したか（閾値は docs/jev.md） */
  allows?: boolean;
  answers?: Record<string, Record<string, number>>;
}

export interface MergeRouteInput {
  autoMergeEnabled: boolean;
  isAgentPr: boolean;
  hold: boolean;
  autoMergeMode: boolean;
  /** 現在の patch-id と一致する最新の受け付け記録 */
  acceptance: Acceptance | null;
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
  if (!input.acceptance) {
    reasons.push('現在の差分に対して有効な判定がありません');
  } else if (!input.acceptance.autoEligible) {
    reasons.push(...input.acceptance.reasons);
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
export function eligibility(parts: { reviewPass: boolean; risk: { ok: boolean; reasons: string[] }; scopeOk: boolean; outside: string[]; jevGate?: { ok: boolean; reason: string } }): { autoEligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!parts.reviewPass) reasons.push('Reviewer のブロッキング指摘があります');
  reasons.push(...parts.risk.reasons);
  if (!parts.scopeOk) reasons.push(`計画の範囲外のファイルがあります: ${parts.outside.join(', ')}`);
  if (parts.jevGate && !parts.jevGate.ok) reasons.push(parts.jevGate.reason);
  return { autoEligible: reasons.length === 0, reasons };
}
