// usage から USD の計算と、月・1 レビューの上限の判定。import は型だけで、Node と Workers の両方で動く。
import type { ModelPricing } from './config.ts';

export interface Usage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const KEYS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const;

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** 完全一致、無ければ最も長い前方一致の単価。無ければ null */
export function findPricing(model: string, pricing: Record<string, ModelPricing>): ModelPricing | null {
  const entries = Object.entries(pricing).filter((e): e is [string, ModelPricing] => typeof e[1] === 'object' && e[1] !== null);
  const exact = entries.find(([k]) => k === model);
  if (exact) return exact[1];
  const prefix = entries.filter(([k]) => model.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
  return prefix?.[1] ?? null;
}

/** 推定料金（USD）。単価の無いモデルは null */
export function estimateUsd(usage: Usage, model: string, pricing: Record<string, ModelPricing>): number | null {
  const p = findPricing(model, pricing);
  if (!p) return null;
  return round(KEYS.reduce((s, k) => s + (usage[k] * p[k]) / 1e6, 0));
}

/** UTC の YYYY-MM */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 月の上限を先に、次に1レビューの上限を見る。ちょうど上限は通す */
export function checkBudget(input: {
  monthUsd: number;
  estimatedUsd: number;
  budget: { monthlyUsd: number; perReviewUsd: number };
}): { ok: true; reason: null } | { ok: false; reason: 'budget-exceeded' | 'too-large' } {
  if (input.monthUsd + input.estimatedUsd > input.budget.monthlyUsd) return { ok: false, reason: 'budget-exceeded' };
  if (input.estimatedUsd > input.budget.perReviewUsd) return { ok: false, reason: 'too-large' };
  return { ok: true, reason: null };
}
