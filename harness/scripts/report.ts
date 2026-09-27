import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { fixPrsFor, isFixPr, renderReport, summarize, type MergedPr, type ReportRow } from '../lib/report.ts';
import { appRecords, changedFiles, fixRequestCount, isAgentPr, type PullRequest } from '../lib/state.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

/**
 * 判定の集計（Jev の切り替え判断用）。GitHub だけから数える（独自 DB は持たない）。
 *
 *   node harness/scripts/report.ts <owner/repo> [days=30]
 *
 * ここでは GitHub から事実を集めて行にするだけ。集計と基準の判定は harness/lib/report.ts、基準の意味は docs/security.md の「Jev」。
 * 受け付けられなかった判定コメントも件数に出す。
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
for (const pr of agentPrs) {
  const comments = await gh.listComments(pr.number);
  const fixedBy = pr.merged_at
    ? fixPrsFor({ number: pr.number, title: pr.title, headRef: pr.head.ref, mergedAt: pr.merged_at, files: await files(pr.number) }, fixCandidates)
    : [];
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
  });
}

console.log(renderReport(summarize(config, rows), rows, days));
