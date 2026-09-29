import { RISK_LEVELS, type RiskLevel } from './config.ts';
import { parseSplit, validateSplit, type SplitChild } from './epic.ts';
import { guardrailPatterns, type GuardrailConfig } from './guardrail.ts';
import { validateScopePattern } from './scope.ts';
import { Checker } from './validate.ts';

/**
 * 計画コメントの構造化出力（```agent-plan）。書式は docs/formats.md を参照。
 * ゲートはこの値だけで判断し、本文の自然言語は読まない。
 */
export interface Plan {
  version: 1;
  issue: number;
  risk: RiskLevel;
  needsHuman: boolean;
  needsHumanReasons: string[];
  acChangeProposed: boolean;
  openQuestions: string[];
  files: string[];
  /** Epic として子課題に分けるとき（2件以上）。あれば files は空でよく、Risk では止めない */
  split?: SplitChild[];
  /** 投稿前の批評の結果。無い計画は計画ゲートで止める（evaluateCritiqueGate。verdict の値そのものでは止めない） */
  critique?: { verdict: CritiqueVerdict; rounds: number; mustRemaining?: number };
}

export const CRITIQUE_VERDICTS = ['go', 'revise', 'split', 'drop'] as const;
export type CritiqueVerdict = (typeof CRITIQUE_VERDICTS)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function parsePlan(raw: unknown): Parsed<Plan> {
  const c = new Checker();
  const o = c.object(raw, 'plan');
  if (!o) return { ok: false, errors: c.errors };
  if (o.version !== 1) c.errors.push('plan.version: 1 ではありません');
  const plan: Plan = {
    version: 1,
    issue: c.integer(o.issue, 'plan.issue'),
    risk: c.oneOf(o.risk, RISK_LEVELS, 'plan.risk'),
    needsHuman: c.boolean(o.needsHuman, 'plan.needsHuman'),
    needsHumanReasons: c.stringArray(o.needsHumanReasons, 'plan.needsHumanReasons'),
    acChangeProposed: c.boolean(o.acChangeProposed, 'plan.acChangeProposed'),
    openQuestions: c.stringArray(o.openQuestions, 'plan.openQuestions'),
    // 触るファイル一覧が欠けていてもゲートで止められるよう、ここでは空配列を許す
    files: o.files === undefined ? [] : c.stringArray(o.files, 'plan.files'),
  };
  if (o.split !== undefined) plan.split = parseSplit(c, o.split);
  if (o.critique !== undefined) {
    const k = c.object(o.critique, 'plan.critique');
    if (k) {
      const rounds = c.integer(k.rounds, 'plan.critique.rounds');
      if (Number.isInteger(k.rounds) && rounds < 1) c.errors.push('plan.critique.rounds: 1 以上ではありません');
      plan.critique = { verdict: c.oneOf(k.verdict, CRITIQUE_VERDICTS, 'plan.critique.verdict'), rounds };
      // 最後の回の必須の指摘の件数（任意）
      if (k.mustRemaining !== undefined) {
        const must = c.integer(k.mustRemaining, 'plan.critique.mustRemaining');
        if (Number.isInteger(k.mustRemaining) && must < 0) c.errors.push('plan.critique.mustRemaining: 0 以上ではありません');
        plan.critique.mustRemaining = must;
      }
    }
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: plan };
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
  /** split の検査で止まったか（理由コード split-invalid） */
  splitInvalid?: boolean;
  /** ガードレールに当たった計画のパターン（当たったときだけ） */
  guardrail?: string[];
  /** reasons のうち、委任承認なら飛ばせる理由（ガードレール・想定 Risk high / critical。1件以上のときだけ） */
  skippable?: string[];
  /** 委任承認で通したとき（harness/lib/delegate.ts の delegatePlanGate） */
  delegated?: PlanDelegation;
  /** 止めた理由が批評の関所（evaluateCritiqueGate）だけか（理由コード no-critique） */
  critiqueOnly?: boolean;
  /** 批評で必須の指摘が残ったまま、人が進めると決めた計画（revise で mustRemaining が1以上。ゲートの記録に残す） */
  critiqueProceeded?: CritiqueProceeded;
}

/** 委任承認で計画ゲートを通した記録（plan-gate の記録の delegated） */
export interface PlanDelegation {
  /** 飛ばした理由 */
  skipped: string[];
  /** 効いていた委任のラベル */
  label: string | null;
  mode: 'plan' | 'plan+merge';
  by: string | null;
  since: string | null;
}

export interface CritiqueProceeded {
  verdict: 'revise';
  mustRemaining: number;
}

/**
 * 計画ゲート：どれかに該当すれば plan-review で停止。
 * split がある計画は Risk と files の欠落では止めず、分け方の検査（harness/lib/epic.ts）で止める。
 * files がガードレールに触れる計画は、想定 Risk に関わらず止める。split の子課題の files は見ない
 * （分ける段階では子 Issue を作るだけで、子課題はそれぞれの計画でゲートがもう一度見る）。
 * guardrail は必須（省略でガードレールを見落とさないため）。一覧が無い設定はすべてを当たりとする（harness/lib/guardrail.ts）。
 */
export function evaluatePlanGate(plan: Plan, issueNumber: number, guardrail: GuardrailConfig): GateResult {
  const reasons: string[] = [];
  // 委任承認なら飛ばせる理由（harness/lib/delegate.ts の delegatePlanGate）
  const skippable: string[] = [];
  const skip = (reason: string) => {
    reasons.push(reason);
    skippable.push(reason);
  };
  if (plan.issue !== issueNumber) reasons.push(`計画の issue 番号（#${plan.issue}）がこの Issue（#${issueNumber}）と一致しません`);
  if (plan.needsHuman) reasons.push('Planner が人間の判断が必要と申告しています');
  if (plan.acChangeProposed) reasons.push('要件・AC の変更提案があります');
  if (plan.openQuestions.length > 0) reasons.push(`未解決の質問が ${plan.openQuestions.length} 件あります`);
  if (!plan.split && (plan.risk === 'high' || plan.risk === 'critical')) skip(`想定 Risk が ${plan.risk} です`);
  if (!plan.split && plan.files.length === 0) reasons.push('触るファイル一覧（files）がありません');
  for (const pattern of plan.files) {
    const problem = validateScopePattern(pattern);
    if (problem) reasons.push(`files「${pattern}」: ${problem}`);
  }
  const guarded = guardrailPatterns(guardrail, plan.files);
  if (guarded.length > 0) skip(`ガードレールに触れます（人が実装して Merge する）: ${guarded.join(', ')}`);
  const extra = { ...(guarded.length > 0 ? { guardrail: guarded } : {}), ...(skippable.length > 0 ? { skippable } : {}) };
  if (plan.split) {
    const problems = validateSplit(plan.split);
    reasons.push(...problems);
    if (problems.length > 0) return { pass: false, reasons, splitInvalid: true, ...extra };
  }
  return { pass: reasons.length === 0, reasons, ...extra };
}

/**
 * 批評の関所：計画に批評（plan-critic）の記録が無い、または計画より前に段階 plan-critique の着手宣言が無ければ止める理由を返す。
 * critiqueClaimed が null のときは確かめられない（GitHub を読まない render-plan）として、宣言の検査だけ飛ばす。
 * 批評の中身（verdict の値）では止めない。revise で mustRemaining が1以上なら、止めずに proceeded を返す（記録に残すため）。
 * split の計画も同じに扱う。
 */
export function evaluateCritiqueGate(plan: Plan, critiqueClaimed: boolean | null): { reasons: string[]; proceeded?: CritiqueProceeded } {
  const reasons: string[] = [];
  if (!plan.critique) reasons.push('批評（plan-critic）の記録（`critique`）がありません');
  if (critiqueClaimed === false) reasons.push('計画より前に段階 `plan-critique` の着手宣言がありません（批評の入力を作った印）');
  if (reasons.length > 0) return { reasons };
  const k = plan.critique!;
  return k.verdict === 'revise' && (k.mustRemaining ?? 0) >= 1 ? { reasons, proceeded: { verdict: 'revise', mustRemaining: k.mustRemaining! } } : { reasons };
}

/** 計画ゲートの結果に批評の関所を合わせる。ほかの理由が無く批評の関所だけで止めたときは critiqueOnly */
export function withCritiqueGate(gate: GateResult, critique: ReturnType<typeof evaluateCritiqueGate>): GateResult {
  if (critique.reasons.length === 0) return critique.proceeded ? { ...gate, critiqueProceeded: critique.proceeded } : gate;
  const onlyCritique = gate.reasons.length === 0 && !gate.splitInvalid;
  return { ...gate, pass: false, reasons: [...gate.reasons, ...critique.reasons], ...(onlyCritique ? { critiqueOnly: true } : {}) };
}

/** セッションの見込み（render-plan・post-plan）：計画ゲートと批評の関所を合わせた結果。critiqueClaimed の扱いは evaluateCritiqueGate と同じ */
export function expectedPlanGate(plan: Plan, issueNumber: number, guardrail: GuardrailConfig, critiqueClaimed: boolean | null): GateResult {
  return withCritiqueGate(evaluatePlanGate(plan, issueNumber, guardrail), evaluateCritiqueGate(plan, critiqueClaimed));
}

/** Planner が人の判断を求めているか（needsHuman・AC の変更提案・未解決の質問のどれか） */
export function plannerRequestsHuman(plan: Plan): boolean {
  return plan.needsHuman || plan.acChangeProposed || plan.openQuestions.length > 0;
}

/** agent:plan-review の出どころ。gate は App のゲートの停止、planner は Planner の申告か人が付けた印 */
export type PlanReviewOrigin = 'gate' | 'planner';

/**
 * 停止の記録に書く出どころ。labelBefore は、App が判定する時点で agent:plan-review が付いていて、
 * 前の印を解かなかったか（Planner が先に付けた、または人が付けた印）。
 */
export function planReviewOrigin(plan: Plan, labelBefore: boolean): PlanReviewOrigin {
  return plannerRequestsHuman(plan) || labelBefore ? 'planner' : 'gate';
}

/**
 * 前の印（agent:plan-review）を解かずに止めたときの理由の書き出し。on-comment.ts が書く理由の文はこれで始まる。
 * 版によって続きが違う：planReviewOrigin が入った 64f6e68（#122）より前は「（Planner が人の判断を求めています）」、
 * それ以降は「（Planner の申告か人が付けた印です。人が外すまで止めます）」。recordedOrigin は書き出しだけで見分ける（Issue #274）
 */
export const PRIOR_PLAN_REVIEW_REASON_PREFIX = '`agent:plan-review` が付いています';

/** 計画ゲートの記録のうち、出どころを決めるのに読むところ */
export interface PlanGateOriginFacts {
  pass: boolean;
  planReviewOrigin?: PlanReviewOrigin;
  reasons?: unknown;
  plan?: unknown;
}

/**
 * 停止の記録の出どころ。欄があればその値。欄の無い古い記録（64f6e68 より前）は、次がすべてそろうときだけ gate と推し量り、ほかは planner（緩めない側）：
 * 止まった記録（pass: false）、記録の plan（on-comment.ts が写す元の計画。決定の記録で判定し直したときも答え済みにする前の計画）に
 * needsHuman・acChangeProposed・openQuestions がそろっていて Planner の申告が無い、理由に前の印で止めたもの（PRIOR_PLAN_REVIEW_REASON_PREFIX で始まる）が無い。
 * 最後に印を付けたのが App か（人の印でないか）は、呼び出し元が priorPlanReviewReleased で見る
 */
export function recordedOrigin(previous: PlanGateOriginFacts): PlanReviewOrigin {
  if (previous.planReviewOrigin === 'gate' || previous.planReviewOrigin === 'planner') return previous.planReviewOrigin;
  if (previous.pass !== false) return 'planner';
  const plan = previous.plan as { needsHuman?: unknown; acChangeProposed?: unknown; openQuestions?: unknown } | null | undefined;
  if (!plan || typeof plan !== 'object') return 'planner';
  if (typeof plan.needsHuman !== 'boolean' || typeof plan.acChangeProposed !== 'boolean' || !Array.isArray(plan.openQuestions)) return 'planner';
  if (plan.needsHuman || plan.acChangeProposed || plan.openQuestions.length > 0) return 'planner';
  const reasons = Array.isArray(previous.reasons) ? previous.reasons : [];
  if (reasons.some((r) => typeof r === 'string' && r.startsWith(PRIOR_PLAN_REVIEW_REASON_PREFIX))) return 'planner';
  return 'gate';
}

/**
 * 計画の出し直しで、前の agent:plan-review を理由に止めないか。
 * Issue に印があり、App の最新の計画ゲートの記録がゲートの停止（recordedOrigin が gate。出どころの無い古い記録は推し量れたときだけ）で、
 * 最後に印を付けたのが App のときだけ true。推し量れない古い記録は人が外すまで止める。
 */
export function priorPlanReviewReleased(
  hasLabel: boolean,
  previous: PlanGateOriginFacts | null | undefined,
  lastLabeledByApp: boolean,
): boolean {
  return hasLabel && previous?.pass === false && recordedOrigin(previous) === 'gate' && lastLabeledByApp;
}
