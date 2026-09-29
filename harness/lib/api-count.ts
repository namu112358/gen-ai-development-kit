import type { RequestOptions, ResponseInfo, ResponseObserver, Transport } from './github.ts';

/**
 * GitHub API の呼び出しの回数を、メソッドとパスの形（番号などを伏せたもの）ごとに数える（#247）。
 * 環境変数 AGENT_HARNESS_API_COUNT を付けたときだけ agent.ts が組み立て、終わりに要約を標準エラーに出す。
 * 付けないときは使わない（Transport も gh api の引数も今と同じ）。
 */

export const API_COUNT_ENV = 'AGENT_HARNESS_API_COUNT';

/** この区切りより後ろ（ラベル名・ブランチ名・ref・ファイルのパス・比較の範囲）は1つの :x にまとめる */
const COLLAPSE_AFTER = ['compare', 'labels', 'branches', 'contents', 'git/ref', 'git/refs'];

/** GraphQL の本文の query が mutation か（先頭の空白と # のコメントを飛ばして見る） */
function isMutation(query: string): boolean {
  const rest = query.replace(/^(?:\s|#[^\n]*)*/, '');
  return /^mutation\b/.test(rest);
}

/** `<メソッド> <パスの形>`。番号は :n、40 桁の SHA は :sha、owner/repo は :owner/:repo にする */
export function pathShape(method: string, path: string, body?: unknown): string {
  const m = method.toUpperCase();
  let p = path.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (p === '/graphql') {
    const query = (body as { query?: unknown } | undefined)?.query;
    if (typeof query !== 'string') return `${m} /graphql`;
    return `${m} /graphql (${isMutation(query) ? 'mutation' : 'query'})`;
  }
  const segs = p.split('/').slice(1);
  const out: string[] = [];
  let i = 0;
  if (segs[0] === 'repos' && segs.length >= 3) {
    out.push('repos', ':owner', ':repo');
    i = 3;
  }
  for (; i < segs.length; i++) {
    const s = segs[i]!;
    if (/^\d+$/.test(s)) out.push(':n');
    else if (/^[0-9a-f]{40}$/i.test(s)) out.push(':sha');
    else out.push(s);
    const collapse = COLLAPSE_AFTER.includes(s) || COLLAPSE_AFTER.includes(`${segs[i - 1] ?? ''}/${s}`);
    if (collapse && i + 1 < segs.length) {
      out.push(':x');
      break;
    }
  }
  return `${m} /${out.join('/')}`;
}

interface RateLimit {
  remaining: string;
  used: string;
  limit: string;
}

export class ApiCounter {
  private readonly shapes = new Map<string, number>();
  private readonly limits = new Map<string, RateLimit>();
  private calls = 0;
  private seen = 0;

  record(method: string, path: string, opts?: RequestOptions): void {
    const shape = pathShape(method, path, opts?.body);
    this.shapes.set(shape, (this.shapes.get(shape) ?? 0) + 1);
    this.calls++;
  }

  /** 応答のヘッダーを覚える。this を外して Transport に渡せるようにアロー関数にする */
  readonly observe: ResponseObserver = (info: ResponseInfo): void => {
    this.seen++;
    const h = info.headers;
    const remaining = h['x-ratelimit-remaining'];
    if (remaining === undefined) return;
    this.limits.set(h['x-ratelimit-resource'] ?? 'unknown', {
      remaining,
      used: h['x-ratelimit-used'] ?? '?',
      limit: h['x-ratelimit-limit'] ?? '?',
    });
  };

  get total(): number {
    return this.calls;
  }

  get responses(): number {
    return this.seen;
  }

  summary(command: string): string {
    const lines = [`[api-count] ${command}: 計 ${this.calls} 回（HTTP の応答 ${this.seen} 回）`];
    for (const [resource, l] of [...this.limits].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`[api-count]   ${resource}: remaining ${l.remaining} / used ${l.used} / limit ${l.limit}`);
    }
    const shapes = [...this.shapes].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
    for (const [shape, n] of shapes) lines.push(`[api-count]   ${n}  ${shape}`);
    return `${lines.join('\n')}\n`;
  }
}

/** 包んだ Transport に渡す前に1回数える。失敗・404 でも数え、戻り値と例外はそのまま返す */
export class CountingTransport implements Transport {
  private readonly inner: Transport;
  private readonly counter: ApiCounter;
  constructor(inner: Transport, counter: ApiCounter) {
    this.inner = inner;
    this.counter = counter;
  }

  request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
    this.counter.record(method, path, opts);
    return this.inner.request(method, path, opts);
  }
}

/** AGENT_HARNESS_API_COUNT が未設定・空・0 なら null（数えない） */
export function apiCountFromEnv(env: Record<string, string | undefined>): ApiCounter | null {
  const v = env[API_COUNT_ENV];
  if (v === undefined || v === '' || v === '0') return null;
  return new ApiCounter();
}
