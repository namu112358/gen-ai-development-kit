import { shortSession } from './blocks.ts';
import type { Claim } from './queue.ts';

/**
 * 持ち主のいない衝突した Agent PR の判定（ダッシュボードの「引き継ぐか決める」の行）。GitHub を呼ばない純粋関数。
 * 持ち主のいないとは、PR と Close する Issue の着手宣言のどれも期限内でない（期限切れか、宣言が無い）こと。
 * stack.ts の orphan-base（base のブランチが消えた Stacked PR）や gates/apply.ts の resumeFromOrphan とは別のもの。
 * 引き継ぐかは人が決める（規則は変えない。hq・fleet は拾わない）。
 */

export interface ClaimLimits {
  humanClaimStaleHours: number;
  routineClaimTakeoverMinutes: number;
}

interface PrRef {
  number: number;
  title: string;
  html_url: string;
}

/** 衝突している Agent PR 1本分の材料。claims は PR と Close する Issue の claimOf の結果 */
export interface UnownedConflictInput {
  pr: PrRef;
  issues: number[];
  claims: (Claim | null)[];
}

/** 描く行の材料。claim は表示する期限切れの宣言（時刻の新しいもの）。無ければ null */
export interface UnownedConflictRow {
  pr: PrRef;
  issues: number[];
  claim: Claim | null;
}

/**
 * 解除されていない宣言が期限内か。手動は humanClaimStaleHours 時間、Routine は routineClaimTakeoverMinutes 分
 * （queue.ts の holdsMainFollow と同じ数え方。段階は問わない）。時刻が読めなければ期限内とみなさない
 */
export function claimAlive(claim: Claim | null, now: Date, limits: ClaimLimits): boolean {
  if (!claim || claim.released) return false;
  const minutes = (now.getTime() - new Date(claim.at).getTime()) / 60_000;
  if (Number.isNaN(minutes)) return false;
  if (claim.by === 'manual') return Math.floor(minutes / 60) < limits.humanClaimStaleHours;
  return minutes < limits.routineClaimTakeoverMinutes;
}

/** 期限内の宣言が1つも無い PR を、入力の順のまま行の材料にする */
export function unownedConflicts(inputs: UnownedConflictInput[], now: Date, limits: ClaimLimits): UnownedConflictRow[] {
  const rows: UnownedConflictRow[] = [];
  for (const input of inputs) {
    if (input.claims.some((c) => claimAlive(c, now, limits))) continue;
    const expired = input.claims
      .filter((c): c is Claim => c !== null && !c.released)
      .sort((a, b) => (new Date(b.at).getTime() || 0) - (new Date(a.at).getTime() || 0));
    rows.push({ pr: input.pr, issues: input.issues, claim: expired[0] ?? null });
  }
  return rows;
}

/** ダッシュボードの1行：PR・Issue・宣言のセッションの短い ID と時刻・人が言うこと */
export function renderUnownedConflictLine(row: UnownedConflictRow): string {
  const issues = row.issues.length ? `Issue ${row.issues.map((n) => `#${n}`).join('・')}` : 'Issue なし';
  const c = row.claim;
  const claim = c ? `宣言 ${[c.session ? `session ${shortSession(c.session)}` : null, c.at].filter(Boolean).join('・')}（期限切れ）` : '宣言なし';
  return `- [#${row.pr.number}](${row.pr.html_url}) ${row.pr.title}（${issues}）— 引き継ぐか決める：${claim}。引き継ぐならどのセッションにでも「#${row.pr.number} を引き継いで sync」と言う`;
}
