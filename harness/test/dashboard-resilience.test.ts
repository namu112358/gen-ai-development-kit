// Issue #885：手元のダッシュボードが、受け箱の未読の数の読み取りや進みの帯の問い合わせの失敗で止まらないこと。
// /events の接続時に unread が投げても接続を続ける、POST /notes の書き込みの後に unread が投げても 201、
// createInboxPoller が unread の失敗を onError に渡して続ける、createPollRun が loadProgress の失敗でも組み直しと見張りの確定を行い、次の回でやり直す
import assert from 'node:assert/strict';
import { request, type IncomingMessage } from 'node:http';
import { test } from 'node:test';
import { createInboxPoller, createPollRun, startServer } from '../scripts/dashboard.ts';
import type { PollResult } from '../scripts/dashboard/github.ts';
import { COLUMNS, type Graph } from '../scripts/dashboard/graph.ts';

const HTML = '<!doctype html><title>dash</title><p>test-page</p>';
const TOKEN = 'a'.repeat(64);
const snapshot = (): Graph => ({ columns: COLUMNS, tasks: [], edges: [], sessions: [], todos: [], progress: { epics: null, mergedToday: null, running: { sessions: 0, subagents: 0 } } });

function send(port: number, o: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ res: IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: o.path, method: o.method, headers: { host: `127.0.0.1:${port}`, ...o.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ res, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end(o.body);
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

test('/events：接続時に notes.unread() が投げても onError に渡して接続を続け、snapshot・status は送り inbox は送らない。その後も / に応える', async () => {
  const errors: Error[] = [];
  const notes = { token: TOKEN, add: () => ({ id: 'x' }), unread: (): number => { throw new Error('受け箱が読めない'); } };
  const s = await startServer({ port: 0, html: HTML, snapshot, status: () => ({ state: 'running' }), notes, onError: (e) => errors.push(e) });
  try {
    const c = connect(s.port);
    try {
      const buf = await c.until((b) => /event: status\ndata: .*\n\n/.test(b));
      assert.match(buf, /event: snapshot\n/);
      assert.doesNotMatch(buf, /event: inbox\n/);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!.message, /受け箱が読めない/);
      assert.equal(s.clients(), 1, '接続は続いている');
    } finally {
      c.close();
    }
    const r = await send(s.port, { method: 'GET', path: '/' });
    assert.equal(r.res.statusCode, 200);
    assert.match(r.body, /test-page/);
  } finally {
    await s.close();
  }
});

test('createInboxPoller：unread が投げても tick は投げず onError に渡してその回は送らず、次に読めた回に変わっていれば送る', () => {
  // 各回の unread の結果（数か、投げる）。最初の1つは作るときの読み取り
  const cases: { name: string; seq: (number | 'throw')[]; sent: number[]; errors: number }[] = [
    { name: '途中の回が投げる', seq: [0, 'throw', 2, 2], sent: [2], errors: 1 },
    { name: '途中の回が投げ、次に読めた数が前と同じ', seq: [1, 'throw', 1], sent: [], errors: 1 },
    { name: '最初の読み取りが投げる', seq: ['throw', 0, 0], sent: [0], errors: 1 },
  ];
  for (const c of cases) {
    let i = 0;
    const sent: number[] = [];
    const errors: Error[] = [];
    const poller = createInboxPoller({
      unread: () => {
        const v = c.seq[i++]!;
        if (v === 'throw') throw new Error('受け箱が読めない');
        return v;
      },
      send: (n) => sent.push(n),
      onError: (e) => errors.push(e),
    });
    while (i < c.seq.length) assert.doesNotThrow(() => poller.tick(), c.name);
    assert.deepEqual(sent, c.sent, c.name);
    assert.equal(errors.length, c.errors, c.name);
    assert.ok(errors.every((e) => e instanceof Error), c.name);
  }
});

test('POST /notes：add が成功した後に unread が投げても 201 で id を返し（unread は付けない）、add は1回だけ、onError に渡す', async () => {
  const errors: Error[] = [];
  let adds = 0;
  const notes = {
    token: TOKEN,
    add: () => { adds++; return { id: 'note-1' }; },
    unread: (): number => { throw new Error('受け箱が読めない'); },
  };
  const s = await startServer({ port: 0, html: HTML, snapshot, onError: (e) => errors.push(e), notes });
  try {
    const r = await send(s.port, {
      method: 'POST',
      path: '/notes',
      headers: { origin: `http://127.0.0.1:${s.port}`, 'x-dashboard-token': TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '気づき' }),
    });
    assert.equal(r.res.statusCode, 201);
    const json = JSON.parse(r.body) as Record<string, unknown>;
    assert.equal(json.id, 'note-1');
    assert.equal('unread' in json, false);
    assert.equal(adds, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /受け箱が読めない/);
  } finally {
    await s.close();
  }
});

test('createPollRun：loadProgress が投げても rebuild と commit を行ってから同じエラーで reject し、次の回は unchanged でも loadProgress と rebuild をやり直す', async () => {
  const calls: string[] = [];
  const polls: PollResult[] = [{ kind: 'changed', numbers: [7] }, { kind: 'unchanged' }];
  const boom = new Error('進みの帯が読めない');
  let progressFails = true;
  const progressErrors: Error[] = [];
  const run = createPollRun({
    watcher: {
      poll: async () => { calls.push('poll'); return polls.shift()!; },
      commit: () => { calls.push('commit'); },
    },
    data: {
      loadAll: async () => { calls.push('loadAll'); },
      refresh: async (numbers: number[]) => { calls.push(`refresh:${numbers.join(',')}`); },
      loadProgress: async () => {
        calls.push('loadProgress');
        if (progressFails) throw boom;
      },
    },
    rebuild: () => { calls.push('rebuild'); },
    now: () => new Date('2026-10-12T00:00:00Z'),
    onProgressError: (e) => progressErrors.push(e),
  });

  await assert.rejects(run(), (e: unknown) => e === boom);
  assert.deepEqual(calls, ['poll', 'refresh:7', 'loadProgress', 'rebuild', 'commit']);
  assert.deepEqual(progressErrors, [boom]);

  calls.length = 0;
  progressFails = false;
  await run();
  assert.deepEqual(calls, ['poll', 'loadProgress', 'rebuild', 'commit'], '前の回の失敗を覚えていて、unchanged でもやり直す');
  assert.equal(progressErrors.length, 1);
});
