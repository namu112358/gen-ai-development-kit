import { spawnSync } from 'node:child_process';

/**
 * GitHub REST / GraphQL の最小クライアント。
 * - Actions：App のトークンで fetch（FetchTransport）
 * - Routine・手元：`gh api`（GhTransport。Routine では GitHub プロキシ経由で認証される）
 */

export interface RequestOptions {
  body?: unknown;
  accept?: string;
  /** true なら本文をテキストのまま返す（diff など） */
  raw?: boolean;
  /** 404 を null として返す */
  allow404?: boolean;
}

export interface Transport {
  request(method: string, path: string, opts?: RequestOptions): Promise<unknown>;
}

/** 応答1つの状態とヘッダー（名前は小文字）。上限（X-RateLimit-*）を外から見るために渡す */
export interface ResponseInfo {
  status: number;
  headers: Record<string, string>;
}

export type ResponseObserver = (info: ResponseInfo) => void;

export interface TransportOptions {
  /** 応答ごとに呼ぶ（FetchTransport はやり直しの各回も）。GhTransport は、あるときだけ gh api に --include を付ける */
  onResponse?: ResponseObserver;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class FetchTransport implements Transport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly onResponse: ResponseObserver | undefined;
  constructor(token: string, baseUrl = 'https://api.github.com', opts: TransportOptions = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.onResponse = opts.onResponse;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: opts.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-harness',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method, headers, body });
      if (this.onResponse) {
        const seen: Record<string, string> = {};
        res.headers.forEach((value, name) => { seen[name.toLowerCase()] = value; });
        this.onResponse({ status: res.status, headers: seen });
      }
      if (res.status === 404 && opts.allow404) return null;
      if ((res.status >= 500 || res.status === 429) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, `${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      if (opts.raw) return text;
      return text === '' ? null : JSON.parse(text);
    }
  }
}

/** raw の応答（ジョブのログなど）に含まれる端末の制御文字で gh（2.97.0 以降）が止まらないようにするフラグ */
export const GH_ALLOW_ESCAPE_FLAG = '--allow-escape-sequences';

/**
 * `gh api` の引数。include が偽なら --include を付けない（今までと同じ引数）。
 * raw の要求だけ --allow-escape-sequences を付ける（応答は文字列として受け取り、端末にそのまま出さない。制御文字は使う側が取り除く）。
 * 本文は --input - で標準入力から渡す（呼び出し元が JSON.stringify(opts.body) を渡す）
 */
export function ghApiArgs(method: string, path: string, opts: RequestOptions, include: boolean): string[] {
  const args = ['api', '--method', method, path.replace(/^\//, ''), '-H', `Accept: ${opts.accept ?? 'application/vnd.github+json'}`];
  if (opts.raw) args.push(GH_ALLOW_ESCAPE_FLAG);
  if (include) args.push('--include');
  if (opts.body !== undefined) args.push('--input', '-');
  return args;
}

/**
 * `gh api --include` の標準出力を、状態行・ヘッダーと本文に分ける（最初の空行で分けるので、本文の中の空行では切れない）。
 * エラーの応答（4xx・5xx）でも gh は標準出力に頭と本文を書く。HTTP/ で始まらなければ info は null で、全部を本文とする
 */
export function parseGhInclude(stdout: string): { info: ResponseInfo | null; body: string } {
  if (!stdout.startsWith('HTTP/')) return { info: null, body: stdout };
  const sep = /\r?\n\r?\n/.exec(stdout);
  const head = sep ? stdout.slice(0, sep.index) : stdout;
  const body = sep ? stdout.slice(sep.index + sep[0].length) : '';
  const [statusLine = '', ...lines] = head.split(/\r?\n/);
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { info: { status: Number(statusLine.match(/^HTTP\/\S+\s+(\d{3})/)?.[1] ?? 0), headers }, body };
}

/** 古い gh（--allow-escape-sequences を知らない版）がこのフラグで止まったか。ほかの未知のフラグや制御文字で止まったエラーは偽 */
export function isUnknownEscapeFlagError(stderr: string): boolean {
  return stderr.includes(`unknown flag: ${GH_ALLOW_ESCAPE_FLAG}`);
}

/** --allow-escape-sequences を除いた引数（元の配列は変えない） */
export function withoutEscapeFlag(args: string[]): string[] {
  return args.filter((a) => a !== GH_ALLOW_ESCAPE_FLAG);
}

/** gh を1回動かした結果 */
export interface GhRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** gh を動かす部分（テストで差し替える） */
export type GhRunner = (args: string[], input: string | undefined) => GhRunResult;

const spawnGh: GhRunner = (args, input) => {
  const res = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

export class GhTransport implements Transport {
  private readonly onResponse: ResponseObserver | undefined;
  private readonly run: GhRunner;
  constructor(opts: TransportOptions = {}, run: GhRunner = spawnGh) {
    this.onResponse = opts.onResponse;
    this.run = run;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const args = ghApiArgs(method, path, opts, this.onResponse !== undefined);
    const input = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    let res = this.run(args, input);
    // 古い gh はこのフラグを知らずに止まる（制御文字でも止めない版なので、除いて1回だけやり直せば今までどおり読める）
    if (res.status !== 0 && opts.raw && isUnknownEscapeFlagError(res.stderr)) res = this.run(withoutEscapeFlag(args), input);
    let stdout = res.stdout;
    if (this.onResponse) {
      const parsed = parseGhInclude(stdout);
      if (parsed.info) this.onResponse(parsed.info);
      stdout = parsed.body;
    }
    if (res.status !== 0) {
      const stderr = res.stderr;
      const status = Number(stderr.match(/HTTP (\d{3})/)?.[1] ?? 0);
      if (status === 404 && opts.allow404) return null;
      throw new HttpError(status, `gh api ${method} ${path} failed: ${stderr.slice(0, 500)}`);
    }
    if (opts.raw) return stdout;
    return stdout.trim() === '' ? null : JSON.parse(stdout);
  }
}

export class GitHub {
  readonly owner: string;
  readonly repo: string;
  private readonly transport: Transport;

  constructor(transport: Transport, repository: string) {
    const [owner, repo] = repository.split('/');
    if (!owner || !repo) throw new Error(`invalid repository: ${repository}`);
    this.transport = transport;
    this.owner = owner;
    this.repo = repo;
  }

  get repoPath(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  request<T = any>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const full = path.startsWith('/repos/') || path.startsWith('/graphql') || path.startsWith('http') || path.startsWith('/app') || path.startsWith('/user') ? path : `${this.repoPath}${path}`;
    return this.transport.request(method, full, opts) as Promise<T>;
  }

  get<T = any>(path: string, opts?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, opts);
  }

  /** ページを最後まで読む（per_page=100） */
  async paginate<T = any>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.get<T[] | { items?: T[]; check_runs?: T[] }>(`${path}${sep}per_page=100&page=${page}`);
      const list: T[] = Array.isArray(items) ? items : (items.items ?? items.check_runs ?? []);
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.transport.request('POST', '/graphql', { body: { query, variables } }) as { data?: T; errors?: { message: string }[] };
    if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join('; ')}`);
    return res.data as T;
  }

  // --- よく使う操作 ---

  addLabels(issue: number, labels: string[]): Promise<unknown> {
    return this.request('POST', `/issues/${issue}/labels`, { body: { labels } });
  }

  async removeLabel(issue: number, label: string): Promise<void> {
    await this.request('DELETE', `/issues/${issue}/labels/${encodeURIComponent(label)}`, { allow404: true });
  }

  comment(issue: number, body: string): Promise<{ id: number; html_url: string }> {
    return this.request('POST', `/issues/${issue}/comments`, { body: { body } });
  }

  listComments(issue: number): Promise<IssueComment[]> {
    return this.paginate<IssueComment>(`/issues/${issue}/comments`);
  }

  /** PR が base に対して加えた変更（3点比較）の diff */
  compareDiff(base: string, head: string): Promise<string> {
    return this.request<string>('GET', `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      accept: 'application/vnd.github.diff',
      raw: true,
    });
  }
}

export interface IssueComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  author_association: string;
  user: { login: string; type: string } | null;
}

/** opts（onResponse）は選んだ Transport に渡す。渡さなければ今までと同じ */
export function transportFromEnv(opts: TransportOptions = {}): Transport {
  const token = process.env.GH_APP_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) return new FetchTransport(token, process.env.GITHUB_API_URL ?? 'https://api.github.com', opts);
  return new GhTransport(opts);
}
