import { extractBlock, hasClaudeMark } from './blocks.ts';
import { appLogin, CHECKS, LABELS, REVIEW_EXEMPT_LABEL, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import { patchId } from './patch-id.ts';
import { buildQueue, type Action, type Claim, type IssueFacts, type PrFacts } from './queue.ts';
import {
  acceptanceForPatch,
  appRecords,
  closingIssues,
  hasLabel,
  isAgentPr,
  isSameRepoPr,
  isAppComment,
  isTrustedComment,
  lastLabeled,
  latestPlanGate,
  planLinkedIssues,
  prDiff,
  timeline,
  type PlanGateRecord,
  type PullRequest,
  type Review,
} from './state.ts';

/**
 * queue の材料（事実）を GitHub から集める。App（Actions）と人のセッションの両方から使う。
 * Routine は GitHub API を直接呼べない（MCP ツールのみ）ため、App が計算してダッシュボードに公開した queue を読む。
 */

/** 有効な着手宣言。解除コメントか、宣言より新しい計画・判定コメントがあれば null */
export function claimOf(comments: IssueComment[]): Claim | null {
  for (const c of [...comments].reverse()) {
    if (!hasClaudeMark(c.body) || !isTrustedComment(c)) continue;
    if (extractBlock(c.body, 'agent-plan').found || extractBlock(c.body, 'agent-verdict').found) return null;
    const b = extractBlock(c.body, 'agent-claim');
    if (b.found && b.ok) {
      const claim = b.value as Claim;
      return claim.released ? null : claim;
    }
  }
  return null;
}

function latestClaudeBlockAt(comments: IssueComment[], kind: 'agent-plan' | 'agent-verdict'): IssueComment | null {
  return [...comments].reverse().find((c) => isTrustedComment(c) && hasClaudeMark(c.body) && extractBlock(c.body, kind).found) ?? null;
}

async function openBlockers(gh: GitHub, n: number): Promise<number[]> {
  const data = await gh.graphql<{ repository: { issue: { blockedBy: { nodes: { number: number; state: string }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){blockedBy(first:50){nodes{number state}}}}}`,
    { owner: gh.owner, repo: gh.repo, n },
  );
  return data.repository.issue.blockedBy.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number);
}

export async function issueFacts(gh: GitHub, cfg: HarnessConfig, issue: { number: number; title: string; labels: { name: string }[] }, prByIssue: Map<number, number>): Promise<IssueFacts> {
  const [events, comments] = await Promise.all([timeline(gh, issue.number), gh.listComments(issue.number)]);
  const gate = latestPlanGate(cfg, comments);
  const plan = latestClaudeBlockAt(comments, 'agent-plan');
  const planOk = lastLabeled(events, LABELS.planOk);
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    readyAt: lastLabeled(events, LABELS.ready)?.created_at ?? null,
    claim: claimOf(comments),
    openBlockers: await openBlockers(gh, issue.number),
    gate: gate ? { pass: gate.value.pass, planCommentId: gate.value.planCommentId, at: gate.comment.created_at } : null,
    latestPlanAt: plan?.created_at ?? null,
    planOkByApp: planOk?.actor?.login === appLogin(cfg),
    openPr: prByIssue.get(issue.number) ?? null,
  };
}

/** 判定コメントへの App の返答をこれ以上待たない時間（ゲートの実行が落ちた場合に判定し直す） */
const GATE_REPLY_TIMEOUT_MS = 30 * 60_000;

/**
 * 現在の head に対する人（コラボレーターで、Claude・App 以外）のレビュー。時刻ではなく、レビューの commit_id で判定する
 * （push の直後、App が範囲照合を書く前に出したレビューも取りこぼさないため）。
 */
export function humanFeedback(reviews: Review[], headSha: string, app: string): Review[] {
  return reviews.filter(
    (r) => r.commit_id === headSha && r.user?.login !== app && isTrustedComment(r) && !hasClaudeMark(r.body) && ['COMMENTED', 'CHANGES_REQUESTED'].includes(r.state),
  );
}

export async function prFacts(gh: GitHub, cfg: HarnessConfig, pr: PullRequest, readyAt: Map<number, string | null>, issueLabels: Map<number, string[]>): Promise<PrFacts> {
  const [detail, comments, reviews, commit, checks, issues] = await Promise.all([
    gh.get<PullRequest>(`/pulls/${pr.number}`),
    gh.listComments(pr.number),
    gh.paginate<Review>(`/pulls/${pr.number}/reviews`),
    gh.get<{ commit: { committer: { date: string } } }>(`/commits/${pr.head.sha}`),
    gh.paginate<{ name: string; started_at: string; app: { slug: string } | null }>(`/commits/${pr.head.sha}/check-runs`),
    closingIssues(gh, pr.number),
  ]);
  const fromApp = checks.filter((c) => c.app?.slug === cfg.appSlug);
  // push の時刻は、App がその head に範囲照合を書いた時刻（なければコミット日時）。コミット日時は push の時刻と一致しないことがある
  const pushedAt = fromApp.find((c) => c.name === CHECKS.scope)?.started_at ?? commit.commit.committer.date;
  const patch = patchId(await prDiff(gh, pr));
  const acc = acceptanceForPatch(cfg, comments, patch);
  const accRecord = appRecords<{ patchId: string }>(cfg, comments, 'acceptance').filter((r) => r.value.patchId === patch).at(-1);
  // 受け付けの記録があっても agent/review が head に書かれていなければ、反映の途中で落ちたとみなして判定し直す
  const applied = fromApp.some((c) => c.name === CHECKS.review);
  const verdict = latestClaudeBlockAt(comments, 'agent-verdict');
  const lastGateReply = comments.filter((c) => isAppComment(cfg, c) && /kind=(acceptance|verdict-rejected)/.test(c.body)).at(-1);
  const verdictBlock = verdict ? extractBlock(verdict.body, 'agent-verdict') : null;
  const verdictForHead = verdictBlock?.found && verdictBlock.ok && (verdictBlock.value as { headSha?: string }).headSha === pr.head.sha;
  const verdictFresh = verdict !== null && Date.now() - new Date(verdict.created_at).getTime() < GATE_REPLY_TIMEOUT_MS;
  const human = humanFeedback(reviews, pr.head.sha, appLogin(cfg));
  const issue = issues[0] ?? null;
  return {
    number: pr.number,
    agent: isAgentPr(cfg, pr, `${gh.owner}/${gh.repo}`),
    conflicted: detail.mergeable_state === 'dirty',
    claim: claimOf(comments),
    issue,
    readyAt: issue ? (readyAt.get(issue) ?? null) : null,
    issueLabels: issue ? (issueLabels.get(issue) ?? []) : [],
    labels: pr.labels.map((l) => l.name),
    headSha: pr.head.sha,
    headPushedAt: pushedAt,
    acceptance: acc && accRecord && applied ? { reviewPass: acc.reviewPass, at: accRecord.comment.created_at } : null,
    verdictAwaitingGate: Boolean(verdictForHead && verdictFresh && (!lastGateReply || lastGateReply.created_at < verdict!.created_at)),
    humanFeedbackSincePush: human.length,
  };
}

export interface QueueResult {
  computedAt: string;
  actions: (Action & { planFiles?: string[] })[];
  skipped: Action[];
}

/** 次にやることを計算する。implement には計画ゲートを通過した計画の files（App の写し）を付ける */
export async function computeQueue(gh: GitHub, config: HarnessConfig, currentSession: string | null, now: Date = new Date()): Promise<QueueResult> {
  const issues = (await gh.paginate<{ number: number; title: string; labels: { name: string }[]; pull_request?: unknown }>(`/issues?state=open&labels=${encodeURIComponent(LABELS.ready)}`)).filter((i) => !i.pull_request);
  // Agent PR と、計画のある Issue を Closes する人の PR（例外ラベル付きは除く）を判定の対象にする
  const repository = `${gh.owner}/${gh.repo}`;
  const prs: PullRequest[] = [];
  for (const p of await gh.paginate<PullRequest>('/pulls?state=open')) {
    if (isAgentPr(config, p, repository)) prs.push(p);
    else if (isSameRepoPr(p, repository) && !hasLabel(p, REVIEW_EXEMPT_LABEL) && (await planLinkedIssues(gh, config, p.number)).linked.length > 0) prs.push(p);
  }
  const prByIssue = new Map<number, number>();
  for (const pr of prs) for (const n of await closingIssues(gh, pr.number)) prByIssue.set(n, pr.number);
  const iFacts = await Promise.all(issues.map((i) => issueFacts(gh, config, i, prByIssue)));
  const readyAt = new Map(iFacts.map((f) => [f.number, f.readyAt]));
  const issueLabels = new Map(iFacts.map((f) => [f.number, f.labels]));
  const pFacts = await Promise.all(prs.map((p) => prFacts(gh, config, p, readyAt, issueLabels)));
  const result = buildQueue(iFacts, pFacts, { currentSession, now, routineClaimTakeoverMinutes: config.routine.routineClaimTakeoverMinutes, humanClaimStaleHours: config.routine.humanClaimStaleHours }, config.routine.maxItemsPerRun);
  const actions = await Promise.all(result.actions.map(async (a) => {
    if (a.kind !== 'implement') return a;
    const gate = latestPlanGate(config, await gh.listComments(a.issue)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    return { ...a, planFiles: gate?.value.plan?.files ?? [] };
  }));
  return { computedAt: now.toISOString(), actions, skipped: result.skipped };
}
