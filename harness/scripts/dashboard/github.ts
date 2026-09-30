/**
 * ダッシュボードの GitHub 側：読み取り専用の Transport、条件付きリクエスト（ETag）での更新の見張り、
 * グラフの材料（facts）の取り直し。facts は harness/lib の issueFacts / prFacts / claimOf をそのまま使う。
 * 取り直しは、変わった番号をまとめた GraphQL の問い合わせで材料を先に読み、harness/lib が送る要求には先読みの Transport が答える。
 */
import { appMarkKind } from '../../lib/blocks.ts';
import { areaLimitLabels } from '../../lib/concurrency.ts';
import { bodyIssueRefs, isAgentPr, isAppComment, isSameRepoPr, latestPlanGate, linkedIssues, withStack, type PullRequest, type Review, type TimelineEvent } from '../../lib/state.ts';
import { classifyBase } from '../../lib/stack.ts';
import type { HarnessConfig } from '../../lib/config.ts';
import { issueFacts, prFacts } from '../../lib/facts.ts';
import type { FleetPr } from '../../lib/fleet.ts';
import { GitHub, type IssueComment, type RequestOptions, type Transport } from '../../lib/github.ts';
import type { DashIssue, DashPr, PlanCopy } from './graph.ts';

/** 書き込みを拒む Transport：GET と、mutation を含まない /graphql への POST だけを通す */
export class ReadOnlyTransport implements Transport {
  private readonly inner: Transport;
  constructor(inner: Transport) {
    this.inner = inner;
  }

  request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
    if (method.toUpperCase() === 'GET') return this.inner.request(method, path, opts);
    const query = (opts?.body as { query?: unknown } | undefined)?.query;
    const isQuery = typeof query === 'string' && !/^\s*mutation\b/i.test(query) && !/\bmutation\s*[({]/i.test(query);
    if (method.toUpperCase() === 'POST' && /^\/?graphql$/.test(path) && isQuery) return this.inner.request(method, path, opts);
    return Promise.reject(new Error(`ダッシュボードは読み取りだけです（${method} ${path} は送りません）`));
  }
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export type PollResult = { kind: 'unchanged' } | { kind: 'full' } | { kind: 'changed'; numbers: number[] };

const PAGE = 50;

/**
 * 条件付きリクエストで Issue / PR の更新を見張る。304 は API の上限に数えられない。
 * poll の結果を取り込み終えたら commit を呼ぶ。取り込みに失敗して commit しなければ、次の poll が同じ変化をもう一度返す。
 */
export class UpdateWatcher {
  private readonly fetch: FetchLike;
  private readonly token: string;
  private readonly url: string;
  private etag: string | null = null;
  private seen: Map<number, string> | null = null;
  private pending: { etag: string | null; seen: Map<number, string> } | null = null;

  constructor(opts: { fetch: FetchLike; token: string; repository: string; apiUrl?: string }) {
    this.fetch = opts.fetch;
    this.token = opts.token;
    this.url = `${opts.apiUrl ?? 'https://api.github.com'}/repos/${opts.repository}/issues?state=all&sort=updated&direction=desc&per_page=${PAGE}`;
  }

  async poll(): Promise<PollResult> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-harness-dashboard',
    };
    if (this.etag) headers['if-none-match'] = this.etag;
    const res = await this.fetch(this.url, { method: 'GET', headers });
    this.pending = null;
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status !== 200) throw new Error(`GET ${this.url} -> ${res.status}`);
    const items = (await res.json()) as { number: number; updated_at: string }[];
    const next = new Map(items.map((i) => [i.number, i.updated_at]));
    const prev = this.seen;
    this.pending = { etag: res.headers.get('etag'), seen: next };
    if (prev === null) return { kind: 'full' };
    const numbers = items.filter((i) => prev.get(i.number) !== i.updated_at).map((i) => i.number);
    if (items.length >= PAGE && numbers.length >= items.length) return { kind: 'full' };
    return numbers.length > 0 ? { kind: 'changed', numbers } : { kind: 'unchanged' };
  }

  /** 直前の poll の結果を取り込み終えた。ETag と既読の updated_at を進める */
  commit(): void {
    if (!this.pending) return;
    this.etag = this.pending.etag;
    this.seen = this.pending.seen;
    this.pending = null;
  }
}

interface IssueItem {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

// --- まとめた GraphQL の問い合わせ ---

/** GraphQL の1ページの件数（first:）。テストの偽物もこの件数で切る */
export const GRAPHQL_PAGE = {
  openPrs: 20,
  openIssues: 20,
  labels: 100,
  comments: 100,
  timeline: 100,
  reviews: 100,
  checkSuites: 20,
  checkRuns: 50,
} as const;

const P = GRAPHQL_PAGE;
const PAGE_INFO = 'pageInfo{hasNextPage endCursor}';
const ACTOR = '{__typename login}';
const COMMENT = `fullDatabaseId body url createdAt updatedAt authorAssociation author${ACTOR}`;
const LABEL_EVENT = `createdAt actor${ACTOR} label{name}`;
const REVIEW = `fullDatabaseId state body submittedAt commit{oid} authorAssociation author${ACTOR}`;

/** ページ送りで続きを読む接続。name は GraphQL の欄の名前、body は after を付けて読む欄 */
const CONNECTIONS = {
  labels: (after: string) => `labels(first:${P.labels}${after}){nodes{name} ${PAGE_INFO}}`,
  comments: (after: string) => `comments(first:${P.comments}${after}){nodes{${COMMENT}} ${PAGE_INFO}}`,
  timelineItems: (after: string) =>
    `timelineItems(itemTypes:[LABELED_EVENT,UNLABELED_EVENT],first:${P.timeline}${after}){nodes{__typename ... on LabeledEvent{${LABEL_EVENT}} ... on UnlabeledEvent{${LABEL_EVENT}}} ${PAGE_INFO}}`,
  reviews: (after: string) => `reviews(first:${P.reviews}${after}){nodes{${REVIEW}} ${PAGE_INFO}}`,
  checkRuns: (after: string) => `checkRuns(first:${P.checkRuns}${after},filterBy:{checkType:LATEST}){nodes{name startedAt} ${PAGE_INFO}}`,
  checkSuites: (after: string) => `checkSuites(first:${P.checkSuites}${after}){nodes{id app{slug} ${CONNECTIONS.checkRuns('')}} ${PAGE_INFO}}`,
};

const ISSUE_FIELDS = [
  'number title state body url',
  CONNECTIONS.labels(''),
  CONNECTIONS.comments(''),
  CONNECTIONS.timelineItems(''),
  'blockedBy(first:50){nodes{number state}}',
  'closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}',
].join(' ');
const PR_LIGHT = [
  'number state isDraft id title body url updatedAt autoMergeRequest{enabledAt}',
  CONNECTIONS.labels(''),
  `author${ACTOR} headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid`,
  'closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}',
].join(' ');
const PR_DETAIL = [
  'mergeStateStatus',
  CONNECTIONS.comments(''),
  CONNECTIONS.reviews(''),
  `commits(last:1){nodes{commit{id oid committedDate ${CONNECTIONS.checkSuites('')}}}}`,
  'headRef{compare(headRef:$base){aheadBy}}',
].join(' ');
const RATE_LIMIT = 'rateLimit{cost limit remaining resetAt}';

export interface BatchSpec {
  /** issueOrPullRequest で読む番号（Issue なら Issue の欄、PR なら PR の詳しい欄まで） */
  numbers: number[];
  /** 開いた PR の一覧（light：紐付けに要る欄だけ、detail：prFacts に要る欄まで） */
  openPrs?: 'light' | 'detail';
  /** 開いた Issue の一覧（Issue の欄） */
  openIssues?: boolean;
  /** 一覧のページ送りの続き */
  prAfter?: string;
  issueAfter?: string;
}

/**
 * まとめた問い合わせを組み、GitHub の数え方（接続ごとに、親の first を掛けた要求の数を足して 100 で割り、丸める。最小 1）の費用の見積もりを返す。
 * issueOrPullRequest は Issue と PR の両方の欄を足した上の見積もり
 */
export function buildBatchQuery(spec: BatchSpec): { query: string; variables: Record<string, unknown>; estimatedCost: number } {
  const vars = ['$owner:String!', '$repo:String!'];
  const variables: Record<string, unknown> = {};
  const parts: string[] = [];
  let requests = 0;
  let usesBase = false;
  const issueRequests = 5; // labels・comments・timelineItems・blockedBy・closedByPullRequestsReferences
  const prLightRequests = 2; // labels・closingIssuesReferences
  const prDetailRequests = 4 + P.checkSuites; // comments・reviews・commits・checkSuites と、suite ごとの checkRuns
  if (spec.openPrs) {
    const after = spec.prAfter !== undefined ? ',after:$prAfter' : '';
    if (after) {
      vars.push('$prAfter:String');
      variables.prAfter = spec.prAfter;
    }
    const detail = spec.openPrs === 'detail';
    usesBase ||= detail;
    parts.push(`openPrs:pullRequests(states:OPEN,first:${P.openPrs}${after},orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_LIGHT}${detail ? ` ${PR_DETAIL}` : ''}} ${PAGE_INFO}}`);
    requests += 1 + P.openPrs * (prLightRequests + (detail ? prDetailRequests : 0));
  }
  if (spec.openIssues) {
    const after = spec.issueAfter !== undefined ? ',after:$issueAfter' : '';
    if (after) {
      vars.push('$issueAfter:String');
      variables.issueAfter = spec.issueAfter;
    }
    parts.push(`openIssues:issues(states:OPEN,first:${P.openIssues}${after},orderBy:{field:CREATED_AT,direction:DESC}){nodes{${ISSUE_FIELDS}} ${PAGE_INFO}}`);
    requests += 1 + P.openIssues * issueRequests;
  }
  for (const n of [...new Set(spec.numbers)].sort((a, b) => a - b)) {
    usesBase = true;
    parts.push(`n${n}:issueOrPullRequest(number:${n}){__typename ... on Issue{${ISSUE_FIELDS}} ... on PullRequest{${PR_LIGHT} ${PR_DETAIL}}}`);
    requests += issueRequests + prLightRequests + prDetailRequests;
  }
  if (usesBase) vars.push('$base:String!');
  const query = `query DashBatch(${vars.join(',')}){${RATE_LIMIT} repository(owner:$owner,name:$repo){${parts.join(' ')}}}`;
  return { query, variables, estimatedCost: Math.max(1, Math.round(requests / 100)) };
}

/** 1つの Issue / PR の接続の続き（after から1ページ） */
function moreByNumberQuery(conn: 'labels' | 'comments' | 'timelineItems' | 'reviews'): string {
  const field = `page:${CONNECTIONS[conn](',after:$c')}`;
  const onIssue = conn === 'reviews' ? '' : ` ... on Issue{${field}}`;
  const onPr = conn === 'timelineItems' ? '' : ` ... on PullRequest{${field}}`;
  return `query DashMore($owner:String!,$repo:String!,$n:Int!,$c:String){${RATE_LIMIT} repository(owner:$owner,name:$repo){issueOrPullRequest(number:$n){__typename${onIssue}${onPr}}}}`;
}

/** commit の checkSuites・suite の checkRuns の続き */
function moreByNodeQuery(conn: 'checkSuites' | 'checkRuns'): string {
  const on = conn === 'checkSuites' ? 'Commit' : 'CheckSuite';
  return `query DashMoreNode($id:ID!,$c:String){${RATE_LIMIT} node(id:$id){... on ${on}{page:${CONNECTIONS[conn](',after:$c')}}}}`;
}

// --- GraphQL の応答の形 ---

interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface Conn<T> { nodes: T[]; pageInfo?: PageInfo }
interface GActor { __typename: string; login: string }
interface GComment { fullDatabaseId: string | number; body: string; url: string; createdAt: string; updatedAt: string; authorAssociation: string; author: GActor | null }
interface GEvent { __typename: string; createdAt: string; actor: GActor | null; label: { name: string } | null }
interface GReview { fullDatabaseId: string | number; state: string; body: string; submittedAt: string | null; commit: { oid: string } | null; authorAssociation: string; author: GActor | null }
interface GSuite { id: string; app: { slug: string } | null; checkRuns: Conn<{ name: string; startedAt: string | null }> }
interface GNode {
  __typename?: string;
  number: number;
  title: string;
  state: string;
  body: string | null;
  url: string;
  labels: Conn<{ name: string }>;
  comments?: Conn<GComment>;
  timelineItems?: Conn<GEvent>;
  blockedBy?: Conn<{ number: number; state: string }>;
  closedByPullRequestsReferences?: Conn<{ number: number; state: string; repository: { nameWithOwner: string } }>;
  // PR
  isDraft?: boolean;
  id?: string;
  updatedAt?: string;
  autoMergeRequest?: { enabledAt: string | null } | null;
  author?: GActor | null;
  headRefName?: string;
  headRefOid?: string;
  headRepository?: { nameWithOwner: string } | null;
  baseRefName?: string;
  baseRefOid?: string;
  closingIssuesReferences?: Conn<{ number: number; repository: { nameWithOwner: string } }>;
  mergeStateStatus?: string;
  reviews?: Conn<GReview>;
  commits?: Conn<{ commit: { id: string; oid: string; committedDate: string; checkSuites: Conn<GSuite> } }>;
  headRef?: { compare: { aheadBy: number } | null } | null;
}

/** GraphQL の作者を REST の user にそろえる。Bot（GitHub App）は REST と同じく login に [bot] を付ける */
export function restUser(actor: GActor | null | undefined): { login: string; type: string } | null {
  if (!actor) return null;
  if (actor.__typename === 'Bot') return { login: `${actor.login}[bot]`, type: 'Bot' };
  return { login: actor.login, type: actor.__typename };
}

/** fullDatabaseId（BigInt。文字列で返る）を REST の id にする。databaseId は 32 ビットで今の ID が収まらないので使わない */
const restId = (id: string | number): number => Number(id);
const restBody = (body: string | null | undefined): string | null => (body === '' || body === undefined ? null : body);

function restComment(c: GComment): IssueComment {
  return { id: restId(c.fullDatabaseId), body: c.body, html_url: c.url, created_at: c.createdAt, updated_at: c.updatedAt, author_association: c.authorAssociation, user: restUser(c.author) };
}

function restReview(r: GReview): Review {
  return { id: restId(r.fullDatabaseId), state: r.state, body: r.body, submitted_at: r.submittedAt ?? '', commit_id: r.commit?.oid ?? '', author_association: r.authorAssociation, user: restUser(r.author) };
}

function restEvent(e: GEvent): TimelineEvent {
  return { event: e.__typename === 'LabeledEvent' ? 'labeled' : 'unlabeled', created_at: e.createdAt, actor: restUser(e.actor), ...(e.label ? { label: { name: e.label.name } } : {}) };
}

function restPull(n: GNode): PullRequest {
  return {
    number: n.number,
    state: n.state.toLowerCase(),
    draft: n.isDraft ?? false,
    node_id: n.id ?? '',
    title: n.title,
    body: restBody(n.body),
    html_url: n.url,
    updated_at: n.updatedAt ?? '',
    auto_merge: n.autoMergeRequest ? { enabled_at: n.autoMergeRequest.enabledAt } : null,
    labels: n.labels.nodes.map((l) => ({ name: l.name })),
    user: restUser(n.author),
    head: { ref: n.headRefName ?? '', sha: n.headRefOid ?? '', repo: n.headRepository ? { full_name: n.headRepository.nameWithOwner } : null },
    base: { ref: n.baseRefName ?? '', sha: n.baseRefOid ?? '' },
  };
}

function restItem(n: GNode, isPr: boolean): IssueItem {
  return {
    number: n.number,
    title: n.title,
    state: n.state === 'MERGED' ? 'closed' : n.state.toLowerCase(),
    body: restBody(n.body),
    html_url: n.url,
    labels: n.labels.nodes.map((l) => ({ name: l.name })),
    ...(isPr ? { pull_request: { html_url: n.url } } : {}),
  };
}

interface PrDetail {
  mergeableState: string;
  reviews: Review[];
  commit: { oid: string; date: string } | null;
  checkRuns: { name: string; started_at: string | null; app: { slug: string } | null }[];
  aheadBy: number | null;
}

type ClosingNode = { number: number; repository: { nameWithOwner: string } };
type ClosedByNode = { number: number; state: string; repository: { nameWithOwner: string } };

/** まとめた問い合わせで読んだ材料（REST の形に直したもの） */
export class Snapshot {
  openPrs: PullRequest[] | null = null;
  openIssues: IssueItem[] | null = null;
  readonly items = new Map<number, IssueItem>();
  readonly pulls = new Map<number, PullRequest>();
  readonly comments = new Map<number, IssueComment[]>();
  readonly timelines = new Map<number, TimelineEvent[]>();
  readonly blockers = new Map<number, { number: number; state: string }[]>();
  readonly closedBy = new Map<number, ClosedByNode[]>();
  readonly closing = new Map<number, ClosingNode[]>();
  readonly details = new Map<number, PrDetail>();
  /** issueOrPullRequest が見つけられなかった番号（404 と同じに扱う） */
  readonly missing = new Set<number>();

  /** 読み直しに要る欄がそろっている番号（Issue の欄、PR なら詳しい欄まで。見つからなかった番号も含む） */
  has(n: number): boolean {
    if (this.missing.has(n)) return true;
    if (!this.items.has(n)) return false;
    return this.pulls.has(n) ? this.details.has(n) : this.comments.has(n);
  }

  merge(other: Snapshot): void {
    for (const key of ['items', 'pulls', 'comments', 'timelines', 'blockers', 'closedBy', 'closing', 'details'] as const) {
      const into = this[key] as Map<number, unknown>;
      for (const [k, v] of other[key] as Map<number, unknown>) into.set(k, v);
    }
    for (const n of other.missing) this.missing.add(n);
    this.openPrs ??= other.openPrs;
    this.openIssues ??= other.openIssues;
  }

  /** 接続を読み終えた node を取り込む */
  add(node: GNode, kind: 'issue' | 'pr-light' | 'pr-detail'): void {
    const isPr = kind !== 'issue';
    this.items.set(node.number, restItem(node, isPr));
    if (isPr) {
      this.pulls.set(node.number, restPull(node));
      this.closing.set(node.number, node.closingIssuesReferences?.nodes ?? []);
    } else {
      this.comments.set(node.number, (node.comments?.nodes ?? []).map(restComment));
      this.timelines.set(node.number, (node.timelineItems?.nodes ?? []).map(restEvent));
      this.blockers.set(node.number, node.blockedBy?.nodes ?? []);
      this.closedBy.set(node.number, node.closedByPullRequestsReferences?.nodes ?? []);
    }
    if (kind === 'pr-detail') {
      this.comments.set(node.number, (node.comments?.nodes ?? []).map(restComment));
      const commit = node.commits?.nodes[0]?.commit ?? null;
      this.details.set(node.number, {
        mergeableState: (node.mergeStateStatus ?? 'unknown').toLowerCase(),
        reviews: (node.reviews?.nodes ?? []).map(restReview),
        commit: commit ? { oid: commit.oid, date: commit.committedDate } : null,
        checkRuns: (commit?.checkSuites.nodes ?? []).flatMap((s) => s.checkRuns.nodes.map((r) => ({ name: r.name, started_at: r.startedAt, app: s.app ? { slug: s.app.slug } : null }))),
        // head のブランチが無い開いた PR（同じリポジトリではほぼ起きない）は比べられないので、main に遅れていないとする
        aheadBy: node.headRef?.compare?.aheadBy ?? null,
      });
    }
  }
}

/** harness/lib の GraphQL の問い合わせ（facts.ts の openBlockers・state.ts の closingIssues）。文字列が変われば内側に流れ、テストの呼び出しの数で気付く */
const BLOCKED_BY_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){blockedBy(first:50){nodes{number state}}}}}`;
const CLOSING_QUERY = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){closingIssuesReferences(first:20){nodes{number repository{nameWithOwner}}}}}}`;

/** Stacked PR の層の候補（withStack が /pulls/{n} で取り直す PR）。stack の欄は GraphQL に無い */
function stackCandidate(config: HarnessConfig, pr: { base: { ref: string }; body: string | null }): boolean {
  return pr.base.ref !== config.defaultBranch || bodyIssueRefs(pr.body).some((r) => r.keyword === 'refs');
}

/** 要求のページ（per_page・page）に合わせて切る。GitHub.paginate が次のページを読みにきても同じ要素を返さない */
function page<T>(list: T[], url: URL): T[] {
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const n = Number(url.searchParams.get('page') ?? 1);
  return list.slice((n - 1) * per, n * per);
}

/**
 * 先読みの Transport：まとめた問い合わせの結果から、harness/lib の issueFacts・prFacts・linkedIssues・withStack が送る要求に答える。
 * 答えられない要求（読んでいない番号、PR の差分、Stacked PR の層の /pulls/{n}、形の分からない GraphQL）だけを内側に流す。
 * 差分と層の /pulls/{n} は、渡されたキャッシュ（DashboardData が持つ）で同じ head・同じ updated_at では1回だけ流す
 */
export class PrefetchTransport implements Transport {
  private readonly snap: Snapshot;
  private readonly inner: Transport;
  private readonly repoPath: string;
  private readonly config: HarnessConfig;
  private readonly diffs: Map<string, unknown>;
  private readonly stacks: Map<number, { updatedAt: string; pr: unknown }>;

  constructor(opts: { snap: Snapshot; inner: Transport; repoPath: string; config: HarnessConfig; diffs: Map<string, unknown>; stacks: Map<number, { updatedAt: string; pr: unknown }> }) {
    this.snap = opts.snap;
    this.inner = opts.inner;
    this.repoPath = opts.repoPath;
    this.config = opts.config;
    this.diffs = opts.diffs;
    this.stacks = opts.stacks;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const answer = this.answer(method, path, opts);
    if (answer !== undefined) return answer;
    if (method === 'GET' && /\/compare\//.test(path) && opts.raw) {
      const key = `${opts.accept ?? ''} ${path}`;
      if (!this.diffs.has(key)) this.diffs.set(key, await this.inner.request(method, path, opts));
      return this.diffs.get(key);
    }
    const pull = method === 'GET' ? path.match(/\/pulls\/(\d+)$/) : null;
    const known = pull ? this.snap.pulls.get(Number(pull[1])) : undefined;
    if (known) {
      const cached = this.stacks.get(known.number);
      if (cached && cached.updatedAt === known.updated_at) return cached.pr;
      const pr = await this.inner.request(method, path, opts);
      this.stacks.set(known.number, { updatedAt: known.updated_at, pr });
      return pr;
    }
    return this.inner.request(method, path, opts);
  }

  /** 先読みで答えられれば答え（allow404 の見つからない番号は null）、答えられなければ undefined */
  private answer(method: string, path: string, opts: RequestOptions): unknown {
    const s = this.snap;
    if (method === 'POST' && /^\/?graphql$/.test(path)) {
      const body = opts.body as { query?: string; variables?: { n?: number; pr?: number } } | undefined;
      if (body?.query === BLOCKED_BY_QUERY && s.blockers.has(Number(body.variables?.n))) {
        return { data: { repository: { issue: { blockedBy: { nodes: s.blockers.get(Number(body.variables?.n)) } } } } };
      }
      if (body?.query === CLOSING_QUERY && s.closing.has(Number(body.variables?.pr))) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: s.closing.get(Number(body.variables?.pr)) } } } } };
      }
      return undefined;
    }
    if (method !== 'GET' || !path.startsWith(`${this.repoPath}/`)) return undefined;
    const url = new URL(path.slice(this.repoPath.length), 'https://prefetch.invalid');
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if (p === '/pulls' && url.searchParams.get('state') === 'open' && s.openPrs) return page(s.openPrs, url);
    if ((m = p.match(/^\/pulls\/(\d+)$/))) {
      const n = Number(m[1]);
      const pr = s.pulls.get(n);
      const detail = s.details.get(n);
      if (!pr || !detail || stackCandidate(this.config, pr)) return undefined;
      return { ...pr, mergeable_state: detail.mergeableState };
    }
    if ((m = p.match(/^\/pulls\/(\d+)\/reviews$/))) {
      const reviews = s.details.get(Number(m[1]))?.reviews;
      return reviews ? page(reviews, url) : undefined;
    }
    if ((m = p.match(/^\/issues\/(\d+)$/))) {
      const n = Number(m[1]);
      if (s.missing.has(n) && opts.allow404) return null;
      return s.items.get(n);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
      const list = s.comments.get(Number(m[1]));
      return list ? page(list, url) : undefined;
    }
    if ((m = p.match(/^\/issues\/(\d+)\/timeline$/))) {
      const list = s.timelines.get(Number(m[1]));
      return list ? page(list, url) : undefined;
    }
    if ((m = p.match(/^\/commits\/([0-9a-f]+)$/))) {
      const d = [...s.details.values()].find((x) => x.commit?.oid === m![1]);
      return d?.commit ? { sha: d.commit.oid, commit: { committer: { date: d.commit.date } } } : undefined;
    }
    if ((m = p.match(/^\/commits\/([0-9a-f]+)\/check-runs$/))) {
      const d = [...s.details.values()].find((x) => x.commit?.oid === m![1]);
      if (!d) return undefined;
      // GraphQL は、読み手から見えない App（非公開の App。ハーネスの App もそう）の checkSuite の app を null で返す。REST はどの check run にも app を付けるので、
      // null は見えない App のものとして、ハーネスの App（appSlug）の名義に読み替える（見える App は slug のまま）
      const runs = d.checkRuns.map((r) => ({ ...r, app: r.app ?? { slug: this.config.appSlug } }));
      return { total_count: runs.length, check_runs: page(runs, url) };
    }
    return undefined;
  }
}

/**
 * グラフの材料を持ち、変わった Issue / PR だけ取り直す。
 * 対象：開いた Issue（ダッシュボード Issue を除く）のうち、agent: のラベル・有効な着手宣言・Closes する開いた PR のどれかがあるもの。加えて開いた Agent PR。
 * 読み直しは、まとめた GraphQL の問い合わせ1回（ページ送りと、新しい紐付けで読んでいない Issue が要るときの2回目を除く）で材料を読み、
 * REST に残すのは PR の差分（head ごとにキャッシュ）と Stacked PR の層の /pulls/{n}（回の中で PR ごとに1回）だけ
 */
export class DashboardData {
  private readonly gh: GitHub;
  private readonly config: HarnessConfig;
  private readonly issueMap = new Map<number, DashIssue>();
  private readonly prMap = new Map<number, DashPr>();
  private openPrs: PullRequest[] = [];
  /** 開いた PR が紐付く Issue（harness/lib/state.ts の linkedIssues。Stacked PR の層は本文の Refs #N）。PR の updated_at ごとに覚える */
  private links = new Map<number, { updatedAt: string; issues: number[] }>();
  /** PR の差分（要求のパスと accept ごと。パスに head の sha が入る） */
  private readonly diffs = new Map<string, unknown>();

  constructor(gh: GitHub, config: HarnessConfig) {
    this.gh = gh;
    this.config = config;
  }

  issues(): DashIssue[] {
    return [...this.issueMap.values()].sort((a, b) => a.fleet.facts.number - b.fleet.facts.number);
  }

  prs(): DashPr[] {
    return [...this.prMap.values()].sort((a, b) => a.number - b.number);
  }

  private get repository(): string {
    return `${this.gh.owner}/${this.gh.repo}`;
  }

  /**
   * 先読みに答えさせる GitHub（読み直しの回ごとに作る）。内側は受け取った gh（ReadOnlyTransport を通る）。
   * Stacked PR の層の /pulls/{n} は回の中だけで覚える（mergeable_state が main の動きで変わるので、回をまたいでは使わない）
   */
  private prefetched(snap: Snapshot): GitHub {
    const inner: Transport = { request: (method, path, opts) => this.gh.request(method, path, opts) };
    return new GitHub(new PrefetchTransport({ snap, inner, repoPath: this.gh.repoPath, config: this.config, diffs: this.diffs, stacks: new Map() }), this.repository);
  }

  /**
   * GraphQL を送る。issueOrPullRequest の NOT_FOUND（消えた・移された番号）は見つからない番号として受け取り、それ以外のエラーは投げる
   * （gh.graphql はエラーが1つでもあると全体を投げるので、同じ /graphql への要求を gh.request で送る）
   */
  private async query(query: string, variables: Record<string, unknown>): Promise<{ data: any; notFound: string[] }> {
    const res = await this.gh.request<{ data?: any; errors?: { type?: string; message: string; path?: (string | number)[] }[] }>('POST', '/graphql', { body: { query, variables } });
    const errors = res?.errors ?? [];
    const notFound = errors.filter((e) => e.type === 'NOT_FOUND' && typeof e.path?.[1] === 'string' && /^n\d+$/.test(String(e.path[1])));
    const other = errors.filter((e) => !notFound.includes(e));
    if (other.length > 0 || !res?.data) throw new Error(`GraphQL: ${(other.length > 0 ? other : errors).map((e) => e.message).join('; ') || 'no data'}`);
    return { data: res.data, notFound: notFound.map((e) => String(e.path![1])) };
  }

  private async batch(spec: BatchSpec): Promise<Snapshot> {
    const snap = new Snapshot();
    const built = buildBatchQuery(spec);
    const { data, notFound } = await this.query(built.query, this.batchVars(built));
    const repo = data.repository ?? {};
    for (const alias of notFound) snap.missing.add(Number(alias.slice(1)));
    if (spec.openPrs) {
      const nodes = await this.allPages(repo.openPrs as Conn<GNode>, async (after) =>
        (await this.batchPage({ numbers: [], openPrs: spec.openPrs, prAfter: after })).openPrs);
      for (const node of nodes) await this.complete(node, spec.openPrs === 'detail' ? 'pr-detail' : 'pr-light');
      for (const node of nodes) snap.add(node, spec.openPrs === 'detail' ? 'pr-detail' : 'pr-light');
      snap.openPrs = nodes.map((node) => snap.pulls.get(node.number)!);
    }
    if (spec.openIssues) {
      const nodes = await this.allPages(repo.openIssues as Conn<GNode>, async (after) =>
        (await this.batchPage({ numbers: [], openIssues: true, issueAfter: after })).openIssues);
      for (const node of nodes) await this.complete(node, 'issue');
      for (const node of nodes) snap.add(node, 'issue');
      snap.openIssues = nodes.map((node) => snap.items.get(node.number)!);
    }
    for (const [alias, node] of Object.entries(repo) as [string, GNode | null][]) {
      if (!/^n\d+$/.test(alias)) continue;
      if (!node) {
        snap.missing.add(Number(alias.slice(1)));
        continue;
      }
      const kind = node.__typename === 'PullRequest' ? 'pr-detail' : 'issue';
      await this.complete(node, kind);
      snap.add(node, kind);
    }
    return snap;
  }

  private batchVars(built: ReturnType<typeof buildBatchQuery>): Record<string, unknown> {
    return { owner: this.gh.owner, repo: this.gh.repo, ...(built.query.includes('$base') ? { base: this.config.defaultBranch } : {}), ...built.variables };
  }

  private async batchPage(spec: BatchSpec): Promise<{ openPrs: Conn<GNode>; openIssues: Conn<GNode> }> {
    const built = buildBatchQuery(spec);
    return (await this.query(built.query, this.batchVars(built))).data.repository;
  }

  /** 接続を最後のページまで読む */
  private async allPages<T>(first: Conn<T>, next: (after: string) => Promise<Conn<T>>): Promise<T[]> {
    const out = [...first.nodes];
    let info = first.pageInfo;
    while (info?.hasNextPage && info.endCursor) {
      const conn = await next(info.endCursor);
      out.push(...conn.nodes);
      info = conn.pageInfo;
    }
    return out;
  }

  /** node の中の接続で hasNextPage のものを、その接続だけの問い合わせで読み足す（REST に流さない） */
  private async complete(node: GNode, kind: 'issue' | 'pr-light' | 'pr-detail'): Promise<void> {
    const byNumber = async (conn: 'labels' | 'comments' | 'timelineItems' | 'reviews', c: Conn<any> | undefined): Promise<void> => {
      if (!c) return;
      c.nodes = await this.allPages(c, async (after) =>
        (await this.query(moreByNumberQuery(conn), { owner: this.gh.owner, repo: this.gh.repo, n: node.number, c: after })).data.repository.issueOrPullRequest.page);
      c.pageInfo = { hasNextPage: false, endCursor: null };
    };
    const byNode = async (conn: 'checkSuites' | 'checkRuns', id: string, c: Conn<any>): Promise<void> => {
      c.nodes = await this.allPages(c, async (after) => (await this.query(moreByNodeQuery(conn), { id, c: after })).data.node.page);
      c.pageInfo = { hasNextPage: false, endCursor: null };
    };
    await byNumber('labels', node.labels);
    if (kind === 'issue') {
      await byNumber('comments', node.comments);
      await byNumber('timelineItems', node.timelineItems);
    }
    if (kind === 'pr-detail') {
      await byNumber('comments', node.comments);
      await byNumber('reviews', node.reviews);
      const commit = node.commits?.nodes[0]?.commit;
      if (commit) {
        await byNode('checkSuites', commit.id, commit.checkSuites);
        for (const suite of commit.checkSuites.nodes) await byNode('checkRuns', suite.id, suite.checkRuns);
      }
    }
  }

  /**
   * 開いた PR が紐付く Issue を、先読みの結果だけで見込む（harness/lib/state.ts の linkedIssues と同じ分け方）。
   * 本文の Closes #N で補う場合は、Issue か PR か分からないので候補をすべて返し、linkedIssues が GET /issues/{N} で確かめる番号として lookups にも入れる
   */
  private async expectedLinks(gh: GitHub, snap: Snapshot, pr: PullRequest): Promise<{ issues: number[]; lookups: number[] }> {
    const cached = this.links.get(pr.number);
    if (cached && cached.updatedAt === pr.updated_at) return { issues: cached.issues, lookups: [] };
    const full = await withStack(gh, this.config, pr);
    const kind = classifyBase(full, this.config.defaultBranch);
    if (kind === 'stacked') return { issues: bodyIssueRefs(full.body).map((r) => r.number), lookups: [] };
    const closing = (snap.closing.get(pr.number) ?? []).filter((n) => n.repository.nameWithOwner === this.repository).map((n) => n.number);
    if (closing.length > 0 || kind !== 'default') return { issues: closing, lookups: [] };
    const candidates = bodyIssueRefs(full.body).filter((r) => r.keyword === 'closes').map((r) => r.number);
    return { issues: candidates, lookups: candidates };
  }

  /**
   * 見込みの紐付けで、読み直しに要るのに読んでいない番号（pick が選ぶ Issue・PR と、本文の Closes #N を確かめる番号）があれば、
   * 2回目の問い合わせで読み足す（新しく開いた PR・紐付けが変わった PR が、その回に読んでいない Issue に紐付くとき）
   */
  private async fillMissing(gh: GitHub, snap: Snapshot, pick: (links: Map<number, number[]>) => Set<number>): Promise<void> {
    const open = (snap.openPrs ?? []).filter((p) => isSameRepoPr(p, this.repository));
    const links = new Map<number, number[]>();
    const lookups = new Set<number>();
    for (const p of open) {
      const expected = await this.expectedLinks(gh, snap, p);
      links.set(p.number, expected.issues);
      for (const n of expected.lookups) lookups.add(n);
    }
    const missing = new Set([...pick(links)].filter((n) => !snap.has(n)));
    for (const n of lookups) if (!snap.items.has(n) && !snap.missing.has(n)) missing.add(n);
    if (missing.size > 0) snap.merge(await this.batch({ numbers: [...missing] }));
  }

  private async loadOpenPrs(gh: GitHub, snap: Snapshot): Promise<void> {
    this.openPrs = (snap.openPrs ?? []).filter((p) => isSameRepoPr(p, this.repository));
    const links = new Map<number, { updatedAt: string; issues: number[] }>();
    await pool(this.openPrs, 4, async (p) => {
      const cached = this.links.get(p.number);
      links.set(p.number, cached && cached.updatedAt === p.updated_at
        ? cached
        : { updatedAt: p.updated_at, issues: await linkedIssues(gh, this.config, await withStack(gh, this.config, p)) });
    });
    this.links = links;
  }

  /** Issue に紐付く開いた PR */
  private openPrsOf(issue: number): PullRequest[] {
    return this.openPrs.filter((p) => this.links.get(p.number)?.issues.includes(issue));
  }

  /** すべて読み直す（開いた Issue と開いた PR の詳しい欄を1回の問い合わせで読む） */
  async loadAll(): Promise<void> {
    const snap = await this.batch({ numbers: [], openPrs: 'detail', openIssues: true });
    const gh = this.prefetched(snap);
    await this.fillMissing(gh, snap, () => new Set());
    await this.loadOpenPrs(gh, snap);
    const items = (snap.openIssues ?? []).filter((i) => !i.pull_request && i.title !== this.config.dashboardIssueTitle);
    this.issueMap.clear();
    this.prMap.clear();
    await pool(items, 4, (i) => this.loadIssue(gh, snap, i));
    const covered = new Set(this.prs().map((p) => p.number));
    await pool(this.openPrs.filter((p) => !covered.has(p.number) && isAgentPr(this.config, p, this.repository)), 4, (p) => this.loadPr(gh, snap, p, null));
  }

  /** 変わった番号に関わる Issue と PR（紐付けは links から引く） */
  private affected(numbers: number[], open: PullRequest[], linksOf: (n: number) => number[]): { issues: Set<number>; prs: Set<number> } {
    const issues = new Set<number>();
    const prs = new Set<number>();
    for (const n of numbers) {
      const pr = open.find((p) => p.number === n);
      const known = this.prMap.get(n);
      if (pr || known) {
        const linked = [...new Set([...linksOf(n), ...(known?.issue != null ? [known.issue] : [])])];
        if (linked.length > 0) linked.forEach((i) => issues.add(i));
        else prs.add(n);
      } else {
        issues.add(n);
      }
    }
    return { issues, prs };
  }

  /** 変わった番号（Issue でも PR でもよい）に関わる Issue と PR だけ取り直す */
  async refresh(numbers: number[]): Promise<void> {
    // 1回目：変わった番号と、前の回の紐付けから分かる相手（PR の Issue、Issue の開いた PR）と、開いた PR の一覧（紐付けに要る欄だけ）
    const first = new Set(numbers);
    for (const n of numbers) {
      for (const i of this.links.get(n)?.issues ?? []) first.add(i);
      const k = this.prMap.get(n)?.issue;
      if (k != null) first.add(k);
    }
    for (const i of [...first]) for (const p of this.openPrsOf(i)) first.add(p.number);
    const snap = await this.batch({ numbers: [...first], openPrs: 'light' });
    const gh = this.prefetched(snap);
    // 2回目：新しい紐付けで、読んでいない Issue（とその開いた PR）が要るときだけ
    await this.fillMissing(gh, snap, (links) => {
      const open = (snap.openPrs ?? []).filter((p) => isSameRepoPr(p, this.repository));
      const { issues, prs } = this.affected(numbers, open, (n) => links.get(n) ?? []);
      const need = new Set<number>([...issues, ...prs]);
      for (const i of issues) for (const [p, linked] of links) if (linked.includes(i)) need.add(p);
      return need;
    });
    await this.loadOpenPrs(gh, snap);
    const { issues, prs } = this.affected(numbers, this.openPrs, (n) => this.links.get(n)?.issues ?? []);
    for (const n of numbers) if (!this.openPrs.some((p) => p.number === n)) this.prMap.delete(n);
    for (const n of issues) {
      const item = await gh.get<IssueItem | null>(`/issues/${n}`, { allow404: true });
      for (const [k, p] of this.prMap) if (p.issue === n) this.prMap.delete(k);
      this.issueMap.delete(n);
      if (item && !item.pull_request && item.state === 'open' && item.title !== this.config.dashboardIssueTitle) await this.loadIssue(gh, snap, item);
    }
    for (const n of prs) {
      this.prMap.delete(n);
      const pr = this.openPrs.find((p) => p.number === n);
      if (pr && isAgentPr(this.config, pr, this.repository)) await this.loadPr(gh, snap, pr, null);
    }
  }

  /** Merge 済みの PR（fleetStatus の merged と、main への追従の判断に使う） */
  private mergedPrs(snap: Snapshot, issue: number): number[] {
    return (snap.closedBy.get(issue) ?? [])
      .filter((p) => p.repository.nameWithOwner === this.repository && p.state === 'MERGED')
      .map((p) => p.number);
  }

  private async loadIssue(gh: GitHub, snap: Snapshot, item: IssueItem): Promise<void> {
    const open = this.openPrsOf(item.number);
    const prByIssue = new Map<number, number>(open.length > 0 ? [[item.number, open[0]!.number]] : []);
    const facts = await issueFacts(gh, this.config, item, prByIssue, areaLimitLabels(this.config, this.openPrs, this.repository));
    const target = facts.labels.some((l) => l.startsWith('agent:')) || facts.claim !== null || open.length > 0;
    if (!target) return;
    const fleetPrs: FleetPr[] = this.mergedPrs(snap, item.number).map((number) => ({ number, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null }));
    for (const pr of open) {
      fleetPrs.push((await this.loadPr(gh, snap, pr, item.number, new Map([[item.number, facts.readyAt]]), new Map([[item.number, facts.labels]]))).fleet);
    }
    // 計画の写しは issueFacts が返さないので、コメントから読む（App の名義の記録だけを数える）
    const gate = latestPlanGate(this.config, await gh.listComments(item.number)) as { value: { plan?: PlanCopy } } | null;
    const plan = gate?.value.plan && typeof gate.value.plan === 'object' ? gate.value.plan : null;
    this.issueMap.set(item.number, { fleet: { facts, closed: false, planFiles: null, prs: fleetPrs }, body: item.body, url: item.html_url, plan });
  }

  private async loadPr(gh: GitHub, snap: Snapshot, pr: PullRequest, issue: number | null, readyAt = new Map<number, string | null>(), issueLabels = new Map<number, string[]>()): Promise<DashPr> {
    const [facts, comments] = await Promise.all([
      prFacts(gh, this.config, pr, readyAt, issueLabels),
      gh.listComments(pr.number),
    ]);
    const dash: DashPr = {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      issue,
      fleet: {
        number: pr.number,
        merged: false,
        draft: pr.draft,
        autoMerge: pr.auto_merge !== null && pr.auto_merge !== undefined,
        humanReview: comments.some((c) => isAppComment(this.config, c) && appMarkKind(c.body) === 'human-review'),
        behindMain: (snap.details.get(pr.number)?.aheadBy ?? 0) > 0,
        facts,
      },
    };
    this.prMap.set(pr.number, dash);
    return dash;
  }
}

/** 同時に size 件まで走らせる */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
