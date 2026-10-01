import { createHash } from 'node:crypto';
import type { AutoModeJevRecord } from './auto-mode.ts';
import { appMarkKind, extractBlock } from './blocks.ts';
import { appLogin, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import type { Acceptance } from './merge-route.ts';
import type { PlanDelegation } from './plan.ts';
import { classifyBase, stackOf } from './stack.ts';

/**
 * GitHub 上の状態の読み取り。ハーネスは独自の DB を持たず、状態はすべてラベル・コメント・Timeline から再構成する。
 * App の名義で書かれたものだけを信頼する（本文の目印だけでは信頼しない）。
 */

export interface PullRequest {
  number: number;
  state: string;
  draft: boolean;
  merged?: boolean;
  merged_at?: string | null;
  node_id: string;
  title: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  auto_merge: unknown | null;
  mergeable_state?: string;
  labels: { name: string }[];
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
}

export interface TimelineEvent {
  event: string;
  created_at?: string;
  actor?: { login: string } | null;
  label?: { name: string };
  state?: string;
  user?: { login: string } | null;
  submitted_at?: string;
}

export function isTrustedComment(comment: Pick<IssueComment, 'author_association'>): boolean {
  return TRUSTED_ASSOCIATIONS.has(comment.author_association);
}

export function isAppComment(config: HarnessConfig, comment: Pick<IssueComment, 'user'>): boolean {
  return comment.user?.login === appLogin(config);
}

/** 同じリポジトリからの PR（fork は含めない）。判定の対象になる */
export function isSameRepoPr(pr: PullRequest, repository: string): boolean {
  return pr.head.repo?.full_name === repository;
}

/** 同じリポジトリの `claude/` ブランチからの PR だけを Agent の PR とみなす（fork は含めない）。自動 Merge の経路はこれだけ */
export function isAgentPr(config: HarnessConfig, pr: PullRequest, repository: string): boolean {
  return pr.head.repo?.full_name === repository && pr.head.ref.startsWith(config.agentBranchPrefix);
}

export function hasLabel(item: { labels: ({ name?: string } | string)[] }, name: string): boolean {
  return item.labels.some((l) => (typeof l === 'string' ? l : l.name) === name);
}

export function timeline(gh: GitHub, issue: number): Promise<TimelineEvent[]> {
  return gh.paginate<TimelineEvent>(`/issues/${issue}/timeline`);
}

/** ラベルが最後に付けられたイベント（外されていれば null） */
export function lastLabeled(events: TimelineEvent[], label: string): TimelineEvent | null {
  let last: TimelineEvent | null = null;
  for (const e of events) {
    if (e.label?.name !== label) continue;
    if (e.event === 'labeled') last = e;
    if (e.event === 'unlabeled') last = null;
  }
  return last;
}

/** App の構造化コメント（kind 指定）を古い順に返す */
export function appRecords<T>(config: HarnessConfig, comments: IssueComment[], kind: string): { comment: IssueComment; value: T }[] {
  const out: { comment: IssueComment; value: T }[] = [];
  for (const comment of comments) {
    if (!isAppComment(config, comment) || appMarkKind(comment.body) !== kind) continue;
    const block = extractBlock(comment.body, 'agent-app');
    if (block.found && block.ok) out.push({ comment, value: block.value as T });
  }
  return out;
}

export interface PlanGateRecord {
  version: 1;
  planCommentId: number;
  pass: boolean;
  reasons: string[];
  /** 停止の出どころ（gate：App のゲートの停止、planner：Planner の申告か人が付けた印）。古い記録には無い */
  planReviewOrigin?: 'gate' | 'planner';
  /** 決定の記録（agent-decision）で判定し直したときのコメント */
  decisionCommentId?: number;
  /** 委任承認で通したとき（飛ばした理由・ラベル・段階・付けた人・付けた時刻）。harness/lib/delegate.ts の delegatePlanGate */
  delegated?: PlanDelegation;
  /** 批評で必須の指摘が残ったまま、人が進めると決めて通った計画（critique が revise で mustRemaining が1以上）。古い記録には無い */
  critiqueProceeded?: { verdict: 'revise'; mustRemaining: number };
  /** auto mode の危険の判定をかけたとき（通した・保留にした）。harness/gates/auto-mode.ts と on-comment.ts の onPlan。古い記録には無い */
  autoMode?: PlanAutoMode;
}

/** 計画ゲートで auto mode の危険の判定をかけた記録（plan-gate の記録の autoMode） */
export interface PlanAutoMode {
  /** auto mode で飛ばした（保留なら飛ばそうとした）理由 */
  skipped: string[];
  /** 効いていた auto mode のラベル */
  label: string;
  by: string | null;
  since: string | null;
  /** Jev の危険の問いの記録（同じ計画コメント・同じ本文なら使い回す） */
  jev: AutoModeJevRecord;
  /** 危険の判定で保留にしたか */
  hold: boolean;
  /** 危険の判定の理由（Jev の1行） */
  reasons: string[];
}

export function latestPlanGate(config: HarnessConfig, comments: IssueComment[]): { comment: IssueComment; value: PlanGateRecord } | null {
  return appRecords<PlanGateRecord>(config, comments, 'plan-gate').at(-1) ?? null;
}

export function acceptanceForPatch(config: HarnessConfig, comments: IssueComment[], patchId: string): Acceptance | null {
  const records = appRecords<Acceptance>(config, comments, 'acceptance');
  return records.filter((r) => r.value.patchId === patchId).at(-1)?.value ?? null;
}

export interface Review {
  id: number;
  state: string;
  body: string;
  submitted_at: string;
  /** レビューした時点の PR の head */
  commit_id: string;
  author_association: string;
  user: { login: string } | null;
}

/** App がこれまでに出した変更要求レビューの数（修正回数）。解除（dismiss）済みも数える */
export async function fixRequestCount(gh: GitHub, config: HarnessConfig, pr: number): Promise<number> {
  const reviews = await gh.paginate<Review>(`/pulls/${pr}/reviews`);
  return reviews.filter((r) => r.user?.login === appLogin(config) && appMarkKind(r.body) === 'fix-request').length;
}

/** PR の変更ファイル（リネームは旧パスも含む） */
export async function changedFiles(gh: GitHub, pr: number): Promise<string[]> {
  const files = await gh.paginate<{ filename: string; previous_filename?: string }>(`/pulls/${pr}/files`, 30);
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}

/** PR が Close する Issue（本文の Closes #N を GitHub が解釈したもの） */
export async function closingIssues(gh: GitHub, pr: number): Promise<number[]> {
  const data = await gh.graphql<{ repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] } } } }>(
    `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`,
    { owner: gh.owner, repo: gh.repo, pr },
  );
  // 別リポジトリの Issue は同じ番号のローカル Issue と取り違えないよう除く
  return data.repository.pullRequest.closingIssuesReferences.nodes.filter((n) => n.repository.nameWithOwner === `${gh.owner}/${gh.repo}`).map((n) => n.number);
}

/** PR 自身の差分の patch-id を計算するための diff（base ブランチの現在値との3点比較） */
export function prDiff(gh: GitHub, pr: PullRequest, headSha: string = pr.head.sha): Promise<string> {
  return gh.compareDiff(pr.base.ref, headSha);
}

export interface DashboardIssue {
  number: number;
  title: string;
  user: { login: string } | null;
  labels: { name: string }[];
  pull_request?: unknown;
}

/** App が作ったダッシュボード Issue（無ければ null） */
export async function findDashboard(gh: GitHub, config: HarnessConfig): Promise<DashboardIssue | null> {
  const mine = await gh.paginate<DashboardIssue>(`/issues?state=open&creator=${encodeURIComponent(appLogin(config))}`, 5);
  // creator フィルタだけに頼らず、App が作ったことを手元でも確かめる
  return mine.find((i) => i.title === config.dashboardIssueTitle && !i.pull_request && i.user?.login === appLogin(config)) ?? null;
}

/** 自動 Merge モード。ダッシュボードに停止ラベルがない場合だけ有効（ダッシュボードが無ければ停止＝安全側） */
export async function autoMergeMode(gh: GitHub, config: HarnessConfig): Promise<boolean> {
  // リポジトリ設定の Allow auto-merge も停止スイッチとして扱う（ラベルは本人名義の操作でも外せるため、設定を最終手段にする）
  const repo = await gh.get<{ allow_auto_merge?: boolean }>(gh.repoPath);
  if (repo.allow_auto_merge !== true) return false;
  const dashboard = await findDashboard(gh, config);
  return dashboard !== null && !hasLabel(dashboard, config.autoMergeStopLabel);
}

/** 本文の Issue の参照。refs は `Refs #N`、closes は GitHub の閉じるキーワード（Closes・Fixes・Resolves などの別形） */
export interface BodyIssueRef {
  number: number;
  keyword: 'refs' | 'closes';
}

/** HTML コメントとフェンスのコードブロックを除いた本文（PR テンプレートの説明文や引用の例を読まないため） */
function withoutCommentsAndFences(body: string): string {
  const noComments = body.replace(/<!--[\s\S]*?(-->|$)/g, '');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of noComments.split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence === null) {
      if (m) fence = m[1]!;
      else out.push(line);
    } else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) {
      fence = null;
    }
  }
  return out.join('\n');
}

/**
 * PR 本文の `Refs #N`・`Closes #N`（閉じるキーワードの別形も。大文字小文字を問わず、直後の `:` は任意）を読む。
 * 同じリポジトリの `#N` だけを読み、`owner/repo#N` や URL は読まない。同じ番号は1つにまとめ、本文に出てくる順に返す。
 */
export function bodyIssueRefs(body: string | null): BodyIssueRef[] {
  if (!body) return [];
  const out: BodyIssueRef[] = [];
  const re = /\b(refs|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+#(\d+)\b/gi;
  for (const m of withoutCommentsAndFences(body).matchAll(re)) {
    const number = Number(m[2]);
    if (number <= 0 || out.some((r) => r.number === number)) continue;
    out.push({ number, keyword: m[1]!.toLowerCase() === 'refs' ? 'refs' : 'closes' });
  }
  return out;
}

/** 紐付けを調べられる PR（API の PR も一覧の要素もそのまま渡せる形）。stack はスタックの層にだけ入る */
export interface LinkablePr {
  number: number;
  body: string | null;
  base: { ref: string };
  stack?: unknown;
}

/**
 * PR が紐付く Issue。紐付けの入口はここだけにする。
 * スタックの層（一番下が既定ブランチ宛ての形の正しい stack）は、App が本文の `Refs #N`・`Closes #N` を読む
 * （base が既定ブランチでない層の Closes は closingIssuesReferences に入らない見込みのため）。
 * それ以外（スタックでない・形が崩れている・orphan-base）は GitHub の closingIssuesReferences。
 * ただし base が既定ブランチの PR（default）で一覧が空なら、本文の `Closes #N` で補う。PR を作った直後は GitHub が
 * closingIssuesReferences をまだ埋めていないことがあるため（#269）。補うのは、このリポジトリの Issue（PR でない）と確かめた番号だけ。
 * orphan-base は GitHub がもともと一覧を埋めない PR で、本文だけで紐付けないよう補わない。
 * 補うときは番号ごとに GET /issues/{N} を読むので、queue・ダッシュボードの呼び出しも、その分だけ増える。
 */
export async function linkedIssues(gh: GitHub, config: HarnessConfig, pr: LinkablePr): Promise<number[]> {
  return (await linkedIssuesWithSource(gh, config, pr)).issues;
}

/** linkedIssues と同じ紐付けに、本文の `Closes #N` で補ったか（GitHub の紐付けの抜け）を添える。fromBody は補った Issue があるときだけ真 */
export async function linkedIssuesWithSource(gh: GitHub, config: HarnessConfig, pr: LinkablePr): Promise<{ issues: number[]; fromBody: boolean }> {
  const kind = classifyBase(pr, config.defaultBranch);
  if (kind === 'stacked') return { issues: bodyIssueRefs(pr.body).map((r) => r.number), fromBody: false };
  const closing = await closingIssues(gh, pr.number);
  if (closing.length > 0 || kind !== 'default') return { issues: closing, fromBody: false };
  const issues = await bodyClosingIssues(gh, pr.body);
  return { issues, fromBody: issues.length > 0 };
}

/** 本文の `Closes #N` のうち、このリポジトリの Issue（存在し、PR でない）の番号。404 は飛ばし、それ以外のエラーは投げる */
async function bodyClosingIssues(gh: GitHub, body: string | null): Promise<number[]> {
  const out: number[] = [];
  for (const ref of bodyIssueRefs(body).filter((r) => r.keyword === 'closes')) {
    const item = await gh.request<{ pull_request?: unknown } | null>('GET', `/issues/${ref.number}`, { allow404: true });
    if (item && !('pull_request' in item)) out.push(ref.number);
  }
  return out;
}

/**
 * 一覧（GET /pulls?state=open）の要素を、stack が確かな PR にする。要素に stack のキーが無く、
 * base が既定ブランチでないか本文に `Refs #N` があるときだけ /pulls/{n} で取り直す（それ以外は受け取った要素を返す）。
 */
export async function withStack<T extends LinkablePr>(gh: GitHub, config: HarnessConfig, pr: T): Promise<T> {
  if ('stack' in pr) return pr;
  if (pr.base.ref === config.defaultBranch && !bodyIssueRefs(pr.body).some((r) => r.keyword === 'refs')) return pr;
  return gh.get<T>(`/pulls/${pr.number}`);
}

async function linkablePr(gh: GitHub, pr: number | LinkablePr): Promise<LinkablePr> {
  return typeof pr === 'number' ? gh.get<PullRequest>(`/pulls/${pr}`) : pr;
}

/** 紐付けが無いときの文言（スタックの層は Refs か Closes、スタックでない PR は Closes） */
function missingLinkText(config: HarnessConfig, pr: LinkablePr): string {
  return classifyBase(pr, config.defaultBranch) === 'stacked' ? '本文に `Refs #番号` か `Closes #番号` がありません' : '本文に `Closes #番号` がありません';
}

/** PR が紐付く Issue の、計画ゲートを通過した計画の files。見つからなければ理由を返す。番号で呼ばれたら PR を取り直して stack を読む */
export async function plannedFilesForPr(gh: GitHub, config: HarnessConfig, prOrNumber: number | LinkablePr): Promise<{ files: string[] } | { missing: string }> {
  const pr = await linkablePr(gh, prOrNumber);
  const issues = await linkedIssues(gh, config, pr);
  if (issues.length === 0) return { missing: missingLinkText(config, pr) };
  return filesOfIssues(issues, (n) => issuePlannedFiles(gh, config, n));
}

/** Issue 1件の、計画ゲートを通過した計画の files（agent/scope の照合。ローカルの scope-check も使う）。無ければ理由を返す */
export async function issuePlannedFiles(gh: GitHub, config: HarnessConfig, n: number): Promise<{ files: string[] } | { missing: string }> {
  const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
  if (!gate?.value.pass || !gate.value.plan) return { missing: `#${n} に計画ゲートを通過した計画がありません` };
  return { files: gate.value.plan.files };
}

/** Issue ごとの files を順に集める。1件でも無ければその理由を返す */
async function filesOfIssues(issues: number[], one: (n: number) => Promise<{ files: string[] } | { missing: string }>): Promise<{ files: string[] } | { missing: string }> {
  const files: string[] = [];
  for (const n of issues) {
    const r = await one(n);
    if ('missing' in r) return r;
    files.push(...r.files);
  }
  return { files };
}

/**
 * 委任承認（計画＋Merge）の範囲照合に使う計画の files。ゲートを通った計画か、ゲートの停止（planReviewOrigin: gate。ガードレール・Risk などで App が止め、
 * Planner の申告が無いもの）で止まった計画か、人が進めると決めた計画（plan-proceed の記録。issueDelegateFiles）だけを使う。ほかの Planner の申告で止まった計画・古い停止・記録が無いときは理由を返す
 */
export async function plannedFilesForDelegate(gh: GitHub, config: HarnessConfig, prOrNumber: number | LinkablePr): Promise<{ files: string[] } | { missing: string }> {
  const pr = await linkablePr(gh, prOrNumber);
  const issues = await linkedIssues(gh, config, pr);
  if (issues.length === 0) return { missing: missingLinkText(config, pr) };
  return filesOfIssues(issues, (n) => issueDelegateFiles(gh, config, n));
}

/**
 * Issue 1件の、委任承認（計画＋Merge）・bypass の範囲照合に使う計画の files（ローカルの scope-check も使う）。
 * ゲートを通った計画か、ゲートの停止（planReviewOrigin: gate）で止まった計画か、Planner の申告・前の印で止まり人が進めると決めた計画
 * （proceededPlan。App の plan-proceed の記録があり、計画コメントの本文がその後変わっていない）だけ。無ければ理由を返す
 */
export async function issueDelegateFiles(gh: GitHub, config: HarnessConfig, n: number): Promise<{ files: string[] } | { missing: string }> {
  const gate = delegatePlanGate(config, await gh.listComments(n));
  if (!gate) return { missing: `#${n} に委任承認で照合できる計画がありません（ゲートを通ったか、ゲートの停止で止まった計画だけを使う）` };
  return { files: gate.plan.files };
}

type UsablePlanGate = PlanGateRecord & { plan: { files: string[] }; planBodySha256?: string };

/**
 * Issue のコメントから、委任承認・bypass の範囲照合に使える計画ゲートの記録（issueDelegateFiles の選び方）。無ければ null。
 * auto mode でテストを弱める変更を Jev に問う材料（harness/gates/auto-mode-tests.ts）も、この選び方で計画を選ぶ（写さない）
 */
export function delegatePlanGate(config: HarnessConfig, comments: IssueComment[]): UsablePlanGate | null {
  const gate = latestPlanGate(config, comments) as { value: PlanGateRecord & { plan?: { files: string[] }; planBodySha256?: string } } | null;
  const usable =
    gate?.value.pass === true ||
    (gate?.value.pass === false && (gate.value.planReviewOrigin === 'gate' || (gate.value.planReviewOrigin === 'planner' && proceededPlan(config, comments, gate.value))));
  if (!gate || !usable || !gate.value.plan) return null;
  return gate.value as UsablePlanGate;
}

/**
 * delegatePlanGate で選んだ計画の、計画コメントの本文。記録の planBodySha256 と今の本文の sha256 が一致するときだけ返す
 * （ゲートの後に編集された計画は使わない）。planBodySha256 の無い古い記録は、編集されたかを確かめられないので使わない（Issue #440）。無ければ null
 */
export function delegatePlanBody(config: HarnessConfig, comments: IssueComment[]): string | null {
  const gate = delegatePlanGate(config, comments);
  if (!gate) return null;
  const planComment = comments.find((c) => c.id === gate.planCommentId);
  if (!planComment) return null;
  if (!gate.planBodySha256 || createHash('sha256').update(planComment.body).digest('hex') !== gate.planBodySha256) return null;
  return planComment.body;
}

/**
 * 止まった計画ゲートの記録の計画を、人が進めると決めたか（Issue #365）。App の plan-proceed の記録（status: ok）のうち、
 * planCommentId が記録と一致し、planBodySha256 が記録の値と一致し、今の計画コメントの本文の sha256 もそれと一致するものがあれば真。
 * 出し直した計画（planCommentId が変わる）・決定の後に編集された計画・App 以外の名義の記録では偽（harness/gates/plan-decision.ts の onProceed）
 */
function proceededPlan(config: HarnessConfig, comments: IssueComment[], gate: { planCommentId: number; planBodySha256?: string }): boolean {
  if (!gate.planBodySha256) return false;
  const planComment = comments.find((c) => c.id === gate.planCommentId);
  if (!planComment || createHash('sha256').update(planComment.body).digest('hex') !== gate.planBodySha256) return false;
  return appRecords<{ status?: string; planCommentId?: number; planBodySha256?: string | null }>(config, comments, 'plan-proceed').some(
    (r) => r.value.status === 'ok' && r.value.planCommentId === gate.planCommentId && r.value.planBodySha256 === gate.planBodySha256,
  );
}

/**
 * PR が「計画のある Issue」に紐付いているか（スタックでない PR は Closes、スタックの層は本文の Refs／Closes）。計画ゲートの記録（通過・人の判断待ちのどちらでも）が
 * 読める計画を持っていれば計画あり。人の PR にも求める（Issues を開発状態の唯一の記録にするため）。番号で呼ばれたら PR を取り直して stack を読む。
 */
export async function planLinkedIssues(gh: GitHub, config: HarnessConfig, prOrNumber: number | LinkablePr): Promise<{ linked: number[]; unplanned: number[] }> {
  const pr = await linkablePr(gh, prOrNumber);
  const linked: number[] = [];
  const unplanned: number[] = [];
  for (const n of await linkedIssues(gh, config, pr)) {
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: unknown } } | null;
    (gate?.value.plan ? linked : unplanned).push(n);
  }
  return { linked, unplanned };
}

/**
 * Issue に紐付く開いた PR（計画が投稿されたときに plan-link を書き直すため）。
 * Closes する PR（GraphQL）に、本文でその Issue を `Refs`／`Closes` するスタックの層を足す（GraphQL の分が先、重なりは1つ）。
 * 一覧の要素に stack のキーが無ければ /pulls/{n} で取り直して層かを確かめる（取り直せなければ層と確かめられないので入れない）。
 * stacked か orphan-base かは、書き直しの先の writePlanLink が取り直した PR で見る。
 */
export async function openPrsClosing(gh: GitHub, issue: number): Promise<number[]> {
  const data = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number state repository{nameWithOwner}}}}}}`,
    { owner: gh.owner, repo: gh.repo, n: issue },
  );
  const repository = `${gh.owner}/${gh.repo}`;
  const out = data.repository.issue.closedByPullRequestsReferences.nodes
    .filter((p) => p.state === 'OPEN' && p.repository.nameWithOwner === repository)
    .map((p) => p.number);
  for (const item of await gh.paginate<PullRequest>('/pulls?state=open')) {
    if (out.includes(item.number) || !isSameRepoPr(item, repository)) continue;
    if (!bodyIssueRefs(item.body).some((r) => r.number === issue)) continue;
    const full: unknown = 'stack' in item ? item : await gh.get<PullRequest>(`/pulls/${item.number}`).catch(() => null);
    const stack = stackOf(full);
    if (stack !== null && stack !== 'malformed') out.push(item.number);
  }
  return out;
}
