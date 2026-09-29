import { appMarkKind, extractBlock } from './blocks.ts';
import { appLogin, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import type { Acceptance } from './merge-route.ts';
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
 */
export async function linkedIssues(gh: GitHub, config: HarnessConfig, pr: LinkablePr): Promise<number[]> {
  if (classifyBase(pr, config.defaultBranch) === 'stacked') return bodyIssueRefs(pr.body).map((r) => r.number);
  return closingIssues(gh, pr.number);
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
  const files: string[] = [];
  for (const n of issues) {
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    if (!gate?.value.pass || !gate.value.plan) return { missing: `#${n} に計画ゲートを通過した計画がありません` };
    files.push(...gate.value.plan.files);
  }
  return { files };
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
