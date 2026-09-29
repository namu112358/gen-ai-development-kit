// Issue #278：ダッシュボードの読み直しの予定（失敗で backoff、上限で止める、接続が0なら読まない）。時計・乱数・タイマーは差し替える
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../lib/github.ts';
import { UpdateWatcher, type FetchLike } from '../scripts/dashboard/github.ts';
import { limitFetch, RateLimitedTransport, RateLimitPaused, RateLimitState, type FetchFn } from '../scripts/dashboard/rate-limit.ts';
import { PollScheduler, type PollStatus, type SchedulerOptions } from '../scripts/dashboard/scheduler.ts';

const T0 = 1_800_000_000_000;
const INTERVAL = 1000;
const CAP = 60_000;

interface Timer { fn: () => Promise<void>; ms: number; cleared: boolean; fired: boolean }

type StateLike = SchedulerOptions['state'];
const idleState = (): StateLike => ({ pausedUntil: () => null, retryNotBefore: () => null });

function rig(opts: { run: () => Promise<void>; state?: StateLike; random?: () => number; connections?: () => number }) {
  let t = T0;
  const timers: Timer[] = [];
  const statuses: PollStatus[] = [];
  const errors: Error[] = [];
  let conns = 1;
  const s = new PollScheduler({
    intervalMs: INTERVAL,
    capMs: CAP,
    run: opts.run,
    state: opts.state ?? idleState(),
    connections: opts.connections ?? (() => conns),
    now: () => t,
    random: opts.random ?? (() => 0.75),
    setTimer: (fn, ms) => { const h: Timer = { fn, ms, cleared: false, fired: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as Timer).cleared = true; },
    onStatus: (st) => statuses.push(st),
    onError: (e) => errors.push(e),
  });
  const pending = () => timers.filter((x) => !x.cleared && !x.fired);
  return {
    s, timers, statuses, errors,
    now: () => t,
    advance: (ms: number) => { t += ms; },
    setConnections: (n: number) => { conns = n; },
    pending,
    /** 置かれたタイマー（1つだけのはず）の時刻まで時計を進めて呼ぶ */
    async fire(): Promise<number> {
      const p = pending();
      assert.equal(p.length, 1, `置かれたタイマーが ${p.length} 個`);
      const h = p[0]!;
      h.fired = true;
      t += h.ms;
      await h.fn();
      return h.ms;
    },
  };
}

/** 決めた順に成功・失敗する run */
function scripted(steps: (Error | null)[]): { run: () => Promise<void>; count: () => number } {
  let n = 0;
  return {
    run: async () => {
      const step = steps[n++];
      assert.ok(step !== undefined, '想定より多く読んだ');
      if (step) throw step;
    },
    count: () => n,
  };
}

test('PollScheduler：初めは running。wake ですぐ1回読み、成功したら intervalMs 後にタイマーを置く', async () => {
  const r = scripted([null, null]);
  const g = rig({ run: r.run });
  assert.deepEqual(g.s.status(), { state: 'running' });
  await g.s.wake();
  assert.equal(r.count(), 1);
  assert.equal(g.pending().length, 1);
  assert.equal(g.pending()[0]!.ms, INTERVAL);
  assert.equal(await g.fire(), INTERVAL);
  assert.equal(r.count(), 2);
  assert.deepEqual(g.s.status(), { state: 'running' });
  assert.deepEqual(g.errors, []);
});

test('PollScheduler：タイマーが置かれていれば wake は何もしない', async () => {
  const r = scripted([null]);
  const g = rig({ run: r.run });
  await g.s.wake();
  await g.s.wake();
  await g.s.wake();
  assert.equal(r.count(), 1);
  assert.equal(g.pending().length, 1);
});

test('PollScheduler：403・429・502・503・504・通信の失敗で exponential backoff + jitter で延び、成功すると intervalMs に戻る', async () => {
  const r = scripted([
    new HttpError(502, 'GET /x -> 502'),
    new HttpError(503, 'GET /x -> 503'),
    new HttpError(504, 'GET /x -> 504'),
    new TypeError('fetch failed'),
    new HttpError(429, 'GET /x -> 429'),
    new HttpError(403, 'GET /x -> 403'),
    null,
    null,
  ]);
  const g = rig({ run: r.run, random: () => 0.75 });
  await g.s.wake();
  // attempt 1..6：floor(0.75 * min(CAP, INTERVAL * 2 ** attempt))
  const expected = [1500, 3000, 6000, 12_000, 24_000, Math.floor(0.75 * CAP)];
  assert.equal(g.pending()[0]!.ms, expected[0]);
  assert.deepEqual(g.s.status(), { state: 'backoff', until: g.now() + expected[0]!, attempt: 1, error: g.errors[0]!.message });
  for (let i = 1; i < expected.length; i++) {
    await g.fire();
    const st = g.s.status();
    assert.equal(st.state, 'backoff');
    assert.ok(st.state === 'backoff');
    assert.equal(st.attempt, i + 1);
    assert.equal(g.pending()[0]!.ms, expected[i], `attempt ${i + 1}`);
    assert.equal(st.until, g.now() + expected[i]!);
  }
  assert.equal(g.errors.length, 6, 'onError を失敗ごとに呼ぶ');
  assert.match(g.errors[3]!.message, /fetch failed/);
  await g.fire(); // 成功
  assert.deepEqual(g.s.status(), { state: 'running' });
  assert.equal(g.pending()[0]!.ms, INTERVAL, '成功したら元の間隔');
  await g.fire();
  assert.equal(r.count(), 8);
});

test('PollScheduler：成功した後の失敗は attempt 1 からやり直す', async () => {
  const r = scripted([new HttpError(502, 'x'), new HttpError(502, 'x'), null, new HttpError(502, 'x')]);
  const g = rig({ run: r.run, random: () => 0.75 });
  await g.s.wake();
  await g.fire();
  assert.equal(g.pending()[0]!.ms, 3000);
  await g.fire();
  assert.equal(g.pending()[0]!.ms, INTERVAL);
  await g.fire();
  assert.equal(g.pending()[0]!.ms, 1500);
  assert.equal((g.s.status() as { attempt: number }).attempt, 1);
});

test('PollScheduler：jitter は random で変わる（乱数を差し替えると間隔が変わる）', async () => {
  const delays: number[] = [];
  for (const v of [0.1, 0.5, 0.9]) {
    const g = rig({ run: scripted([new HttpError(503, 'x')]).run, random: () => v });
    await g.s.wake();
    delays.push(g.pending()[0]!.ms);
  }
  assert.deepEqual(delays, [200, 1000, 1800]);
});

test('PollScheduler：Retry-After（retryNotBefore）より早く読み直さない', async () => {
  let notBefore: number | null = null;
  const state: StateLike = { pausedUntil: () => null, retryNotBefore: () => notBefore };
  let n = 0;
  let now = 0;
  const g = rig({
    state,
    random: () => 0.75,
    run: async () => {
      n++;
      if (n === 1) { notBefore = now + 120_000; throw new HttpError(429, 'GET /x -> 429'); }
    },
  });
  now = g.now();
  await g.s.wake();
  const ms = g.pending()[0]!.ms;
  assert.ok(ms >= 120_000, `Retry-After より早い：${ms}`);
  assert.equal(ms, 120_000 + 1500);
  assert.deepEqual(g.s.status(), { state: 'backoff', until: g.now() + ms, attempt: 1, error: 'GET /x -> 429' });
});

test('PollScheduler：pausedUntil があれば run を呼ばず paused にし、until まで待つ。リセットを過ぎたら読む', async () => {
  let paused: { until: number; resource: string } | null = { until: T0 + 60_000, resource: 'core' };
  const r = scripted([null]);
  const g = rig({ run: r.run, state: { pausedUntil: () => paused, retryNotBefore: () => null } });
  await g.s.wake();
  assert.equal(r.count(), 0, '止めている間は読まない');
  assert.deepEqual(g.s.status(), { state: 'paused', until: T0 + 60_000, resource: 'core' });
  assert.equal(g.pending()[0]!.ms, 60_000);
  paused = null;
  await g.fire();
  assert.equal(r.count(), 1);
  assert.deepEqual(g.s.status(), { state: 'running' });
  assert.deepEqual(g.errors, []);
});

test('PollScheduler：run の途中の RateLimitPaused は失敗に数えず paused に回る（attempt を増やさない）', async () => {
  // 本物の RateLimitPaused を RateLimitedTransport から取る
  const limit = new RateLimitState({ now: () => T0 });
  limit.observeHeaders({ get: (n: string) => ({ 'x-ratelimit-remaining': '1', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': String(T0 / 1000 + 30) } as Record<string, string>)[n.toLowerCase()] ?? null });
  const never: FetchFn = async () => { throw new Error('呼ばれないはず'); };
  let paused: unknown;
  try { await new RateLimitedTransport({ fetch: never, token: 't', state: limit }).request('GET', '/x'); } catch (e) { paused = e; }
  assert.ok(paused instanceof RateLimitPaused);
  const pausedErr: RateLimitPaused = paused;

  const r = scripted([new HttpError(502, 'x'), pausedErr, new HttpError(502, 'x')]);
  const g = rig({ run: r.run, random: () => 0.75 }); // state は止めていない（run の途中で止まった）
  await g.s.wake();
  assert.equal(g.pending()[0]!.ms, 1500);
  assert.equal(g.errors.length, 1);
  // 1500 ms 進めて2回目：RateLimitPaused
  await g.fire();
  assert.deepEqual(g.s.status(), { state: 'paused', until: pausedErr.until, resource: 'core' });
  assert.equal(g.pending()[0]!.ms, pausedErr.until - g.now());
  assert.equal(g.errors.length, 1, 'RateLimitPaused は onError に回さない');
  await g.fire();
  const st = g.s.status();
  assert.ok(st.state === 'backoff');
  assert.equal(st.attempt, 2, 'RateLimitPaused で attempt を増やしていない');
  assert.equal(g.pending()[0]!.ms, 3000);
});

test('PollScheduler：run が失敗した後に pausedUntil があれば paused に回る', async () => {
  let paused: { until: number; resource: string } | null = null;
  let now = 0;
  const g = rig({
    state: { pausedUntil: () => paused, retryNotBefore: () => null },
    run: async () => { paused = { until: now + 90_000, resource: 'graphql' }; throw new HttpError(403, 'rate limit'); },
  });
  now = g.now();
  await g.s.wake();
  assert.deepEqual(g.s.status(), { state: 'paused', until: now + 90_000, resource: 'graphql' });
  assert.equal(g.pending()[0]!.ms, 90_000);
});

test('PollScheduler：接続が0なら run を呼ばず、タイマーも置かない。接続が戻ったら wake ですぐ1回読む', async () => {
  const r = scripted([null, null]);
  const g = rig({ run: r.run });
  g.setConnections(0);
  await g.s.wake();
  assert.equal(r.count(), 0);
  assert.equal(g.pending().length, 0);
  g.setConnections(1);
  await g.s.wake();
  assert.equal(r.count(), 1);
  assert.equal(g.pending().length, 1);
});

test('PollScheduler：タイマーが来たときに接続が0なら読まずにタイマーも置かない。接続が戻った wake ですぐ読む', async () => {
  const r = scripted([null, null]);
  const g = rig({ run: r.run });
  await g.s.wake();
  g.setConnections(0);
  await g.fire();
  assert.equal(r.count(), 1, '接続が0の間は問い合わせない');
  assert.equal(g.pending().length, 0);
  g.advance(10 * INTERVAL);
  g.setConnections(2);
  await g.s.wake();
  assert.equal(r.count(), 2);
  assert.equal(g.pending().length, 1);
});

test('PollScheduler：run の後に接続が0ならタイマーを置かず、backoff の時刻は覚えておいて wake が守る', async () => {
  let n = 0;
  let conns = 1;
  const g = rig({
    connections: () => conns,
    random: () => 0.75,
    run: async () => { n++; if (n === 1) { conns = 0; throw new HttpError(502, 'x'); } },
  });
  await g.s.wake();
  assert.equal(n, 1);
  assert.equal(g.pending().length, 0, '接続が0になったのでタイマーを置かない');
  conns = 1;
  g.advance(500); // backoff（1500 ms）の途中
  await g.s.wake();
  assert.equal(n, 1, 'backoff の時刻より前には読まない');
  assert.equal(g.pending().length, 1);
  assert.equal(g.pending()[0]!.ms, 1000, '残りの時間でタイマーを置く');
  await g.fire();
  assert.equal(n, 2);
});

test('PollScheduler：run の途中の wake で2本目の run が始まらない', async () => {
  let n = 0;
  let release!: () => void;
  const g = rig({ run: () => { n++; return new Promise<void>((res) => { release = res; }); } });
  const first = g.s.wake();
  await new Promise<void>((res) => setImmediate(res)); // run が始まるまで待つ（時計には頼らない）
  await g.s.wake();
  await g.s.wake();
  assert.equal(n, 1);
  release();
  await first;
  assert.equal(n, 1);
  assert.equal(g.pending().length, 1, 'タイマーは1つだけ');
});

test('PollScheduler：onStatus は状態が変わったときだけ呼ぶ', async () => {
  const r = scripted([null, null, new HttpError(502, 'x'), null]);
  const g = rig({ run: r.run });
  await g.s.wake();
  await g.fire();
  assert.equal(g.statuses.length, 0, 'running のまま');
  await g.fire();
  assert.equal(g.statuses.length, 1);
  assert.equal(g.statuses[0]!.state, 'backoff');
  await g.fire();
  assert.equal(g.statuses.length, 2);
  assert.deepEqual(g.statuses[1], { state: 'running' });
});

test('PollScheduler：stop でタイマーを外し、その後の wake は何もしない', async () => {
  const r = scripted([null]);
  const g = rig({ run: r.run });
  await g.s.wake();
  const h = g.pending()[0]!;
  g.s.stop();
  assert.equal(h.cleared, true);
  await g.s.wake();
  assert.equal(r.count(), 1);
  assert.equal(g.pending().length, 0);
});

test('PollScheduler + limitFetch：UpdateWatcher 経由の 429 + Retry-After の後、Retry-After より早く読み直さない', async () => {
  let t = T0;
  const state = new RateLimitState({ now: () => t });
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    if (calls === 1) return { status: 429, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '120' : null) }, json: async () => ({}) };
    return { status: 200, headers: { get: () => null }, json: async () => [] };
  };
  const watcher = new UpdateWatcher({ fetch: limitFetch(fetch, state), token: 't', repository: 'o/r' });
  const timers: Timer[] = [];
  const errors: Error[] = [];
  const s = new PollScheduler({
    intervalMs: INTERVAL, capMs: CAP, state, connections: () => 1, now: () => t, random: () => 0.5,
    run: async () => { await watcher.poll(); watcher.commit(); },
    setTimer: (fn, ms) => { const h: Timer = { fn, ms, cleared: false, fired: false }; timers.push(h); return h; },
    clearTimer: (h) => { (h as Timer).cleared = true; },
    onError: (e) => errors.push(e),
  });
  await s.wake();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(timers.length, 1);
  assert.ok(timers[0]!.ms >= 120_000, `Retry-After より早い：${timers[0]!.ms}`);
  assert.equal(timers[0]!.ms, 120_000 + 1000);
  const st = s.status();
  assert.ok(st.state === 'backoff');
  assert.ok(st.until >= T0 + 120_000);
  timers[0]!.fired = true;
  t += timers[0]!.ms;
  await timers[0]!.fn();
  assert.equal(calls, 2);
  assert.deepEqual(s.status(), { state: 'running' });
  assert.equal(timers.at(-1)!.ms, INTERVAL);
});
