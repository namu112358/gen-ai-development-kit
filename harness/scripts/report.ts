import { appMarkKind } from '../lib/blocks.ts';
import { appLogin, loadConfig, TEST_EXEMPT_LABEL } from '../lib/config.ts';
import { exemptRecords } from '../lib/exempt.ts';
import { GitHub, transportFromEnv, type IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import {
  decisionAgreement,
  implementModelOf,
  implementModelQuality,
  planReturnsOf,
  renderImplementModelQuality,
  decisionRows,
  fixLinksFor,
  fixPrFilesOf,
  fixRequestFindings,
  modelRoutingQuality,
  renderModelRoutingQuality,
  isFixPr,
  laterPassHead,
  panelComparison,
  panelPairs,
  renderDecisionAgreement,
  renderPanelComparison,
  renderReport,
  renderTokenRatios,
  summarize,
  tamperDecision,
  autoModeTestsDecision,
  autoModeViewRecords,
  autoModeViewShift,
  renderAutoModeViewShift,
  tokenRatios,
  type DecisionRow,
  type MergedPr,
  type PanelCompareInput,
  type PanelPairRow,
  type ReportRow,
} from '../lib/report.ts';
import { jobsOf, type Run } from '../lib/qa-retro.ts';
import { MUTATION_JOB, parseSurvivedMutants } from '../lib/test-health.ts';
import { appRecords, closingIssues, fixRequestCount, isAgentPr, latestPlanGate, type PlanGateRecord, type PullRequest, type Review } from '../lib/state.ts';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { TEST_TAMPER_JEV_KIND, type TamperJevRecord } from '../lib/test-tamper-jev.ts';
import { AUTO_MODE_TESTS_KIND, type AutoModeTestsRecord } from '../lib/auto-mode-tests.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

/**
 * 判定の集計（Jev の切り替え判断用）。GitHub だけから数える（独自 DB は持たない）。
 *
 *   node harness/scripts/report.ts <owner/repo> [days=30]
 *
 * ここでは GitHub から事実を集めて行にするだけ。集計と基準の判定は harness/lib/report.ts、基準の意味は docs/security.md の「Jev」。
 * 受け付けられなかった判定コメントも件数に出す。テストの改ざんの Jev の記録と人の判断（test:exempt・Merge した差分）の一致も数える（Q95）。
 * 実装のモデル（PR 本文の「実装のモデル:」の行）ごとに、1回で合格した割合・修正の回数・計画に返した回数を出す節も付ける（#473）。
 * 勧め（計画ゲートの記録の modelRouting）×実装のモデルごとの結果の節も付ける（#139）。
 * 最後に合体版のレビューの記録と今の判定を比べる節（基準は docs/plan.md の Q91）と、人の決定の記録の Jev の判定と人の判断の一致率の節（Q93）、
 * auto mode の危険の問いの見解あり・なしの結論の比べ（shadow。#426）の節を出す。
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

// Issue の着手宣言のコメント（Issue 番号でキャッシュする。計画に返した回数の数え方は lib/report.ts の planReturnsOf）
const issueCommentsOf = new Map<number, IssueComment[]>();
async function issueComments(n: number): Promise<IssueComment[]> {
  const cached = issueCommentsOf.get(n);
  if (cached) return cached;
  const list = await gh.listComments(n).catch(() => []);
  issueCommentsOf.set(n, list);
  return list;
}

// fix の PR の候補（タイトルかブランチで fix と分かる Merge 済みの PR）だけ、変更ファイル・patch・本文・Closes する Issue を取る
const fixCandidates: MergedPr[] = [];
for (const p of merged) {
  if (!isFixPr({ title: p.title, headRef: p.head.ref })) continue;
  fixCandidates.push({ number: p.number, title: p.title, headRef: p.head.ref, mergedAt: p.merged_at ?? null, body: p.body, ...(await prFiles(p.number)), closes: await closes(p.number) });
}

/**
 * 組の head ごとに、その後の最初の合格の head（`laterPassHead`）までの PR 自身のコミットの変更ファイル（合体版の比較の「後の head で直された」）。
 * 今の reviewer が不合格にした head だけ読む。compare（H...L）の commits を PR のコミットの一覧に入っているものに絞り、
 * 親が2つ以上の merge コミットを除く（main の取り込みで入った main 側の変更は数えない。harness/gates/push-claim.ts と同じ絞り方）。
 * force push で H が L の祖先でなくなったときは、compare の commits で読める範囲だけを数える。compare が失敗したら（H が消えたなど）その head は空。
 */
async function laterHeadFilesOf(pr: number, input: Pick<PanelCompareInput, 'comments' | 'acceptances'>): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  let own: Set<string> | null = null;
  for (const a of input.acceptances) {
    const head = a.value.verdictHeadSha;
    if (seen.has(head)) continue;
    seen.add(head);
    if (a.value.reviewPass) continue;
    const later = laterPassHead(input, head);
    if (!later) continue;
    try {
      own ??= new Set((await gh.paginate<{ sha: string }>(`/pulls/${pr}/commits`)).map((c) => c.sha));
      const cmp = await gh.get<{ commits?: { sha: string; parents?: unknown[] }[] }>(`/compare/${head}...${later}`);
      const files = new Set<string>();
      for (const c of cmp.commits ?? []) {
        if (!own.has(c.sha) || (c.parents?.length ?? 0) >= 2) continue;
        const detail = await gh.get<{ files?: { filename: string; previous_filename?: string }[] }>(`/commits/${c.sha}`);
        for (const f of detail.files ?? []) {
          files.add(f.filename);
          if (f.previous_filename) files.add(f.previous_filename);
        }
      }
      out[head] = [...files];
    } catch {
      out[head] = [];
    }
  }
  return out;
}

/**
 * PR の head の mutation のジョブのログから survived の数を読む（Issue #139）。ログの期限切れ・権限・ジョブが無いときは null（失敗で止めない）。
 * 新しい実行から順に、mutation のジョブが走った（skipped・未完了でない）最初のログを読む
 */
async function mutationSurvivedOf(headSha: string): Promise<number | null> {
  try {
    const res = await gh.get<{ workflow_runs?: Run[] }>(`/actions/runs?head_sha=${headSha}&event=pull_request&per_page=20`);
    const runs = (res?.workflow_runs ?? []).filter((r) => r.status === 'completed').sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id - a.id);
    for (const r of runs) {
      const job = (await jobsOf(gh, `/actions/runs/${r.id}/jobs`)).find((j) => j.name === MUTATION_JOB && j.conclusion !== 'skipped' && j.conclusion !== null);
      if (!job) continue;
      const log = await gh.get<unknown>(`/actions/jobs/${job.id}/logs`, { raw: true });
      return typeof log === 'string' ? parseSurvivedMutants(log).length : null;
    }
  } catch {
    // 読めなければ null
  }
  return null;
}

const rows: ReportRow[] = [];
const panelRows: PanelPairRow[] = [];
const panelExcluded: Record<string, number> = {};
// auto mode の危険の問いの見解あり・なし（#426）：受け付けの記録（patch-id ごと）と計画ゲートの記録（計画コメントごと）
const viewAcceptances: Acceptance[] = [];
const viewPlanGates: PlanGateRecord[] = [];
for (const pr of agentPrs) {
  const comments = await gh.listComments(pr.number);
  const fixLinks = pr.merged_at
    ? fixLinksFor(
        { number: pr.number, title: pr.title, headRef: pr.head.ref, mergedAt: pr.merged_at, body: pr.body, ...(await prFiles(pr.number)), closes: await closes(pr.number) },
        fixCandidates,
      )
    : [];
  const acceptance = appRecords<Acceptance>(config, comments, 'acceptance').at(-1)?.value ?? null;
  const fixedBy = fixLinks.map((l) => l.pr);
  let planReturns = 0;
  for (const i of await closes(pr.number)) planReturns += planReturnsOf(await issueComments(i));
  // 勧め（Issue #139）：PR が Closes する Issue の最新の計画ゲートの記録の modelRouting（ok で勧めがある最初のもの）
  let recommendedModel: 'opus' | 'sonnet' | null = null;
  let recommendedGatePass: boolean | null = null;
  for (const i of await closes(pr.number)) {
    const gate = latestPlanGate(config, await issueComments(i))?.value;
    if (gate?.modelRouting?.status === 'ok' && gate.modelRouting.recommended) {
      recommendedModel = gate.modelRouting.recommended;
      recommendedGatePass = gate.pass;
      break;
    }
  }
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
    // auto mode でテストを弱める変更を通した PR と、その後に人が直させたか（Issue #349）
    autoModeTests: autoModeTestsDecision(
      appRecords<AutoModeTestsRecord>(config, comments, AUTO_MODE_TESTS_KIND).map((r) => r.value),
      Boolean(pr.merged_at),
      acceptance?.patchId ?? null,
    ),
    fixLinks,
    implementModel: implementModelOf(pr.body),
    planReturns,
    recommendedModel,
    recommendedGatePass,
  });

  // 合体版のレビューの記録と今の判定の組（App の fix-request と、レビューコメント）
  const row = rows.at(-1)!;
  const reviews = await gh.paginate<Review>(`/pulls/${pr.number}/reviews`);
  row.blockingFindings = reviews
    .filter((r) => r.user?.login === appLogin(config) && appMarkKind(r.body) === 'fix-request')
    .reduce((n, r) => n + fixRequestFindings(r.body).length, 0);
  // 勧めのある PR だけ mutation のログを読む（古い PR は読まない）
  row.mutationSurvived = recommendedModel === null ? null : await mutationSurvivedOf(pr.head.sha);
  const reviewComments = await gh.paginate<{ path: string; created_at: string; author_association: string; user: { login: string } | null; body: string }>(
    `/pulls/${pr.number}/comments`,
  );
  // fix-pr の裏付けは、Jev・Claude の外れと同じ結び付けの、根拠になったファイルだけで見る
  const fixPrFiles = fixPrFilesOf(fixLinks);
  const acceptances = appRecords<Acceptance>(config, comments, 'acceptance');
  viewAcceptances.push(...acceptances.map((a) => a.value));
  const panel = panelPairs(config, {
    pr: pr.number,
    mergedAt: row.mergedAt,
    reverted: row.reverted,
    fixedBy,
    fixRequests: row.fixRequests,
    comments,
    acceptances,
    fixRequestReviews: reviews
      .filter((r) => r.user?.login === appLogin(config) && appMarkKind(r.body) === 'fix-request')
      .map((r) => ({ commitId: r.commit_id, submittedAt: r.submitted_at, body: r.body })),
    reviewComments: reviewComments.map((c) => ({ path: c.path, createdAt: c.created_at, authorAssociation: c.author_association, login: c.user?.login ?? '', body: c.body })),
    fixPrFiles,
    laterHeadFiles: await laterHeadFilesOf(pr.number, { comments, acceptances }),
  });
  panelRows.push(...panel.rows);
  for (const [k, n] of Object.entries(panel.excluded)) panelExcluded[k] = (panelExcluded[k] ?? 0) + n;
}

console.log(`${renderReport(summarize(config, rows), rows, days)}\n\n${renderTokenRatios(tokenRatios(rows))}

${renderImplementModelQuality(implementModelQuality(rows))}

${renderModelRoutingQuality(modelRoutingQuality(rows))}`);
console.log(`\n${renderPanelComparison(panelComparison(panelRows), panelRows, panelExcluded)}`);

// 人の決定の記録（shadow の plan-decision）と人の判断の一致率。plan-decision の記録がある Issue だけ events と Closes する PR を読む
const issues = (await gh.paginate<{ number: number; comments: number; pull_request?: unknown }>(`/issues?state=all&since=${new Date(since).toISOString()}`, 10)).filter(
  (i) => !i.pull_request && i.comments > 0,
);
const decisionRowsAll: DecisionRow[] = [];
for (const i of issues) {
  const comments = await gh.listComments(i.number);
  // 見解あり・なしの比べは、読んだコメントの計画ゲートの記録から拾う（API を増やさない）
  viewPlanGates.push(...appRecords<PlanGateRecord>(config, comments, 'plan-gate').map((r) => r.value));
  if (appRecords(config, comments, 'plan-decision').length === 0) continue;
  const events = await gh.paginate<{ event: string; created_at?: string; actor?: { login: string } | null; label?: { name: string } }>(`/issues/${i.number}/events`);
  const data = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; createdAt: string }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:50,includeClosedPrs:true){nodes{number createdAt}}}}}`,
    { owner: gh.owner, repo: gh.repo, n: i.number },
  );
  decisionRowsAll.push(...decisionRows(config, i.number, comments, events, data.repository.issue.closedByPullRequestsReferences.nodes));
}
console.log(`\n${renderDecisionAgreement(decisionAgreement(decisionRowsAll), decisionRowsAll)}`);
console.log(`\n${renderAutoModeViewShift(autoModeViewShift(autoModeConfig(config).dangerSafe, autoModeViewRecords(viewPlanGates, viewAcceptances)))}`);
