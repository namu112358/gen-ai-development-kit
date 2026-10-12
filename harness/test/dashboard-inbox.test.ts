// Issue #817：手元のダッシュボードの気づきの受け箱（harness/scripts/dashboard/inbox.ts）と、送る要求（POST /notes）。
// 受け箱の add・list・unread・markRead（形の合わない id の拒否）、waitForUnread、Origin と合言葉の確かめ、
// Origin・合言葉が合わない POST は 403 で受け箱に入らないこと、画面（page.html）が合言葉を付けて送り inbox イベントを受けること
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { isAllowedOrigin, PAGE_PATH, startServer, tokenMatches, type DashboardServer } from '../scripts/dashboard.ts';
import { COLUMNS, type Graph } from '../scripts/dashboard/graph.ts';
import { Inbox, NOTE_ID_PATTERN, waitForUnread } from '../scripts/dashboard/inbox.ts';

const tmp = mkdtempSync(join(tmpdir(), 'dashboard-inbox-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const HTML = '<!doctype html><title>dash</title><p>test-page</p>';
const TOKEN = 'a'.repeat(64);
const snapshot = (): Graph => ({ columns: COLUMNS, tasks: [], edges: [], sessions: [], todos: [], progress: { epics: null, mergedToday: null, running: { sessions: 0, subagents: 0 } } });

function newInbox(): { dir: string; inbox: Inbox } {
  const dir = mkdtempSync(join(tmp, 'inbox-'));
  return { dir, inbox: new Inbox(dir) };
}

/** dir の下の sub にあるファイルの数（ディレクトリが無ければ 0） */
function fileCount(dir: string, sub: 'notes' | 'read'): number {
  const p = join(dir, sub);
  return existsSync(p) ? readdirSync(p).length : 0;
}

function post(
  port: number,
  h: { origin?: string; token?: string; contentType?: string; body: string },
): Promise<{ res: IncomingMessage; body: string }> {
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (h.origin !== undefined) headers.origin = h.origin;
  if (h.token !== undefined) headers['x-dashboard-token'] = h.token;
  if (h.contentType !== undefined) headers['content-type'] = h.contentType;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/notes', method: 'POST', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ res, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end(h.body);
  });
}

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

async function withInboxServer(fn: (s: DashboardServer, ctx: { dir: string; inbox: Inbox }) => Promise<void>): Promise<void> {
  const ctx = newInbox();
  const notes = { token: TOKEN, add: (text: string) => ctx.inbox.add(text), unread: () => ctx.inbox.unread() };
  const s = await startServer({ port: 0, html: HTML, snapshot, notes });
  try {
    await fn(s, ctx);
  } finally {
    await s.close();
  }
}

test('Inbox：add で未読が1件になり list に出る。markRead の後は未読 0。まだ何も無ければ list は空・unread は 0', () => {
  const { dir, inbox } = newInbox();
  assert.equal(inbox.unread(), 0);
  assert.deepEqual(inbox.list(), []);
  const note = inbox.add('ログが読みにくい');
  assert.match(note.id, NOTE_ID_PATTERN);
  assert.equal(inbox.unread(), 1);
  const listed = inbox.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, note.id);
  assert.equal(listed[0]!.text, 'ログが読みにくい');
  assert.deepEqual(inbox.markRead([note.id]), { ok: true });
  assert.equal(inbox.unread(), 0);
  assert.deepEqual(inbox.list(), []);
  assert.equal(fileCount(dir, 'notes'), 1, '読んだ印を付けても気づきは消さない');
});

test('Inbox：markRead は形の合わない id・無い id を拒み、ほかの id にも印を付けない', () => {
  const { dir, inbox } = newInbox();
  const note = inbox.add('気づき');
  const cases: { name: string; ids: string[] }[] = [
    { name: 'パスの外', ids: ['../x'] },
    { name: '形の合う id と合わない id', ids: [note.id, '../x'] },
    { name: '区切りを含む', ids: [`${note.id}/../../x`] },
    { name: '形は合うが notes/ に無い', ids: ['20260101T000000000Z-deadbeef'] },
  ];
  for (const c of cases) {
    const r = inbox.markRead(c.ids);
    assert.equal(r.ok, false, c.name);
    assert.equal(inbox.unread(), 1, c.name);
    assert.equal(fileCount(dir, 'read'), 0, c.name);
  }
});

test('waitForUnread：待っている間に未読が届くと unread で終わる', async () => {
  const { inbox } = newInbox();
  const timer = setTimeout(() => inbox.add('届いた'), 30);
  try {
    assert.deepEqual(await waitForUnread(inbox, { timeoutMs: 3000, intervalMs: 10 }), { result: 'unread', unread: 1 });
  } finally {
    clearTimeout(timer);
  }
});

test('waitForUnread：未読が届かなければ timeout で終わる', async () => {
  const { inbox } = newInbox();
  assert.deepEqual(await waitForUnread(inbox, { timeoutMs: 50, intervalMs: 10 }), { result: 'timeout', unread: 0 });
});

test('isAllowedOrigin：http://127.0.0.1:<port> と http://localhost:<port> に完全に一致するときだけ', () => {
  const cases: [string | undefined, boolean][] = [
    ['http://127.0.0.1:4000', true],
    ['http://localhost:4000', true],
    ['http://127.0.0.1:4001', false],
    ['https://127.0.0.1:4000', false],
    ['https://localhost:4000', false],
    ['http://127.0.0.1', false],
    ['http://127.0.0.1:4000/', false],
    ['http://localhost.evil.example:4000', false],
    ['http://evil.example', false],
    ['null', false],
    ['', false],
    [undefined, false],
  ];
  for (const [origin, want] of cases) assert.equal(isAllowedOrigin(origin, 4000), want, String(origin));
});

test('tokenMatches：同じときだけ真。長さ違い・中身違い・無いは偽', () => {
  const cases: [string | undefined, boolean][] = [
    [TOKEN, true],
    ['b'.repeat(64), false],
    [TOKEN.slice(1), false],
    [`${TOKEN}a`, false],
    ['', false],
    [undefined, false],
  ];
  for (const [given, want] of cases) assert.equal(tokenMatches(given, TOKEN), want, String(given));
});

test('POST /notes：Origin・合言葉・content-type が合えば 201 で受け箱に1件入る', async () => {
  await withInboxServer(async (s, { inbox }) => {
    const r = await post(s.port, { origin: `http://127.0.0.1:${s.port}`, token: TOKEN, contentType: 'application/json', body: JSON.stringify({ text: '送る欄からの気づき' }) });
    assert.equal(r.res.statusCode, 201);
    const json = JSON.parse(r.body) as { id: string; unread: number };
    assert.equal(json.unread, 1);
    assert.equal(inbox.unread(), 1);
    const listed = inbox.list();
    assert.equal(listed[0]!.id, json.id);
    assert.equal(listed[0]!.text, '送る欄からの気づき');
  });
});

test('POST /notes：Origin か合言葉が合わなければ 403 で、受け箱に入らない', async () => {
  await withInboxServer(async (s, { dir, inbox }) => {
    const origin = `http://127.0.0.1:${s.port}`;
    const cases: { name: string; origin?: string; token?: string }[] = [
      { name: 'Origin が別のサイト', origin: 'http://evil.example', token: TOKEN },
      { name: 'Origin のポート違い', origin: `http://127.0.0.1:${s.port + 1}`, token: TOKEN },
      { name: 'Origin が無い', token: TOKEN },
      { name: '合言葉が違う', origin, token: 'b'.repeat(64) },
      { name: '合言葉が無い', origin },
    ];
    for (const c of cases) {
      const r = await post(s.port, { origin: c.origin, token: c.token, contentType: 'application/json', body: JSON.stringify({ text: '入ってはいけない' }) });
      assert.equal(r.res.statusCode, 403, c.name);
      assert.equal(inbox.unread(), 0, c.name);
      assert.equal(fileCount(dir, 'notes'), 0, c.name);
    }
  });
});

test('POST /notes：空の text は 400、content-type が JSON でなければ 415 で、受け箱に入らない', async () => {
  await withInboxServer(async (s, { dir, inbox }) => {
    const ok = { origin: `http://127.0.0.1:${s.port}`, token: TOKEN };
    const cases: { name: string; contentType: string; body: string; status: number }[] = [
      { name: '空の text', contentType: 'application/json', body: JSON.stringify({ text: '   ' }), status: 400 },
      { name: 'content-type 違い', contentType: 'text/plain', body: JSON.stringify({ text: '気づき' }), status: 415 },
    ];
    for (const c of cases) {
      const r = await post(s.port, { ...ok, contentType: c.contentType, body: c.body });
      assert.equal(r.res.statusCode, c.status, c.name);
      assert.equal(inbox.unread(), 0, c.name);
      assert.equal(fileCount(dir, 'notes'), 0, c.name);
    }
  });
});

test('POST /notes：notes を渡さないサーバーでは 404', async () => {
  const s = await startServer({ port: 0, html: HTML, snapshot });
  try {
    const r = await post(s.port, { origin: `http://127.0.0.1:${s.port}`, token: TOKEN, contentType: 'application/json', body: JSON.stringify({ text: '気づき' }) });
    assert.equal(r.res.statusCode, 404);
  } finally {
    await s.close();
  }
});

test('/events：接続時に event: inbox で未読の数を送り、POST /notes で受けたら全員に送り直す', async () => {
  await withInboxServer(async (s) => {
    const c = connect(s.port);
    try {
      const first = await c.until((b) => /event: inbox\ndata: .*\n\n/.test(b));
      assert.deepEqual(JSON.parse(first.match(/event: inbox\ndata: (.*)\n\n/)![1]!), { unread: 0 });
      const r = await post(s.port, { origin: `http://127.0.0.1:${s.port}`, token: TOKEN, contentType: 'application/json', body: JSON.stringify({ text: '気づき' }) });
      assert.equal(r.res.statusCode, 201);
      const after = await c.until((b) => (b.match(/event: inbox\n/g) ?? []).length >= 2);
      const all = [...after.matchAll(/event: inbox\ndata: (.*)\n\n/g)].map((m) => JSON.parse(m[1]!));
      assert.deepEqual(all.at(-1), { unread: 1 });
    } finally {
      c.close();
    }
  });
});

test('page.html：合言葉の meta を置き、/notes に x-dashboard-token を付けて送り、inbox イベントを受ける', () => {
  const html = readFileSync(PAGE_PATH, 'utf8');
  assert.match(html, /<meta[^>]*name=["']dashboard-token["'][^>]*content=["']__DASHBOARD_TOKEN__["']/);
  assert.match(html, /fetch\(\s*['"]\/notes['"]/);
  assert.match(html, /['"]x-dashboard-token['"]\s*:/);
  assert.match(html, /addEventListener\(\s*['"]inbox['"]/);
});
