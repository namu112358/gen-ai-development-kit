/**
 * Issue・PR を GraphQL を使わず REST（GitHub.get・GitHub.paginate）だけで読み、gh の `--json` の欄の名前にそろえて返す（Issue #712）。
 * 手元・Actions・クラウドのどの Transport でも同じ要求・同じ直し方になる。読むだけで、GitHub に書き込まない。
 * 違い：コメント・review の id は REST の数の ID（gh の --json は node ID。editComment が数の ID を使うため）。gh にしかない欄（autoMergeRequest.enabledAt など）は出さない。
 */
import type { GitHub } from './github.ts';
import { bodyIssueRefs, isSameRepoPr, type PullRequest } from './state.ts';

interface RestUser { login: string }
interface RestLabel { name: string }
interface RestIssue {
  number: number; title: string; body: string | null; state: string; html_url: string;
  labels: RestLabel[]; user: RestUser | null;
}
interface RestComment {
  id: number; body: string; html_url: string; created_at: string; author_association: string; user: RestUser | null;
}
interface RestReview {
  id: number; body: string | null; state: string; submitted_at?: string | null; author_association: string; commit_id?: string; user: RestUser | null;
}
interface RestCheckRun {
  name: string; status: string; conclusion: string | null; details_url: string | null; started_at: string | null; completed_at: string | null;
}
interface RestStatus { context: string; state: string; target_url: string | null }
type RestPr = PullRequest & { merged_at?: string | null };

const author = (u: RestUser | null | undefined): { login: string } | null => (u ? { login: u.login } : null);
const labelsOf = (ls: RestLabel[] | undefined): { name: string }[] => (ls ?? []).map((l) => ({ name: l.name }));

function commentOut(c: RestComment) {
  return { id: c.id, author: author(c.user), authorAssociation: c.author_association, body: c.body, createdAt: c.created_at, url: c.html_url };
}

export async function restIssueView(gh: GitHub, n: number) {
  const issue = await gh.get<RestIssue>(`/issues/${n}`);
  const comments = await gh.paginate<RestComment>(`/issues/${n}/comments`);
  return {
    number: issue.number, title: issue.title, body: issue.body, state: issue.state.toUpperCase(),
    labels: labelsOf(issue.labels), author: author(issue.user), url: issue.html_url, comments: comments.map(commentOut),
  };
}

/** 開いた Issue を語で検索する（1ページ＝100件まで）。/search/issues は /repos/ の下ではない */
export async function restIssueSearch(gh: GitHub, terms: string[]) {
  const q = [`repo:${gh.owner}/${gh.repo}`, 'is:issue', 'is:open', ...terms].join(' ');
  const res = await gh.get<{ items?: RestIssue[] }>(`/search/issues?q=${encodeURIComponent(q)}&per_page=100`);
  return (res.items ?? []).map((i) => ({ number: i.number, title: i.title, state: i.state.toUpperCase(), labels: labelsOf(i.labels), url: i.html_url }));
}

export async function restPrView(gh: GitHub, n: number) {
  const pr = await gh.get<RestPr>(`/pulls/${n}`);
  const sha = pr.head.sha;
  const [runs, combined, comments, reviews] = await Promise.all([
    gh.paginate<RestCheckRun>(`/commits/${sha}/check-runs`),
    gh.get<{ statuses?: RestStatus[] }>(`/commits/${sha}/status`),
    gh.paginate<RestComment>(`/issues/${n}/comments`),
    gh.paginate<RestReview>(`/pulls/${n}/reviews`),
  ]);
  const am = pr.auto_merge as { enabled_by?: RestUser | null; merge_method?: string; commit_title?: string | null; commit_message?: string | null } | null;
  return {
    number: pr.number, title: pr.title, body: pr.body,
    state: pr.merged_at || pr.merged ? 'MERGED' : pr.state.toUpperCase(),
    isDraft: pr.draft, headRefName: pr.head.ref, headRefOid: sha, baseRefName: pr.base.ref,
    autoMergeRequest: am
      ? { enabledBy: author(am.enabled_by), mergeMethod: (am.merge_method ?? '').toUpperCase(), commitHeadline: am.commit_title ?? null, commitBody: am.commit_message ?? null }
      : null,
    statusCheckRollup: [
      ...runs.map((r) => ({
        __typename: 'CheckRun', name: r.name, status: r.status.toUpperCase(), conclusion: (r.conclusion ?? '').toUpperCase(),
        detailsUrl: r.details_url, startedAt: r.started_at, completedAt: r.completed_at,
      })),
      ...(combined.statuses ?? []).map((s) => ({ __typename: 'StatusContext', context: s.context, state: s.state.toUpperCase(), targetUrl: s.target_url })),
    ],
    labels: labelsOf(pr.labels), url: pr.html_url, comments: comments.map(commentOut),
    reviews: reviews.map((r) => ({
      id: r.id, author: author(r.user), authorAssociation: r.author_association, state: r.state, body: r.body ?? '',
      submittedAt: r.submitted_at ?? null, commit: { oid: r.commit_id ?? null },
    })),
  };
}

const listedPrs = (gh: GitHub) => gh.paginate<PullRequest>('/pulls?state=open');

export async function restPrList(gh: GitHub) {
  return (await listedPrs(gh)).map((p) => ({
    number: p.number, title: p.title, body: p.body, headRefName: p.head.ref, baseRefName: p.base.ref, isDraft: p.draft, url: p.html_url,
  }));
}

/** PR の一覧から、その Issue を本文で Closes / Refs する同じリポジトリの PR を、一覧の順に返す */
export function prsReferencing(prs: PullRequest[], issue: number, repository: string): { number: number; keyword: 'closes' | 'refs' }[] {
  const out: { number: number; keyword: 'closes' | 'refs' }[] = [];
  for (const p of prs) {
    if (!isSameRepoPr(p, repository)) continue;
    const ref = bodyIssueRefs(p.body).find((r) => r.number === issue);
    if (ref) out.push({ number: p.number, keyword: ref.keyword });
  }
  return out;
}

export async function restOpenPrsReferencing(gh: GitHub, issue: number) {
  const prs = await listedPrs(gh);
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  return prsReferencing(prs, issue, `${gh.owner}/${gh.repo}`).map((r) => {
    const p = byNumber.get(r.number)!;
    return { number: r.number, keyword: r.keyword, headRefName: p.head.ref, baseRefName: p.base.ref, isDraft: p.draft };
  });
}
