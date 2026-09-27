import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Claude Code のセッション記録（jsonl）からトークン数を集計し、API で動かした場合の料金を見積もる。
 * サブスク利用なので実際には請求されない。料金は目安。
 */

export interface TokenCounts {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** 100 万トークンあたりの USD */
export type ModelPricing = TokenCounts;

/** harness.config.json の pricing（`$comment` などの文字列は無視する） */
export type PricingTable = Record<string, ModelPricing | string>;

export type UsageSummary = Record<string, TokenCounts>;

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
const KEYS = Object.keys(zero()) as (keyof TokenCounts)[];

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function countsOf(u: RawUsage): TokenCounts {
  const cc = u.cache_creation;
  const hasBreakdown = cc !== undefined && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined);
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    // 内訳が無ければキャッシュ書込はすべて 5 分とみなす
    cacheWrite5m: hasBreakdown ? (cc.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
    cacheWrite1h: hasBreakdown ? (cc.ephemeral_1h_input_tokens ?? 0) : 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/** assistant の行をモデル別に合計する。同じ message.id は複数行に出る（内容ブロックごと）ので最後の1行だけ数える */
export function summarizeUsage(lines: string[]): UsageSummary {
  const byId = new Map<string, { model: string; counts: TokenCounts }>();
  let anonymous = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { id?: string; model?: string; usage?: RawUsage } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const m = entry?.message;
    if (entry?.type !== 'assistant' || !m?.usage) continue;
    byId.set(m.id ?? `(no-id-${anonymous++})`, { model: m.model ?? 'unknown', counts: countsOf(m.usage) });
  }
  const summary: UsageSummary = {};
  for (const { model, counts } of byId.values()) {
    const acc = (summary[model] ??= zero());
    for (const k of KEYS) acc[k] += counts[k];
  }
  return summary;
}

export function totalTokens(summary: UsageSummary): TokenCounts {
  const acc = zero();
  for (const c of Object.values(summary)) for (const k of KEYS) acc[k] += c[k];
  return acc;
}

/** 完全一致を優先し、無ければ最長の前方一致（`claude-opus-5-5-20260901` → `claude-opus-5-5`） */
export function findPricing(model: string, pricing: PricingTable): ModelPricing | null {
  const entries = Object.entries(pricing).filter((e): e is [string, ModelPricing] => typeof e[1] === 'object' && e[1] !== null);
  const exact = entries.find(([k]) => k === model);
  if (exact) return exact[1];
  const prefix = entries.filter(([k]) => model.startsWith(k)).sort((a, b) => b[0].length - a[0].length)[0];
  return prefix?.[1] ?? null;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** 推定料金（USD）。単価の無いモデルが1つでも使われていれば合計は null（不明）。トークン 0 のモデルは数えない */
export function estimateCost(summary: UsageSummary, pricing: PricingTable): { totalUsd: number | null; perModel: Record<string, number | null> } {
  const perModel: Record<string, number | null> = {};
  let total: number | null = 0;
  for (const [model, c] of Object.entries(summary)) {
    if (KEYS.every((k) => c[k] === 0)) continue;
    const p = findPricing(model, pricing);
    const usd = p ? round(KEYS.reduce((s, k) => s + (c[k] * p[k]) / 1e6, 0)) : null;
    perModel[model] = usd;
    total = usd === null || total === null ? null : total + usd;
  }
  return { totalUsd: total === null ? null : round(total), perModel };
}

function jsonlIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * セッション記録（本体＋サブエージェント）のパス。explicit が無ければ cwd に対応する
 * `~/.claude/projects/<cwd の英数字以外を - にしたもの>/` の最も新しい .jsonl を今のセッションとみなす。
 * 見つからなければ []（例外は投げない）。
 */
export function findSessionTranscripts(cwd: string, explicit?: string): string[] {
  try {
    let main = explicit;
    if (!main) {
      const dir = join(homedir(), '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      main = jsonlIn(dir).map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f;
    }
    if (!main || !existsSync(main)) return [];
    return [main, ...jsonlIn(join(dirname(main), basename(main, '.jsonl'), 'subagents')).sort()];
  } catch {
    return [];
  }
}
