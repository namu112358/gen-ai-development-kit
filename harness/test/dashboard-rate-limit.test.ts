// Issue #278：ダッシュボードの GitHub API の上限（X-RateLimit-*・GraphQL の rateLimit・Retry-After）を見て、下限を切ったらリセットまで読まないこと
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../lib/github.ts';
import { UpdateWatcher, type FetchLike } from '../scripts/dashboard/github.ts';
import {
  limitFetch, RateLimitedTransport, RateLimitPaused, RateLimitState,
  type FetchFn, type FetchResponse, type HeadersLike,
} from '../scripts/dashboard/rate-limit.ts';

const T0 = 1_800_000_000_000;
const RESET_S = T0 / 1000 + 600; // 10 分後（epoch 秒）

const hdrs = (h: Record<string, string>): HeadersLike => {
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
};
const limitHeaders = (remaining: number, limit = 5000, reset = RESET_S, resource?: string): Record<string, string> => ({
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-limit': String(limit),
  'x-ratelimit-reset': String(reset),
  ...(resource ? { 'x-ratelimit-resource': resource } : {}),
});

function clock(start = T0): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v) => { t = v; } };
}

interface Reply { status: number; headers?: Record<string, string>; body?: string }
interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
function fakeFetch(replies: Reply[]): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const r = replies.shift();
    assert.ok(r, '想定より多く問い合わせた');
    const res: FetchResponse = { status: r.status, headers: hdrs(r.headers ?? {}), text: async () => r.body ?? '' };
    return res;
  };
  return { fetch, calls };
}

// --- RateLimitState ---

test('RateLimitState：minRemaining の既定は 0.3', () => {
  assert.equal(new RateLimitState().minRemaining, 0.3);
  assert.equal(new RateLimitState({ minRemaining: 0.5 }).minRemaining, 0.5);
});

test('RateLimitState.observeHeaders：残りが下限を切ると、リセットの時刻まで pausedUntil を返す（Resource が無ければ core）', () => {
  const c = clock();
  const s = new RateLimitState({ now: c.now });
  assert.equal(s.pausedUntil(), null);
  s.observeHeaders(hdrs(limitHeaders(2000))); // 0.4
  assert.equal(s.pausedUntil(), null, '下限より上なら止めない');
  s.observeHeaders(hdrs(limitHeaders(1000))); // 0.2
  assert.deepEqual(s.pausedUntil(), { until: RESET_S * 1000, resource: 'core' });
  c.set(RESET_S * 1000 - 1);
  assert.deepEqual(s.pausedUntil(), { until: RESET_S * 1000, resource: 'core' });
  c.set(RESET_S * 1000 + 1);
  assert.equal(s.pausedUntil(), null, 'リセットを過ぎたら読む');
});

test('RateLimitState.observeHeaders：minRemaining を変えると、その割合で止める', () => {
  const s = new RateLimitState({ minRemaining: 0.5, now: () => T0 });
  s.observeHeaders(hdrs(limitHeaders(2000))); // 0.4 < 0.5
  assert.deepEqual(s.pausedUntil(), { until: RESET_S * 1000, resource: 'core' });
});

test('RateLimitState.observeHeaders：X-RateLimit-Resource: graphql のヘッダーだけでも graphql の資源で止まる', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeHeaders(hdrs(limitHeaders(10, 5000, RESET_S, 'graphql')));
  assert.deepEqual(s.pausedUntil(), { until: RESET_S * 1000, resource: 'graphql' });
  const r = s.resources().find((x) => x.resource === 'graphql');
  assert.deepEqual(r, { resource: 'graphql', remaining: 10, limit: 5000, resetAt: RESET_S * 1000 });
});

test('RateLimitState.observeHeaders：Remaining・Limit・Reset のどれかが無い／数でなければ何もしない', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeHeaders(hdrs({}));
  s.observeHeaders(hdrs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000' }));
  s.observeHeaders(hdrs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET_S) }));
  s.observeHeaders(hdrs({ 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(RESET_S) }));
  s.observeHeaders(hdrs({ 'x-ratelimit-remaining': 'abc', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(RESET_S) }));
  assert.equal(s.pausedUntil(), null);
  assert.deepEqual(s.resources(), []);
});

test('RateLimitState.observeHeaders：リセットの時刻が過ぎた資源では止めない', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeHeaders(hdrs(limitHeaders(0, 5000, T0 / 1000 - 1)));
  assert.equal(s.pausedUntil(), null);
});

test('RateLimitState.pausedUntil：下限を切った資源が複数なら、リセットが最も遅いもの', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeHeaders(hdrs(limitHeaders(10, 5000, RESET_S + 300, 'core')));
  s.observeHeaders(hdrs(limitHeaders(10, 5000, RESET_S, 'graphql')));
  s.observeHeaders(hdrs(limitHeaders(4000, 5000, RESET_S + 900, 'search')));
  assert.deepEqual(s.pausedUntil(), { until: (RESET_S + 300) * 1000, resource: 'core' });
  assert.equal(s.resources().length, 3);
});

test('RateLimitState.observeGraphql：data.rateLimit を graphql の資源として覚え、下限を切るとリセットまで止める', () => {
  const c = clock();
  const s = new RateLimitState({ now: c.now });
  const resetAt = new Date(RESET_S * 1000).toISOString();
  s.observeGraphql({ data: { rateLimit: { remaining: 4000, limit: 5000, resetAt } } });
  assert.equal(s.pausedUntil(), null);
  s.observeGraphql({ data: { rateLimit: { remaining: 100, limit: 5000, resetAt }, repository: {} } });
  assert.deepEqual(s.pausedUntil(), { until: RESET_S * 1000, resource: 'graphql' });
  c.set(RESET_S * 1000 + 1);
  assert.equal(s.pausedUntil(), null);
});

test('RateLimitState.observeGraphql：rateLimit が無い本文では何もしない', () => {
  const s = new RateLimitState({ now: () => T0 });
  for (const b of [null, undefined, 'x', {}, { data: null }, { data: {} }, { data: { rateLimit: null } }]) s.observeGraphql(b);
  assert.equal(s.pausedUntil(), null);
  assert.deepEqual(s.resources(), []);
});

test('RateLimitState.observeFailure：429 の Retry-After（秒）を now + 秒にし、過ぎたら null', () => {
  const c = clock();
  const s = new RateLimitState({ now: c.now });
  assert.equal(s.retryNotBefore(), null);
  s.observeFailure(429, hdrs({ 'retry-after': '30' }));
  assert.equal(s.retryNotBefore(), T0 + 30_000);
  c.set(T0 + 30_001);
  assert.equal(s.retryNotBefore(), null);
});

test('RateLimitState.observeFailure：403 で Retry-After が無く Remaining が 0 なら、Reset を「これより早く読まない時刻」にする', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeFailure(403, hdrs(limitHeaders(0)));
  assert.equal(s.retryNotBefore(), RESET_S * 1000);
});

test('RateLimitState.observeFailure：403 で Retry-After があれば Retry-After を使う', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeFailure(403, hdrs({ 'retry-after': '60' }));
  assert.equal(s.retryNotBefore(), T0 + 60_000);
});

test('RateLimitState.observeFailure：403・429 以外の status や、手がかりの無い 403 では何もしない', () => {
  const s = new RateLimitState({ now: () => T0 });
  s.observeFailure(500, hdrs({ 'retry-after': '30' }));
  s.observeFailure(502, hdrs(limitHeaders(0)));
  s.observeFailure(403, hdrs({}));
  s.observeFailure(403, hdrs(limitHeaders(100)));
  assert.equal(s.retryNotBefore(), null);
});

// --- RateLimitedTransport ---

test('RateLimitedTransport：FetchTransport と同じ要求を送る（authorization・accept・版・user-agent、本文は JSON）', async () => {
  const { fetch, calls } = fakeFetch([{ status: 200, body: '{"ok":true}' }, { status: 200, body: '[1]' }]);
  const t = new RateLimitedTransport({ fetch, token: 'tok-9', state: new RateLimitState({ now: () => T0 }) });
  assert.deepEqual(await t.request('POST', '/repos/o/r/issues', { body: { title: 'x' } }), { ok: true });
  assert.deepEqual(await t.request('GET', '/repos/o/r/pulls', { accept: 'application/vnd.github.raw' }), [1]);
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/o/r/issues');
  assert.equal(calls[0]!.method, 'POST');
  assert.equal(calls[0]!.headers.authorization, 'Bearer tok-9');
  assert.equal(calls[0]!.headers.accept, 'application/vnd.github+json');
  assert.equal(calls[0]!.headers['x-github-api-version'], '2022-11-28');
  assert.ok(calls[0]!.headers['user-agent']);
  assert.deepEqual(JSON.parse(calls[0]!.body!), { title: 'x' });
  assert.equal(calls[1]!.headers.accept, 'application/vnd.github.raw');
  assert.equal(calls[1]!.body, undefined);
});

test('RateLimitedTransport：baseUrl を変えられる。404 + allow404 は null、raw はテキスト、空の本文は null', async () => {
  const { fetch, calls } = fakeFetch([{ status: 404, body: 'nf' }, { status: 200, body: 'diff --git' }, { status: 204, body: '' }]);
  const t = new RateLimitedTransport({ fetch, token: 't', state: new RateLimitState({ now: () => T0 }), baseUrl: 'https://ghe.example/api/v3' });
  assert.equal(await t.request('GET', '/x', { allow404: true }), null);
  assert.equal(await t.request('GET', '/y', { raw: true }), 'diff --git');
  assert.equal(await t.request('DELETE', '/z'), null);
  assert.equal(calls[0]!.url, 'https://ghe.example/api/v3/x');
});

test('RateLimitedTransport：残りが下限を切ったら、リセットまで fetch を呼ばずに RateLimitPaused を投げ、過ぎたら読む', async () => {
  const c = clock();
  const state = new RateLimitState({ now: c.now });
  const { fetch, calls } = fakeFetch([
    { status: 200, headers: limitHeaders(1000), body: '[]' },
    { status: 200, headers: limitHeaders(5000, 5000, RESET_S + 3600), body: '[]' },
  ]);
  const t = new RateLimitedTransport({ fetch, token: 't', state });
  assert.deepEqual(await t.request('GET', '/repos/o/r/issues'), []);
  await assert.rejects(t.request('GET', '/repos/o/r/pulls'), (e: unknown) => {
    assert.ok(e instanceof RateLimitPaused);
    assert.equal(e.until, RESET_S * 1000);
    assert.equal(e.resource, 'core');
    return true;
  });
  c.set(RESET_S * 1000 - 1);
  await assert.rejects(t.request('GET', '/repos/o/r/pulls'), RateLimitPaused);
  assert.equal(calls.length, 1, '止めている間は GitHub を読まない');
  c.set(RESET_S * 1000 + 1);
  assert.deepEqual(await t.request('GET', '/repos/o/r/pulls'), []);
  assert.equal(calls.length, 2);
});

test('RateLimitedTransport：/graphql の成功した応答の rateLimit が下限を切ったら、graphql の資源で止める', async () => {
  const state = new RateLimitState({ now: () => T0 });
  const resetAt = new Date(RESET_S * 1000).toISOString();
  const { fetch, calls } = fakeFetch([{ status: 200, body: JSON.stringify({ data: { rateLimit: { remaining: 50, limit: 5000, resetAt }, viewer: { login: 'x' } } }) }]);
  const t = new RateLimitedTransport({ fetch, token: 't', state });
  assert.deepEqual(await t.request('POST', '/graphql', { body: { query: 'query { viewer { login } }' } }), { data: { rateLimit: { remaining: 50, limit: 5000, resetAt }, viewer: { login: 'x' } } });
  assert.deepEqual(state.pausedUntil(), { until: RESET_S * 1000, resource: 'graphql' });
  await assert.rejects(t.request('POST', '/graphql', { body: { query: 'query { viewer { login } }' } }), (e: unknown) => {
    assert.ok(e instanceof RateLimitPaused);
    assert.equal(e.resource, 'graphql');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('RateLimitedTransport：X-RateLimit-Resource: graphql のヘッダーだけでも止める', async () => {
  const state = new RateLimitState({ now: () => T0 });
  const { fetch, calls } = fakeFetch([{ status: 200, headers: limitHeaders(10, 5000, RESET_S, 'graphql'), body: '{"data":{}}' }]);
  const t = new RateLimitedTransport({ fetch, token: 't', state });
  await t.request('POST', '/graphql', { body: { query: 'query { a }' } });
  assert.deepEqual(state.pausedUntil(), { until: RESET_S * 1000, resource: 'graphql' });
  await assert.rejects(t.request('POST', '/graphql', { body: { query: 'query { a }' } }), RateLimitPaused);
  assert.equal(calls.length, 1);
});

test('RateLimitedTransport：502・503・504 は内部でやり直さず、1回で HttpError を投げる', async () => {
  for (const status of [502, 503, 504]) {
    const { fetch, calls } = fakeFetch([{ status, body: 'bad gateway' }, { status: 200, body: '[]' }]);
    const t = new RateLimitedTransport({ fetch, token: 't', state: new RateLimitState({ now: () => T0 }) });
    await assert.rejects(t.request('GET', '/x'), (e: unknown) => e instanceof HttpError && e.status === status);
    assert.equal(calls.length, 1, `${status} をやり直した`);
  }
});

test('RateLimitedTransport：通信の失敗はそのまま投げる（やり直さない）', async () => {
  let n = 0;
  const fetch: FetchFn = async () => { n++; throw new TypeError('fetch failed'); };
  const t = new RateLimitedTransport({ fetch, token: 't', state: new RateLimitState({ now: () => T0 }) });
  await assert.rejects(t.request('GET', '/x'), /fetch failed/);
  assert.equal(n, 1);
});

test('RateLimitedTransport：429 + Retry-After は observeFailure してから HttpError を投げる', async () => {
  const state = new RateLimitState({ now: () => T0 });
  const { fetch } = fakeFetch([{ status: 429, headers: { 'retry-after': '45' }, body: 'slow down' }]);
  const t = new RateLimitedTransport({ fetch, token: 't', state });
  await assert.rejects(t.request('GET', '/x'), (e: unknown) => e instanceof HttpError && e.status === 429);
  assert.equal(state.retryNotBefore(), T0 + 45_000);
});

test('RateLimitedTransport：403 で Remaining 0 なら、Reset を覚えて次からはリセットまで止める', async () => {
  const state = new RateLimitState({ now: () => T0 });
  const { fetch, calls } = fakeFetch([{ status: 403, headers: limitHeaders(0), body: 'rate limit exceeded' }]);
  const t = new RateLimitedTransport({ fetch, token: 't', state });
  await assert.rejects(t.request('GET', '/x'), (e: unknown) => e instanceof HttpError && e.status === 403);
  assert.equal(state.retryNotBefore(), RESET_S * 1000);
  assert.deepEqual(state.pausedUntil(), { until: RESET_S * 1000, resource: 'core' });
  await assert.rejects(t.request('GET', '/x'), RateLimitPaused);
  assert.equal(calls.length, 1);
});

// --- limitFetch（UpdateWatcher） ---

interface WatchReply { status: number; headers?: Record<string, string>; body?: unknown }
function watchFetch(replies: WatchReply[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const r = replies.shift();
    assert.ok(r, '想定より多く問い合わせた');
    return { status: r.status, headers: hdrs(r.headers ?? {}), json: async () => r.body ?? [] };
  };
  return { fetch, calls };
}

test('limitFetch：UpdateWatcher の応答のヘッダーで下限を切ったら、次の poll は fetch を呼ばずに RateLimitPaused', async () => {
  const c = clock();
  const state = new RateLimitState({ now: c.now });
  const { fetch, calls } = watchFetch([
    { status: 200, headers: { etag: '"e1"', ...limitHeaders(100) }, body: [{ number: 1, updated_at: 't1' }] },
    { status: 304, headers: { etag: '"e1"', ...limitHeaders(5000, 5000, RESET_S + 3600) } },
  ]);
  const w = new UpdateWatcher({ fetch: limitFetch(fetch, state), token: 't', repository: 'o/r' });
  assert.deepEqual(await w.poll(), { kind: 'full' });
  w.commit();
  await assert.rejects(w.poll(), RateLimitPaused);
  assert.equal(calls.length, 1);
  c.set(RESET_S * 1000 + 1);
  assert.deepEqual(await w.poll(), { kind: 'unchanged' });
  assert.equal(calls.length, 2);
});

test('limitFetch：UpdateWatcher 経由の 429 + Retry-After を覚える（応答はそのまま返す）', async () => {
  const state = new RateLimitState({ now: () => T0 });
  const { fetch } = watchFetch([{ status: 429, headers: { 'retry-after': '120' } }]);
  const wrapped = limitFetch(fetch, state);
  const res = await wrapped('https://api.github.com/repos/o/r/issues', { method: 'GET', headers: {} });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '120');
  assert.equal(state.retryNotBefore(), T0 + 120_000);
});
