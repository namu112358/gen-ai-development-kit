// judge-input の過去の PR の読み方のテスト用の見本：1つの見本（変更ファイル・ファイルごとの履歴・過去の PR のコメント・レビュー・レビューコメント）から、REST の応答と、まとめた GraphQL の問い合わせ（PastPrHistories・PastPrThreads）の応答と、前のファイルごとの履歴の問い合わせの応答を返す偽の GitHub（#249）
import { FakeGitHub } from './gate-fixtures.ts';

export const REPO = 'o/r';
const T0 = '2026-09-20T00:00:00Z';
/** GraphQL の1ページの件数（comments・reviews・レビューごとの comments の first:100） */
export const PAST_PR_PAGE = 100;

export interface PActor { login: string; bot?: boolean }
export interface PComment { id: number; body: string; created_at?: string; author?: PActor | null; association?: string }
export interface PReviewComment { id: number; body: string; path: string; line: number | null; original_line?: number | null; created_at?: string; author?: PActor | null; association?: string }
export interface PReview { id: number; state: string; body?: string; submitted_at?: string | null; author?: PActor | null; association?: string; comments?: PReviewComment[] }
export interface HistoryPr { number: number; title: string; merged: boolean; mergedAt: string | null; baseRefName: string }
export interface PastPrWorld { number: number; comments?: PComment[]; reviews?: PReview[] }
export interface PastWorld {
  /** 判定する PR の番号 */
  pr: number;
  /** 判定する PR の変更ファイル（/pulls/{pr}/files の順） */
  files: string[];
  /** ファイルごとの履歴（commit ごとの associatedPullRequests）。無いファイルは新しいファイル（履歴が空） */
  histories?: Record<string, HistoryPr[][]>;
  /** 既定のブランチが読めない（object が null） */
  noBranch?: boolean;
  /** 過去の PR のコメント・レビュー・レビューコメント */
  prs: PastPrWorld[];
}

const author = (a: PActor | null | undefined): PActor | null => (a === undefined ? { login: 'rev' } : a);

// --- REST の形（前の読み方が読むもの。PastPrReview・PastPrReviewComment・IssueComment の欄だけ） ---

const restUser = (a: PActor | null | undefined) => {
  const x = author(a);
  return x ? { login: x.bot ? `${x.login}[bot]` : x.login, type: x.bot ? 'Bot' : 'User' } : null;
};
const commentUrl = (n: number, id: number) => `https://github.com/${REPO}/pull/${n}#issuecomment-${id}`;
const reviewUrl = (n: number, id: number) => `https://github.com/${REPO}/pull/${n}#pullrequestreview-${id}`;
const reviewCommentUrl = (n: number, id: number) => `https://github.com/${REPO}/pull/${n}#discussion_r${id}`;

export function restPastComment(n: number, c: PComment) {
  const at = c.created_at ?? T0;
  return { id: c.id, body: c.body, html_url: commentUrl(n, c.id), created_at: at, updated_at: at, author_association: c.association ?? 'OWNER', user: restUser(c.author) };
}
export function restPastReview(n: number, r: PReview) {
  return {
    id: r.id, body: r.body ?? '', state: r.state, submitted_at: r.submitted_at === undefined ? T0 : r.submitted_at,
    html_url: reviewUrl(n, r.id), author_association: r.association ?? 'OWNER', user: restUser(r.author),
  };
}
export function restPastReviewComment(n: number, c: PReviewComment) {
  return {
    id: c.id, body: c.body, path: c.path, line: c.line, original_line: c.original_line === undefined ? c.line : c.original_line,
    created_at: c.created_at ?? T0, html_url: reviewCommentUrl(n, c.id), author_association: c.association ?? 'OWNER', user: restUser(c.author),
  };
}
/** REST の /pulls/{n}/comments：全部のレビューのコメントを created_at → id の順 */
export function restPastReviewComments(p: PastPrWorld) {
  return (p.reviews ?? []).flatMap((r) => r.comments ?? []).map((c) => restPastReviewComment(p.number, c))
    .sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1));
}

function restPage<T>(list: T[], path: string): T[] {
  const url = new URL(path, 'https://x.invalid');
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const n = Number(url.searchParams.get('page') ?? 1);
  return list.slice((n - 1) * per, n * per);
}

// --- GraphQL の形 ---

const gActor = (a: PActor | null | undefined) => {
  const x = author(a);
  return x ? { __typename: x.bot ? 'Bot' : 'User', login: x.login } : null;
};
function conn<T>(list: T[], first = PAST_PR_PAGE) {
  const nodes = list.slice(0, first);
  return { nodes, pageInfo: { hasNextPage: nodes.length < list.length, endCursor: String(nodes.length) } };
}
const gComment = (n: number, c: PComment) => {
  const r = restPastComment(n, c);
  return { fullDatabaseId: String(c.id), body: r.body, url: r.html_url, createdAt: r.created_at, updatedAt: r.updated_at, authorAssociation: r.author_association, author: gActor(c.author) };
};
const gReviewComment = (n: number, c: PReviewComment) => {
  const r = restPastReviewComment(n, c);
  return { fullDatabaseId: String(c.id), body: r.body, path: r.path, line: r.line, originalLine: r.original_line, createdAt: r.created_at, url: r.html_url, authorAssociation: r.author_association, author: gActor(c.author) };
};
const gReview = (n: number, rv: PReview) => {
  const r = restPastReview(n, rv);
  return {
    fullDatabaseId: String(rv.id), state: r.state, body: r.body, submittedAt: r.submitted_at, url: r.html_url, authorAssociation: r.author_association, author: gActor(rv.author),
    comments: conn((rv.comments ?? []).map((c) => gReviewComment(n, c))),
  };
};
const gPr = (p: PastPrWorld) => ({
  comments: conn((p.comments ?? []).map((c) => gComment(p.number, c))),
  reviews: conn((p.reviews ?? []).map((r) => gReview(p.number, r))),
});

/** history(first:5) の commit ごとの associatedPullRequests(first:5) */
function historyNodes(world: PastWorld, path: string) {
  return (world.histories?.[path] ?? []).slice(0, 5).map((prs) => ({ associatedPullRequests: { nodes: prs.slice(0, 5) } }));
}

const HISTORY_ALIAS = /\b(f\d+)\s*:\s*history\s*\(\s*first\s*:\s*5\s*,\s*path\s*:\s*\$(\w+)\s*\)/g;
const THREAD_ALIAS = /\b(p\d+)\s*:\s*pullRequest\s*\(\s*number\s*:\s*\$(\w+)\s*\)/g;

function answerGraphql(world: PastWorld, body: { query: string; variables?: Record<string, any> }): unknown {
  const q = String(body.query);
  const v = body.variables ?? {};
  if (/^\s*query PastPrHistories\(/.test(q)) {
    if (world.noBranch) return { data: { repository: { object: null } } };
    const object: Record<string, unknown> = {};
    for (const m of q.matchAll(HISTORY_ALIAS)) {
      const path = v[m[2]!];
      if (typeof path !== 'string') throw new Error(`PastPrHistories: 変数 $${m[2]} がありません`);
      object[m[1]!] = { nodes: historyNodes(world, path) };
    }
    return { data: { repository: { object } } };
  }
  if (/^\s*query PastPrThreads\(/.test(q)) {
    const repository: Record<string, unknown> = {};
    for (const m of q.matchAll(THREAD_ALIAS)) {
      const n = v[m[2]!];
      if (typeof n !== 'number') throw new Error(`PastPrThreads: 変数 $${m[2]} がありません`);
      const p = world.prs.find((x) => x.number === n);
      repository[m[1]!] = p ? gPr(p) : null;
    }
    return { data: { repository } };
  }
  // 前の読み方（judge.ts の FILE_HISTORY_QUERY。ファイルごとに1回）
  if (q.includes('history(first: 5, path: $path)')) {
    if (world.noBranch) return { data: { repository: { object: null } } };
    return { data: { repository: { object: { history: { nodes: historyNodes(world, String(v.path)) } } } } };
  }
  throw new Error(`unexpected graphql: ${q.slice(0, 80)}`);
}

/**
 * 過去の PR の見本を、REST（/pulls/{pr}/files・/issues/{n}/comments・/pulls/{n}/reviews・/pulls/{n}/comments）と、
 * まとめた GraphQL の問い合わせ（PastPrHistories・PastPrThreads）と、前のファイルごとの履歴の問い合わせの全部で返す偽の GitHub。
 * 呼び出しは calls に残る（dashboard-fixtures.ts の callNames で短い形にできる）
 */
export function pastPrFake(world: PastWorld): FakeGitHub {
  const pr = (n: number) => world.prs.find((p) => p.number === n) ?? { number: n };
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)\/files/, (m) => {
      if (Number(m[1]) !== world.pr) throw new Error(`unexpected files of #${m[1]}`);
      return restPage(world.files.map((filename) => ({ filename, additions: 1, deletions: 1 })), m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)\/comments/, (m) => {
      const p = pr(Number(m[1]));
      return restPage((p.comments ?? []).map((c) => restPastComment(p.number, c)), m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)\/reviews/, (m) => {
      const p = pr(Number(m[1]));
      return restPage((p.reviews ?? []).map((r) => restPastReview(p.number, r)), m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)\/comments/, (m) => restPage(restPastReviewComments(pr(Number(m[1]))), m.input!))
    .on('POST', /^\/graphql$/, (_m, body) => answerGraphql(world, body));
}
