/**
 * GitHub API の上限の残りを応答から読み、下限を切ったらリセットまで送らない。
 * 読み取り用の Transport（ReadOnlyTransport の内側に使う）と、UpdateWatcher に渡す fetch の包み。
 */
import { HttpError, type RequestOptions, type Transport } from '../../lib/github.ts';
import type { FetchLike } from './github.ts';

export interface HeadersLike {
  get(name: string): string | null;
}

export interface RateLimitInfo {
  resource: string;
  remaining: number;
  limit: number;
  /** ms の epoch */
  resetAt: number;
}

/** 上限の残りが下限を切っているので送らなかった */
export class RateLimitPaused extends Error {
  readonly until: number;
  readonly resource: string;
  constructor(until: number, resource: string) {
    super(`GitHub API の上限（${resource}）の残りが少ないため、${new Date(until).toISOString()} まで読みません`);
    this.until = until;
    this.resource = resource;
  }
}

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 資源（core・graphql・search など）ごとの残りとリセットの時刻 */
export class RateLimitState {
  readonly minRemaining: number;
  private readonly now: () => number;
  private readonly limits = new Map<string, RateLimitInfo>();
  private notBefore: number | null = null;

  constructor(opts: { minRemaining?: number; now?: () => number } = {}) {
    this.minRemaining = opts.minRemaining ?? 0.3;
    this.now = opts.now ?? Date.now;
  }

  observeHeaders(headers: HeadersLike): void {
    const remaining = num(headers.get('x-ratelimit-remaining'));
    const limit = num(headers.get('x-ratelimit-limit'));
    const reset = num(headers.get('x-ratelimit-reset'));
    if (remaining === null || limit === null || reset === null) return;
    const resource = headers.get('x-ratelimit-resource')?.trim() || 'core';
    this.limits.set(resource, { resource, remaining, limit, resetAt: reset * 1000 });
  }

  /** GraphQL の応答の data.rateLimit（問い合わせが求めたときだけ返る） */
  observeGraphql(body: unknown): void {
    const r = (body as { data?: { rateLimit?: { remaining?: unknown; limit?: unknown; resetAt?: unknown } } } | null)?.data?.rateLimit;
    if (!r || typeof r.remaining !== 'number' || typeof r.limit !== 'number' || typeof r.resetAt !== 'string') return;
    const resetAt = Date.parse(r.resetAt);
    if (!Number.isFinite(resetAt)) return;
    this.limits.set('graphql', { resource: 'graphql', remaining: r.remaining, limit: r.limit, resetAt });
  }

  /** 403・429 の応答から「これより早く読まない時刻」を覚える（Retry-After、無ければ残り0のときのリセット） */
  observeFailure(status: number, headers: HeadersLike): void {
    if (status !== 403 && status !== 429) return;
    this.observeHeaders(headers);
    const retryAfter = num(headers.get('retry-after'));
    if (retryAfter !== null) {
      this.notBefore = this.now() + retryAfter * 1000;
      return;
    }
    const reset = num(headers.get('x-ratelimit-reset'));
    if (num(headers.get('x-ratelimit-remaining')) === 0 && reset !== null) this.notBefore = reset * 1000;
  }

  pausedUntil(): { until: number; resource: string } | null {
    const now = this.now();
    let out: { until: number; resource: string } | null = null;
    for (const l of this.limits.values()) {
      if (l.limit <= 0 || l.resetAt <= now || l.remaining / l.limit >= this.minRemaining) continue;
      if (!out || l.resetAt > out.until) out = { until: l.resetAt, resource: l.resource };
    }
    return out;
  }

  retryNotBefore(): number | null {
    return this.notBefore !== null && this.notBefore > this.now() ? this.notBefore : null;
  }

  resources(): RateLimitInfo[] {
    return [...this.limits.values()];
  }

  /** 止めている間は送らない */
  assertOpen(): void {
    const p = this.pausedUntil();
    if (p) throw new RateLimitPaused(p.until, p.resource);
  }
}

export interface FetchResponse {
  status: number;
  headers: HeadersLike;
  text(): Promise<string>;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<FetchResponse>;

/** FetchTransport と同じ要求を送り、上限を読む。やり直しはしない（遅らせ方は scheduler.ts が決める） */
export class RateLimitedTransport implements Transport {
  private readonly fetch: FetchFn;
  private readonly token: string;
  private readonly state: RateLimitState;
  private readonly baseUrl: string;

  constructor(opts: { fetch: FetchFn; token: string; state: RateLimitState; baseUrl?: string }) {
    this.fetch = opts.fetch;
    this.token = opts.token;
    this.state = opts.state;
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com';
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    this.state.assertOpen();
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: opts.accept ?? 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'agent-harness-dashboard',
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetch(url, body === undefined ? { method, headers } : { method, headers, body });
    this.state.observeHeaders(res.headers);
    if (res.status === 404 && opts.allow404) return null;
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      this.state.observeFailure(res.status, res.headers);
      throw new HttpError(res.status, `${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    }
    if (opts.raw) return text;
    if (text === '') return null;
    const parsed: unknown = JSON.parse(text);
    if (/^\/?graphql$/.test(path) || /\/graphql$/.test(url)) this.state.observeGraphql(parsed);
    return parsed;
  }
}

/** UpdateWatcher に渡す fetch を包む。止めている間は送らず、応答の上限を同じ状態に読む */
export function limitFetch(fetch: FetchLike, state: RateLimitState): FetchLike {
  return async (url, init) => {
    state.assertOpen();
    const res = await fetch(url, init);
    state.observeHeaders(res.headers);
    state.observeFailure(res.status, res.headers);
    return res;
  };
}
