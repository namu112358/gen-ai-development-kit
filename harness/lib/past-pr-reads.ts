/**
 * judge-input の過去の PR の節の材料（変更ファイルを触った Merge 済みの過去の PR と、そのコメント・レビュー・レビューコメント）を GraphQL でまとめて読む。#249。
 * 変更ファイルの履歴は別名を付けた1回の問い合わせ、選んだ過去の PR のスレッドも別名を付けた1回の問い合わせで読む。
 * 作者・関係・ID は harness/lib/graphql-prefetch.ts の変換で REST の形にそろえる。入れ子の接続に続きがある PR だけ、今の REST の読み方で読み直す。
 */
import type { HarnessConfig } from './config.ts';
import type { GitHub } from './github.ts';
import { type GActor, type GComment, type PageInfo, restComment, restId, restUser } from './graphql-prefetch.ts';
import { PAST_PR_FILE_LIMIT, type PastPrReview, type PastPrReviewComment, type PastPrs, selectPastPrs } from './session-inputs.ts';

type HistoryPr = { number: number; title: string; merged: boolean; mergedAt: string | null; baseRefName: string };
type History = { nodes: { associatedPullRequests: { nodes: HistoryPr[] } }[] };

/** 過去の PR のスレッドの1ページの件数（first:）。テストの偽物もこの件数で切る */
export const PAST_PR_PAGE = { comments: 100, reviews: 100, reviewComments: 100 } as const;

const ACTOR = '{__typename login}';
const PAGE_INFO = 'pageInfo{hasNextPage endCursor}';
const COMMENT = `fullDatabaseId body url createdAt updatedAt authorAssociation author${ACTOR}`;
const REVIEW_COMMENT = `fullDatabaseId body path line originalLine createdAt url authorAssociation author${ACTOR}`;
const REVIEW = `fullDatabaseId state body submittedAt url authorAssociation author${ACTOR} comments(first:${PAST_PR_PAGE.reviewComments}){nodes{${REVIEW_COMMENT}} ${PAGE_INFO}}`;
const THREAD = `comments(first:${PAST_PR_PAGE.comments}){nodes{${COMMENT}} ${PAGE_INFO}} reviews(first:${PAST_PR_PAGE.reviews}){nodes{${REVIEW}} ${PAGE_INFO}}`;

/** 変更ファイルごとの履歴を別名（f0…）で1回に読む問い合わせ。ファイル名は変数（$p0…）で渡し、文字列に埋め込まない */
export function historiesQuery(count: number): string {
  const vars = ['$owner:String!', '$name:String!', '$branch:String!', ...Array.from({ length: count }, (_, i) => `$p${i}:String!`)];
  const fields = Array.from({ length: count }, (_, i) =>
    `f${i}:history(first:5,path:$p${i}){nodes{associatedPullRequests(first:5){nodes{number title merged mergedAt baseRefName}}}}`).join(' ');
  return `query PastPrHistories(${vars.join(',')}){repository(owner:$owner,name:$name){object(expression:$branch){... on Commit{${fields}}}}}`;
}

/** 過去の PR のコメント・レビュー・レビューコメントを別名（p0…）で1回に読む問い合わせ。番号は変数（$n0…）で渡す */
export function threadsQuery(count: number): string {
  const vars = ['$owner:String!', '$name:String!', ...Array.from({ length: count }, (_, i) => `$n${i}:Int!`)];
  const fields = Array.from({ length: count }, (_, i) => `p${i}:pullRequest(number:$n${i}){${THREAD}}`).join(' ');
  return `query PastPrThreads(${vars.join(',')}){repository(owner:$owner,name:$name){${fields}}}`;
}

interface GReviewComment { fullDatabaseId: string | number; body: string; path: string; line: number | null; originalLine: number | null; createdAt: string; url: string; authorAssociation: string; author: GActor | null }
interface GPastReview { fullDatabaseId: string | number; state: string; body: string | null; submittedAt: string | null; url: string; authorAssociation: string; author: GActor | null; comments: { nodes: GReviewComment[]; pageInfo: PageInfo } }
interface GThread { comments: { nodes: GComment[]; pageInfo: PageInfo }; reviews: { nodes: GPastReview[]; pageInfo: PageInfo } }

function restPastReview(r: GPastReview): PastPrReview {
  return { id: restId(r.fullDatabaseId), body: r.body, state: r.state, submitted_at: r.submittedAt, html_url: r.url, author_association: r.authorAssociation, user: restUser(r.author) };
}

function restReviewComment(c: GReviewComment): PastPrReviewComment {
  return { id: restId(c.fullDatabaseId), body: c.body, path: c.path, line: c.line, original_line: c.originalLine, created_at: c.createdAt, html_url: c.url, author_association: c.authorAssociation, user: restUser(c.author) };
}

/** どれかの接続に続きがあるか（あれば、その PR は REST で読み直す） */
function truncated(t: GThread): boolean {
  return t.comments.pageInfo.hasNextPage || t.reviews.pageInfo.hasNextPage || t.reviews.nodes.some((r) => r.comments.pageInfo.hasNextPage);
}

/** 変更ファイル（先頭 30 件）を触った Merge 済みの過去の PR と、そのコメント・レビュー・レビューコメント。API のエラーはそのまま投げる */
export async function pastPrsFor(gh: GitHub, config: HarnessConfig, n: number): Promise<PastPrs> {
  const changed = (await gh.paginate<{ filename: string }>(`/pulls/${n}/files`)).map((f) => f.filename);
  const considered = changed.slice(0, PAST_PR_FILE_LIMIT);
  const histories: Parameters<typeof selectPastPrs>[0] = [];
  if (considered.length > 0) {
    const variables: Record<string, unknown> = { owner: gh.owner, name: gh.repo, branch: config.defaultBranch };
    considered.forEach((path, i) => { variables[`p${i}`] = path; });
    const data = await gh.graphql<{ repository: { object: Record<string, History | undefined> | null } }>(historiesQuery(considered.length), variables);
    // 既定のブランチに無い新しいファイルは履歴が空
    considered.forEach((path, i) => {
      const nodes = data.repository.object?.[`f${i}`]?.nodes ?? [];
      histories.push({ path, prs: nodes.flatMap((c) => c.associatedPullRequests.nodes) });
    });
  }
  const selected = selectPastPrs(histories, n, config.defaultBranch);
  const threads: (GThread | null)[] = [];
  if (selected.length > 0) {
    const variables: Record<string, unknown> = { owner: gh.owner, name: gh.repo };
    selected.forEach((p, i) => { variables[`n${i}`] = p.number; });
    const data = await gh.graphql<{ repository: Record<string, GThread | null> }>(threadsQuery(selected.length), variables);
    selected.forEach((_, i) => threads.push(data.repository[`p${i}`] ?? null));
  }
  const prs: PastPrs['prs'] = [];
  for (const [i, p] of selected.entries()) {
    const t = threads[i] ?? null;
    const head = { number: p.number, title: p.title, mergedAt: p.mergedAt, files: p.files };
    if (t === null || truncated(t)) {
      prs.push({
        ...head,
        comments: await gh.listComments(p.number),
        reviews: await gh.paginate<PastPrReview>(`/pulls/${p.number}/reviews`),
        reviewComments: await gh.paginate<PastPrReviewComment>(`/pulls/${p.number}/comments`),
      });
      continue;
    }
    // レビューコメントは REST の /pulls/{n}/comments と同じ順（作成の古い順、同じ時刻なら ID の順）に並べる
    const reviewComments = t.reviews.nodes.flatMap((r) => r.comments.nodes.map(restReviewComment))
      .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1));
    prs.push({ ...head, comments: t.comments.nodes.map(restComment), reviews: t.reviews.nodes.map(restPastReview), reviewComments });
  }
  return { changedFiles: changed.length, filesConsidered: considered.length, prs };
}
