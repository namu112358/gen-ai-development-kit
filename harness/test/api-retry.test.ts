// #715：GitHub API の上限の分類（classifyRateLimit）と FetchTransport・graphql() のやり直し（短時間の上限と 502・503・504 は full jitter で待ってやり直し、core の上限は RateLimitError で止まる）を確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FetchTransport,
  GitHub,
  HttpError,
  RateLimitError,
  classifyRateLimit,
} from '../lib/github.ts';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const RESET_EPOCH = 1791676800;
const RESET_ISO = new Date(RESET_EPOCH * 1000).toISOString();
const R = 0.5;

type Reply = { status: number; headers?: Record<string, string>; body?: string };
type Call = { url: string; method: string; body: string | undefined };

/** 決めた順に応答を返し、呼ばれた要求を残す fetch */
function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body as string | undefined });
    const r = replies[calls.length - 1];
    if (!r) throw new Error(`fetch が想定より多く呼ばれた（${calls.length} 回目）`);
    return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** fetch と待ち・乱数・時刻を差し替えた FetchTransport */
function transport(replies: Reply[], onResponse?: (i: { status: number }) => void) {
  const { fetch, calls } = fakeFetch(replies);
  const sleeps: number[] = [];
  const t = new FetchTransport('t', 'https://api.example', {
    fetch,
    onResponse,
    retry: { sleep: async (ms) => { sleeps.push(ms); }, random: () => R, now: () => NOW },
  });
  return { t, calls, sleeps };
}

/** full jitter の乱数の分（random × min(capMs, baseMs × 2^attempt)、既定 base 1000・cap 30000） */
const jitter = (attempt: number) => Math.floor(R * Math.min(30000, 1000 * 2 ** attempt));

const OK: Reply = { status: 200, body: '{"ok":true}' };
const PRIMARY_HEADERS = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_EPOCH), 'x-ratelimit-resource': 'core' };

// ---- classifyRateLimit ----

test('classifyRateLimit：Requirements の分岐ごとの分類', () => {
  const cases: [number, Record<string, string>, string, 'primary' | 'secondary' | null][] = [
    [403, { 'x-ratelimit-remaining': '0' }, '', 'primary'],
    [429, { 'x-ratelimit-remaining': '0' }, '', 'primary'],
    [403, {}, 'gh: API rate limit exceeded for user ID 1. (HTTP 403)', 'primary'],
    [403, {}, 'api rate limit EXCEEDED', 'primary'],
    [429, {}, '', 'secondary'],
    [403, { 'retry-after': '60' }, '', 'secondary'],
    [403, { 'x-ratelimit-remaining': '10' }, 'You have exceeded a secondary rate limit', 'secondary'],
    [403, {}, 'You have exceeded a Secondary Rate Limit', 'secondary'],
    [403, { 'x-ratelimit-remaining': '10' }, '{"message":"Resource not accessible by integration"}', null],
    [403, {}, '', null],
    [500, { 'x-ratelimit-remaining': '0' }, 'API rate limit exceeded', null],
    [502, { 'retry-after': '5' }, '', null],
    [200, { 'x-ratelimit-remaining': '0' }, '', null],
  ];
  for (const [status, headers, text, want] of cases) {
    assert.equal(classifyRateLimit(status, headers, text), want, JSON.stringify({ status, headers, text }));
  }
});

// ---- AC1：短時間の上限と 502・503・504 ----

test('secondary：Retry-After（無ければ 60 秒）より短くない full jitter で待ってやり直し、onResponse は各回に呼ぶ', async () => {
  const cases: [string, Reply, number][] = [
    ['429 + Retry-After: 5', { status: 429, headers: { 'retry-after': '5' } }, 5000],
    ['403 + secondary rate limit の本文（Retry-After 無し）', { status: 403, body: '{"message":"You have exceeded a secondary rate limit."}' }, 60000],
  ];
  for (const [name, first, floor] of cases) {
    const seen: number[] = [];
    const { t, calls, sleeps } = transport([first, OK], (i) => seen.push(i.status));
    assert.deepEqual(await t.request('GET', '/repos/o/r/pulls/3'), { ok: true }, name);
    assert.equal(calls.length, 2, name);
    assert.deepEqual(sleeps, [floor + jitter(0)], name);
    assert.deepEqual(seen, [first.status, 200], name);
  }
});

test('5xx：GET の 502・503・504 は待ってやり直し、Retry-After があればそれより短くしない', async () => {
  const cases: [Reply, number][] = [
    [{ status: 502 }, 0],
    [{ status: 503 }, 0],
    [{ status: 504 }, 0],
    [{ status: 503, headers: { 'retry-after': '3' } }, 3000],
  ];
  for (const [first, floor] of cases) {
    const name = JSON.stringify(first);
    const { t, calls, sleeps } = transport([first, OK]);
    assert.deepEqual(await t.request('GET', '/repos/o/r/pulls/3'), { ok: true }, name);
    assert.equal(calls.length, 2, name);
    assert.deepEqual(sleeps, [floor + jitter(0)], name);
  }
});

test('上限の回数：やり直しは既定3回（4回送る）で止まり、5xx は HttpError、secondary は RateLimitError', async () => {
  {
    const { t, calls, sleeps } = transport(Array.from({ length: 4 }, () => ({ status: 503 })));
    await assert.rejects(
      () => t.request('GET', '/repos/o/r/pulls/3'),
      (e: unknown) => e instanceof HttpError && !(e instanceof RateLimitError) && e.status === 503,
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [jitter(0), jitter(1), jitter(2)]);
  }
  {
    const { t, calls, sleeps } = transport(Array.from({ length: 4 }, () => ({ status: 429, headers: { 'retry-after': '1' } })));
    await assert.rejects(
      () => t.request('GET', '/repos/o/r/pulls/3'),
      (e: unknown) => e instanceof RateLimitError && e.kind === 'secondary' && e.status === 429,
    );
    assert.equal(calls.length, 4);
    assert.deepEqual(sleeps, [1000 + jitter(0), 1000 + jitter(1), 1000 + jitter(2)]);
  }
});

test('maxWaitMs：1回の待ちが 120000ms を超えるなら待たずに RateLimitError（resetAt は now + Retry-After）', async () => {
  const { t, calls, sleeps } = transport([{ status: 429, headers: { 'retry-after': '200' } }]);
  const resetAt = new Date(NOW + 200_000).toISOString();
  await assert.rejects(
    () => t.request('GET', '/repos/o/r/pulls/3'),
    (e: unknown) => e instanceof RateLimitError && e.kind === 'secondary' && e.resetAt === resetAt && e.message.includes(resetAt),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

// ---- AC2：書き込み ----

test('書き込み（POST・PATCH・mutation の /graphql）は 502 で1回だけ送り、query の /graphql はやり直す', async () => {
  const writes: [string, string, unknown][] = [
    ['POST', '/repos/o/r/issues/1/comments', { body: 'x' }],
    ['PATCH', '/repos/o/r/issues/comments/9', { body: 'x' }],
    ['POST', '/graphql', { query: 'mutation { addComment(input: {}) { clientMutationId } }', variables: {} }],
    ['POST', '/graphql', { query: '# note\n  mutation M { x }', variables: {} }],
  ];
  for (const [method, path, body] of writes) {
    const name = `${method} ${path} ${JSON.stringify(body)}`;
    const { t, calls, sleeps } = transport([{ status: 502 }, OK]);
    await assert.rejects(() => t.request(method, path, { body }), (e: unknown) => e instanceof HttpError && e.status === 502, name);
    assert.equal(calls.length, 1, name);
    assert.deepEqual(sleeps, [], name);
  }
  {
    const { t, calls } = transport([{ status: 502 }, { status: 200, body: '{"data":{"a":1}}' }]);
    assert.deepEqual(await t.request('POST', '/graphql', { body: { query: 'query { a }', variables: {} } }), { data: { a: 1 } });
    assert.equal(calls.length, 2);
  }
});

test('書き込みでも短時間の上限（POST の 429 + Retry-After）はやり直す', async () => {
  const { t, calls, sleeps } = transport([{ status: 429, headers: { 'retry-after': '2' } }, { status: 201, body: '{"id":1}' }]);
  assert.deepEqual(await t.request('POST', '/repos/o/r/issues/1/comments', { body: { body: 'x' } }), { id: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, 'POST');
  assert.equal(calls[1]!.body, calls[0]!.body);
  assert.deepEqual(sleeps, [2000 + jitter(0)]);
});

// ---- AC3：core の上限・ほかの 403 ----

test('primary：compareDiff とチェックの作成は1回だけ送り、リセットの時刻を含む RateLimitError', async () => {
  const routes: [string, (gh: GitHub) => Promise<unknown>][] = [
    ['compareDiff', (gh) => gh.compareDiff('main', 'feature')],
    ['POST /check-runs', (gh) => gh.request('POST', '/check-runs', { body: { name: 'gate', head_sha: 'a'.repeat(40) } })],
  ];
  for (const [name, call] of routes) {
    const { t, calls, sleeps } = transport([{ status: 403, headers: PRIMARY_HEADERS, body: '{"message":"API rate limit exceeded"}' }, OK]);
    await assert.rejects(
      () => call(new GitHub(t, 'o/r')),
      (e: unknown) =>
        e instanceof RateLimitError && e instanceof HttpError && e.status === 403 && e.kind === 'primary' &&
        e.resource === 'core' && e.resetAt === RESET_ISO && e.message.includes(RESET_ISO),
      name,
    );
    assert.equal(calls.length, 1, name);
    assert.deepEqual(sleeps, [], name);
  }
});

test('ほかの 403（Resource not accessible by integration）は RateLimitError にせず、やり直さない', async () => {
  for (const method of ['GET', 'POST']) {
    const { t, calls, sleeps } = transport([
      { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, body: '{"message":"Resource not accessible by integration"}' },
      OK,
    ]);
    await assert.rejects(
      () => t.request(method, '/repos/o/r/check-runs', method === 'POST' ? { body: { name: 'x' } } : {}),
      (e: unknown) => e instanceof HttpError && !(e instanceof RateLimitError) && e.status === 403,
      method,
    );
    assert.equal(calls.length, 1, method);
    assert.deepEqual(sleeps, [], method);
  }
});

test('graphql()：errors[].type が RATE_LIMITED なら RateLimitError（primary・resource graphql・status 200）、ほかの errors は RateLimitError にしない', async () => {
  {
    const { t, calls } = transport([{ status: 200, body: JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for installation ID 1.' }] }) }]);
    await assert.rejects(
      () => new GitHub(t, 'o/r').graphql('query { viewer { login } }'),
      (e: unknown) =>
        e instanceof RateLimitError && e.kind === 'primary' && e.resource === 'graphql' && e.status === 200 && e.message.startsWith('GraphQL:'),
    );
    assert.equal(calls.length, 1);
  }
  {
    const { t } = transport([{ status: 200, body: JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }) }]);
    await assert.rejects(
      () => new GitHub(t, 'o/r').graphql('query { viewer { login } }'),
      (e: unknown) => e instanceof Error && !(e instanceof RateLimitError) && e.message.startsWith('GraphQL:'),
    );
  }
});
