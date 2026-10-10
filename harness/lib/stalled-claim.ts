import { shortSession } from './blocks.ts';
import type { Claim } from './queue.ts';

/**
 * 止まっていそうな着手宣言の判定（ダッシュボードの節「止まっていそうな着手宣言」、Issue #391）。GitHub を呼ばない純粋関数。
 * 対象は PR の宣言のうち段階が judge・fix・sync のもの。最後の動き（宣言の at と PR の head の commit の時刻の新しいほう）から
 * routine.stalledClaimMinutes 分（無ければ 60）以上たったものを出す。判定コメントが出た PR は claimOf が宣言を終わったとみなす（null）ので出ない。
 * 知らせるだけで、宣言を取り消したり引き継いだりしない（引き継ぐかは人が決める）。
 * 限界：commit の時刻は committer.date（commit を作った時刻）で push の時刻ではない。前に作った commit を後で push すると、
 * 動きが無いように見えることがある。PR の updated_at は App のコメントやラベルの付け外しでも動くので、動きの材料にしない。
 * 時刻の読めない宣言・commit は出さない（知らせ損ねるほうを選び、誤って「止まっている」と出さない）。
 */

export const DEFAULT_STALLED_CLAIM_MINUTES = 60;
export const STALLED_CLAIM_STAGES = ['judge', 'fix', 'sync'] as const;

/** routine.stalledClaimMinutes（無ければ 60） */
export function stalledClaimMinutes(routine: { stalledClaimMinutes?: number }): number {
  return routine.stalledClaimMinutes ?? DEFAULT_STALLED_CLAIM_MINUTES;
}

export interface PrRef {
  number: number;
  title: string;
  html_url: string;
}

/** PR 1本分の材料。claim は PR のコメントの claimOf の結果、headCommitAt は head の commit の時刻（読めなければ null） */
export interface StalledClaimInput {
  pr: PrRef;
  claim: Claim | null;
  headCommitAt: string | null;
}

/** 描く行の材料。last は最後の動きの時刻（ISO 文字列） */
export interface StalledClaimRow {
  pr: PrRef;
  claim: Claim;
  last: string;
}

const minutesSince = (iso: string, now: Date): number => (now.getTime() - new Date(iso).getTime()) / 60_000;

/** 宣言だけで候補か：解除されていない judge・fix・sync の宣言で、宣言の時刻が読めて minutes 分以上たっている（commit を読むかの判断に使う） */
export function stalledCandidate(claim: Claim | null, now: Date, minutes: number): boolean {
  if (!claim || claim.released) return false;
  if (!(STALLED_CLAIM_STAGES as readonly string[]).includes(claim.stage ?? '')) return false;
  const passed = minutesSince(claim.at, now);
  return !Number.isNaN(passed) && passed >= minutes;
}

/** 候補のうち、head の commit の時刻が読めて、最後の動きから minutes 分以上たったものを入力の順のまま返す */
export function stalledClaims(inputs: StalledClaimInput[], now: Date, minutes: number): StalledClaimRow[] {
  const rows: StalledClaimRow[] = [];
  for (const { pr, claim, headCommitAt } of inputs) {
    if (!claim || !stalledCandidate(claim, now, minutes) || headCommitAt === null) continue;
    const commitMs = new Date(headCommitAt).getTime();
    if (Number.isNaN(commitMs)) continue;
    const last = commitMs > new Date(claim.at).getTime() ? headCommitAt : claim.at;
    if (minutesSince(last, now) < minutes) continue;
    rows.push({ pr, claim, last });
  }
  return rows;
}

/** 経過の表記：1時間未満は「59分」、以上は「4時間12分」（分は切り捨て） */
export function elapsedText(from: string, now: Date): string {
  const total = Math.max(0, Math.floor(minutesSince(from, now)));
  const hours = Math.floor(total / 60);
  return hours > 0 ? `${hours}時間${total % 60}分` : `${total}分`;
}

/** ダッシュボードの1行：PR・段階・セッションの短い ID・最後の動きからの経過・宣言の時刻 */
export function renderStalledClaimLine(row: StalledClaimRow, now: Date): string {
  const c = row.claim;
  const parts = [`段階 ${c.stage}`, c.session ? `session ${shortSession(c.session)}` : null, `${elapsedText(row.last, now)}動きなし`].filter(Boolean).join('・');
  return `- [#${row.pr.number}](${row.pr.html_url}) ${row.pr.title} — ${parts}（宣言 ${c.at}）。引き継ぐかは人が決める`;
}
