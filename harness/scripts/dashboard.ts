/**
 * エージェントの状態をグラフで見る、手元の読み取り専用のダッシュボード（GitHub には書かない）。
 *
 *   node harness/scripts/dashboard.ts [--port 4177] [--interval 5]
 *
 * 127.0.0.1 で待ち受け、表示した URL をブラウザで開く。GitHub は条件付きリクエストで --interval 秒ごとに確かめ、
 * 変わった Issue / PR だけ組み直して Server-Sent Events で差分を送る。手元のセッション記録（~/.claude/projects）も見張る。
 * 詳しくは harness/scripts/dashboard/README.md。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.ts';
import { FetchTransport, GitHub } from '../lib/github.ts';
import { buildGraph, diffGraphs, type Graph, type GraphEvent } from './dashboard/graph.ts';
import { DashboardData, ReadOnlyTransport, UpdateWatcher } from './dashboard/github.ts';
import { readSessions, watchSessions } from './dashboard/sessions.ts';

export const PAGE_PATH: string = fileURLToPath(new URL('./dashboard/page.html', import.meta.url));

export interface DashboardServer {
  url: string;
  port: number;
  publish(events: GraphEvent[]): void;
  close(): Promise<void>;
}

/** DNS rebinding で別のサイトから読まれないよう、Host が 127.0.0.1 / localhost のこのポートのものだけに応える */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** 127.0.0.1 で待ち受ける。port 0 なら空いたポート。snapshot() は /events の接続時に送る全体 */
export function startServer(opts: { port: number; html: string; snapshot: () => Graph }): Promise<DashboardServer> {
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
      clients.add(res);
      req.on('close', () => clients.delete(res));
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

async function main(args: string[]): Promise<void> {
  const port = option(args, '--port', 4177);
  const intervalMs = Math.max(2, option(args, '--interval', 5)) * 1000;
  const config = loadConfig();
  const repo = repository();
  const repoRoot = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim().replace(/\/\.git$/, '');
  const projectsDir = join(homedir(), '.claude', 'projects');
  const tok = token();
  const gh = new GitHub(new ReadOnlyTransport(new FetchTransport(tok)), repo);
  const data = new DashboardData(gh, config);
  const watcher = new UpdateWatcher({ fetch: (url, init) => fetch(url, init), token: tok, repository: repo });

  const build = (): Graph => buildGraph(data.issues(), data.prs(), readSessions({ projectsDir, repoRoot, now: new Date() }), { now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours });
  let graph = build();
  const server = await startServer({ port, html: readFileSync(PAGE_PATH, 'utf8'), snapshot: () => graph });
  console.log(`ダッシュボード: ${server.url}（${repo}、${intervalMs / 1000} 秒ごとに確かめます。止めるには Ctrl+C）`);

  const rebuild = () => {
    const next = build();
    const events = diffGraphs(graph, next);
    graph = next;
    if (events.length > 0) server.publish(events);
  };

  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await watcher.poll();
      if (r.kind === 'full') await data.loadAll();
      else if (r.kind === 'changed') await data.refresh(r.numbers);
      if (r.kind !== 'unchanged') rebuild();
    } catch (e) {
      console.error(`更新に失敗しました（次の問い合わせで続けます）: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  await tick();
  const timer = setInterval(tick, intervalMs);
  // GitHub の材料を読み直している間は途中の状態を出さない（読み終えた tick が組み直す）
  const stopWatch = watchSessions(projectsDir, () => { if (!busy) rebuild(); });
  const stop = async () => {
    clearInterval(timer);
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
