/**
 * エージェントの状態をグラフで見る、手元の読み取り専用のダッシュボード（GitHub には書かない）。
 *
 *   node harness/scripts/dashboard.ts [--port 4177] [--interval 30] [--min-remaining 0.3]
 *
 * 127.0.0.1 で待ち受け、表示した URL をブラウザで開く。GitHub は条件付きリクエストで --interval 秒ごとに確かめ、
 * 変わった Issue / PR だけ組み直して Server-Sent Events で差分を送る。手元のセッション記録（~/.claude/projects）も見張る。
 * API の上限の残りが --min-remaining の割合を切ったらリセットまで読まず、失敗の後は backoff + jitter で遅らせ、
 * ブラウザの接続が0の間は GitHub を読まない。
 * 詳しくは harness/scripts/dashboard/README.md。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { worktreeRoot } from '../lib/worktree.ts';
import { buildGraph, diffGraphs, type Graph, type GraphEvent } from './dashboard/graph.ts';
import { DashboardData, ReadOnlyTransport, UpdateWatcher } from './dashboard/github.ts';
import { limitFetch, RateLimitedTransport, RateLimitState } from './dashboard/rate-limit.ts';
import { PollScheduler, type PollStatus } from './dashboard/scheduler.ts';
import { readSessions, watchSessions } from './dashboard/sessions.ts';

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

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * 127.0.0.1 で待ち受ける。port 0 なら空いたポート。snapshot() は /events の接続時に送る全体、
 * status() はその後に送る見張りの状態（event: status）。onConnect は接続のたびに呼ぶ
 */
export function startServer(opts: { port: number; html: string; snapshot: () => Graph; status?: () => unknown; onConnect?: () => void }): Promise<DashboardServer> {
  const clients = new Set<ServerResponse>();
  let port = opts.port;
  const server = createServer((req, res) => {
    if (!isAllowedHost(req.headers.host, port)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(opts.html);
      return;
    }
    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(sse('snapshot', opts.snapshot()));
      if (opts.status) res.write(sse('status', opts.status()));
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
        send(type, data) {
          const chunk = sse(type, data);
          for (const c of clients) c.write(chunk);
        },
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
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
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
  const repoRoot = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim().replace(/\/\.git$/, '');
  // worktree の置き場所は起動時に1回だけ決める（リポジトリの中なら、サーバーを立てずに止まる）
  const worktreesDir = worktreeRoot(repoRoot, config, process.env);
  const projectsDir = join(homedir(), '.claude', 'projects');
  const tok = token();
  const limits = new RateLimitState({ minRemaining });
  const gh = new GitHub(new ReadOnlyTransport(new RateLimitedTransport({ fetch: (url, init) => fetch(url, init), token: tok, state: limits })), repo);
  const data = new DashboardData(gh, config);
  const watcher = new UpdateWatcher({ fetch: limitFetch((url, init) => fetch(url, init), limits), token: tok, repository: repo });

  const build = (): Graph => buildGraph(data.issues(), data.prs(), readSessions({ projectsDir, repoRoot, worktreesDir, now: new Date() }), { now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours });
  let graph = build();
  let scheduler: PollScheduler | null = null;
  const server = await startServer({
    port,
    html: readFileSync(PAGE_PATH, 'utf8'),
    snapshot: () => graph,
    status: () => scheduler?.status() ?? { state: 'running' },
    onConnect: () => void scheduler?.wake(),
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
      if (r.kind !== 'unchanged') rebuild();
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
  const stop = async () => {
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
