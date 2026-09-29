import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TITLE_TYPES } from './title.ts';
import type { PricingTable } from './usage.ts';

/**
 * `harness.config.json` の読み込みと、ラベル・理由コード・必須チェックの名前などの定義。
 */

export interface HarnessConfig {
  appSlug: string;
  defaultBranch: string;
  agentBranchPrefix: string;
  /** ダッシュボード Issue にこのラベルがあれば自動 Merge モードは停止（ダッシュボードが無い場合も停止） */
  autoMergeStopLabel: string;
  classification: {
    /** [名前, 上限行数] を小さい順に。最後の上限を超えたら XXL */
    sizes: [string, number][];
    sizeExclude: string[];
    /** area 名 → パスのパターン（harness/lib/scope.ts の書式） */
    areas: Record<string, string[]>;
    /** Issue の分類を Jev に問うか（shadow は提案コメントのみ、label は足りないラベルを Jev が付ける） */
    issueTriage: 'off' | 'shadow' | 'label';
  };
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
  routine: { maxItemsPerRun: number; humanClaimStaleHours: number; routineClaimTakeoverMinutes: number };
  /** テストファイルのパターン（harness/lib/scope.ts の書式）。agent/tests が改ざんを検査する。無ければ既定（harness/lib/test-tamper.ts） */
  testPatterns?: string[];
  /** area 名 → 同時に開いてよい、判定前の Agent PR（Draft）の数。上限に達した領域の Issue には新しく着手しない（無い領域は無制限） */
  areaConcurrency?: Record<string, number>;
  /** ガードレール（Agent が自分を縛る仕組み）のパターン。触れる PR は自動 Merge せず、触れる計画は計画ゲートで止める（harness/lib/guardrail.ts）。無ければすべてのファイルをガードレールとして扱う */
  guardrailPaths?: string[];
  /** guardrailPaths の中で普通に判定するもの（harness.config.json は外せない） */
  guardrailExclude?: string[];
  /**
   * 導入先の製品で必ず人が Merge するパス（認証・マイグレーション・課金など。範囲パターンの書式、harness/lib/scope.ts）。
   * 触れる PR は Risk に関わらず自動 Merge しない。計画ゲートには効かない。無ければ何もしない
   */
  humanMergePaths?: string[];
  /**
   * 委任承認（人が計画ゲートの承認と Merge の判断を App に委ねる。docs/risk-policy.md）。ダッシュボードの planLabel は計画ゲートの承認だけを、
   * mergeLabel は計画ゲートの承認と Merge の判断を委ねる。期限は無く、ラベルが付いている間ずっと有効。無ければ既定値（delegateConfig）
   */
  delegate?: { planLabel?: string; mergeLabel?: string };
  /** 古いキー。label だけを mergeLabel として読む（hours・minRemainingMinutes は読まない）。delegate.mergeLabel があればそちらが優先 */
  delegateMerge?: { label?: string; hours?: number; minRemainingMinutes?: number };
  /**
   * 委任承認の間でも人が承認・Merge するパス（自動 Merge の仕組みそのもの。harness.config.json は一覧に無くても当たる）。範囲パターンの書式。
   * 触れる PR は委任で自動経路に乗せず、重なりうる files の計画は委任で計画ゲートを通さない
   */
  delegateMergeExclude?: string[];
  /**
   * Ruleset の必須チェックのうち、導入先の CI が出すもの（harness/lib/ruleset.ts）。integrationId を省くと GitHub Actions。
   * 無ければ `[{ "context": "ci" }]`、空の配列ならプロジェクトの CI を必須にしない。ハーネスのチェックはここに書かない（コードに固定）
   */
  projectChecks?: { context: string; integrationId?: number }[];
  fixLoop: { normalLimit: number; criticalLimit: number };
  staleHours: number;
  dashboardIssueTitle: string;
  reviewPanel?: { mode: 'off' | 'shadow' | 'enforce' }; // 合体版のレビューの動かし方（docs/review-panel.md）。無ければ off
  /**
   * fleet の進め方。nesting が orca なら ship をサブエージェントで並行に動かし（入れ子のサブエージェントが使える環境）、
   * flat なら1つのセッションで段階を交互に進める。maxParallelShips は --max が無いときに同時に動かす ship の数。無ければ既定値（fleetConfig）
   */
  fleet?: { nesting?: 'orca' | 'flat'; maxParallelShips?: number };
  jev: { mode: 'off' | 'shadow' | 'enforce'; model: string; maxDiffChars: number; /** 人の決定の記録で Planner の申告の停止を外すか（無ければ shadow） */ decisionRelease?: 'off' | 'shadow' | 'enforce'; thresholds: { lowProbability: number; noulSafe: number; /** issueTriage が label のとき、ラベルを付ける確率の下限 */ labelProbability?: number; /** 決定の記録がすべてに答えているとみなす確率の下限（無ければ 0.9） */ decisionProbability?: number } };
  /** モデル ID → 100 万トークンあたりの USD（推定料金用。`$comment` は無視される） */
  pricing?: PricingTable;
}

const CONFIG_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));

export function loadConfig(path: string = CONFIG_PATH): HarnessConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;
}

/** 委任承認のラベルの既定値 */
export const DELEGATE_DEFAULTS = { planLabel: 'agent:delegate-plan', mergeLabel: 'agent:delegate-merge' } as const;

/** 委任承認のラベル（無い項目は既定値。古い delegateMerge.label も mergeLabel として読み、delegate.mergeLabel が優先） */
export function delegateConfig(config: Pick<HarnessConfig, 'delegate' | 'delegateMerge'>): { planLabel: string; mergeLabel: string } {
  return {
    planLabel: config.delegate?.planLabel ?? DELEGATE_DEFAULTS.planLabel,
    mergeLabel: config.delegate?.mergeLabel ?? config.delegateMerge?.label ?? DELEGATE_DEFAULTS.mergeLabel,
  };
}

/** fleet の進め方の既定値 */
export const FLEET_DEFAULTS = { nesting: 'orca', maxParallelShips: 3 } as const;

/** fleet の進め方（無い項目は既定値）。書式の誤りは throw する（方式が決まらないまま進めない） */
export function fleetConfig(config: Pick<HarnessConfig, 'fleet'>): { nesting: 'orca' | 'flat'; maxParallelShips: number } {
  const { nesting = FLEET_DEFAULTS.nesting, maxParallelShips = FLEET_DEFAULTS.maxParallelShips } = (config.fleet ?? {}) as { nesting?: unknown; maxParallelShips?: unknown };
  if (nesting !== 'orca' && nesting !== 'flat') throw new Error('fleet.nesting は orca か flat で書いてください');
  if (typeof maxParallelShips !== 'number' || !Number.isInteger(maxParallelShips) || maxParallelShips <= 0) throw new Error('fleet.maxParallelShips は正の整数で書いてください');
  return { nesting, maxParallelShips };
}

/** App が操作したことを示す GitHub 上のログイン名 */
export function appLogin(config: HarnessConfig): string {
  return `${config.appSlug}[bot]`;
}

export const LABELS = {
  ready: 'agent:ready',
  planReview: 'agent:plan-review',
  planOk: 'agent:plan-ok',
  waiting: 'agent:waiting',
  blocked: 'agent:blocked',
  hold: 'agent:hold',
  /** 子課題に分けた親 Issue（課題の種類なので agent:* にせず、Close しても残す） */
  epic: 'epic',
} as const;

/** 止めたとき（agent:blocked / agent:plan-review）に必ず残す理由コード */
export const REASON_CODES = {
  'form-error': 'Issue 本文が Issue Form の書式でない',
  'plan-invalid': '計画の構造化出力が読めない',
  'needs-decision': '仕様・設計・AC について人の判断が必要',
  'high-risk': '想定 Risk が high 以上',
  'split-invalid': 'Epic の分け方（split）が検査に通らない',
  'resplit': 'Epic を子課題に分けた後に、別の分け方の計画が来た',
  'split-failed': 'Epic の子課題を作る途中で失敗した',
  'fix-limit': '修正回数の上限に達した',
  'orphan-base': 'スタックでないのに base が既定ブランチ以外の PR（Draft に留めている）',
  'external': '権限・外部サービス・手作業など Claude の外の対応が必要',
  'other': 'その他（コメントに詳細）',
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

export const reasonMark = (code: ReasonCode): string => `<!-- agent-harness:reason code=${code} -->`;

export function reasonOf(body: string | null | undefined): ReasonCode | null {
  const code = (body ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').match(/<!-- agent-harness:reason code=([\w-]+) -->/)?.[1];
  return code && code in REASON_CODES ? (code as ReasonCode) : null;
}

/** queue の並び順を変える優先度ラベル（高い順。付いていなければ medium） */
export const PRIORITY_LABELS = {
  highest: 'priority:highest',
  high: 'priority:high',
  medium: 'priority:medium',
  low: 'priority:low',
  lowest: 'priority:lowest',
} as const;

const PRIORITY_ORDER: string[] = Object.values(PRIORITY_LABELS);

/** 小さいほど先に処理する（highest=0 … lowest=4）。複数付いていれば最も高いもの、無ければ medium */
export function priorityRank(labels: string[]): number {
  const ranks = labels.map((l) => PRIORITY_ORDER.indexOf(l)).filter((r) => r >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : PRIORITY_ORDER.indexOf(PRIORITY_LABELS.medium);
}

/** 課題の種類のラベル（タイトルの type と同じ一覧） */
export const typeLabel = (type: (typeof TITLE_TYPES)[number]): string => `type:${type}`;

/** ハーネスが管理するラベルの接頭辞。setup-labels は定義に無いものを消す（廃止したラベルを残さない） */
export const MANAGED_PREFIXES = ['agent:', 'risk:', 'priority:', 'type:', 'size:', 'area:', 'plan:', 'review:', 'test:'];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const riskLabel = (level: RiskLevel): string => `risk:${level}`;

export const CHECKS = {
  review: 'agent/review',
  risk: 'agent/risk',
  scope: 'agent/scope',
  mergeRoute: 'merge-route',
  planLink: 'agent/plan-link',
  title: 'agent/title',
  tests: 'agent/tests',
} as const;

/** GitHub Actions の App ID（Ruleset の必須チェックの出どころ） */
export const GITHUB_ACTIONS_APP_ID = 15368;

/**
 * projectChecks を既定値で埋めて検査する。書式の誤りは throw する。
 * loadConfig では検査しない（ゲートはこのキーを使わないので、誤りで全ゲートを止めない）。使うのは setup.ts の ruleset
 */
export function projectChecks(config: HarnessConfig): { context: string; integrationId: number }[] {
  const raw: unknown = config.projectChecks ?? [{ context: 'ci' }];
  if (!Array.isArray(raw)) throw new Error('projectChecks は配列で書いてください');
  const harness = new Set<string>(Object.values(CHECKS));
  const seen = new Set<string>();
  return raw.map((item: unknown, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`projectChecks[${i}] はオブジェクトで書いてください`);
    const { context, integrationId = GITHUB_ACTIONS_APP_ID } = item as { context?: unknown; integrationId?: unknown };
    if (typeof context !== 'string' || context.trim() === '') throw new Error(`projectChecks[${i}].context は空でない文字列で書いてください`);
    if (typeof integrationId !== 'number' || !Number.isInteger(integrationId) || integrationId <= 0) throw new Error(`projectChecks[${i}].integrationId は正の整数で書いてください`);
    if (harness.has(context)) throw new Error(`projectChecks[${i}].context の ${context} はハーネスのチェックと同じ名前です（ハーネスのチェックは設定に書きません）`);
    if (seen.has(context)) throw new Error(`projectChecks の ${context} が重複しています`);
    seen.add(context);
    return { context, integrationId };
  });
}

/** 人の PR を判定を待たずに通すラベル（人だけが付ける） */
export const REVIEW_EXEMPT_LABEL = 'review:exempt';

/** 計画のある Issue を Closes しない PR を例外として通すラベル（人だけが付ける） */
export const PLAN_EXEMPT_LABEL = 'plan:exempt';

/** テストを弱める変更を例外として通すラベル（人だけが付ける） */
export const TEST_EXEMPT_LABEL = 'test:exempt';

/** ラベルの定義（setup-labels が使う） */
export const LABEL_DEFS: { name: string; color: string; description: string }[] = [
  { name: LABELS.ready, color: '0e8a16', description: '人: 着手してよい。Routine が次の実行で拾う' },
  { name: LABELS.planReview, color: 'd93f0b', description: 'Routine/App: 計画済み・人間の判断が必要' },
  { name: LABELS.planOk, color: '0052cc', description: 'App のみ: 計画ゲート通過' },
  { name: LABELS.waiting, color: 'c5def5', description: 'Routine/App: 依存待ち' },
  { name: LABELS.blocked, color: 'b60205', description: '人の対応が必要' },
  { name: LABELS.hold, color: '000000', description: '人: 個別停止' },
  { name: LABELS.epic, color: '3e4b9e', description: 'App: 子課題に分けた親 Issue（queue は飛ばす）' },
  { name: PRIORITY_LABELS.highest, color: '5c0000', description: '人/App: queue で最も先に処理する' },
  { name: PRIORITY_LABELS.high, color: 'b60205', description: '人/App: queue で先に処理する' },
  { name: PRIORITY_LABELS.medium, color: 'fbca04', description: '人/App: 通常（優先度の無い Issue もこの扱い）' },
  { name: PRIORITY_LABELS.low, color: 'c5def5', description: '人/App: queue で後に処理する' },
  { name: PRIORITY_LABELS.lowest, color: 'ededed', description: '人/App: queue で最も後に処理する' },
  ...TITLE_TYPES.map((t) => ({ name: typeLabel(t), color: 'd4c5f9', description: `人/App: 課題の種類（タイトルの type が ${t}）。Epic には付けない` })),
  { name: 'review:exempt', color: 'fef2c0', description: '人: 判定を待たずに agent/review を通す' },
  { name: 'plan:exempt', color: 'fef2c0', description: '人: 計画のある Issue に紐付かない PR を例外として通す' },
  { name: TEST_EXEMPT_LABEL, color: 'fef2c0', description: '人: テストを弱める変更を例外として agent/tests を通す' },
  { name: 'agent:auto-merge-stopped', color: '000000', description: 'ダッシュボード専用: 自動 Merge モードの停止スイッチ' },
  { name: DELEGATE_DEFAULTS.planLabel, color: '8a63d2', description: 'ダッシュボード専用・人だけが付ける: 計画ゲートの承認を App に委ねる（委任承認・計画）' },
  { name: DELEGATE_DEFAULTS.mergeLabel, color: '5319e7', description: 'ダッシュボード専用・人だけが付ける: 計画ゲートの承認と Merge を App に委ねる（委任承認・計画＋Merge）' },
  { name: riskLabel('low'), color: 'c2e0c6', description: 'Issue：計画時の想定 Risk／PR：App が受け付けた判定の Risk（表示用）' },
  { name: riskLabel('medium'), color: 'fef2c0', description: 'Issue：計画時の想定 Risk／PR：App が受け付けた判定の Risk（表示用）' },
  { name: riskLabel('high'), color: 'f9d0c4', description: 'Issue：計画時の想定 Risk／PR：App が受け付けた判定の Risk（表示用）' },
  { name: riskLabel('critical'), color: 'e99695', description: 'Issue：計画時の想定 Risk／PR：App が受け付けた判定の Risk（表示用）' },
];

/** 設定から作るラベル（size:* と area:*）を含めた、導入先に作るラベルの一覧 */
export function allLabelDefs(config: HarnessConfig): { name: string; color: string; description: string }[] {
  const sizes = [...config.classification.sizes.map(([name, max]) => ({ name, description: `App: 差分 ${max} 行未満` })), { name: 'XXL', description: 'App: それより大きい差分' }];
  return [
    ...LABEL_DEFS,
    ...sizes.map((s) => ({ name: `size:${s.name}`, color: 'ededed', description: s.description })),
    ...Object.keys(config.classification.areas).map((a) => ({ name: `area:${a}`, color: 'bfd4f2', description: `App: ${config.classification.areas[a]!.join(', ')}`.slice(0, 100) })),
  ];
}

/** ゲートがコメントを受け付ける作成者の関連（Q60） */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
