/**
 * まとめた GraphQL の問い合わせで Issue・PR の材料を先に読み、REST の形に直す先読みの仕組み（ダッシュボードと fleet-status・step が使う）。#305・#249。
 * harness/lib の issueFacts・prFacts などが送る REST の要求には、先読みの Transport（PrefetchTransport）が答える。
 * GraphQL の作者・関係・コメントの ID を REST の形にそろえるのは、この中の restUser・restComment・restReview・restEvent の1か所だけ。
 */
import type { HarnessConfig } from './config.ts';
import type { GitHub, IssueComment, RequestOptions, Transport } from './github.ts';
import { bodyIssueRefs, type PullRequest, type Review, type TimelineEvent } from './state.ts';

export interface IssueItem {
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

export interface PageInfo { hasNextPage: boolean; endCursor: string | null }
export interface Conn<T> { nodes: T[]; pageInfo?: PageInfo }
export interface GActor { __typename: string; login: string }
export interface GComment { fullDatabaseId: string | number; body: string; url: string; createdAt: string; updatedAt: string; authorAssociation: string; author: GActor | null }
export interface GEvent { __typename: string; createdAt: string; actor: GActor | null; label: { name: string } | null }
export interface GReview { fullDatabaseId: string | number; state: string; body: string; submittedAt: string | null; commit: { oid: string } | null; authorAssociation: string; author: GActor | null }
interface GSuite { id: string; app: { slug: string } | null; checkRuns: Conn<{ name: string; startedAt: string | null }> }
export interface GNode {
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
export const restId = (id: string | number): number => Number(id);
const restBody = (body: string | null | undefined): string | null => (body === '' || body === undefined ? null : body);

export function restComment(c: GComment): IssueComment {
  return { id: restId(c.fullDatabaseId), body: c.body, html_url: c.url, created_at: c.createdAt, updated_at: c.updatedAt, author_association: c.authorAssociation, user: restUser(c.author) };
}

export function restReview(r: GReview): Review {
  return { id: restId(r.fullDatabaseId), state: r.state, body: r.body, submitted_at: r.submittedAt ?? '', commit_id: r.commit?.oid ?? '', author_association: r.authorAssociation, user: restUser(r.author) };
}

export function restEvent(e: GEvent): TimelineEvent {
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

export interface PrDetail {
  mergeableState: string;
  reviews: Review[];
  commit: { oid: string; date: string } | null;
  checkRuns: { name: string; started_at: string | null; app: { slug: string } | null }[];
  aheadBy: number | null;
}

export type ClosingNode = { number: number; repository: { nameWithOwner: string } };
export type ClosedByNode = { number: number; state: string; repository: { nameWithOwner: string } };

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
 * 差分と層の /pulls/{n} は、渡されたキャッシュ（呼び出し元が持つ。ダッシュボードは回をまたいで差分を覚える）で同じ head・同じ updated_at では1回だけ流す
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


// --- まとめた問い合わせを送って Snapshot にする ---

/**
 * GraphQL を送る。issueOrPullRequest の NOT_FOUND（消えた・移された番号）は見つからない番号として受け取り、それ以外のエラーは投げる
 * （gh.graphql はエラーが1つでもあると全体を投げるので、同じ /graphql への要求を gh.request で送る。新しいクライアントは作らない）
 */
async function query(gh: GitHub, q: string, variables: Record<string, unknown>): Promise<{ data: any; notFound: string[] }> {
  const res = await gh.request<{ data?: any; errors?: { type?: string; message: string; path?: (string | number)[] }[] }>('POST', '/graphql', { body: { query: q, variables } });
  const errors = res?.errors ?? [];
  const notFound = errors.filter((e) => e.type === 'NOT_FOUND' && typeof e.path?.[1] === 'string' && /^n\d+$/.test(String(e.path[1])));
  const other = errors.filter((e) => !notFound.includes(e));
  if (other.length > 0 || !res?.data) throw new Error(`GraphQL: ${(other.length > 0 ? other : errors).map((e) => e.message).join('; ') || 'no data'}`);
  return { data: res.data, notFound: notFound.map((e) => String(e.path![1])) };
}

function batchVars(gh: GitHub, config: HarnessConfig, built: ReturnType<typeof buildBatchQuery>): Record<string, unknown> {
  return { owner: gh.owner, repo: gh.repo, ...(built.query.includes('$base') ? { base: config.defaultBranch } : {}), ...built.variables };
}

async function batchPage(gh: GitHub, config: HarnessConfig, spec: BatchSpec): Promise<{ openPrs: Conn<GNode>; openIssues: Conn<GNode> }> {
  const built = buildBatchQuery(spec);
  return (await query(gh, built.query, batchVars(gh, config, built))).data.repository;
}

/** 接続を最後のページまで読む */
async function allPages<T>(first: Conn<T>, next: (after: string) => Promise<Conn<T>>): Promise<T[]> {
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
async function complete(gh: GitHub, node: GNode, kind: 'issue' | 'pr-light' | 'pr-detail'): Promise<void> {
  const byNumber = async (conn: 'labels' | 'comments' | 'timelineItems' | 'reviews', c: Conn<any> | undefined): Promise<void> => {
    if (!c) return;
    c.nodes = await allPages(c, async (after) =>
      (await query(gh, moreByNumberQuery(conn), { owner: gh.owner, repo: gh.repo, n: node.number, c: after })).data.repository.issueOrPullRequest.page);
    c.pageInfo = { hasNextPage: false, endCursor: null };
  };
  const byNode = async (conn: 'checkSuites' | 'checkRuns', id: string, c: Conn<any>): Promise<void> => {
    c.nodes = await allPages(c, async (after) => (await query(gh, moreByNodeQuery(conn), { id, c: after })).data.node.page);
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
 * まとめた問い合わせ（buildBatchQuery）を送り、続きのページまで読んで Snapshot にする。
 * 送るのは gh.request('POST', '/graphql')（gh の Transport を通るので、読み取り専用の Transport や呼び出しの回数の数え方もそのまま効く）
 */
export async function readBatch(gh: GitHub, config: HarnessConfig, spec: BatchSpec): Promise<Snapshot> {
  const snap = new Snapshot();
  const built = buildBatchQuery(spec);
  const { data, notFound } = await query(gh, built.query, batchVars(gh, config, built));
  const repo = data.repository ?? {};
  for (const alias of notFound) snap.missing.add(Number(alias.slice(1)));
  if (spec.openPrs) {
    const nodes = await allPages(repo.openPrs as Conn<GNode>, async (after) =>
      (await batchPage(gh, config, { numbers: [], openPrs: spec.openPrs, prAfter: after })).openPrs);
    for (const node of nodes) await complete(gh, node, spec.openPrs === 'detail' ? 'pr-detail' : 'pr-light');
    for (const node of nodes) snap.add(node, spec.openPrs === 'detail' ? 'pr-detail' : 'pr-light');
    snap.openPrs = nodes.map((node) => snap.pulls.get(node.number)!);
  }
  if (spec.openIssues) {
    const nodes = await allPages(repo.openIssues as Conn<GNode>, async (after) =>
      (await batchPage(gh, config, { numbers: [], openIssues: true, issueAfter: after })).openIssues);
    for (const node of nodes) await complete(gh, node, 'issue');
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
    await complete(gh, node, kind);
    snap.add(node, kind);
  }
  return snap;
}
