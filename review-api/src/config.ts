// review-api の設定（review.config.json）の型と、読み取り・検査の loadReviewConfig。
// 誤りは全部の鍵を見て集め、1つの Error にまとめて投げる。import は書かない（Node と Workers の両方で型検査が通るように）。

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ReviewConfig {
  trigger: { actions: string[]; skipBotSenders: boolean; branchPrefix: string; requireClosesIssue: boolean; settleSeconds: number };
  claude: {
    reviewModel: string;
    riskModel: string;
    effort: string;
    maxTokens: number;
    maxToolCalls: number;
    maxDiffChars: number;
    maxFileChars: number;
    diffOnlyExtensions: string[];
  };
  budget: { monthlyUsd: number; perReviewUsd: number };
  pricing: Record<string, ModelPricing>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function loadReviewConfig(raw: unknown): ReviewConfig {
  const errors: string[] = [];
  const fail = (path: string, expected: string): void => {
    errors.push(`- ${path}: ${expected}`);
  };
  const section = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
    const v = parent[key];
    if (isObject(v)) return v;
    fail(key, 'オブジェクト');
    return {};
  };
  const str = (o: Record<string, unknown>, path: string, key: string, allowEmpty = false): string => {
    const v = o[key];
    if (typeof v === 'string' && (allowEmpty || v !== '')) return v;
    fail(`${path}.${key}`, allowEmpty ? '文字列' : '空でない文字列');
    return '';
  };
  const bool = (o: Record<string, unknown>, path: string, key: string): boolean => {
    const v = o[key];
    if (typeof v === 'boolean') return v;
    fail(`${path}.${key}`, '真偽値');
    return false;
  };
  const posInt = (o: Record<string, unknown>, path: string, key: string): number => {
    const v = o[key];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    fail(`${path}.${key}`, '正の整数');
    return 0;
  };
  const nonNegInt = (o: Record<string, unknown>, path: string, key: string): number => {
    const v = o[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
    fail(`${path}.${key}`, '0 以上の整数');
    return 0;
  };
  const posNum = (o: Record<string, unknown>, path: string, key: string): number => {
    const v = o[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    fail(`${path}.${key}`, '有限の正の数');
    return 0;
  };

  const root = isObject(raw) ? raw : {};
  if (!isObject(raw)) fail('(全体)', 'オブジェクト');

  const trigger = isObject(raw) ? section(root, 'trigger') : {};
  const claude = isObject(raw) ? section(root, 'claude') : {};
  const budget = isObject(raw) ? section(root, 'budget') : {};
  const pricingRaw = isObject(raw) ? section(root, 'pricing') : {};

  const rawActions = trigger.actions;
  let actions: string[] = [];
  if (isObject(raw) && isObject(root.trigger)) {
    if (Array.isArray(rawActions) && rawActions.length > 0 && rawActions.every((a) => typeof a === 'string' && a !== '')) {
      actions = rawActions as string[];
    } else {
      fail('trigger.actions', '空でない文字列の配列');
    }
  }

  const rawDiffOnly = claude.diffOnlyExtensions;
  let diffOnlyExtensions: string[] = [];
  if (isObject(raw) && isObject(root.claude)) {
    if (Array.isArray(rawDiffOnly) && rawDiffOnly.every((e) => typeof e === 'string' && e.startsWith('.') && e !== '')) {
      diffOnlyExtensions = rawDiffOnly as string[];
    } else {
      fail('claude.diffOnlyExtensions', "'.' で始まる文字列の配列（空配列可）");
    }
  }

  const out: ReviewConfig = {
    trigger: {
      actions,
      skipBotSenders: bool(trigger, 'trigger', 'skipBotSenders'),
      branchPrefix: str(trigger, 'trigger', 'branchPrefix', true),
      requireClosesIssue: bool(trigger, 'trigger', 'requireClosesIssue'),
      settleSeconds: nonNegInt(trigger, 'trigger', 'settleSeconds'),
    },
    claude: {
      reviewModel: str(claude, 'claude', 'reviewModel'),
      riskModel: str(claude, 'claude', 'riskModel'),
      effort: str(claude, 'claude', 'effort'),
      maxTokens: posInt(claude, 'claude', 'maxTokens'),
      maxToolCalls: posInt(claude, 'claude', 'maxToolCalls'),
      maxDiffChars: posInt(claude, 'claude', 'maxDiffChars'),
      maxFileChars: posInt(claude, 'claude', 'maxFileChars'),
      diffOnlyExtensions,
    },
    budget: {
      monthlyUsd: posNum(budget, 'budget', 'monthlyUsd'),
      perReviewUsd: posNum(budget, 'budget', 'perReviewUsd'),
    },
    pricing: {},
  };

  for (const [model, value] of Object.entries(pricingRaw)) {
    if (model.startsWith('$')) continue;
    const path = `pricing.${model}`;
    if (!isObject(value)) {
      fail(path, 'オブジェクト');
      continue;
    }
    const num = (key: string): number => {
      const v = value[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
      fail(`${path}.${key}`, '有限の 0 以上の数');
      return 0;
    };
    out.pricing[model] = {
      input: num('input'),
      output: num('output'),
      cacheWrite5m: num('cacheWrite5m'),
      cacheWrite1h: num('cacheWrite1h'),
      cacheRead: num('cacheRead'),
    };
  }

  if (errors.length > 0) throw new Error(`review.config.json の誤り（${errors.length} 件）\n${errors.join('\n')}`);
  return out;
}
