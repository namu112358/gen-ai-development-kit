// ダッシュボードの読み直しのテスト用の見本：1つの見本（Issue・PR・コメント・レビュー・ラベルの付け外し・チェック・依存・Stacked PR の層）から、
// REST の応答（今の読み方）と、まとめた GraphQL の問い合わせの応答（harness/scripts/dashboard/github.ts の DashBatch・DashMore・DashMoreNode）を返す偽の GitHub
import { GRAPHQL_PAGE } from '../../scripts/dashboard/github.ts';
import { config, FakeGitHub, HEAD } from './gate-fixtures.ts';

export const REPO = 'o/r';
export const APP_SLUG = config.appSlug;
const T0 = '2026-09-26T00:00:00Z';

export interface WActor { login: string; bot?: boolean }
export interface WComment { id: number; body: string; created_at?: string; author?: WActor | null; association?: string }
export interface WEvent { event: 'labeled' | 'unlabeled'; label: string; created_at?: string; actor?: WActor | null }
export interface WReview { id: number; state: string; body?: string; submitted_at?: string; commit_id?: string; author?: WActor | null; association?: string }
/** hidden：読み手から見えない App（非公開の App）。REST は app の slug を返し、GraphQL は checkSuite の app を null で返す */
export interface WCheck { name: string; started_at?: string; app: string | null; hidden?: boolean }
export interface WIssue {
  number: number;
  title?: string;
  state?: 'open' | 'closed';
  body?: string | null;
  labels?: string[];
  comments?: WComment[];
  events?: WEvent[];
  blockedBy?: { number: number; state: string }[];
  /** Closes する PR（includeClosedPrs: true。state は OPEN・CLOSED・MERGED） */
  closedBy?: { number: number; state: string }[];
}
export interface WPr {
  number: number;
  title?: string;
  body?: string | null;
  state?: 'open' | 'closed';
  draft?: boolean;
  labels?: string[];
  author?: WActor | null;
  headRef?: string;
  headSha?: string;
  headRepo?: string | null;
  baseRef?: string;
  /** REST の /pulls/{n} だけが返す stack（Stacked PR の層） */
  stack?: unknown;
  mergeableState?: string;
  updatedAt?: string;
  autoMerge?: boolean;
  comments?: WComment[];
  reviews?: WReview[];
  committedDate?: string;
  checks?: WCheck[];
  /** closingIssuesReferences（GitHub が本文の Closes を解釈したもの） */
  closing?: number[];
  /** main が head より進んでいる commit の数（REST の /compare/{head}...main の ahead_by） */
  aheadBy?: number;
  /** head のブランチが無い（GraphQL の headRef が null） */
  headRefMissing?: boolean;
}
export interface World { issues: WIssue[]; prs: WPr[]; diff?: string }

const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';

// --- REST の形 ---

const restUser = (a: WActor | null | undefined) => (a ? { login: a.bot ? `${a.login}[bot]` : a.login, type: a.bot ? 'Bot' : 'User' } : null);
const author = (a: WActor | null | undefined): WActor | null => (a === undefined ? { login: 'me' } : a);

export function restComment(c: WComment) {
  return { id: c.id, body: c.body, html_url: `https://github.com/${REPO}#c${c.id}`, created_at: c.created_at ?? T0, updated_at: c.created_at ?? T0, author_association: c.association ?? 'OWNER', user: restUser(author(c.author)) };
}
function restReview(r: WReview, head: string) {
  return { id: r.id, state: r.state, body: r.body ?? '', submitted_at: r.submitted_at ?? T0, commit_id: r.commit_id ?? head, author_association: r.association ?? 'OWNER', user: restUser(author(r.author)) };
}
function restEvent(e: WEvent) {
  return { event: e.event, created_at: e.created_at ?? T0, actor: restUser(author(e.actor)), label: { name: e.label } };
}
function prDefaults(p: WPr) {
  return {
    title: p.title ?? `pr${p.number}`,
    body: p.body === undefined ? null : p.body,
    headRef: p.headRef ?? `claude/issue-${p.number}`,
    headSha: p.headSha ?? HEAD,
    headRepo: p.headRepo === undefined ? REPO : p.headRepo,
    baseRef: p.baseRef ?? 'main',
    updatedAt: p.updatedAt ?? T0,
  };
}
export function restPr(p: WPr, detail = false) {
  const d = prDefaults(p);
  return {
    number: p.number, state: p.state ?? 'open', draft: p.draft ?? true, node_id: `PR_${p.number}`, title: d.title, body: d.body,
    html_url: `https://github.com/${REPO}/pull/${p.number}`, updated_at: d.updatedAt, auto_merge: p.autoMerge ? { enabled_at: T0 } : null,
    labels: (p.labels ?? []).map((name) => ({ name })), user: restUser(author(p.author)),
    head: { ref: d.headRef, sha: d.headSha, repo: d.headRepo ? { full_name: d.headRepo } : null }, base: { ref: d.baseRef, sha: 'b'.repeat(40) },
    ...(detail ? { mergeable_state: p.mergeableState ?? 'clean', ...(p.stack !== undefined ? { stack: p.stack } : {}) } : {}),
  };
}
export function restIssue(i: WIssue) {
  return { number: i.number, title: i.title ?? `t${i.number}`, state: i.state ?? 'open', body: i.body === undefined ? null : i.body, html_url: `https://github.com/${REPO}/issues/${i.number}`, labels: (i.labels ?? []).map((name) => ({ name })) };
}
const restPrItem = (p: WPr) => ({ ...restIssue({ number: p.number, title: prDefaults(p).title, body: prDefaults(p).body, labels: p.labels, state: p.state ?? 'open' }), html_url: `https://github.com/${REPO}/pull/${p.number}`, pull_request: { html_url: `https://github.com/${REPO}/pull/${p.number}` } });
const restChecks = (p: WPr) => (p.checks ?? []).map((c) => ({ name: c.name, started_at: c.started_at ?? T0, app: c.app ? { slug: c.app } : null }));

/** REST の一覧のページ（GitHub.paginate の per_page・page） */
function restPage<T>(list: T[], path: string): T[] {
  const url = new URL(path, 'https://x.invalid');
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const n = Number(url.searchParams.get('page') ?? 1);
  return list.slice((n - 1) * per, n * per);
}

// --- GraphQL の形 ---

const gActor = (a: WActor | null | undefined) => {
  const x = author(a);
  return x ? { __typename: x.bot ? 'Bot' : 'User', login: x.login } : null;
};
const gComment = (c: WComment) => {
  const r = restComment(c);
  return { fullDatabaseId: String(c.id), body: r.body, url: r.html_url, createdAt: r.created_at, updatedAt: r.updated_at, authorAssociation: r.author_association, author: gActor(c.author) };
};
const gReview = (r: WReview, head: string) => ({
  fullDatabaseId: String(r.id), state: r.state, body: r.body ?? '', submittedAt: r.submitted_at ?? T0, commit: { oid: r.commit_id ?? head }, authorAssociation: r.association ?? 'OWNER', author: gActor(r.author),
});
const gEvent = (e: WEvent) => ({ __typename: e.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent', createdAt: e.created_at ?? T0, actor: gActor(e.actor), label: { name: e.label } });

/** 接続の1ページ（カーソルは読んだ位置の数） */
function conn<T>(list: T[], first: number, after?: string | null) {
  const start = after ? Number(after) : 0;
  const nodes = list.slice(start, start + first);
  const end = start + nodes.length;
  return { nodes, pageInfo: { hasNextPage: end < list.length, endCursor: String(end) } };
}

function suites(p: WPr) {
  const key = (c: WCheck) => `${c.hidden ? 'hidden:' : ''}${c.app}`;
  const groups = [...new Map((p.checks ?? []).map((c) => [key(c), c])).values()];
  return groups.map((g, i) => ({
    id: `S_${p.number}_${i}`,
    app: g.app && !g.hidden ? { slug: g.app } : null,
    runs: (p.checks ?? []).filter((c) => key(c) === key(g)).map((c) => ({ name: c.name, startedAt: c.started_at ?? T0 })),
  }));
}

function gIssue(i: WIssue) {
  const r = restIssue(i);
  return {
    __typename: 'Issue', number: i.number, title: r.title, state: r.state.toUpperCase(), body: r.body ?? '', url: r.html_url,
    labels: conn(r.labels, GRAPHQL_PAGE.labels),
    comments: conn((i.comments ?? []).map(gComment), GRAPHQL_PAGE.comments),
    timelineItems: conn((i.events ?? []).map(gEvent), GRAPHQL_PAGE.timeline),
    blockedBy: { nodes: (i.blockedBy ?? []).slice(0, 50) },
    closedByPullRequestsReferences: { nodes: (i.closedBy ?? []).slice(0, 20).map((c) => ({ ...c, repository: { nameWithOwner: REPO } })) },
  };
}

function gPr(p: WPr) {
  const d = prDefaults(p);
  const r = restPr(p);
  return {
    __typename: 'PullRequest', number: p.number, title: d.title, state: (p.state ?? 'open').toUpperCase(), body: d.body ?? '', url: r.html_url,
    isDraft: r.draft, id: r.node_id, updatedAt: d.updatedAt, autoMergeRequest: p.autoMerge ? { enabledAt: T0 } : null,
    labels: conn(r.labels, GRAPHQL_PAGE.labels), author: gActor(p.author),
    headRefName: d.headRef, headRefOid: d.headSha, headRepository: d.headRepo ? { nameWithOwner: d.headRepo } : null, baseRefName: d.baseRef, baseRefOid: r.base.sha,
    closingIssuesReferences: { nodes: (p.closing ?? []).map((number) => ({ number, repository: { nameWithOwner: REPO } })) },
    mergeStateStatus: (p.mergeableState ?? 'clean').toUpperCase(),
    comments: conn((p.comments ?? []).map(gComment), GRAPHQL_PAGE.comments),
    reviews: conn((p.reviews ?? []).map((x) => gReview(x, d.headSha)), GRAPHQL_PAGE.reviews),
    commits: { nodes: [{ commit: {
      id: `C_${p.number}`, oid: d.headSha, committedDate: p.committedDate ?? T0,
      checkSuites: conn(suites(p).map((s) => ({ id: s.id, app: s.app, checkRuns: conn(s.runs, GRAPHQL_PAGE.checkRuns) })), GRAPHQL_PAGE.checkSuites),
    } }] },
    headRef: p.headRefMissing ? null : { compare: { aheadBy: p.aheadBy ?? 0 } },
  };
}

const RATE = { cost: 1, limit: 5000, remaining: 4999, resetAt: '2026-09-26T01:00:00Z' };

/** 見本の番号の node（無ければ null） */
function gNode(world: World, n: number) {
  const i = world.issues.find((x) => x.number === n);
  if (i) return gIssue(i);
  const p = world.prs.find((x) => x.number === n);
  return p ? gPr(p) : null;
}

function answerGraphql(world: World, body: { query: string; variables: Record<string, any> }): unknown {
  const q = body.query;
  const v = body.variables ?? {};
  const openPrs = world.prs.filter((p) => (p.state ?? 'open') === 'open');
  const openIssues = world.issues.filter((i) => (i.state ?? 'open') === 'open');
  if (q.startsWith('query DashBatch(')) {
    const repository: Record<string, unknown> = {};
    const errors: unknown[] = [];
    if (q.includes('openPrs:pullRequests(')) repository.openPrs = conn(openPrs.map(gPr), GRAPHQL_PAGE.openPrs, v.prAfter);
    if (q.includes('openIssues:issues(')) repository.openIssues = conn(openIssues.map(gIssue), GRAPHQL_PAGE.openIssues, v.issueAfter);
    for (const m of q.matchAll(/\bn(\d+):issueOrPullRequest\(number:(\d+)\)/g)) {
      const node = gNode(world, Number(m[2]));
      repository[`n${m[1]}`] = node;
      if (!node) errors.push({ type: 'NOT_FOUND', path: ['repository', `n${m[1]}`], message: `Could not resolve to an issue or pull request with the number of ${m[2]}.` });
    }
    return { data: { rateLimit: RATE, repository }, ...(errors.length > 0 ? { errors } : {}) };
  }
  if (q.startsWith('query DashMore(')) {
    const name = q.match(/page:(\w+)\(/)![1]!;
    const node = gNode(world, Number(v.n)) as Record<string, any> | null;
    const full = fullConnection(world, Number(v.n), name);
    const first = { labels: GRAPHQL_PAGE.labels, comments: GRAPHQL_PAGE.comments, timelineItems: GRAPHQL_PAGE.timeline, reviews: GRAPHQL_PAGE.reviews }[name]!;
    return { data: { rateLimit: RATE, repository: { issueOrPullRequest: node ? { __typename: node.__typename, page: conn(full, first, v.c) } : null } } };
  }
  if (q.startsWith('query DashMoreNode(')) {
    const id = String(v.id);
    const pr = world.prs.find((p) => id === `C_${p.number}` || id.startsWith(`S_${p.number}_`))!;
    if (id.startsWith('C_')) {
      const list = suites(pr).map((s) => ({ id: s.id, app: s.app, checkRuns: conn(s.runs, GRAPHQL_PAGE.checkRuns) }));
      return { data: { rateLimit: RATE, node: { page: conn(list, GRAPHQL_PAGE.checkSuites, v.c) } } };
    }
    const suite = suites(pr).find((s) => s.id === id)!;
    return { data: { rateLimit: RATE, node: { page: conn(suite.runs, GRAPHQL_PAGE.checkRuns, v.c) } } };
  }
  // harness/lib とダッシュボードの前の問い合わせ（REST で読む今の読み方の正解を作るため）
  if (q.includes('blockedBy(first:50)')) return { data: { repository: { issue: { blockedBy: { nodes: world.issues.find((i) => i.number === v.n)?.blockedBy ?? [] } } } } };
  if (q.includes('closedByPullRequestsReferences')) {
    const nodes = (world.issues.find((i) => i.number === v.n)?.closedBy ?? []).map((c) => ({ ...c, repository: { nameWithOwner: REPO } }));
    return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } } };
  }
  if (q.includes('closingIssuesReferences')) {
    const nodes = (world.prs.find((p) => p.number === v.pr)?.closing ?? []).map((number) => ({ number, repository: { nameWithOwner: REPO } }));
    return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } };
  }
  throw new Error(`unexpected graphql: ${q.slice(0, 80)}`);
}

function fullConnection(world: World, n: number, name: string): unknown[] {
  const i = world.issues.find((x) => x.number === n);
  const p = world.prs.find((x) => x.number === n);
  if (name === 'labels') return ((i ?? p)?.labels ?? []).map((l) => ({ name: l }));
  if (name === 'comments') return ((i ?? p)?.comments ?? []).map(gComment);
  if (name === 'timelineItems') return (i?.events ?? []).map(gEvent);
  if (name === 'reviews') return (p?.reviews ?? []).map((r) => gReview(r, prDefaults(p!).headSha));
  throw new Error(`unknown connection ${name}`);
}

/**
 * 見本を REST（今の読み方）と、まとめた GraphQL の問い合わせの両方で返す偽の GitHub。
 * どの道を読んだかは calls に残る（テストは DashboardData が内側に流した呼び出しをこれで数える）
 */
export function dashboardFake(world: World): FakeGitHub {
  const prBySha = (sha: string) => world.prs.find((p) => prDefaults(p).headSha === sha);
  const openPrs = () => world.prs.filter((p) => (p.state ?? 'open') === 'open');
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/pulls\?state=open/, (m) => restPage(openPrs().map((p) => restPr(p)), m.input!))
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)$/, (m) => {
      const p = world.prs.find((x) => x.number === Number(m[1]));
      if (!p) throw new Error(`404 pulls/${m[1]}`);
      return restPr(p, true);
    })
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)\/reviews/, (m) => {
      const p = world.prs.find((x) => x.number === Number(m[1]))!;
      return restPage((p.reviews ?? []).map((r) => restReview(r, prDefaults(p).headSha)), m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/issues\?state=open/, (m) => restPage([...world.issues.filter((i) => (i.state ?? 'open') === 'open').map(restIssue), ...openPrs().map(restPrItem)], m.input!))
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)$/, (m, _b, opts) => {
      const n = Number(m[1]);
      const i = world.issues.find((x) => x.number === n);
      if (i) return restIssue(i);
      const p = world.prs.find((x) => x.number === n);
      if (p) return restPrItem(p);
      if (opts.allow404) return null;
      throw new Error(`404 issues/${n}`);
    })
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)\/comments/, (m) => {
      const n = Number(m[1]);
      return restPage(((world.issues.find((x) => x.number === n) ?? world.prs.find((x) => x.number === n))?.comments ?? []).map(restComment), m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)\/timeline/, (m) => {
      const events = (world.issues.find((x) => x.number === Number(m[1]))?.events ?? []).map(restEvent);
      // REST の timeline にはラベルの付け外しのほかの出来事も入る（lastLabeled は読まない）
      return restPage([{ event: 'mentioned', created_at: T0 }, ...events], m.input!);
    })
    .on('GET', /^\/repos\/o\/r\/commits\/(\w+)$/, (m) => ({ sha: m[1], commit: { committer: { date: prBySha(m[1]!)?.committedDate ?? T0 } } }))
    .on('GET', /^\/repos\/o\/r\/commits\/(\w+)\/check-runs/, (m) => {
      const p = prBySha(m[1]!);
      const list = p ? restChecks(p) : [];
      return { total_count: list.length, check_runs: restPage(list, m.input!) };
    })
    .on('GET', /^\/repos\/o\/r\/compare\/([^.]+)\.\.\.(.+)$/, (m, _b, opts) => {
      if (opts.raw) return world.diff ?? DIFF;
      const p = prBySha(decodeURIComponent(m[1]!));
      return { ahead_by: p?.aheadBy ?? 0 };
    })
    .on('POST', /^\/graphql$/, (_m, body) => answerGraphql(world, body));
}

/** 内側に流れた呼び出しを、道の短い形（GraphQL は操作の名前）にする */
export function callNames(fake: FakeGitHub, from = 0): string[] {
  return fake.calls.slice(from).map((c) => {
    if (c.path === '/graphql') return `graphql:${String(c.body?.query).match(/^query (\w+)/)?.[1] ?? 'anonymous'}`;
    return `${c.method} ${c.path.replace(/^\/repos\/o\/r/, '').replace(/[?].*$/, '')}`;
  });
}
