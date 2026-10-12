import { appMarkKind, extractBlock, hasClaudeMark } from './blocks.ts';
import { areaLimitLabels, describeFullAreas, fullAreas } from './concurrency.ts';
import { appLogin, CHECKS, LABELS, REVIEW_EXEMPT_LABEL, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import { patchId } from './patch-id.ts';
import { buildQueue, claimHistoryOf, type Action, type Claim, type IssueFacts, type PrFacts, type StoredClaim } from './queue.ts';
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

/** 着手宣言の並びの1要素。end は計画・判定コメント（持ち主を消す）、claim は段階ごとの宣言 */
export interface ClaimTimelineItem {
  kind: 'end' | 'claim';
  comment: IssueComment;
  claim: Claim | null;
  position: number;
  phase: 0 | 1;
  at: string;
  index: number;
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * 着手宣言を「段階ごとに投稿されたコメント」とみなす並び。Claude の目印があり、コラボレーターが書いたコメントだけを読む。
 * history の無い宣言は1要素、history を持つ宣言は段階ごとに1要素（history[0] は（コメント ID, 0）、2件目からは「ID が after のコメントのすぐ後」（位置 max(前の段階の位置, after)・段 1・時刻は段階の at））。
 * history を持つ宣言が1件も無ければ入力の順のまま、あれば 位置 → 段 → 時刻 → コメント ID → 添字 で並べる。
 */
export function claimTimeline(comments: IssueComment[]): ClaimTimelineItem[] {
  const items: ClaimTimelineItem[] = [];
  let hasHistory = false;
  for (const c of comments) {
    if (!hasClaudeMark(c.body) || !isTrustedComment(c)) continue;
    if (extractBlock(c.body, 'agent-plan').found || extractBlock(c.body, 'agent-verdict').found) {
      items.push({ kind: 'end', comment: c, claim: null, position: c.id, phase: 0, at: c.created_at, index: 0 });
      continue;
    }
    const b = extractBlock(c.body, 'agent-claim');
    if (!b.found || !b.ok) continue;
    const value = b.value as StoredClaim;
    const history = claimHistoryOf(value);
    if (history === null) {
      items.push({ kind: 'claim', comment: c, claim: value, position: c.id, phase: 0, at: c.created_at, index: 0 });
      continue;
    }
    hasHistory = true;
    let position = c.id;
    for (const [k, e] of history.entries()) {
      if (k > 0) position = Math.max(position, e.after ?? 0);
      const claim = {
        by: value.by,
        ...(value.session !== undefined ? { session: value.session } : {}),
        ...(e.stage !== undefined ? { stage: e.stage } : {}),
        at: e.at,
        ...(e.released ? { released: true } : {}),
        ...(k === 0 && value.takeover ? { takeover: true } : {}),
      } as Claim;
      items.push({ kind: 'claim', comment: c, claim, position: k === 0 ? c.id : position, phase: k === 0 ? 0 : 1, at: k === 0 ? c.created_at : e.at, index: k });
    }
  }
  if (!hasHistory) return items;
  return items.sort((a, b) => a.position - b.position || a.phase - b.phase || timeOf(a.at) - timeOf(b.at) || a.comment.id - b.comment.id || a.index - b.index);
}

/**
 * 有効な着手宣言。最初の宣言が持ち主（Issue #171）で、返すのは持ち主の最新の段階の宣言。claimTimeline の並びを古い順に見て：
 * - 持ち主がいなければ、解除でない宣言のセッションが持ち主になる
 * - 持ち主と同じセッションの宣言は段階の更新（解除なら持ち主がなくなる）
 * - ほかのセッションの宣言は、takeover: true か、持ち主が Routine の宣言なら持ち主が移る。それ以外（解除も）は無視する
 * - 計画・判定コメントで持ち主がなくなる
 * session の無い古い書式の宣言同士は同じセッションとみなす（見分けられないため、最後の宣言を使う）。
 * history を持つ宣言は段階ごとに読み、最後の段階の Claim（history は含めない）を返す。until があれば時刻が until 以下の要素だけで読む（push の時点の宣言。読めない時刻は含めない）。
 * 持ち主が Routine のときの期限（routineClaimTakeoverMinutes）は、queue の claimedByOther が着手の前に判断する
 */
export function claimOf(comments: IssueComment[], opts: { until?: string } = {}): Claim | null {
  const until = opts.until === undefined ? null : Date.parse(opts.until);
  let owner: Claim | null = null;
  for (const item of claimTimeline(comments)) {
    if (until !== null && !(Date.parse(item.at) <= until)) continue;
    if (item.kind === 'end') {
      owner = null;
      continue;
    }
    const claim = item.claim!;
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

/** 着手宣言の段階の時刻（読める最大）。無ければ null。停滞の判定が動きに数える。history の2件目からは書く側の時計が進んでいても GitHub の updated_at を上限にする */
export function claimActivityAt(comments: IssueComment[]): string | null {
  const times = claimTimeline(comments).flatMap((i) => {
    if (i.kind !== 'claim' || Number.isNaN(Date.parse(i.at))) return [];
    const updated = Date.parse(i.comment.updated_at);
    return [i.phase === 1 && !Number.isNaN(updated) ? Math.min(Date.parse(i.at), updated) : Date.parse(i.at)];
  });
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
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
  return claimTimeline(comments).some((i) => i.kind === 'claim' && i.position < planCommentId && i.claim!.stage === 'plan-critique' && !i.claim!.released);
}

/**
 * 人の判断待ち（plan-review・Issue の止まる印）の始まりの時刻。待ちでなければ null（Issue #667）。
 * 止まる印（hold → blocked → waiting の順で最初に付いているもの）はその印を付けた時刻。
 * plan-review（印が付いている、または止まった計画ゲートの記録がある）は、印を付けた時刻・止まったゲートの時刻・最新の決定の記録の時刻のうち最も遅いもの
 * （決定の記録はラベルもゲートも変えないので、記録で待ちを消さず記録の時刻から数え直す）。印もゲートの停止の時刻も無ければ null。
 * 始まりより後に計画コメントがあれば、計画の出し直しでゲートの返事待ちなので null。
 */
export function humanWaitSince(input: {
  labels: string[];
  labeledAt: Partial<Record<string, string>>;
  gate: { pass: boolean; at: string } | null;
  latestPlanAt: string | null;
  latestDecisionAt: string | null;
}): string | null {
  const stop = [LABELS.hold, LABELS.blocked, LABELS.waiting].find((l) => input.labels.includes(l));
  if (stop) return input.labeledAt[stop] ?? null;
  const stoppedGate = input.gate !== null && !input.gate.pass;
  const labeled = input.labels.includes(LABELS.planReview) ? (input.labeledAt[LABELS.planReview] ?? null) : null;
  if (labeled === null && !stoppedGate) return null;
  const times = [labeled, stoppedGate ? input.gate!.at : null, input.latestDecisionAt].filter((t): t is string => t !== null);
  const start = times.reduce((a, b) => (a < b ? b : a));
  if (input.latestPlanAt !== null && input.latestPlanAt > start) return null;
  return start;
}

function latestClaudeBlockAt(comments: IssueComment[], kind: 'agent-plan' | 'agent-verdict' | 'agent-decision'): IssueComment | null {
  return [...comments].reverse().find((c) => isTrustedComment(c) && hasClaudeMark(c.body) && extractBlock(c.body, kind).found) ?? null;
}

async function openBlockers(gh: GitHub, n: number): Promise<number[]> {
  if (gh.restOnly) return (await gh.paginate<{ number: number; state: string }>(`/issues/${n}/dependencies/blocked_by`)).filter((b) => b.state === 'open').map((b) => b.number);
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
  const labeledAt: Partial<Record<string, string>> = {};
  for (const l of [LABELS.planReview, LABELS.hold, LABELS.blocked, LABELS.waiting]) {
    const at = lastLabeled(events, l)?.created_at;
    if (at !== undefined) labeledAt[l] = at;
  }
  const labels = issue.labels.map((l) => l.name);
  return {
    number: issue.number,
    title: issue.title,
    labels,
    readyAt: lastLabeled(events, LABELS.ready)?.created_at ?? null,
    claim: claimOf(comments),
    openBlockers: await openBlockers(gh, issue.number),
    gate: gate ? { pass: gate.value.pass, planCommentId: gate.value.planCommentId, at: gate.comment.created_at } : null,
    latestPlanAt: plan?.created_at ?? null,
    planOkByApp: planOk?.actor?.login === appLogin(cfg),
    openPr: prByIssue.get(issue.number) ?? null,
    areaFull: areaFullFor(cfg, gate, openPrLabels),
    humanWaitSince: humanWaitSince({
      labels,
      labeledAt,
      gate: gate ? { pass: gate.value.pass, at: gate.comment.created_at } : null,
      latestPlanAt: plan?.created_at ?? null,
      latestDecisionAt: latestClaudeBlockAt(comments, 'agent-decision')?.created_at ?? null,
    }),
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
    verdictRejected: verdict !== null && lastGateReply !== undefined && lastGateReply.created_at >= verdict.created_at && appMarkKind(lastGateReply.body) === 'verdict-rejected',
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
