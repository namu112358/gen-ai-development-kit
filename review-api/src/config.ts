// review-api の設定（review.config.json）の型と、読み取り・検査の loadReviewConfig。
// 誤りは全部の鍵を見て集め、1つの Error にまとめて投げる。import は書かない（Node と Workers の両方で型検査が通るように）。

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** PR 本文の Issue の結び付け方。closes は Closes・Fixes・Resolves だけ、closes-or-refs は Refs #N も含む */
export type IssueLink = 'closes' | 'closes-or-refs';
const ISSUE_LINKS: readonly string[] = ['closes', 'closes-or-refs'];

export interface ReviewConfig {
  trigger: {
    actions: string[];
    skipBotSenders: boolean;
    branchPrefix: string;
    requireClosesIssue: boolean;
    settleSeconds: number;
    /** settleSeconds だけ待つ Webhook の action（Issue #1067）。無ければ DEFAULT_SETTLE_ACTIONS */
    settleActions?: string[];
    /** 無ければ closes */
    issueLink?: IssueLink;
  };
  claude: {
    reviewModel: string;
    riskModel: string;
    effort: string;
    maxTokens: number;
    maxToolCalls: number;
    maxDiffChars: number;
    maxFileChars: number;
    diffOnlyExtensions: string[];
    docsOnly?: { extensions: string[]; model: string };
    /** false なら、Reviewer と Risk のモデルが違っても Risk を Reviewer のモデルで比べない（無ければ比べる） */
    riskCompare?: boolean;
  };
  budget: { monthlyUsd: number; perReviewUsd: number };
  pricing: Record<string, ModelPricing>;
}

/** settle で待つ action の既定。opened などは head が新しくなく、待つ間の push はセッションには無い（Issue #1067 の実測） */
export const DEFAULT_SETTLE_ACTIONS: readonly string[] = ['synchronize'];

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

  let settleActions: string[] = [...DEFAULT_SETTLE_ACTIONS];
  if (Object.hasOwn(trigger, 'settleActions')) {
    const v = trigger.settleActions;
    if (Array.isArray(v) && v.every((a) => typeof a === 'string' && a !== '')) {
      settleActions = v as string[];
    } else {
      fail('trigger.settleActions', '空でない文字列の配列（空配列可）');
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

  let docsOnly: { extensions: string[]; model: string } | undefined;
  if (isObject(raw) && isObject(root.claude) && claude.docsOnly !== undefined) {
    const d = claude.docsOnly;
    if (!isObject(d)) {
      fail('claude.docsOnly', 'オブジェクト');
    } else {
      const exts = d.extensions;
      let extensions: string[] = [];
      if (Array.isArray(exts) && exts.length > 0 && exts.every((e) => typeof e === 'string' && e.startsWith('.') && e !== '.')) {
        extensions = exts as string[];
      } else {
        fail('claude.docsOnly.extensions', "'.' で始まる文字列の空でない配列");
      }
      docsOnly = { extensions, model: str(d, 'claude.docsOnly', 'model') };
    }
  }

  const issueLink = Object.hasOwn(trigger, 'issueLink') ? trigger.issueLink : undefined;
  if (Object.hasOwn(trigger, 'issueLink') && !(typeof issueLink === 'string' && ISSUE_LINKS.includes(issueLink))) {
    fail('trigger.issueLink', `${ISSUE_LINKS.join(' か ')}`);
  }
  const riskCompare = Object.hasOwn(claude, 'riskCompare') ? claude.riskCompare : undefined;
  if (Object.hasOwn(claude, 'riskCompare') && typeof riskCompare !== 'boolean') fail('claude.riskCompare', '真偽値');
  const out: ReviewConfig = {
    trigger: {
      actions,
      skipBotSenders: bool(trigger, 'trigger', 'skipBotSenders'),
      branchPrefix: str(trigger, 'trigger', 'branchPrefix', true),
      requireClosesIssue: bool(trigger, 'trigger', 'requireClosesIssue'),
      settleSeconds: nonNegInt(trigger, 'trigger', 'settleSeconds'),
      settleActions,
      ...(typeof issueLink === 'string' && ISSUE_LINKS.includes(issueLink) ? { issueLink: issueLink as IssueLink } : {}),
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
      ...(docsOnly !== undefined ? { docsOnly } : {}),
      ...(typeof riskCompare === 'boolean' ? { riskCompare } : {}),
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

/** 費用の上限を上書きする Worker の環境変数（ダッシュボードの変数。docs/review-api.md の節7） */
export interface BudgetEnv {
  BUDGET_MONTHLY_USD?: string;
  BUDGET_PER_REVIEW_USD?: string;
}

/**
 * env の上限で config.budget を上書きした新しい設定を返す（元の config は変えない）。
 * 無い・空なら review.config.json の値のまま。有限の正の数として読めなければその上限を NaN にし、名前を invalid に入れる
 * （黙って既定に戻さず、budget の段階で止める）。
 */
export function applyBudgetEnv(config: ReviewConfig, env: BudgetEnv): { config: ReviewConfig; invalid: string[] } {
  const invalid: string[] = [];
  const pick = (name: keyof BudgetEnv, fallback: number): number => {
    const raw = env[name]?.trim() ?? '';
    if (raw === '') return fallback;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
    invalid.push(name);
    return NaN;
  };
  const budget = {
    monthlyUsd: pick('BUDGET_MONTHLY_USD', config.budget.monthlyUsd),
    perReviewUsd: pick('BUDGET_PER_REVIEW_USD', config.budget.perReviewUsd),
  };
  return { config: { ...config, budget }, invalid };
}

/** リポジトリの表の行の上書き（review-api/src/repos.ts が表から読む。検査は repos.ts） */
export interface RepoOverrides {
  budget?: { monthlyUsd?: number; perReviewUsd?: number };
  trigger?: { branchPrefix?: string; requireClosesIssue?: boolean; issueLink?: IssueLink };
}

/**
 * 表の行の上書きを重ねた新しい設定を返す（元の config は変えない）。上限は 行の budget → BUDGET_*（applyBudgetEnv）→ review.config.json の順。
 * 行の上限が有限の正の数でなければ、その上限を NaN にして名前（repo.budget.<鍵>）を invalid に入れる（budget の段階で止める）。trigger は行にある鍵だけを重ねる
 */
export function applyRepoOverrides(config: ReviewConfig, overrides: RepoOverrides, env: BudgetEnv): { config: ReviewConfig; invalid: string[] } {
  const fromEnv = applyBudgetEnv(config, env);
  const invalid: string[] = [];
  const budget = { ...fromEnv.config.budget };
  for (const key of ['monthlyUsd', 'perReviewUsd'] as const) {
    const v = overrides.budget?.[key];
    if (v === undefined) {
      if (fromEnv.invalid.includes(key === 'monthlyUsd' ? 'BUDGET_MONTHLY_USD' : 'BUDGET_PER_REVIEW_USD')) {
        invalid.push(key === 'monthlyUsd' ? 'BUDGET_MONTHLY_USD' : 'BUDGET_PER_REVIEW_USD');
      }
      continue;
    }
    if (Number.isFinite(v) && v > 0) budget[key] = v;
    else {
      budget[key] = NaN;
      invalid.push(`repo.budget.${key}`);
    }
  }
  const t = overrides.trigger ?? {};
  const trigger = {
    ...config.trigger,
    ...(t.branchPrefix !== undefined ? { branchPrefix: t.branchPrefix } : {}),
    ...(t.requireClosesIssue !== undefined ? { requireClosesIssue: t.requireClosesIssue } : {}),
    ...(t.issueLink !== undefined ? { issueLink: t.issueLink } : {}),
  };
  return { config: { ...config, budget, trigger }, invalid };
}
