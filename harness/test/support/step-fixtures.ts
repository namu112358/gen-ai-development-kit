/**
 * agent.ts step（harness/lib/step.ts）のテスト用の事実の既定値（Issue #306）。IssueFacts・PrFacts・FleetIssue・FleetPr・StepInput を、
 * 既定値に上書きしたいところだけを渡して作る。App の変更要求レビュー（kind=fix-request）の本文も、判定のゲートと同じ形で作る。
 */
import type { FleetIssue, FleetPr } from '../../lib/fleet.ts';
import type { Claim, ClaimStage, IssueFacts, PrFacts } from '../../lib/queue.ts';
import type { StepInput } from '../../lib/step.ts';
import type { BlockingFinding, BlockingKind } from '../../lib/verdict.ts';

/** 付き添いのセッションの ID（TRANSCRIPT_SESSION_ID の形） */
export const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
/** ほかのセッションの ID */
export const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';
export const NOW = new Date('2026-09-26T12:00:00Z');
/** Issue 番号と PR 番号の既定値 */
export const N = 306;
export const PR = 400;
export const PR_BRANCH = `claude/issue-${N}-step`;

export const GATE_AT = '2026-09-26T01:01:00Z';
export const PLAN_AT = '2026-09-26T01:00:00Z';

/** 計画の無い Issue の事実 */
export const issueFacts = (patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: N,
  title: `t${N}`,
  labels: ['agent:ready'],
  readyAt: '2026-09-26T00:00:00Z',
  claim: null,
  openBlockers: [],
  gate: null,
  latestPlanAt: null,
  planOkByApp: false,
  openPr: null,
  ...patch,
});

/** 計画ゲートを通った（App が agent:plan-ok を付けた）Issue の事実 */
export const planOkFacts = (patch: Partial<IssueFacts> = {}): IssueFacts =>
  issueFacts({ labels: ['agent:ready', 'agent:plan-ok'], gate: { pass: true, planCommentId: 5, at: GATE_AT }, latestPlanAt: PLAN_AT, planOkByApp: true, ...patch });

/** 開いた Agent PR の事実（判定なし） */
export const prFacts = (patch: Partial<PrFacts> = {}): PrFacts => ({
  number: PR,
  agent: true,
  conflicted: false,
  claim: null,
  issueLabels: [],
  issue: N,
  readyAt: null,
  labels: [],
  headSha: 'h',
  headPushedAt: '2026-09-26T02:00:00Z',
  acceptance: null,
  verdictAwaitingGate: false,
  humanFeedbackSincePush: 0,
  ...patch,
});

/** 開いた PR（pr は FleetPr の上書き、facts は PrFacts の上書き） */
export const openPr = (facts: Partial<PrFacts> = {}, pr: Partial<Omit<FleetPr, 'facts'>> = {}): FleetPr => ({
  number: PR,
  merged: false,
  draft: true,
  autoMerge: false,
  humanReview: false,
  behindMain: false,
  ...pr,
  facts: prFacts({ number: pr.number ?? PR, ...facts }),
});

export const mergedPr = (number = PR): FleetPr => ({ number, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null });

export const fleetIssue = (facts: IssueFacts, opts: { prs?: FleetPr[]; planFiles?: string[] | null; closed?: boolean } = {}): FleetIssue => ({
  facts,
  closed: opts.closed ?? false,
  planFiles: opts.planFiles === undefined ? (facts.gate ? ['harness/lib/step.ts'] : null) : opts.planFiles,
  prs: opts.prs ?? [],
});

/** step の入力。issue の他は既定値（このセッションの ID あり・担当の食い違いなし・上限 3・批評の回なし・local none） */
export const stepInput = (issue: FleetIssue, patch: Partial<StepInput> = {}): StepInput => ({
  issue,
  session: SESSION,
  assignee: null,
  areaFull: null,
  fixRequests: [],
  mergeCommits: 0,
  blockedReason: null,
  prBranch: issue.prs.some((p) => !p.merged && p.facts !== null) ? PR_BRANCH : null,
  syncLimit: 3,
  critique: [],
  local: { kind: 'none' },
  proceed: false,
  now: NOW,
  humanClaimStaleHours: 6,
  ...patch,
});

/** 手動の着手宣言 */
export const manual = (session: string, stage: ClaimStage, patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', session, stage, ...patch });

export const finding = (kind: BlockingKind, detail: string, file?: string): BlockingFinding => ({ kind, detail, ...(file !== undefined ? { file } : {}) });

/** App の変更要求レビューの本文（harness/gates/on-comment.ts の renderBlockingReview と同じ形） */
export function fixRequestBody(blocking: BlockingFinding[], round: number): string {
  return [
    `<!-- agent-harness:app kind=fix-request -->`,
    `Reviewer のブロッキング指摘（修正 ${round} 回目）。修正して push してください。`,
    '',
    ...blocking.map((b) => `- **${b.kind}**${b.file ? ` \`${b.file}\`` : ''}: ${b.detail}`),
  ].join('\n');
}
