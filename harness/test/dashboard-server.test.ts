// Issue #176：ダッシュボードのローカルのサーバー（HTML・SSE・Host の確認）と、画面（page.html）が外部を読み込まないこと
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { isAllowedHost, PAGE_PATH, startServer, type DashboardServer } from '../scripts/dashboard.ts';
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
