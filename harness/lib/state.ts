import { appMarkKind, extractBlock } from './blocks.ts';
import { appLogin, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { GitHub, IssueComment } from './github.ts';
import type { Acceptance } from './merge-route.ts';

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

/** 同じリポジトリの `claude/` ブランチからの PR だけを Agent の PR とみなす（fork は含めない） */
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
  const data = await gh.graphql<{ repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number }[] } } } }>(
    `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){closingIssuesReferences(first:5){nodes{number}}}}}`,
    { owner: gh.owner, repo: gh.repo, pr },
  );
  return data.repository.pullRequest.closingIssuesReferences.nodes.map((n) => n.number);
}

/** PR 自身の差分の patch-id を計算するための diff（base ブランチの現在値との3点比較） */
export function prDiff(gh: GitHub, pr: PullRequest, headSha: string = pr.head.sha): Promise<string> {
  return gh.compareDiff(pr.base.ref, headSha);
}

export interface DashboardIssue {
  number: number;
  title: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

/** App が作ったダッシュボード Issue（無ければ null） */
export async function findDashboard(gh: GitHub, config: HarnessConfig): Promise<DashboardIssue | null> {
  const mine = await gh.paginate<DashboardIssue>(`/issues?state=open&creator=${encodeURIComponent(appLogin(config))}`, 5);
  return mine.find((i) => i.title === config.dashboardIssueTitle && !i.pull_request) ?? null;
}

/** 自動 Merge モード。ダッシュボードに停止ラベルがない場合だけ有効（ダッシュボードが無ければ停止＝安全側） */
export async function autoMergeMode(gh: GitHub, config: HarnessConfig): Promise<boolean> {
  const dashboard = await findDashboard(gh, config);
  return dashboard !== null && !hasLabel(dashboard, config.autoMergeStopLabel);
}

/** PR が Close する Issue の、計画ゲートを通過した計画の files。見つからなければ理由を返す */
export async function plannedFilesForPr(gh: GitHub, config: HarnessConfig, pr: number): Promise<{ files: string[] } | { missing: string }> {
  const issues = await closingIssues(gh, pr);
  if (issues.length === 0) return { missing: '本文に `Closes #番号` がありません' };
  const files: string[] = [];
  for (const n of issues) {
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    if (!gate?.value.pass || !gate.value.plan) return { missing: `#${n} に計画ゲートを通過した計画がありません` };
    files.push(...gate.value.plan.files);
  }
  return { files };
}
