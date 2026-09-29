// Issue #176：ダッシュボードのローカルのサーバー（HTML・SSE・Host の確認）と、画面（page.html）が外部を読み込まないこと
// Issue #278：起動の引数（--interval・--min-remaining）、接続の数・接続時の status イベント・send、画面の読み込みの状態の文（statusText）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { isAllowedHost, PAGE_PATH, parseOptions, startServer, type DashboardServer } from '../scripts/dashboard.ts';
import { COLUMNS, type Graph, type Task } from '../scripts/dashboard/graph.ts';

const root = join(import.meta.dirname, '..', '..');
const HTML = '<!doctype html><title>dash</title><p>test-page</p>';
const snapshot = (): Graph => ({ columns: COLUMNS, tasks: [], edges: [], sessions: [], todos: [] });
const sampleTask: Task = {
  id: 'issue-1', kind: 'issue', number: 1, title: 't1', url: 'https://github.com/o/r/issues/1', column: 'implement', status: 'active', note: null,
  claim: { by: 'manual', stage: 'implement', session: null, at: '2026-09-29T00:00:00Z' }, sessions: [], warnings: [],
};

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ res: IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ res, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function withServer(fn: (s: DashboardServer) => Promise<void>): Promise<void> {
  const s = await startServer({ port: 0, html: HTML, snapshot });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

test('startServer：127.0.0.1 の空いたポートで待ち受け、/ で HTML を返す。未知のパスは 404', async () => {
  await withServer(async (s) => {
    assert.ok(s.port > 0);
    assert.equal(s.url.includes(`:${s.port}`), true);
    assert.match(s.url, /^http:\/\/(127\.0\.0\.1|localhost):\d+/);
    const page = await get(s.port, '/');
    assert.equal(page.res.statusCode, 200);
    assert.match(String(page.res.headers['content-type']), /text\/html/);
    assert.equal(page.body, HTML);
    assert.equal((await get(s.port, '/nope')).res.statusCode, 404);
    assert.equal((await get(s.port, '/', `localhost:${s.port}`)).res.statusCode, 200);
  });
});

test('startServer：許されない Host は 403（DNS rebinding を防ぐ）', async () => {
  await withServer(async (s) => {
    assert.equal((await get(s.port, '/', `evil.example:${s.port}`)).res.statusCode, 403);
    assert.equal((await get(s.port, '/events', `evil.example:${s.port}`)).res.statusCode, 403);
  });
});

test('/events：接続時に snapshot、publish のたびに各イベントを SSE で送る', async () => {
  await withServer(async (s) => {
    let buf = '';
    let res: IncomingMessage | undefined;
    const waiters: (() => void)[] = [];
    const until = (pred: () => boolean) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`届かない：${buf}`)), 5000);
      const check = () => { if (pred()) { clearTimeout(timer); resolve(); } else waiters.push(check); };
      check();
    });
    const req = request({ host: '127.0.0.1', port: s.port, path: '/events', method: 'GET', headers: { host: `127.0.0.1:${s.port}`, accept: 'text/event-stream' } }, (r) => {
      res = r;
      r.setEncoding('utf8');
      r.on('data', (c: string) => { buf += c; waiters.splice(0).forEach((w) => w()); });
    });
    req.on('error', () => {});
    req.end();
    try {
      await until(() => /event: snapshot\ndata: .*\n\n/.test(buf));
      assert.equal(res!.statusCode, 200);
      assert.match(String(res!.headers['content-type']), /text\/event-stream/);
      const snap = JSON.parse(buf.match(/event: snapshot\ndata: (.*)\n\n/)![1]!) as Graph;
      assert.deepEqual(snap, JSON.parse(JSON.stringify(snapshot())));

      s.publish([{ type: 'task', task: sampleTask, edges: [{ kind: 'depends', from: 'issue-1', to: 'issue-2' }] }, { type: 'remove', id: 'pr-9' }]);
      await until(() => /event: remove\ndata: .*\n\n/.test(buf));
      const task = JSON.parse(buf.match(/event: task\ndata: (.*)\n\n/)![1]!);
      assert.deepEqual(task, { type: 'task', task: sampleTask, edges: [{ kind: 'depends', from: 'issue-1', to: 'issue-2' }] });
      assert.deepEqual(JSON.parse(buf.match(/event: remove\ndata: (.*)\n\n/)![1]!), { type: 'remove', id: 'pr-9' });
    } finally {
      req.destroy();
    }
  });
});

/** /events に繋ぎ、届いた本文を読めるようにする。close で切る */
function connect(port: number): { until: (pred: (buf: string) => boolean) => Promise<string>; close: () => void } {
  let buf = '';
  const waiters: (() => void)[] = [];
  const req = request({ host: '127.0.0.1', port, path: '/events', method: 'GET', headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' } }, (r) => {
    r.setEncoding('utf8');
    r.on('data', (c: string) => { buf += c; waiters.splice(0).forEach((w) => w()); });
  });
  req.on('error', () => {});
  req.end();
  return {
    until: (pred) => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`届かない：${buf}`)), 5000);
      const check = () => { if (pred(buf)) { clearTimeout(timer); resolve(buf); } else waiters.push(check); };
      check();
    }),
    close: () => req.destroy(),
  };
}

/** 条件が成り立つまで少しずつ待つ（サーバー側で切断が見えるまで） */
async function eventually(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(what);
}

test('parseOptions：既定は port 4177・30 秒・minRemaining 0.3', () => {
  assert.deepEqual(parseOptions([]), { port: 4177, intervalMs: 30_000, minRemaining: 0.3 });
});

test('parseOptions：--interval は秒で、5 より小さければ 5 に丸める。--port・--min-remaining を読む', () => {
  assert.equal(parseOptions(['--interval', '60']).intervalMs, 60_000);
  assert.equal(parseOptions(['--interval', '5']).intervalMs, 5000);
  assert.equal(parseOptions(['--interval', '2']).intervalMs, 5000);
  assert.equal(parseOptions(['--interval', '0']).intervalMs, 5000);
  assert.equal(parseOptions(['--port', '5000']).port, 5000);
  assert.equal(parseOptions(['--min-remaining', '0.5']).minRemaining, 0.5);
  assert.equal(parseOptions(['--min-remaining', '0']).minRemaining, 0);
  assert.equal(parseOptions(['--min-remaining', '1']).minRemaining, 1);
  assert.deepEqual(parseOptions(['--port', '0', '--interval', '10', '--min-remaining', '0.1']), { port: 0, intervalMs: 10_000, minRemaining: 0.1 });
});

test('parseOptions：--min-remaining が 0〜1 の外や数でなければ Error', () => {
  for (const v of ['1.5', '-0.1', 'abc']) assert.throws(() => parseOptions(['--min-remaining', v]), Error, v);
  assert.throws(() => parseOptions(['--min-remaining']), Error, '値が無い');
});

test('startServer：clients() は /events の接続の数。接続のたびに onConnect を呼び、切れたら減る', async () => {
  let connected = 0;
  const s = await startServer({ port: 0, html: HTML, snapshot, onConnect: () => { connected++; } });
  try {
    assert.equal(s.clients(), 0);
    const a = connect(s.port);
    await a.until((b) => /event: snapshot\n/.test(b));
    await eventually(() => connected === 1, 'onConnect が呼ばれない');
    assert.equal(s.clients(), 1);
    const b = connect(s.port);
    await b.until((x) => /event: snapshot\n/.test(x));
    await eventually(() => connected === 2, '2つ目の onConnect が呼ばれない');
    assert.equal(s.clients(), 2);
    a.close();
    await eventually(() => s.clients() === 1, '切れても clients() が減らない');
    b.close();
    await eventually(() => s.clients() === 0, '切れても clients() が 0 にならない');
    assert.equal(connected, 2);
    assert.equal((await get(s.port, '/')).res.statusCode, 200);
    assert.equal(s.clients(), 0, '/ の読み込みは接続に数えない');
  } finally {
    await s.close();
  }
});

test('/events：status があれば snapshot の後に event: status を送る。send で全員に送る', async () => {
  const status = { state: 'paused', until: 1_800_000_000_000, resource: 'core' };
  const s = await startServer({ port: 0, html: HTML, snapshot, status: () => status });
  try {
    const c = connect(s.port);
    const buf = await c.until((b) => /event: status\ndata: .*\n\n/.test(b));
    assert.ok(buf.indexOf('event: snapshot') < buf.indexOf('event: status'), 'snapshot の後に status');
    assert.deepEqual(JSON.parse(buf.match(/event: status\ndata: (.*)\n\n/)![1]!), status);
    s.send('status', { state: 'running' });
    const after = await c.until((b) => (b.match(/event: status\n/g) ?? []).length >= 2);
    const all = [...after.matchAll(/event: status\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!));
    assert.deepEqual(all.at(-1), { state: 'running' });
    c.close();
  } finally {
    await s.close();
  }
});

test('/events：status が無ければ event: status を送らない', async () => {
  const s = await startServer({ port: 0, html: HTML, snapshot });
  try {
    const c = connect(s.port);
    await c.until((b) => /event: snapshot\ndata: .*\n\n/.test(b));
    s.publish([{ type: 'remove', id: 'pr-1' }]);
    const buf = await c.until((b) => /event: remove\n/.test(b));
    assert.doesNotMatch(buf, /event: status/);
    c.close();
  } finally {
    await s.close();
  }
});

type StatusText = (s: unknown) => string;
function loadStatusText(): StatusText {
  const html = readFileSync(PAGE_PATH, 'utf8');
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  const context: Record<string, unknown> = {};
  runInNewContext(m[1]!, context);
  assert.equal(typeof context.statusText, 'function', 'statusText が定義されていない');
  return context.statusText as StatusText;
}

test('page.html の statusText：running か null なら空。paused は上限で止めていること、backoff は失敗して読み直すことを時刻つきで示す', () => {
  const statusText = loadStatusText();
  const until = new Date(2026, 8, 30, 14, 5).getTime();
  assert.equal(statusText(null), '');
  assert.equal(statusText({ state: 'running' }), '');
  const paused = statusText({ state: 'paused', until, resource: 'core' });
  assert.match(paused, /上限/);
  assert.match(paused, /止めています/);
  assert.match(paused, /\d{1,2}:\d{2}/);
  const backoff = statusText({ state: 'backoff', until, attempt: 2, error: 'GET /x -> 502' });
  assert.match(backoff, /失敗/);
  assert.match(backoff, /読み直します/);
  assert.match(backoff, /\d{1,2}:\d{2}/);
});

test('page.html は /events の status イベントを受ける', () => {
  const html = readFileSync(PAGE_PATH, 'utf8');
  assert.match(html, /addEventListener\(\s*['"]status['"]/);
});

test('isAllowedHost：127.0.0.1:<port> と localhost:<port> だけ', () => {
  assert.equal(isAllowedHost('127.0.0.1:4000', 4000), true);
  assert.equal(isAllowedHost('localhost:4000', 4000), true);
  assert.equal(isAllowedHost('127.0.0.1:4001', 4000), false);
  assert.equal(isAllowedHost('127.0.0.1', 4000), false);
  assert.equal(isAllowedHost('evil.example:4000', 4000), false);
  assert.equal(isAllowedHost('127.0.0.1.evil.example:4000', 4000), false);
  assert.equal(isAllowedHost('localhost.evil.example:4000', 4000), false);
  assert.equal(isAllowedHost(undefined, 4000), false);
  assert.equal(isAllowedHost('', 4000), false);
});

test('page.html：外部を読み込まず、/events を EventSource で受け、innerHTML を使わない', () => {
  const html = readFileSync(PAGE_PATH, 'utf8');
  assert.doesNotMatch(html, /\b(src|href)\s*=\s*["']?\s*(https?:)?\/\//i, '外部の src / href');
  assert.doesNotMatch(html, /url\(\s*["']?\s*(https?:)?\/\//i, 'CSS の外部 url()');
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /\bimport\s*\(|from\s+["']https?:/, 'スクリプトの外部 import');
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /new EventSource\(\s*["']\/events["']\s*\)/);
});

test('実行時の依存パッケージが無い', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});
