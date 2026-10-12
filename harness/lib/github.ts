import { spawnSync } from 'node:child_process';
import { isMutation } from './api-count.ts';
import { backoffDelayMs, retryAfterMs } from './backoff.ts';

/**
 * GitHub REST / GraphQL の最小クライアント。
 * - Actions：App のトークンで fetch（FetchTransport）
 * - 手元：`gh api`（GhTransport）
 * - クラウドのセッション（CLAUDE_CODE_REMOTE=true）：`GITHUB_TOKEN` があっても `gh api`（GhTransport）。クラウドの `GITHUB_TOKEN` は GitHub proxy が送信時に本物へ差し替える仮の値で、Node の fetch は proxy を通らず 401 になる
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

/** やり直しの設定。どれも省略でき、省略した値は既定（retries 3・baseMs 1000・capMs 30000・maxWaitMs 120000） */
export interface RetryOptions {
  /** 最初の送信に足してやり直す回数 */
  retries?: number;
  baseMs?: number;
  capMs?: number;
  /** 1回の待ちがこれを超えるなら待たずに失敗にする */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface TransportOptions {
  /** 応答ごとに呼ぶ（FetchTransport はやり直しの各回も）。GhTransport は、あるときだけ gh api に --include を付ける */
  onResponse?: ResponseObserver;
  /** 上限・502・503・504 のやり直しの設定 */
  retry?: RetryOptions;
  /** FetchTransport が使う fetch。無ければ送るときの globalThis.fetch */
  fetch?: typeof fetch;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type RateLimitKind = 'primary' | 'secondary';

/** 上限（primary: core などの時間あたりの上限、secondary: 短時間の上限）で止まった失敗。HttpError として読める */
export class RateLimitError extends HttpError {
  readonly kind: RateLimitKind;
  readonly resource: string | null;
  readonly resetAt: string | null;
  constructor(status: number, message: string, init: { kind: RateLimitKind; resource: string | null; resetAt: string | null }) {
    const label = init.kind === 'primary' ? 'リセット' : '次に送れる時刻';
    super(status, `${message} (${label} ${init.resetAt ?? '不明'})`);
    this.kind = init.kind;
    this.resource = init.resource;
    this.resetAt = init.resetAt;
  }
}

/** 403・429 の失敗が上限によるものか。ヘッダー名は小文字。上限でなければ null */
export function classifyRateLimit(status: number, headers: Record<string, string>, text: string): RateLimitKind | null {
  if (status !== 403 && status !== 429) return null;
  const remaining = headers['x-ratelimit-remaining'];
  if (remaining !== undefined ? remaining.trim() === '0' : /API rate limit exceeded/i.test(text)) return 'primary';
  if (status === 429 || headers['retry-after'] !== undefined || /secondary rate limit/i.test(text)) return 'secondary';
  return null;
}

interface SentResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** 失敗のときの HttpError のメッセージ（無ければ `<method> <path> -> <status>: <text>`） */
  message?: string;
}

const RETRY_DEFAULTS = { retries: 3, baseMs: 1000, capMs: 30000, maxWaitMs: 120000, secondaryFloorMs: 60000 };

/** 読み取りか（GET と、mutation でない /graphql の POST）。書き込みは 5xx でやり直さない */
function isReadRequest(method: string, path: string, opts: RequestOptions): boolean {
  const m = method.toUpperCase();
  if (m === 'GET') return true;
  if (m !== 'POST') return false;
  if (path.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '') !== '/graphql') return false;
  const query = (opts.body as { query?: unknown } | undefined)?.query;
  return typeof query === 'string' && !isMutation(query);
}

function epochToIso(value: string | undefined): string | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  return new Date(Number(value) * 1000).toISOString();
}

/**
 * 1回送る関数 send を、上限と 502・503・504 のやり直しで包む。成功（2xx）は応答を返し、404 + allow404 は null を返す。
 * primary はやり直さず RateLimitError。secondary は読み書きとも待ってやり直す。502・503・504 は読み取りだけ。ほかの失敗は HttpError
 */
async function sendWithRetry(
  method: string,
  path: string,
  opts: RequestOptions,
  retry: RetryOptions | undefined,
  send: () => Promise<SentResponse>,
  primaryResetAt?: () => Promise<string | null>,
): Promise<SentResponse | null> {
  const retries = retry?.retries ?? RETRY_DEFAULTS.retries;
  const baseMs = retry?.baseMs ?? RETRY_DEFAULTS.baseMs;
  const capMs = retry?.capMs ?? RETRY_DEFAULTS.capMs;
  const maxWaitMs = retry?.maxWaitMs ?? RETRY_DEFAULTS.maxWaitMs;
  const sleep = retry?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = retry?.random ?? Math.random;
  const now = retry?.now ?? Date.now;
  const read = isReadRequest(method, path, opts);
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if (res.status >= 200 && res.status < 300) return res;
    if (res.status === 404 && opts.allow404) return null;
    const message = res.message ?? `${method} ${path} -> ${res.status}: ${res.text.slice(0, 500)}`;
    const kind = classifyRateLimit(res.status, res.headers, res.text);
    const resource = res.headers['x-ratelimit-resource'] ?? null;
    if (kind === 'primary') {
      const resetAt = epochToIso(res.headers['x-ratelimit-reset']) ?? (primaryResetAt ? await primaryResetAt() : null);
      throw new RateLimitError(res.status, message, { kind, resource, resetAt });
    }
    const secondary = kind === 'secondary';
    if (!secondary && !(read && (res.status === 502 || res.status === 503 || res.status === 504))) throw new HttpError(res.status, message);
    const floorMs = retryAfterMs(res.headers['retry-after'], now()) ?? (secondary ? RETRY_DEFAULTS.secondaryFloorMs : 0);
    const fail = (): HttpError =>
      secondary
        ? new RateLimitError(res.status, message, { kind: 'secondary', resource, resetAt: new Date(now() + floorMs).toISOString() })
        : new HttpError(res.status, message);
    if (attempt >= retries) throw fail();
    const wait = backoffDelayMs(attempt, { baseMs, capMs, floorMs, random });
    if (wait > maxWaitMs) throw fail();
    await sleep(wait);
  }
}

export class FetchTransport implements Transport {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly onResponse: ResponseObserver | undefined;
  private readonly opts: TransportOptions;
  constructor(token: string, baseUrl = 'https://api.github.com', opts: TransportOptions = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.onResponse = opts.onResponse;
    this.opts = opts;
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
    const res = await sendWithRetry(method, path, opts, this.opts.retry, async () => {
      const doFetch = this.opts.fetch ?? globalThis.fetch;
      const r = await doFetch(url, { method, headers, body });
      const seen: Record<string, string> = {};
      r.headers.forEach((value, name) => { seen[name.toLowerCase()] = value; });
      this.onResponse?.({ status: r.status, headers: seen });
      return { status: r.status, headers: seen, text: await r.text() };
    });
    if (res === null) return null;
    if (opts.raw) return res.text;
    return res.text === '' ? null : JSON.parse(res.text);
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
  private readonly retry: RetryOptions | undefined;
  constructor(opts: TransportOptions = {}, run: GhRunner = spawnGh) {
    this.onResponse = opts.onResponse;
    this.retry = opts.retry;
    this.run = run;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    let args = ghApiArgs(method, path, opts, this.onResponse !== undefined);
    const input = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const res = await sendWithRetry(method, path, opts, this.retry, async () => {
      let r = this.run(args, input);
      // 古い gh はこのフラグを知らずに止まる（制御文字でも止めない版なので、除いてやり直せば今までどおり読める）。一度除いたら以降の回も除く
      if (r.status !== 0 && opts.raw && isUnknownEscapeFlagError(r.stderr)) {
        args = withoutEscapeFlag(args);
        r = this.run(args, input);
      }
      let stdout = r.stdout;
      let info: ResponseInfo | null = null;
      if (this.onResponse) {
        const parsed = parseGhInclude(stdout);
        info = parsed.info;
        if (info) this.onResponse(info);
        stdout = parsed.body;
      }
      if (r.status === 0) return { status: 200, headers: info?.headers ?? {}, text: stdout };
      const stderr = r.stderr;
      const status = info?.status || Number(stderr.match(/HTTP (\d{3})/)?.[1] ?? 0);
      return { status, headers: info?.headers ?? {}, text: `${stdout}${stderr}`, message: `gh api ${method} ${path} failed: ${stderr.slice(0, 500)}` };
    }, async () => {
      const r = this.run(['api', 'rate_limit'], undefined);
      if (r.status !== 0) return null;
      try {
        const reset = (JSON.parse(r.stdout) as { resources?: { core?: { reset?: unknown } } }).resources?.core?.reset;
        return typeof reset === 'number' ? new Date(reset * 1000).toISOString() : null;
      } catch {
        return null;
      }
    });
    if (res === null) return null;
    if (opts.raw) return res.text;
    return res.text.trim() === '' ? null : JSON.parse(res.text);
  }
}

export class GitHub {
  readonly owner: string;
  readonly repo: string;
  private readonly transport: Transport;
  /** true なら GraphQL を使わず REST だけで読む（クラウドのセッション。graphqlUnavailable）。既定は偽で、GraphQL の経路は変わらない */
  restOnly = false;

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
    const full = path.startsWith('/repos/') || path.startsWith('/graphql') || path.startsWith('http') || path.startsWith('/app') || path.startsWith('/user') || path.startsWith('/search/') ? path : `${this.repoPath}${path}`;
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
    const res = await this.transport.request('POST', '/graphql', { body: { query, variables } }) as { data?: T; errors?: { message: string; type?: string }[] };
    if (res.errors?.length) {
      const message = `GraphQL: ${res.errors.map((e) => e.message).join('; ')}`;
      if (res.errors.some((e) => e.type === 'RATE_LIMITED')) throw new RateLimitError(200, message, { kind: 'primary', resource: 'graphql', resetAt: null });
      throw new Error(message);
    }
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

  /** 自分のコメントの本文を書き換える（着手宣言の段階の更新。Issue #656） */
  editComment(commentId: number, body: string): Promise<{ id: number; html_url: string }> {
    return this.request('PATCH', `/issues/comments/${commentId}`, { body: { body } });
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

/** GraphQL の読みが使えない環境か（クラウドのセッション CLAUDE_CODE_REMOTE=true。GitHub が GraphQL に 403 を返す）。env は既定で process.env */
export function graphqlUnavailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === 'true';
}

/**
 * opts（onResponse）は選んだ Transport に渡す。渡さなければ今までと同じ。
 * env は既定で process.env（テストで差し替える）。クラウドのセッション（CLAUDE_CODE_REMOTE=true）ではトークンの有無にかかわらず gh api（GITHUB_TOKEN は proxy 用の仮の値で、fetch では 401 になる）
 */
export function transportFromEnv(opts: TransportOptions = {}, env: NodeJS.ProcessEnv = process.env): Transport {
  if (env.CLAUDE_CODE_REMOTE === 'true') return new GhTransport(opts);
  const token = env.GH_APP_TOKEN ?? env.GITHUB_TOKEN;
  if (token) return new FetchTransport(token, env.GITHUB_API_URL ?? 'https://api.github.com', opts);
  return new GhTransport(opts);
}
