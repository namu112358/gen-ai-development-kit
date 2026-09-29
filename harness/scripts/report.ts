import { appMarkKind } from '../lib/blocks.ts';
import { appLogin, loadConfig, TEST_EXEMPT_LABEL } from '../lib/config.ts';
import { exemptRecords } from '../lib/exempt.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import {
  decisionAgreement,
  decisionRows,
  fixPrsFor,
  isFixPr,
  panelComparison,
  panelPairs,
  renderDecisionAgreement,
  renderPanelComparison,
  renderReport,
  renderTokenRatios,
  summarize,
  tamperDecision,
  tokenRatios,
  type DecisionRow,
  type MergedPr,
  type PanelPairRow,
  type ReportRow,
} from '../lib/report.ts';
import { appRecords, changedFiles, fixRequestCount, isAgentPr, type PullRequest, type Review } from '../lib/state.ts';
import { TEST_TAMPER_JEV_KIND, type TamperJevRecord } from '../lib/test-tamper-jev.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

/**
 * 判定の集計（Jev の切り替え判断用）。GitHub だけから数える（独自 DB は持たない）。
 *
 *   node harness/scripts/report.ts <owner/repo> [days=30]
 *
 * ここでは GitHub から事実を集めて行にするだけ。集計と基準の判定は harness/lib/report.ts、基準の意味は docs/security.md の「Jev」。
 * 受け付けられなかった判定コメントも件数に出す。テストの改ざんの Jev の記録と人の判断（test:exempt・Merge した差分）の一致も数える（Q95）。
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

const filesOf = new Map<number, string[]>();
const files = async (n: number) => filesOf.get(n) ?? filesOf.set(n, await changedFiles(gh, n)).get(n)!;

// fix の PR の候補（タイトルかブランチで fix と分かる Merge 済みの PR）だけ変更ファイルを取る
const fixCandidates: MergedPr[] = [];
for (const p of merged) {
  if (!isFixPr({ title: p.title, headRef: p.head.ref })) continue;
  fixCandidates.push({ number: p.number, title: p.title, headRef: p.head.ref, mergedAt: p.merged_at ?? null, files: await files(p.number) });
}

const rows: ReportRow[] = [];
const panelRows: PanelPairRow[] = [];
const panelExcluded: Record<string, number> = {};
for (const pr of agentPrs) {
  const comments = await gh.listComments(pr.number);
  const fixedBy = pr.merged_at
    ? fixPrsFor({ number: pr.number, title: pr.title, headRef: pr.head.ref, mergedAt: pr.merged_at, files: await files(pr.number) }, fixCandidates)
    : [];
  const acceptance = appRecords<Acceptance>(config, comments, 'acceptance').at(-1)?.value ?? null;
  rows.push({
    pr: pr.number,
    createdAt: pr.created_at,
    mergedAt: pr.merged_at ?? null,
    closedAt: pr.closed_at,
    acceptance,
    rejected: comments.filter((c) => c.body.includes('kind=verdict-rejected')).length,
    fixRequests: await fixRequestCount(gh, config, pr.number),
    reverted: revertedPrs.has(pr.number),
    fixedBy,
    // テストの改ざんの Jev と人の判断（Q95。読んだコメントだけから決める）
    tamper: tamperDecision(
      appRecords<TamperJevRecord>(config, comments, TEST_TAMPER_JEV_KIND).map((r) => r.value),
      exemptRecords(config, comments, TEST_EXEMPT_LABEL),
      Boolean(pr.merged_at),
      acceptance?.patchId ?? null,
    ),
  });

  // 合体版のレビューの記録と今の判定の組（App の fix-request と、レビューコメント）
  const row = rows.at(-1)!;
  const reviews = await gh.paginate<Review>(`/pulls/${pr.number}/reviews`);
  const reviewComments = await gh.paginate<{ path: string; created_at: string; author_association: string; user: { login: string } | null; body: string }>(
    `/pulls/${pr.number}/comments`,
  );
  const fixPrFiles: Record<number, string[]> = {};
  for (const n of fixedBy) fixPrFiles[n] = await files(n);
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
