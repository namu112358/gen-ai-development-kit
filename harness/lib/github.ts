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
  constructor(token: string, baseUrl = 'https://api.github.com') {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: opts.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'gen-ai-development-kit-gate',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method, headers, body });
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

export class GhTransport implements Transport {
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const args = ['api', '--method', method, path.replace(/^\//, ''), '-H', `Accept: ${opts.accept ?? 'application/vnd.github+json'}`];
    let input: string | undefined;
    if (opts.body !== undefined) {
      args.push('--input', '-');
      input = JSON.stringify(opts.body);
    }
    const res = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (res.status !== 0) {
      const stderr = res.stderr ?? '';
      const status = Number(stderr.match(/HTTP (\d{3})/)?.[1] ?? 0);
      if (status === 404 && opts.allow404) return null;
      throw new HttpError(status, `gh api ${method} ${path} failed: ${stderr.slice(0, 500)}`);
    }
    if (opts.raw) return res.stdout;
    return res.stdout.trim() === '' ? null : JSON.parse(res.stdout);
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

export function transportFromEnv(): Transport {
  const token = process.env.GH_APP_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token) return new FetchTransport(token, process.env.GITHUB_API_URL ?? 'https://api.github.com');
  return new GhTransport();
}
