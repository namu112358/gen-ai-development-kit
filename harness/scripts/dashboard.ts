/**
 * エージェントの状態をグラフで見る、手元のダッシュボード（GitHub に書くのは POST /decisions の決定の記録のコメントだけで、気づきは手元の受け箱に書く）。
 *
 *   node harness/scripts/dashboard.ts [--port 4177] [--interval 30] [--min-remaining 0.3]
 *
 * 127.0.0.1 で待ち受け、表示した URL をブラウザで開く。GitHub は条件付きリクエストで --interval 秒ごとに確かめ、
 * 変わった Issue / PR だけ組み直して Server-Sent Events で差分を送る。手元のセッション記録（~/.claude/projects）も見張る。
 * API の上限の残りが --min-remaining の割合を切ったらリセットまで読まず、失敗の後は backoff + jitter で遅らせ、
 * ブラウザの接続が0の間は GitHub を読まない。気づきを送る欄（POST /notes）は手元の受け箱に書き、人がすることへの答え（POST /decisions）は決定の記録のコメントを1件だけ投稿する。どちらも Host・Origin・起動ごとの合言葉で確かめる。
 * 詳しくは harness/scripts/dashboard/README.md。
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { gitCommonDir } from '../lib/local-state.ts';
import { mainRepoRoot, worktreeRoot } from '../lib/worktree.ts';
import { buildGraph, diffGraphs, type Graph, type GraphEvent } from './dashboard/graph.ts';
import { CommentOnlyTransport, createDecisionSink, type DecisionSink } from './dashboard/decision.ts';
import { DashboardData, ReadOnlyTransport, UpdateWatcher } from './dashboard/github.ts';
import { Inbox, inboxDir } from './dashboard/inbox.ts';
import { limitFetch, RateLimitedTransport, RateLimitState } from './dashboard/rate-limit.ts';
import { PollScheduler, type PollStatus } from './dashboard/scheduler.ts';
import { readSessions, watchSessions } from './dashboard/sessions.ts';
import { resolveRepository } from '../lib/repository.ts';

export const PAGE_PATH: string = fileURLToPath(new URL('./dashboard/page.html', import.meta.url));

export interface DashboardServer {
  url: string;
  port: number;
  publish(events: GraphEvent[]): void;
  /** 任意の種類のイベントを全部の接続に送る */
  send(type: string, data: unknown): void;
  /** いまの /events の接続の数 */
  clients(): number;
  close(): Promise<void>;
}

/** DNS rebinding で別のサイトから読まれないよう、Host が 127.0.0.1 / localhost のこのポートのものだけに応える */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** 書く要求（POST）の Origin。http://127.0.0.1:<port> か http://localhost:<port> に完全に一致するときだけ（Origin が無い・null・別のサイトは偽） */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** 起動ごとの合言葉と一致するか。timingSafeEqual で比べ、長さが違う・無いときは偽 */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 起動ごとの合言葉（ページに埋めて配る。ログには出さない） */
export function newDashboardToken(): string {
  return randomBytes(32).toString('hex');
}

/** 受け箱の未読の数を数え直す間隔（ms） */
const INBOX_POLL_MS = 5000;

/** POST /notes の本文の上限（バイト） */
export const NOTES_BODY_LIMIT = 16 * 1024;

/** 気づきを送る欄の受け皿。token はページの合言葉、add は受け箱に1件書く（空などで投げたら 400）、unread は受け箱の未読の数 */
export interface NotesSink {
  token: string;
  add(text: string): { id: string };
  unread(): number;
}

const PLAIN = { 'content-type': 'text/plain; charset=utf-8' } as const;

/** 本文を NOTES_BODY_LIMIT まで読む。超えたら null（読み続けない） */
function readLimitedBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > NOTES_BODY_LIMIT) {
        chunks.length = 0;
        req.removeAllListeners('data');
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 127.0.0.1 で待ち受ける。port 0 なら空いたポート。snapshot() は /events の接続時に送る全体、
 * status() はその後に送る見張りの状態（event: status）。onConnect は接続のたびに呼ぶ
 */
export function startServer(opts: { port: number; html: string; snapshot: () => Graph; status?: () => unknown; onConnect?: () => void; notes?: NotesSink; decisions?: DecisionSink }): Promise<DashboardServer> {
  const clients = new Set<ServerResponse>();
  let port = opts.port;
  const notes = opts.notes;
  const decisions = opts.decisions;
  if (notes && decisions && notes.token !== decisions.token) return Promise.reject(new Error('notes と decisions の合言葉が違います'));
  // 合言葉の置き場所（meta）は、受け箱か決定の受け皿があるときだけ埋める
  const pageToken = (notes ?? decisions)?.token;
  const html = pageToken !== undefined ? opts.html.replace('__DASHBOARD_TOKEN__', () => pageToken) : opts.html;
  const broadcast = (type: string, data: unknown) => {
    const chunk = sse(type, data);
    for (const c of clients) c.write(chunk);
  };
  /** 受け箱に書かずに断る。本文は読まず、応答の後に接続を切る */
  const refuse = (req: IncomingMessage, res: ServerResponse, status: number, text: string) => {
    res.writeHead(status, { ...PLAIN, connection: 'close' }).end(text, () => req.destroy());
  };
  const deny = (req: IncomingMessage, res: ServerResponse, status: number, text: string): null => {
    refuse(req, res, status, text);
    return null;
  };
  /** 書く要求の確かめ（Origin → 合言葉 → content-type → サイズ）。断ったら refuse で返して null、通れば本文 */
  const readGuardedBody = async (req: IncomingMessage, res: ServerResponse, token: string): Promise<string | null> => {
    if (!isAllowedOrigin(req.headers.origin, port)) return deny(req, res, 403, 'forbidden');
    const given = req.headers['x-dashboard-token'];
    if (!tokenMatches(typeof given === 'string' ? given : undefined, token)) return deny(req, res, 403, 'forbidden');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') return deny(req, res, 415, 'unsupported media type');
    if (Number(req.headers['content-length'] ?? 0) > NOTES_BODY_LIMIT) return deny(req, res, 413, 'payload too large');
    const body = await readLimitedBody(req);
    if (body === null) return deny(req, res, 413, 'payload too large');
    return body;
  };
  const postDecision = async (sink: DecisionSink, req: IncomingMessage, res: ServerResponse) => {
    const body = await readGuardedBody(req, res, sink.token);
    if (body === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      return refuse(req, res, 400, 'bad request');
    }
    const r = await sink.submit(raw);
    res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(r.body));
  };
  const postNote = async (sink: NotesSink, req: IncomingMessage, res: ServerResponse) => {
    const body = await readGuardedBody(req, res, sink.token);
    if (body === null) return;
    let text: unknown;
    try {
      text = (JSON.parse(body) as { text?: unknown } | null)?.text;
    } catch {
      text = undefined;
    }
    if (typeof text !== 'string') return refuse(req, res, 400, 'bad request');
    let id: string;
    try {
      id = sink.add(text).id;
    } catch {
      return refuse(req, res, 400, 'bad request');
    }
    const unread = sink.unread();
    res.writeHead(201, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify({ id, unread }));
    broadcast('inbox', { unread });
  };
  const server = createServer((req, res) => {
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, PLAIN).end('forbidden');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
      return;
    }
    if (notes && req.method === 'POST' && path === '/notes') {
      postNote(notes, req, res).catch(() => {
        if (!res.headersSent) refuse(req, res, 500, 'error');
      });
      return;
    }
    if (decisions && req.method === 'POST' && path === '/decisions') {
      postDecision(decisions, req, res).catch(() => {
        if (!res.headersSent) refuse(req, res, 500, 'error');
      });
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(sse('snapshot', opts.snapshot()));
      if (opts.status) res.write(sse('status', opts.status()));
      if (notes) res.write(sse('inbox', { unread: notes.unread() }));
      clients.add(res);
      req.on('close', () => clients.delete(res));
      opts.onConnect?.();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        publish(events) {
          for (const e of events) {
            const chunk = sse(e.type, e);
            for (const c of clients) c.write(chunk);
          }
        },
        send: broadcast,
        clients: () => clients.size,
        close() {
          for (const c of clients) c.end();
          clients.clear();
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

function repository(): string {
  const r = resolveRepository(process.env.GITHUB_REPOSITORY, () => spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '');
  if (!r.ok) throw new Error(r.error);
  return r.repository;
}

function token(): string {
  const env = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  const t = (r.stdout ?? '').trim();
  if (r.status !== 0 || !t) throw new Error('GitHub のトークンが見つかりません（gh auth login をするか、GH_TOKEN を設定してください）');
  return t;
}

function option(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} は数で指定してください`);
  return v;
}

/** 起動の引数。--interval は既定 30 秒で 5 秒より短ければ 5 秒に丸める。--min-remaining は 0〜1 の割合（既定 0.3） */
export function parseOptions(args: string[]): { port: number; intervalMs: number; minRemaining: number } {
  const minRemaining = option(args, '--min-remaining', 0.3);
  if (minRemaining > 1) throw new Error('--min-remaining は 0〜1 の割合で指定してください');
  return { port: option(args, '--port', 4177), intervalMs: Math.max(5, option(args, '--interval', 30)) * 1000, minRemaining };
}

async function main(args: string[]): Promise<void> {
  const { port, intervalMs, minRemaining } = parseOptions(args);
  const config = loadConfig();
  const repo = repository();
  const repoRoot = mainRepoRoot();
  // worktree の置き場所は起動時に1回だけ決める（リポジトリの中なら、サーバーを立てずに止まる）
  const worktreesDir = worktreeRoot(repoRoot, config, process.env);
  // 受け箱の置き場所も起動時に1回だけ決める（共通ディレクトリが取れなければ、サーバーを立てずに止まる）
  const commonDir = gitCommonDir();
  if (commonDir === null) throw new Error('git の共通ディレクトリが取れません（git のリポジトリの中で起動してください）');
  const inbox = new Inbox(inboxDir(commonDir));
  const notes: NotesSink = { token: newDashboardToken(), add: (text) => inbox.add(text), unread: () => inbox.unread() };
  const projectsDir = join(homedir(), '.claude', 'projects');
  const tok = token();
  const limits = new RateLimitState({ minRemaining });
  const gh = new GitHub(new ReadOnlyTransport(new RateLimitedTransport({ fetch: (url, init) => fetch(url, init), token: tok, state: limits })), repo);
  const write = new GitHub(new CommentOnlyTransport(new RateLimitedTransport({ fetch: (url, init) => fetch(url, init), token: tok, state: limits }), repo), repo);
  const decisions = createDecisionSink({ config, read: gh, write, token: notes.token });
  const data = new DashboardData(gh, config);
  const watcher = new UpdateWatcher({ fetch: limitFetch((url, init) => fetch(url, init), limits), token: tok, repository: repo });

  const build = (): Graph => buildGraph(data.issues(), data.prs(), readSessions({ projectsDir, repoRoot, worktreesDir, now: new Date() }), { now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours, progress: data.progress() });
  let graph = build();
  let scheduler: PollScheduler | null = null;
  const server = await startServer({
    port,
    html: readFileSync(PAGE_PATH, 'utf8'),
    snapshot: () => graph,
    status: () => scheduler?.status() ?? { state: 'running' },
    onConnect: () => void scheduler?.wake(),
    notes,
    decisions,
  });
  console.log(`ダッシュボード: ${server.url}（${repo}、${intervalMs / 1000} 秒ごとに確かめます。ブラウザで開いている間だけ読みます。止めるには Ctrl+C）`);

  const rebuild = () => {
    const next = build();
    const events = diffGraphs(graph, next);
    graph = next;
    if (events.length > 0) server.publish(events);
  };

  let busy = false;
  const run = async () => {
    busy = true;
    try {
      const r = await watcher.poll();
      if (r.kind === 'full') await data.loadAll();
      else if (r.kind === 'changed') await data.refresh(r.numbers);
      if (r.kind !== 'unchanged') {
        await data.loadProgress(new Date());
        rebuild();
      }
      watcher.commit();
    } finally {
      busy = false;
    }
  };
  const describe = (s: PollStatus) =>
    s.state === 'paused' ? `上限（${s.resource}）の残りが少ないため ${new Date(s.until).toLocaleTimeString()} まで読みません`
      : s.state === 'backoff' ? `${new Date(s.until).toLocaleTimeString()} に読み直します（${s.attempt} 回目の失敗）`
      : '読み直しを再開しました';
  scheduler = new PollScheduler({
    intervalMs,
    run,
    state: limits,
    connections: () => server.clients(),
    onStatus: (s) => {
      console.log(describe(s));
      server.send('status', s);
    },
    onError: (e) => console.error(`更新に失敗しました: ${e.message}`),
  });
  void scheduler.wake();
  // GitHub の材料を読み直している間は途中の状態を出さない（読み終えた tick が組み直す）
  const stopWatch = watchSessions(projectsDir, () => { if (!busy) rebuild(); });
  // intel が読んだ印を付けた分を画面に返す（変わったときだけ送る）
  let lastUnread = notes.unread();
  const inboxTimer = setInterval(() => {
    const n = notes.unread();
    if (n !== lastUnread) {
      lastUnread = n;
      server.send('inbox', { unread: n });
    }
  }, INBOX_POLL_MS);
  const stop = async () => {
    clearInterval(inboxTimer);
    scheduler?.stop();
    stopWatch();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
