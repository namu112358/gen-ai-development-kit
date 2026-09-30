import { extractBlock, hasClaudeMark } from './blocks.ts';
import { areaLimitLabels, describeFullAreas, fullAreas } from './concurrency.ts';
import { appLogin, CHECKS, LABELS, REVIEW_EXEMPT_LABEL, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import { patchId } from './patch-id.ts';
import { buildQueue, type Action, type Claim, type IssueFacts, type PrFacts } from './queue.ts';
import {
  acceptanceForPatch,
  appRecords,
  hasLabel,
  isAgentPr,
  isSameRepoPr,
  isAppComment,
  isTrustedComment,
  lastLabeled,
  latestPlanGate,
  linkedIssues,
  planLinkedIssues,
  prDiff,
  timeline,
  withStack,
  type PlanGateRecord,
  type PullRequest,
  type Review,
} from './state.ts';

/**
 * queue の材料（事実）を GitHub から集める。App（Actions）と人のセッションの両方から使う。
 * Routine は GitHub API を直接呼べない（MCP ツールのみ）ため、App が計算してダッシュボードに公開した queue を読む。
 */

/**
 * 有効な着手宣言。最初の宣言が持ち主（Issue #171）で、返すのは持ち主の最新の段階の宣言。コメントを古い順に見て：
 * - 持ち主がいなければ、解除でない宣言のセッションが持ち主になる
 * - 持ち主と同じセッションの宣言は段階の更新（解除なら持ち主がなくなる）
 * - ほかのセッションの宣言は、takeover: true か、持ち主が Routine の宣言なら持ち主が移る。それ以外（解除も）は無視する
 * - 計画・判定コメントで持ち主がなくなる
 * session の無い古い書式の宣言同士は同じセッションとみなす（見分けられないため、最後の宣言を使う）。
 * 持ち主が Routine のときの期限（routineClaimTakeoverMinutes）は、queue の claimedByOther が着手の前に判断する
 */
export function claimOf(comments: IssueComment[]): Claim | null {
  let owner: Claim | null = null;
  for (const c of comments) {
    if (!hasClaudeMark(c.body) || !isTrustedComment(c)) continue;
    if (extractBlock(c.body, 'agent-plan').found || extractBlock(c.body, 'agent-verdict').found) {
      owner = null;
      continue;
    }
    const b = extractBlock(c.body, 'agent-claim');
    if (!b.found || !b.ok) continue;
    const claim = b.value as Claim;
    if (owner === null) {
      if (!claim.released) owner = claim;
    } else if (sameClaimSession(owner, claim)) {
      owner = claim.released ? null : claim;
    } else if (!claim.released && (claim.takeover === true || owner.by === 'routine')) {
      owner = claim;
    }
  }
  return owner;
}

const sessionKey = (claim: Claim): string | null => (typeof claim.session === 'string' && claim.session !== '' ? claim.session : null);

/** 同じセッションの宣言か。by と session が同じ（session の無いもの同士も含む） */
function sameClaimSession(a: Claim, b: Claim): boolean {
  return a.by === b.by && sessionKey(a) === sessionKey(b);
}

/**
 * 計画コメント（planCommentId）より前に、段階 plan-critique の着手宣言があるか（計画ゲートの批評の関所）。
 * 読み方は claimOf と同じ（Claude の目印・コラボレーターの作成者・読める agent-claim ブロック）。解除の宣言は数えない。by は manual・routine のどちらでもよい。
 * 「前」はコメントの id の大小で決める（id は投稿順に増える。created_at は同じ秒で並ぶことがあるので使わない）
 */
export function critiqueClaimedBefore(comments: IssueComment[], planCommentId: number): boolean {
  return comments.some((c) => {
    if (c.id >= planCommentId || !hasClaudeMark(c.body) || !isTrustedComment(c)) return false;
    const b = extractBlock(c.body, 'agent-claim');
    if (!b.found || !b.ok) return false;
    const claim = b.value as Claim;
    return claim.stage === 'plan-critique' && !claim.released;
  });
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

export async function issueFacts(
  gh: GitHub,
  cfg: HarnessConfig,
  issue: { number: number; title: string; labels: { name: string }[] },
  prByIssue: Map<number, number>,
  openPrLabels: string[][] = [],
): Promise<IssueFacts> {
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
    areaFull: areaFullFor(cfg, gate, openPrLabels),
  };
}

/** 計画ゲートを通過した計画の触るファイルが、上限に達した領域に入るなら、その説明 */
function areaFullFor(cfg: HarnessConfig, gate: ReturnType<typeof latestPlanGate>, openPrLabels: string[][]): string | null {
  const files = (gate?.value as (PlanGateRecord & { plan?: { files: string[] } }) | undefined)?.plan?.files ?? [];
  const full = fullAreas(cfg, files, openPrLabels);
  return full.length > 0 ? describeFullAreas(full) : null;
}

/** 判定コメントへの App の返答をこれ以上待たない時間の既定値（ゲートの実行が落ちた場合に判定し直す。routine.gateReplyTimeoutMinutes が無いとき） */
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
  const [detail, comments, reviews, commit, checks] = await Promise.all([
    gh.get<PullRequest>(`/pulls/${pr.number}`),
    gh.listComments(pr.number),
    gh.paginate<Review>(`/pulls/${pr.number}/reviews`),
    gh.get<{ commit: { committer: { date: string } } }>(`/commits/${pr.head.sha}`),
    gh.paginate<{ name: string; started_at: string; app: { slug: string } | null }>(`/commits/${pr.head.sha}/check-runs`),
  ]);
  // 取り直した PR（stack が確か）で紐付く Issue を引く。スタックの層は本文の Refs／Closes
  const issues = await linkedIssues(gh, cfg, detail);
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
  const verdictHead = verdictBlock?.found && verdictBlock.ok ? (verdictBlock.value as { headSha?: unknown }).headSha : undefined;
  const verdictFresh = verdict !== null && Date.now() - new Date(verdict.created_at).getTime() < (cfg.routine.gateReplyTimeoutMinutes !== undefined ? cfg.routine.gateReplyTimeoutMinutes * 60_000 : GATE_REPLY_TIMEOUT_MS);
  const noReplyYet = verdict !== null && (!lastGateReply || lastGateReply.created_at < verdict.created_at);
  // 判定した head が今の head と違っても、PR 自身の差分の patch-id が同じなら App は受け付ける（on-comment.ts の onVerdict と同じ条件）。
  // 判定した head の diff は、判定が新しく返事がまだ無いときだけ取る（API 呼び出しを増やさない）。取れなければ待ちに数えない
  let verdictForHead = typeof verdictHead === 'string' && verdictHead === pr.head.sha;
  if (!verdictForHead && typeof verdictHead === 'string' && verdictFresh && noReplyYet) {
    try {
      verdictForHead = patchId(await prDiff(gh, pr, verdictHead)) === patch;
    } catch {
      verdictForHead = false;
    }
  }
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
    verdictAwaitingGate: verdictForHead && verdictFresh && noReplyYet,
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
  // Agent PR と、計画のある Issue に紐付く（Closes。スタックの層は Refs も）人の PR（例外ラベル付きは除く）を判定の対象にする
  const repository = `${gh.owner}/${gh.repo}`;
  const prs: PullRequest[] = [];
  const openPrs = await gh.paginate<PullRequest>('/pulls?state=open');
  // 領域ごとの上限には、同じリポジトリの Draft の Agent PR（判定の前）だけを数える
  const openPrLabels = areaLimitLabels(config, openPrs, repository);
  for (const item of openPrs) {
    // 一覧の要素に stack が無いときは取り直す（スタックの層の Refs #N で紐付けるため）
    const p = await withStack(gh, config, item);
    if (isAgentPr(config, p, repository)) prs.push(p);
    else if (isSameRepoPr(p, repository) && !hasLabel(p, REVIEW_EXEMPT_LABEL) && (await planLinkedIssues(gh, config, p)).linked.length > 0) prs.push(p);
  }
  const prByIssue = new Map<number, number>();
  for (const pr of prs) for (const n of await linkedIssues(gh, config, pr)) prByIssue.set(n, pr.number);
  const iFacts = await Promise.all(issues.map((i) => issueFacts(gh, config, i, prByIssue, openPrLabels)));
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
