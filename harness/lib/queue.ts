import { shortSession } from './blocks.ts';
import { LABELS, priorityRank } from './config.ts';

/**
 * Routine の次の行動を決める純粋関数。GitHub から集めた事実（Facts）だけを入力にする。
 * 段階は GitHub の状態から毎回再構成するので、途中で落ちた実行の続きから冪等に進められる。
 */

/**
 * 着手宣言（コメントの agent-claim）。ラベルは使わない。
 * 解除コメント（released）か、宣言より新しい計画・判定コメントがあれば終わったとみなす（facts.ts の claimOf）。
 */
export type Claim = ({ by: 'routine'; session: string; at: string; stage?: ClaimStage } | { by: 'manual'; at: string; session?: string; stage?: ClaimStage }) & { released?: boolean };

/** 着手宣言の段階（claim --stage）。どの段階で着手しているかを、ほかのセッションとダッシュボードに見せる */
export const CLAIM_STAGES = ['plan', 'plan-critique', 'plan-gate', 'implement', 'judge', 'fix', 'sync'] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];

const activeClaim = (claim: Claim | null): Claim | null => (claim && !claim.released ? claim : null);

/** 今のセッションの手動の宣言か。宣言の session と今のセッションが、どちらも空でない文字列で一致するときだけ（Routine の宣言は含まない） */
export function isOwnClaim(claim: Claim | null, current: string | null): boolean {
  const c = activeClaim(claim);
  return c !== null && c.by === 'manual' && typeof c.session === 'string' && c.session !== '' && typeof current === 'string' && current !== '' && c.session === current;
}

/** 表示用：段階とセッションの短い形（無いものは省く） */
export function describeClaim(claim: Claim): string {
  return [claim.stage ? `段階 ${claim.stage}` : null, claim.session ? `session ${shortSession(claim.session)}` : null].filter(Boolean).join('・');
}

const withDetail = (text: string, claim: Claim): string => {
  const d = describeClaim(claim);
  return d ? `${text}（${d}）` : text;
};

/**
 * claim コマンドで宣言してよいか。ほかのセッションの有効な手動の宣言があれば、期限を過ぎていても止める（引き継ぐのは人が決めて --takeover）。
 * Routine の宣言の上に手動で宣言するのは今までどおり止めない
 */
export function claimBlocker(claim: Claim | null, current: string | null, opts: { takeover: boolean; now: Date; humanClaimStaleHours: number }): string | null {
  const c = activeClaim(claim);
  if (!c || c.by !== 'manual' || opts.takeover || isOwnClaim(c, current)) return null;
  const hours = Math.floor((opts.now.getTime() - new Date(c.at).getTime()) / 3_600_000);
  const stale = hours >= opts.humanClaimStaleHours ? `、${hours} 時間進展なし` : '';
  return withDetail(`ほかのセッションの着手宣言があります${stale}`, c) + '。引き継ぐなら人に確かめてから --takeover を付けてください';
}

/** critic-input・post-plan・worktree の前の確かめ：このセッションの有効な宣言があるか */
export function requireOwnClaim(claim: Claim | null, current: string | null): { error: string | null; warning: string | null } {
  const c = activeClaim(claim);
  if (!c) return { error: '着手宣言がありません。先に claim <番号> --manual --stage <段階> で宣言してください', warning: null };
  if (current === null || current === '') return { error: null, warning: 'このセッションの ID が得られないため、着手宣言が自分のものか見分けられません' };
  if (isOwnClaim(c, current)) return { error: null, warning: null };
  return { error: withDetail('ほかのセッションの着手宣言があります', c) + '。引き継ぐなら人に確かめてから claim --manual --takeover を実行してください', warning: null };
}

/**
 * post-plan の後の着手宣言。ゲートを通る見込みなら、結果を待つ間ほかのセッションに取られないよう plan-gate で出し直す。
 * 通らない見込み（agent:plan-review で人の判断待ち）なら解除する（宣言を残すと「着手中なのに進まない」ように見え、ほかのセッションを待たせる）
 */
export function claimAfterPlan(expectedGate: { pass: boolean }): 'plan-gate' | 'release' {
  return expectedGate.pass ? 'plan-gate' : 'release';
}

/** post-plan が投稿する着手宣言の値。base はこのセッションの手動の宣言（段階と解除の印は上書きする） */
export function claimValueAfterPlan(expectedGate: { pass: boolean }, base: Extract<Claim, { by: 'manual' }>): Claim {
  return claimAfterPlan(expectedGate) === 'plan-gate' ? { ...base, stage: 'plan-gate' } : { ...base, released: true };
}

/** worktree の前に宣言を確かめる Issue の番号。claude/issue-<番号>- のブランチで、--detach でも Routine でもないときだけ */
export function worktreeClaimIssue(branch: string, detach: boolean, routine: boolean): number | null {
  if (detach || routine) return null;
  const m = branch.match(/^claude\/issue-(\d+)-/);
  return m ? Number(m[1]) : null;
}

/**
 * App が main への追従（update-branch）を待つべき判定中の宣言か。有効な宣言で段階が judge、かつ期限内のときだけ true（by は問わない）。
 * 期限は claimedByOther と同じ数え方：手動は humanClaimStaleHours 時間、Routine は routineClaimTakeoverMinutes 分を過ぎたら追従する（落ちたセッションの宣言で止まり続けないため）
 */
export function holdsMainFollow(claim: Claim | null, now: Date, limits: { humanClaimStaleHours: number; routineClaimTakeoverMinutes: number }): boolean {
  const c = activeClaim(claim);
  if (!c || c.stage !== 'judge') return false;
  const minutes = (now.getTime() - new Date(c.at).getTime()) / 60_000;
  if (Number.isNaN(minutes)) return false;
  if (c.by === 'manual') return Math.floor(minutes / 60) < limits.humanClaimStaleHours;
  return minutes < limits.routineClaimTakeoverMinutes;
}

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
  /** 計画の触るファイルが入る領域のうち、判定前の Agent PR（Draft）の数が上限に達しているもの（説明文。無ければ null） */
  areaFull?: string | null;
}

export interface PrFacts {
  number: number;
  /** Agent PR（claude/ ブランチ）か。人の PR は判定だけで、修正は人が行う */
  agent: boolean;
  /** main と衝突している（mergeable_state が dirty） */
  conflicted: boolean;
  /** PR が Close する Issue のラベル（優先度を引き継ぐ） */
  issueLabels: string[];
  claim: Claim | null;
  issue: number | null;
  readyAt: string | null;
  labels: string[];
  headSha: string;
  headPushedAt: string;
  /** 現在の patch-id に対する App の受け付け記録 */
  acceptance: { reviewPass: boolean; at: string } | null;
  /** 現在の head に対する Claude の判定コメントがあり、App の返答（受け付け・却下）がまだない（一定時間で打ち切る） */
  verdictAwaitingGate: boolean;
  /** 最後の push より後の、人（Claude・App 以外のコラボレーター）のレビューの数（会話コメントは数えない） */
  humanFeedbackSincePush: number;
}

export type Action =
  | { kind: 'plan'; issue: number }
  | { kind: 'implement'; issue: number; planCommentId: number }
  | { kind: 'wait-dependency'; issue: number; blockers: number[] }
  | { kind: 'judge'; pr: number; issue: number | null; headSha: string }
  | { kind: 'fix'; pr: number; issue: number | null; reason: 'review' | 'human' }
  | { kind: 'resolve-conflict'; pr: number; issue: number | null }
  | { kind: 'skip'; target: string; reason: string };

export interface QueueOptions {
  currentSession: string | null;
  now: Date;
  /** 終了したとみなす Routine の claim の経過時間（分） */
  routineClaimTakeoverMinutes: number;
  /** 人の着手をこの時間を過ぎたら停滞として表示する（奪いはしない） */
  humanClaimStaleHours: number;
}

const has = (labels: string[], name: string) => labels.includes(name);

/** 着手宣言があり、奪ってはいけないなら理由を返す */
function claimedByOther(claim: Claim | null, opts: QueueOptions): string | null {
  if (!claim || claim.released) return null;
  const minutes = (opts.now.getTime() - new Date(claim.at).getTime()) / 60_000;
  if (claim.by === 'manual') {
    if (isOwnClaim(claim, opts.currentSession)) return null;
    const hours = Math.floor(minutes / 60);
    const detail = [hours >= opts.humanClaimStaleHours ? `${hours} 時間進展なし・停滞` : null, describeClaim(claim) || null].filter(Boolean).join('・');
    return detail ? `人のセッションが着手中（${detail}）` : '人のセッションが着手中';
  }
  if (claim.session === opts.currentSession) return null;
  return minutes < opts.routineClaimTakeoverMinutes ? '別の Routine の実行が着手中' : null;
}

export function decideIssue(f: IssueFacts, opts: QueueOptions): Action {
  const target = `#${f.number}`;
  for (const stop of [LABELS.hold, LABELS.blocked, LABELS.planReview, LABELS.waiting]) {
    if (has(f.labels, stop)) return { kind: 'skip', target, reason: `\`${stop}\`` };
  }
  // Epic は PR を持たない。計画・実装は子課題で進める
  if (has(f.labels, LABELS.epic)) return { kind: 'skip', target, reason: 'Epic（子課題で進める）' };
  if (!has(f.labels, LABELS.ready)) return { kind: 'skip', target, reason: '`agent:ready` がありません' };
  if (f.openPr !== null) return { kind: 'skip', target, reason: `PR #${f.openPr} の段階です` };
  const claimed = claimedByOther(f.claim, opts);
  if (claimed) return { kind: 'skip', target, reason: claimed };
  if (f.openBlockers.length > 0) return { kind: 'wait-dependency', issue: f.number, blockers: f.openBlockers };

  const planPending = f.latestPlanAt !== null && (f.gate === null || f.gate.at < f.latestPlanAt);
  if (planPending) return { kind: 'skip', target, reason: '計画ゲートの結果待ち' };
  if (f.gate === null) return { kind: 'plan', issue: f.number };
  if (!f.gate.pass) return { kind: 'skip', target, reason: '計画ゲートで停止中' };
  if (!has(f.labels, LABELS.planOk) || !f.planOkByApp) return { kind: 'skip', target, reason: '`agent:plan-ok` が App によって付けられていません' };
  if (f.areaFull) return { kind: 'skip', target, reason: `${f.areaFull}。どれかが Merge されるまで着手しない` };
  return { kind: 'implement', issue: f.number, planCommentId: f.gate.planCommentId };
}

export function decidePr(f: PrFacts, opts: QueueOptions): Action {
  const target = `PR #${f.number}`;
  for (const stop of [LABELS.hold, LABELS.blocked]) {
    if (has(f.labels, stop)) return { kind: 'skip', target, reason: `\`${stop}\`` };
  }
  const claimed = claimedByOther(f.claim, opts);
  if (claimed) return { kind: 'skip', target, reason: claimed };
  if (!f.agent) {
    if (f.verdictAwaitingGate) return { kind: 'skip', target, reason: '判定の受け付け待ち' };
    if (!f.acceptance) return { kind: 'judge', pr: f.number, issue: f.issue, headSha: f.headSha };
    return { kind: 'skip', target, reason: f.acceptance.reviewPass ? '判定済み（人の Merge 待ち）' : '判定済み（人の修正待ち）' };
  }
  // 衝突していると CI も判定の反映も進まないので、何より先に解消する
  if (f.conflicted) return { kind: 'resolve-conflict', pr: f.number, issue: f.issue };
  if (f.humanFeedbackSincePush > 0) return { kind: 'fix', pr: f.number, issue: f.issue, reason: 'human' };
  if (f.verdictAwaitingGate) return { kind: 'skip', target, reason: '判定の受け付け待ち' };
  if (!f.acceptance) return { kind: 'judge', pr: f.number, issue: f.issue, headSha: f.headSha };
  if (!f.acceptance.reviewPass) return { kind: 'fix', pr: f.number, issue: f.issue, reason: 'review' };
  return { kind: 'skip', target, reason: '判定済み（Merge 待ち）' };
}

/** 優先度ラベル → agent:ready が付いた順に並べ、上限件数まで返す。skip は上限に数えない */
export function buildQueue(issues: IssueFacts[], prs: PrFacts[], opts: QueueOptions, limit: number): { actions: Action[]; skipped: Action[] } {
  const items = [
    ...issues.map((f) => ({ rank: priorityRank(f.labels), at: f.readyAt, action: decideIssue(f, opts) })),
    ...prs.map((f) => ({ rank: priorityRank(f.issueLabels), at: f.readyAt, action: decidePr(f, opts) })),
  ].sort((a, b) => a.rank - b.rank || (a.at ?? '9999').localeCompare(b.at ?? '9999'));
  const actions = items.filter((i) => i.action.kind !== 'skip').map((i) => i.action);
  const skipped = items.filter((i) => i.action.kind === 'skip').map((i) => i.action);
  return { actions: actions.slice(0, limit), skipped };
}
