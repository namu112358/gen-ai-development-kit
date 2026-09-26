import { LABELS } from './config.ts';

/**
 * Routine の次の行動を決める純粋関数。GitHub から集めた事実（Facts）だけを入力にする。
 * 段階は GitHub の状態から毎回再構成するので、途中で落ちた実行の続きから冪等に進められる。
 */

export type Claim = { by: 'routine'; session: string; at: string } | { by: 'manual'; at: string };

export interface IssueFacts {
  number: number;
  title: string;
  labels: string[];
  readyAt: string | null;
  claim: Claim | null;
  openBlockers: number[];
  /** App の最新の計画ゲート記録 */
  gate: { pass: boolean; planCommentId: number; at: string } | null;
  /** Claude が書いた最新の計画コメント */
  latestPlanAt: string | null;
  /** agent:plan-ok を最後に付けたのが App か */
  planOkByApp: boolean;
  openPr: number | null;
}

export interface PrFacts {
  number: number;
  issue: number | null;
  readyAt: string | null;
  labels: string[];
  headSha: string;
  headPushedAt: string;
  /** 現在の patch-id に対する App の受け付け記録 */
  acceptance: { reviewPass: boolean; at: string } | null;
  /** 現在の head に対する Claude の判定コメントがあり、App の返答（受け付け・却下）がまだない */
  verdictAwaitingGate: boolean;
  /** 最後の push より後の、人（Claude・App 以外のコラボレーター）のレビュー・コメントの数 */
  humanFeedbackSincePush: number;
}

export type Action =
  | { kind: 'plan'; issue: number }
  | { kind: 'implement'; issue: number; planCommentId: number }
  | { kind: 'wait-dependency'; issue: number; blockers: number[] }
  | { kind: 'judge'; pr: number; issue: number | null; headSha: string }
  | { kind: 'fix'; pr: number; issue: number | null; reason: 'review' | 'human' }
  | { kind: 'skip'; target: string; reason: string };

export interface QueueOptions {
  currentSession: string | null;
  now: Date;
  /** 終了したとみなす Routine の claim の経過時間（分） */
  routineClaimTakeoverMinutes: number;
}

const has = (labels: string[], name: string) => labels.includes(name);

export function decideIssue(f: IssueFacts, opts: QueueOptions): Action {
  const target = `#${f.number}`;
  for (const stop of [LABELS.hold, LABELS.blocked, LABELS.planReview, LABELS.waiting]) {
    if (has(f.labels, stop)) return { kind: 'skip', target, reason: `\`${stop}\`` };
  }
  if (!has(f.labels, LABELS.ready)) return { kind: 'skip', target, reason: '`agent:ready` がありません' };
  if (f.openPr !== null || has(f.labels, LABELS.inPr)) return { kind: 'skip', target, reason: `PR #${f.openPr ?? '?'} の段階です` };
  if (has(f.labels, LABELS.working) && f.claim) {
    if (f.claim.by === 'manual') return { kind: 'skip', target, reason: '人のセッションが着手中' };
    if (f.claim.session !== opts.currentSession) {
      const minutes = (opts.now.getTime() - new Date(f.claim.at).getTime()) / 60_000;
      if (minutes < opts.routineClaimTakeoverMinutes) return { kind: 'skip', target, reason: '別の Routine の実行が着手中' };
    }
  }
  if (f.openBlockers.length > 0) return { kind: 'wait-dependency', issue: f.number, blockers: f.openBlockers };

  const planPending = f.latestPlanAt !== null && (f.gate === null || f.gate.at < f.latestPlanAt);
  if (planPending) return { kind: 'skip', target, reason: '計画ゲートの結果待ち' };
  if (f.gate === null) return { kind: 'plan', issue: f.number };
  if (!f.gate.pass) return { kind: 'skip', target, reason: '計画ゲートで停止中' };
  if (!has(f.labels, LABELS.planOk) || !f.planOkByApp) return { kind: 'skip', target, reason: '`agent:plan-ok` が App によって付けられていません' };
  return { kind: 'implement', issue: f.number, planCommentId: f.gate.planCommentId };
}

export function decidePr(f: PrFacts): Action {
  const target = `PR #${f.number}`;
  for (const stop of [LABELS.hold, LABELS.blocked]) {
    if (has(f.labels, stop)) return { kind: 'skip', target, reason: `\`${stop}\`` };
  }
  if (f.humanFeedbackSincePush > 0) return { kind: 'fix', pr: f.number, issue: f.issue, reason: 'human' };
  if (f.verdictAwaitingGate) return { kind: 'skip', target, reason: '判定の受け付け待ち' };
  if (!f.acceptance) return { kind: 'judge', pr: f.number, issue: f.issue, headSha: f.headSha };
  if (!f.acceptance.reviewPass) return { kind: 'fix', pr: f.number, issue: f.issue, reason: 'review' };
  return { kind: 'skip', target, reason: '判定済み（Merge 待ち）' };
}

/** 先着順（agent:ready が付いた順）に並べ、上限件数まで返す。skip は上限に数えない */
export function buildQueue(issues: IssueFacts[], prs: PrFacts[], opts: QueueOptions, limit: number): { actions: Action[]; skipped: Action[] } {
  const items = [
    ...issues.map((f) => ({ at: f.readyAt, action: decideIssue(f, opts) })),
    ...prs.map((f) => ({ at: f.readyAt, action: decidePr(f) })),
  ].sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  const actions = items.filter((i) => i.action.kind !== 'skip').map((i) => i.action);
  const skipped = items.filter((i) => i.action.kind === 'skip').map((i) => i.action);
  return { actions: actions.slice(0, limit), skipped };
}
