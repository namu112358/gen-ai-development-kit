import { LABELS } from './config.ts';
import type { Claim } from './queue.ts';
import { elapsedText, type PrRef } from './stalled-claim.ts';

/**
 * 担当のいない判定待ちの PR の判定（ダッシュボードの節「担当のいない判定待ちの PR」、Issue #493）。GitHub を呼ばない純粋関数。
 * 対象は Agent PR のうち、PR に着手宣言が無く（claim が null）、今の差分の判定の受け付けが無く（accepted が false）、
 * agent:hold・agent:blocked が付かず、衝突していないもの。最後の動き（head の commit の時刻と Claude のコメントの時刻の新しいほう）から
 * routine.stalledClaimMinutes 分（無ければ 60）以上たったものを出す。
 * 知らせるだけで、宣言を取り消したり引き継いだりしない（引き継ぐかは人が決める）。
 * 限界：commit の時刻は committer.date（commit を作った時刻）で push の時刻ではない（#391 と同じ）。時刻の読めない commit は出さない。
 */

/** PR 1本分の材料。accepted は今の差分の受け付けがあるか（null は読んでいない＝時間前の候補） */
export interface UnclaimedJudgeInput {
  pr: PrRef;
  claim: Claim | null;
  labels: string[];
  conflicted: boolean;
  headCommitAt: string | null;
  lastClaudeAt: string | null;
  accepted: boolean | null;
}

/** 描く行の材料。last は最後の動きの時刻（ISO 文字列） */
export interface UnclaimedJudgeRow {
  pr: PrRef;
  last: string;
}

const ms = (iso: string | null): number => (iso === null ? NaN : new Date(iso).getTime());

/** 最後の動き：commit の時刻が読めなければ null、読めれば Claude のコメントの時刻（読めれば）と新しいほう */
export function lastActivity(headCommitAt: string | null, lastClaudeAt: string | null): string | null {
  const commit = ms(headCommitAt);
  if (Number.isNaN(commit)) return null;
  const claude = ms(lastClaudeAt);
  return !Number.isNaN(claude) && claude > commit ? lastClaudeAt : headCommitAt;
}

/** 受け付けを読む前の候補か：宣言なし・hold/blocked なし・衝突なし・最後の動きから minutes 分以上 */
export function unclaimedJudgeCandidate(input: UnclaimedJudgeInput, now: Date, minutes: number): boolean {
  if (input.claim !== null || input.conflicted) return false;
  if (input.labels.includes(LABELS.hold) || input.labels.includes(LABELS.blocked)) return false;
  const last = lastActivity(input.headCommitAt, input.lastClaudeAt);
  if (last === null) return false;
  return (now.getTime() - ms(last)) / 60_000 >= minutes;
}

/** 候補のうち受け付けが無い（accepted === false）ものを入力の順のまま返す */
export function unclaimedJudgePrs(inputs: UnclaimedJudgeInput[], now: Date, minutes: number): UnclaimedJudgeRow[] {
  const rows: UnclaimedJudgeRow[] = [];
  for (const input of inputs) {
    if (input.accepted !== false || !unclaimedJudgeCandidate(input, now, minutes)) continue;
    rows.push({ pr: input.pr, last: lastActivity(input.headCommitAt, input.lastClaudeAt)! });
  }
  return rows;
}

/** ダッシュボードの1行：PR・経過 */
export function renderUnclaimedJudgeLine(row: UnclaimedJudgeRow, now: Date): string {
  return `- [#${row.pr.number}](${row.pr.html_url}) ${row.pr.title} — 宣言なし・${elapsedText(row.last, now)}動きなし。引き継ぐかは人が決める`;
}
