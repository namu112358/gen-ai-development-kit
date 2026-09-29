/**
 * ダッシュボードの GitHub 側：読み取り専用の Transport、条件付きリクエスト（ETag）での更新の見張り、
 * グラフの材料（facts）の取り直し。facts は harness/lib の issueFacts / prFacts / claimOf をそのまま使う。
 */
import { appMarkKind } from '../../lib/blocks.ts';
import { isAppComment, closingIssues, isAgentPr, isSameRepoPr, type PullRequest } from '../../lib/state.ts';
import type { HarnessConfig } from '../../lib/config.ts';
import { issueFacts, prFacts } from '../../lib/facts.ts';
import type { FleetPr } from '../../lib/fleet.ts';
import type { GitHub, RequestOptions, Transport } from '../../lib/github.ts';
import type { DashIssue, DashPr } from './graph.ts';

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

/** 条件付きリクエストで Issue / PR の更新を見張る。304 は API の上限に数えられない */
export class UpdateWatcher {
  private readonly fetch: FetchLike;
  private readonly token: string;
  private readonly url: string;
  private etag: string | null = null;
  private seen: Map<number, string> | null = null;

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
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status !== 200) throw new Error(`GET ${this.url} -> ${res.status}`);
    this.etag = res.headers.get('etag');
    const items = (await res.json()) as { number: number; updated_at: string }[];
    const next = new Map(items.map((i) => [i.number, i.updated_at]));
    const prev = this.seen;
    this.seen = next;
    if (prev === null) return { kind: 'full' };
    const numbers = items.filter((i) => prev.get(i.number) !== i.updated_at).map((i) => i.number);
    if (items.length >= PAGE && numbers.length >= items.length) return { kind: 'full' };
    return numbers.length > 0 ? { kind: 'changed', numbers } : { kind: 'unchanged' };
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

/**
 * グラフの材料を持ち、変わった Issue / PR だけ取り直す。
 * 対象：開いた Issue（ダッシュボード Issue を除く）のうち、agent: のラベル・有効な着手宣言・Closes する開いた PR のどれかがあるもの。加えて開いた Agent PR。
 */
export class DashboardData {
  private readonly gh: GitHub;
  private readonly config: HarnessConfig;
  private readonly issueMap = new Map<number, DashIssue>();
  private readonly prMap = new Map<number, DashPr>();
  private openPrs: PullRequest[] = [];

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

  private async loadOpenPrs(): Promise<void> {
    this.openPrs = (await this.gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, this.repository));
  }

  /** すべて読み直す */
  async loadAll(): Promise<void> {
    await this.loadOpenPrs();
    const items = (await this.gh.paginate<IssueItem>('/issues?state=open')).filter((i) => !i.pull_request && i.title !== this.config.dashboardIssueTitle);
    this.issueMap.clear();
    this.prMap.clear();
    await pool(items, 4, (i) => this.loadIssue(i));
    const covered = new Set(this.prs().map((p) => p.number));
    await pool(this.openPrs.filter((p) => !covered.has(p.number) && isAgentPr(this.config, p, this.repository)), 4, (p) => this.loadPr(p, null));
  }

  /** 変わった番号（Issue でも PR でもよい）に関わる Issue と PR だけ取り直す */
  async refresh(numbers: number[]): Promise<void> {
    await this.loadOpenPrs();
    const issues = new Set<number>();
    const prs = new Set<number>();
    for (const n of numbers) {
      const pr = this.openPrs.find((p) => p.number === n);
      const known = this.prMap.get(n);
      if (pr || known) {
        const linked = pr ? await closingIssues(this.gh, n) : known!.issue !== null ? [known!.issue] : [];
        if (linked.length > 0) linked.forEach((i) => issues.add(i));
        else prs.add(n);
        if (!pr) this.prMap.delete(n);
      } else {
        issues.add(n);
      }
    }
    for (const n of issues) {
      const item = await this.gh.get<IssueItem>(`/issues/${n}`, { allow404: true });
      for (const [k, p] of this.prMap) if (p.issue === n) this.prMap.delete(k);
      this.issueMap.delete(n);
      if (item && !item.pull_request && item.state === 'open' && item.title !== this.config.dashboardIssueTitle) await this.loadIssue(item);
    }
    for (const n of prs) {
      this.prMap.delete(n);
      const pr = this.openPrs.find((p) => p.number === n);
      if (pr && isAgentPr(this.config, pr, this.repository)) await this.loadPr(pr, null);
    }
  }

  private async closingPrs(issue: number): Promise<{ number: number; state: string }[]> {
    const data = await this.gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
      `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`,
      { owner: this.gh.owner, repo: this.gh.repo, n: issue },
    );
    return data.repository.issue.closedByPullRequestsReferences.nodes
      .filter((p) => p.repository.nameWithOwner === this.repository && (p.state === 'OPEN' || p.state === 'MERGED'))
      .map((p) => ({ number: p.number, state: p.state }));
  }

  private async loadIssue(item: IssueItem): Promise<void> {
    const refs = await this.closingPrs(item.number);
    const open = refs.filter((r) => r.state === 'OPEN');
    const prByIssue = new Map<number, number>(open.length > 0 ? [[item.number, open[0]!.number]] : []);
    const facts = await issueFacts(this.gh, this.config, item, prByIssue, this.openPrs.map((p) => p.labels.map((l) => l.name)));
    const target = facts.labels.some((l) => l.startsWith('agent:')) || facts.claim !== null || open.length > 0;
    if (!target) return;
    const fleetPrs: FleetPr[] = [];
    for (const ref of refs) {
      if (ref.state === 'MERGED') {
        fleetPrs.push({ number: ref.number, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null });
        continue;
      }
      const pr = this.openPrs.find((p) => p.number === ref.number) ?? await this.gh.get<PullRequest>(`/pulls/${ref.number}`);
      fleetPrs.push((await this.loadPr(pr, item.number, new Map([[item.number, facts.readyAt]]), new Map([[item.number, facts.labels]]))).fleet);
    }
    this.issueMap.set(item.number, { fleet: { facts, closed: false, planFiles: null, prs: fleetPrs }, body: item.body, url: item.html_url });
  }

  private async loadPr(pr: PullRequest, issue: number | null, readyAt = new Map<number, string | null>(), issueLabels = new Map<number, string[]>()): Promise<DashPr> {
    const [facts, comments, compare] = await Promise.all([
      prFacts(this.gh, this.config, pr, readyAt, issueLabels),
      this.gh.listComments(pr.number),
      this.gh.get<{ ahead_by: number }>(`/compare/${encodeURIComponent(pr.head.sha)}...${encodeURIComponent(this.config.defaultBranch)}`),
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
        behindMain: compare.ahead_by > 0,
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
