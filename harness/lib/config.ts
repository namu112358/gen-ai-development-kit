import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface HarnessConfig {
  appSlug: string;
  defaultBranch: string;
  agentBranchPrefix: string;
  /** ダッシュボード Issue にこのラベルがあれば自動 Merge モードは停止（ダッシュボードが無い場合も停止） */
  autoMergeStopLabel: string;
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
  working: 'agent:working',
  planReview: 'agent:plan-review',
  planOk: 'agent:plan-ok',
  inPr: 'agent:in-pr',
  waiting: 'agent:waiting',
  blocked: 'agent:blocked',
  hold: 'agent:hold',
} as const;

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const riskLabel = (level: RiskLevel): string => `risk:${level}`;

export const CHECKS = {
  review: 'agent/review',
  risk: 'agent/risk',
  scope: 'agent/scope',
  mergeRoute: 'merge-route',
} as const;

/** ラベルの定義（setup-labels が使う） */
export const LABEL_DEFS: { name: string; color: string; description: string }[] = [
  { name: LABELS.ready, color: '0e8a16', description: '人: 着手してよい。Routine が次の実行で拾う' },
  { name: LABELS.working, color: 'fbca04', description: 'Routine/人: 着手宣言（claim）' },
  { name: LABELS.planReview, color: 'd93f0b', description: 'Routine/App: 計画済み・人間の判断が必要' },
  { name: LABELS.planOk, color: '0052cc', description: 'App のみ: 計画ゲート通過' },
  { name: LABELS.inPr, color: '5319e7', description: 'Routine: Draft PR 作成済み' },
  { name: LABELS.waiting, color: 'c5def5', description: 'Routine/App: 依存待ち' },
  { name: LABELS.blocked, color: 'b60205', description: '人の対応が必要' },
  { name: LABELS.hold, color: '000000', description: '人: 個別停止' },
  { name: 'agent:auto-merge-stopped', color: '000000', description: 'ダッシュボード専用: 自動 Merge モードの停止スイッチ' },
  { name: riskLabel('low'), color: 'c2e0c6', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('medium'), color: 'fef2c0', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('high'), color: 'f9d0c4', description: '計画時の想定 Risk（表示用）' },
  { name: riskLabel('critical'), color: 'e99695', description: '計画時の想定 Risk（表示用）' },
];

/** ゲートがコメントを受け付ける作成者の関連（Q60） */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
