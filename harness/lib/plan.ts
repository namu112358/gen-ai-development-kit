import { RISK_LEVELS, type RiskLevel } from './config.ts';
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
  /** 投稿前の批評の結果（記録用。ゲートの判断には使わない） */
  critique?: { verdict: CritiqueVerdict; rounds: number };
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
  if (o.critique !== undefined) {
    const k = c.object(o.critique, 'plan.critique');
    if (k) {
      const rounds = c.integer(k.rounds, 'plan.critique.rounds');
      if (Number.isInteger(k.rounds) && rounds < 1) c.errors.push('plan.critique.rounds: 1 以上ではありません');
      plan.critique = { verdict: c.oneOf(k.verdict, CRITIQUE_VERDICTS, 'plan.critique.verdict'), rounds };
    }
  }
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: plan };
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

/** 計画ゲート：どれかに該当すれば plan-review で停止 */
export function evaluatePlanGate(plan: Plan, issueNumber: number): GateResult {
  const reasons: string[] = [];
  if (plan.issue !== issueNumber) reasons.push(`計画の issue 番号（#${plan.issue}）がこの Issue（#${issueNumber}）と一致しません`);
  if (plan.needsHuman) reasons.push('Planner が人間の判断が必要と申告しています');
  if (plan.acChangeProposed) reasons.push('要件・AC の変更提案があります');
  if (plan.openQuestions.length > 0) reasons.push(`未解決の質問が ${plan.openQuestions.length} 件あります`);
  if (plan.risk === 'high' || plan.risk === 'critical') reasons.push(`想定 Risk が ${plan.risk} です`);
  if (plan.files.length === 0) reasons.push('触るファイル一覧（files）がありません');
  for (const pattern of plan.files) {
    const problem = validateScopePattern(pattern);
    if (problem) reasons.push(`files「${pattern}」: ${problem}`);
  }
  return { pass: reasons.length === 0, reasons };
}
