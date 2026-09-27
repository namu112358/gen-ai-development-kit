import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
    /** Issue の分類を Jev に問うか（shadow は提案コメントのみ） */
    issueTriage: 'off' | 'shadow';
  };
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
  routine: { maxItemsPerRun: number; humanClaimStaleHours: number; routineClaimTakeoverMinutes: number };
  fixLoop: { normalLimit: number; criticalLimit: number };
  staleHours: number;
  dashboardIssueTitle: string;
  jev: { mode: 'off' | 'shadow' | 'enforce'; model: string; maxDiffChars: number; thresholds: { lowProbability: number; noulSafe: number } };
}

const CONFIG_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));

export function loadConfig(path: string = CONFIG_PATH): HarnessConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;
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
} as const;

/** 止めたとき（agent:blocked / agent:plan-review）に必ず残す理由コード */
export const REASON_CODES = {
  'form-error': 'Issue 本文が Issue Form の書式でない',
  'plan-invalid': '計画の構造化出力が読めない',
  'needs-decision': '仕様・設計・AC について人の判断が必要',
  'high-risk': '想定 Risk が high 以上',
  'fix-limit': '修正回数の上限に達した',
  'external': '権限・外部サービス・手作業など Claude の外の対応が必要',
  'other': 'その他（コメントに詳細）',
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

export const reasonMark = (code: ReasonCode): string => `<!-- agent-harness:reason code=${code} -->`;

export function reasonOf(body: string | null | undefined): ReasonCode | null {
  const code = (body ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').match(/<!-- agent-harness:reason code=([\w-]+) -->/)?.[1];
  return code && code in REASON_CODES ? (code as ReasonCode) : null;
}

/** queue の並び順を変える優先度ラベル（付いていなければ通常） */
export const PRIORITY_LABELS = { high: 'priority:high', low: 'priority:low' } as const;

/** 小さいほど先に処理する */
export function priorityRank(labels: string[]): number {
  if (labels.includes(PRIORITY_LABELS.high)) return 0;
  if (labels.includes(PRIORITY_LABELS.low)) return 2;
  return 1;
}

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const riskLabel = (level: RiskLevel): string => `risk:${level}`;

export const CHECKS = {
  review: 'agent/review',
  risk: 'agent/risk',
  scope: 'agent/scope',
  mergeRoute: 'merge-route',
  planLink: 'agent/plan-link',
} as const;

/** 人の PR を判定を待たずに通すラベル（人だけが付ける） */
export const REVIEW_EXEMPT_LABEL = 'review:exempt';

/** 計画のある Issue を Closes しない PR を例外として通すラベル（人だけが付ける） */
export const PLAN_EXEMPT_LABEL = 'plan:exempt';

/** ラベルの定義（setup-labels が使う） */
export const LABEL_DEFS: { name: string; color: string; description: string }[] = [
  { name: LABELS.ready, color: '0e8a16', description: '人: 着手してよい。Routine が次の実行で拾う' },
  { name: LABELS.planReview, color: 'd93f0b', description: 'Routine/App: 計画済み・人間の判断が必要' },
  { name: LABELS.planOk, color: '0052cc', description: 'App のみ: 計画ゲート通過' },
  { name: LABELS.waiting, color: 'c5def5', description: 'Routine/App: 依存待ち' },
  { name: LABELS.blocked, color: 'b60205', description: '人の対応が必要' },
  { name: LABELS.hold, color: '000000', description: '人: 個別停止' },
  { name: PRIORITY_LABELS.high, color: 'b60205', description: '人: queue で先に処理する' },
  { name: PRIORITY_LABELS.low, color: 'c5def5', description: '人: queue で後に処理する' },
  { name: 'review:exempt', color: 'fef2c0', description: '人: 判定を待たずに agent/review を通す' },
  { name: 'plan:exempt', color: 'fef2c0', description: '人: 計画のある Issue に紐付かない PR を例外として通す' },
  { name: 'agent:auto-merge-stopped', color: '000000', description: 'ダッシュボード専用: 自動 Merge モードの停止スイッチ' },
  { name: riskLabel('low'), color: 'c2e0c6', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('medium'), color: 'fef2c0', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('high'), color: 'f9d0c4', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('critical'), color: 'e99695', description: '計画時の想定 Risk（表示用）' },
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
