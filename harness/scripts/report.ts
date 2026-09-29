import { appMarkKind } from '../lib/blocks.ts';
import { appLogin, loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import {
  decisionAgreement,
  decisionRows,
  fixLinksFor,
  fixPrFilesOf,
  isFixPr,
  panelComparison,
  panelPairs,
  renderDecisionAgreement,
  renderPanelComparison,
  renderReport,
  renderTokenRatios,
  summarize,
  tokenRatios,
  type DecisionRow,
  type MergedPr,
  type PanelPairRow,
  type ReportRow,
} from '../lib/report.ts';
import { appRecords, closingIssues, fixRequestCount, isAgentPr, type PullRequest, type Review } from '../lib/state.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

/**
 * 判定の集計（Jev の切り替え判断用）。GitHub だけから数える（独自 DB は持たない）。
 *
 *   node harness/scripts/report.ts <owner/repo> [days=30]
 *
 * ここでは GitHub から事実を集めて行にするだけ。集計と基準の判定は harness/lib/report.ts、基準の意味は docs/security.md の「Jev」。
 * 受け付けられなかった判定コメントも件数に出す。
 * 最後に合体版のレビューの記録と今の判定を比べる節（基準は docs/plan.md の Q91）と、人の決定の記録の Jev の判定と人の判断の一致率の節（Q93）を出す。
 */

const config = loadConfig();
const [repository, daysArg] = process.argv.slice(2);
if (!repository) {
  console.error('usage: node harness/scripts/report.ts <owner/repo> [days]');
  process.exit(1);
}
const days = Number(daysArg ?? 30);
const gh = new GitHub(transportFromEnv(), repository);
const since = Date.now() - days * 86400_000;

const closed = (await gh.paginate<PullRequest & { created_at: string; closed_at: string | null }>('/pulls?state=closed&sort=updated&direction=desc', 10)).filter(
  (p) => p.closed_at && new Date(p.closed_at).getTime() >= since,
);
const merged = closed.filter((p) => p.merged_at);
const agentPrs = closed.filter((p) => isAgentPr(config, p, repository));

// revert の検知：main のコミットメッセージから
const commits = await gh.paginate<{ sha: string; commit: { message: string; committer: { date: string } } }>(`/commits?since=${new Date(since).toISOString()}`, 10);
const revertedPrs = new Set<number>();
for (const c of commits) {
  for (const n of revertedPrNumbers(c.commit.message)) revertedPrs.add(n);
  for (const sha of revertedShas(c.commit.message)) {
    const prs = await gh.get<{ number: number }[]>(`/commits/${sha}/pulls`).catch(() => []);
    for (const p of prs) revertedPrs.add(p.number);
  }
}

// 変更ファイルと patch（/pulls/{n}/files を PR ごとに1回だけ読む。リネームは旧パスにも同じ patch を割り当てる）
const filesOf = new Map<number, { files: string[]; patches: Record<string, string | undefined> }>();
async function prFiles(n: number) {
  const cached = filesOf.get(n);
  if (cached) return cached;
  const list = await gh.paginate<{ filename: string; previous_filename?: string; patch?: string }>(`/pulls/${n}/files`, 30);
  const patches: Record<string, string | undefined> = {};
  for (const f of list) {
    patches[f.filename] = f.patch;
    if (f.previous_filename) patches[f.previous_filename] = f.patch;
  }
  const value = { files: list.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])), patches };
  filesOf.set(n, value);
  return value;
}

// Closes する Issue の番号（PR 番号でキャッシュする。Issue の本文は結び付けに使わない）
const closesOf = new Map<number, number[]>();
const closes = async (n: number) => closesOf.get(n) ?? closesOf.set(n, await closingIssues(gh, n).catch(() => [])).get(n)!;

// fix の PR の候補（タイトルかブランチで fix と分かる Merge 済みの PR）だけ、変更ファイル・patch・本文・Closes する Issue を取る
const fixCandidates: MergedPr[] = [];
for (const p of merged) {
  if (!isFixPr({ title: p.title, headRef: p.head.ref })) continue;
  fixCandidates.push({ number: p.number, title: p.title, headRef: p.head.ref, mergedAt: p.merged_at ?? null, body: p.body, ...(await prFiles(p.number)), closes: await closes(p.number) });
}

const rows: ReportRow[] = [];
const panelRows: PanelPairRow[] = [];
const panelExcluded: Record<string, number> = {};
for (const pr of agentPrs) {
  const comments = await gh.listComments(pr.number);
  const fixLinks = pr.merged_at
    ? fixLinksFor(
        { number: pr.number, title: pr.title, headRef: pr.head.ref, mergedAt: pr.merged_at, body: pr.body, ...(await prFiles(pr.number)), closes: await closes(pr.number) },
        fixCandidates,
      )
    : [];
  const fixedBy = fixLinks.map((l) => l.pr);
  rows.push({
    pr: pr.number,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at,
    acceptance: appRecords<Acceptance>(config, comments, 'acceptance').at(-1)?.value ?? null,
    rejected: comments.filter((c) => c.body.includes('kind=verdict-rejected')).length,
    fixRequests: await fixRequestCount(gh, config, pr.number),
    reverted: revertedPrs.has(pr.number),
    fixedBy,
    fixLinks,
  });

  // 合体版のレビューの記録と今の判定の組（App の fix-request と、レビューコメント）
  const row = rows.at(-1)!;
  const reviews = await gh.paginate<Review>(`/pulls/${pr.number}/reviews`);
  const reviewComments = await gh.paginate<{ path: string; created_at: string; author_association: string; user: { login: string } | null; body: string }>(
    `/pulls/${pr.number}/comments`,
  );
  // fix-pr の裏付けは、Jev・Claude の外れと同じ結び付けの、根拠になったファイルだけで見る
  const fixPrFiles = fixPrFilesOf(fixLinks);
  const panel = panelPairs(config, {
    pr: pr.number,
    mergedAt: row.mergedAt,
    reverted: row.reverted,
    fixedBy,
    fixRequests: row.fixRequests,
    comments,
    acceptances: appRecords<Acceptance>(config, comments, 'acceptance'),
    fixRequestReviews: reviews
      .filter((r) => r.user?.login === appLogin(config) && appMarkKind(r.body) === 'fix-request')
      .map((r) => ({ commitId: r.commit_id, submittedAt: r.submitted_at, body: r.body })),
    reviewComments: reviewComments.map((c) => ({ path: c.path, createdAt: c.created_at, authorAssociation: c.author_association, login: c.user?.login ?? '', body: c.body })),
    fixPrFiles,
  });
  panelRows.push(...panel.rows);
  for (const [k, n] of Object.entries(panel.excluded)) panelExcluded[k] = (panelExcluded[k] ?? 0) + n;
}

console.log(`${renderReport(summarize(config, rows), rows, days)}\n\n${renderTokenRatios(tokenRatios(rows))}`);
console.log(`\n${renderPanelComparison(panelComparison(panelRows), panelRows, panelExcluded)}`);

// 人の決定の記録（shadow の plan-decision）と人の判断の一致率。plan-decision の記録がある Issue だけ events と Closes する PR を読む
const issues = (await gh.paginate<{ number: number; comments: number; pull_request?: unknown }>(`/issues?state=all&since=${new Date(since).toISOString()}`, 10)).filter(
  (i) => !i.pull_request && i.comments > 0,
);
const decisionRowsAll: DecisionRow[] = [];
for (const i of issues) {
  const comments = await gh.listComments(i.number);
  if (appRecords(config, comments, 'plan-decision').length === 0) continue;
  const events = await gh.paginate<{ event: string; created_at?: string; actor?: { login: string } | null; label?: { name: string } }>(`/issues/${i.number}/events`);
  const data = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; createdAt: string }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:50,includeClosedPrs:true){nodes{number createdAt}}}}}`,
    { owner: gh.owner, repo: gh.repo, n: i.number },
  );
  decisionRowsAll.push(...decisionRows(config, i.number, comments, events, data.repository.issue.closedByPullRequestsReferences.nodes));
}
console.log(`\n${renderDecisionAgreement(decisionAgreement(decisionRowsAll), decisionRowsAll)}`);
