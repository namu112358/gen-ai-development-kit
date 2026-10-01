/**
 * ダッシュボードの GitHub 側：読み取り専用の Transport、条件付きリクエスト（ETag）での更新の見張り、
 * グラフの材料（facts）の取り直し。facts は harness/lib の issueFacts / prFacts / claimOf をそのまま使う。
 * 取り直しは、変わった番号をまとめた GraphQL の問い合わせで材料を先に読み、harness/lib が送る要求には先読みの Transport が答える
 * （先読みの仕組みは harness/lib/graphql-prefetch.ts。fleet-status・step も使う）。
 */
import { appMarkKind } from '../../lib/blocks.ts';
import { areaLimitLabels } from '../../lib/concurrency.ts';
import { bodyIssueRefs, isAgentPr, isAppComment, isSameRepoPr, latestPlanGate, linkedIssuesWithSource, withStack, type PullRequest } from '../../lib/state.ts';
import { classifyBase } from '../../lib/stack.ts';
import type { HarnessConfig } from '../../lib/config.ts';
import { issueFacts, prFacts } from '../../lib/facts.ts';
import type { FleetPr } from '../../lib/fleet.ts';
import { GitHub, type RequestOptions, type Transport } from '../../lib/github.ts';
import { type BatchSpec, type IssueItem, PrefetchTransport, readBatch, Snapshot } from '../../lib/graphql-prefetch.ts';
import type { DashIssue, DashPr, PlanCopy } from './graph.ts';

// テストと見本が import している名前（先読みの仕組みは harness/lib/graphql-prefetch.ts に移した）
export { buildBatchQuery, GRAPHQL_PAGE, PrefetchTransport, Snapshot } from '../../lib/graphql-prefetch.ts';

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
  private links = new Map<number, { updatedAt: string; issues: number[]; fromBody: boolean }>();
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
  private batch(spec: BatchSpec): Promise<Snapshot> {
    return readBatch(this.gh, this.config, spec);
  }

  private prefetched(snap: Snapshot): GitHub {
    const inner: Transport = { request: (method, path, opts) => this.gh.request(method, path, opts) };
    return new GitHub(new PrefetchTransport({ snap, inner, repoPath: this.gh.repoPath, config: this.config, diffs: this.diffs, stacks: new Map() }), this.repository);
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
    const links = new Map<number, { updatedAt: string; issues: number[]; fromBody: boolean }>();
    await pool(this.openPrs, 4, async (p) => {
      const cached = this.links.get(p.number);
      links.set(p.number, cached && cached.updatedAt === p.updated_at
        ? cached
        : { updatedAt: p.updated_at, ...(await linkedIssuesWithSource(gh, this.config, await withStack(gh, this.config, p))) });
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
      ...(issue !== null && this.links.get(pr.number)?.fromBody ? { linkGap: true as const } : {}),
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
