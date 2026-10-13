/**
 * 定期実行（stale.ts の onSchedule）がダッシュボード Issue に書く節「答えの無い確認事項」の、行を作る純粋な関数と定数（Issue #963）。
 * GitHub は読まない・書かない。読みは stale.ts が行い、ここは候補の絞り込みと表示の行だけを持つ。
 */
import { confirmFacts, type ConfirmFact } from '../lib/confirm.ts';
import type { IssueComment } from '../lib/github.ts';

export const CONFIRM_READ_DAYS = 30;
export const CONFIRM_READ_PAGES = 10;
export const CONFIRM_READ_LIMIT = CONFIRM_READ_PAGES * 100;

const SUMMARY_LENGTH = 80;

/** /issues/comments が返すコメント（Issue と PR のものが混ざる。issue_url が対象を指す） */
export type BulkComment = IssueComment & { issue_url?: string };

export interface ConfirmRow {
  number: number;
  title: string;
  fact: ConfirmFact;
}

/** コメントの対象の番号。issue_url の末尾 /issues/<n>、無ければ html_url の /issues/<n> か /pull/<n> */
export function commentNumber(c: BulkComment): number | null {
  const fromApi = /\/issues\/(\d+)$/.exec(c.issue_url ?? '');
  const fromHtml = /\/(?:issues|pull)\/(\d+)(?:[#?].*)?$/.exec(c.html_url);
  const m = fromApi ?? fromHtml;
  return m ? Number(m[1]) : null;
}

/** 開いた番号のコメントだけから、答えの無い確認事項（候補）を出す。コラボレーターの条件は confirmFacts のまま */
export function confirmCandidates(comments: BulkComment[], open: Set<number>): ConfirmFact[] {
  const targetOf = (c: IssueComment): number | null => {
    const n = commentNumber(c as BulkComment);
    return n !== null && open.has(n) ? n : null;
  };
  return confirmFacts(comments.filter((c) => targetOf(c) !== null), [], targetOf).filter((f) => f.answer === null);
}

/** 番号ごとの読み直し（その Issue / PR のコメント全部）で答えの有無をやり直し、候補と同じコメントでまだ答えの無いものだけ残す */
export function stillUnanswered(candidates: ConfirmFact[], reread: Map<number, IssueComment[]>): ConfirmFact[] {
  const ids = new Set(candidates.map((f) => f.commentId));
  const kept: ConfirmFact[] = [];
  for (const [n, comments] of reread) {
    for (const f of confirmFacts(comments, [], () => n)) if (ids.has(f.commentId) && f.answer === null) kept.push(f);
  }
  return kept;
}

const summary = (fact: ConfirmFact): string => {
  const text = (fact.confirm.questions[0]?.text ?? '').replace(/\s+/g, ' ').trim();
  const head = text.length > SUMMARY_LENGTH ? `${text.slice(0, SUMMARY_LENGTH)}…` : text;
  const more = fact.confirm.questions.length - 1;
  return more > 0 ? `${head}（ほか ${more} 問）` : head;
};

/** 節の行。input が null のときは読めなかった */
export function confirmSectionLines(input: { rows: ConfirmRow[]; truncated: boolean; oldestAt: string | null } | null): string[] {
  const title = `答えの無い確認事項（直近 ${CONFIRM_READ_DAYS} 日）`;
  if (input === null) return [`### ${title}`, '', '読めませんでした', ''];
  const rows = [...input.rows].sort((a, b) => a.fact.createdAt.localeCompare(b.fact.createdAt) || a.fact.commentId - b.fact.commentId);
  return [
    `### ${title}（${rows.length}）`,
    '',
    ...(rows.length ? rows.map((r) => `- [#${r.number}](${r.fact.url}) ${r.title} — ${summary(r.fact)} — ${r.fact.createdAt}`) : ['なし']),
    ...(input.truncated ? ['', `直近 ${CONFIRM_READ_DAYS} 日のコメントを ${CONFIRM_READ_LIMIT} 件までしか読めませんでした（起点: ${input.oldestAt ?? '不明'}。これより古い確認事項は並んでいません）`] : []),
    '',
  ];
}
