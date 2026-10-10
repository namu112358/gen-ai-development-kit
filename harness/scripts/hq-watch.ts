/**
 * hq の見張り（Issue #559）。hq がターンを終える前に、Bash の run_in_background で必ず置く。
 *
 *   node harness/scripts/hq-watch.ts [--ack <delivery_id>] [--timeout-ms <n>（既定 900000）] [--terminal <handle>]
 *
 * - Orca の `orchestration check --wait` を回す。heartbeat だけの束は、一言を hq-heartbeat.json に控えて ack し、待ちに戻る（hq は起こさない）。
 * - heartbeat 以外の行が入った束（question・escalation・worker_done・status）か、結びつかない一言のある束は、ack せずに標準出力へ
 *   `{"wake":"messages",...}` を書いて終わる（hq が処理して ack する）。区切りまで何も来なければ `{"wake":"timeout"}`。
 * - Orca が失敗したら標準エラーに1行書いて終了コード 1。
 * - 区切りは起動からの全体の締め切り。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { orcaCliCommand } from '../lib/worktree.ts';
import { gitCommonDir, heartbeatPath, readHeartbeatAt, readLedgerFile, recordHeartbeat, writeJson, type HqLedger } from './hq-state.ts';

export const WATCH_TYPES = 'worker_done,escalation,question,status,heartbeat';
const DEFAULT_TIMEOUT_MS = 900_000;

export interface CheckMessage { id: string; type: string; from_handle?: string; subject?: string; body?: string; payload?: unknown }
export type CheckResult = { ok: true; deliveryId: string | null; messages: CheckMessage[] } | { ok: false; error: string };
export interface WorkerRow { dispatchId: string; agentTerminalHandle: string | null }
export interface WatchOpts { ack: string | null; timeoutMs: number; terminal: string | null }
export type WatchOutcome =
  | { wake: 'messages'; deliveryId: string; messages: CheckMessage[] }
  | { wake: 'timeout' }
  | { wake: 'error'; error: string };
export interface WatchDeps {
  check(args: string[]): CheckResult;
  workers(runId: string): WorkerRow[] | null;
  saveNote(theme: string, note: string): void;
  ledger(): HqLedger | null;
  now(): number;
}

/** 束を分ける：空・heartbeat だけ・それ以外を含む */
export function classifyDelivery(r: { deliveryId: string | null; messages: CheckMessage[] }):
  { kind: 'empty' } | { kind: 'heartbeat-only'; deliveryId: string; heartbeats: CheckMessage[] } | { kind: 'wake'; deliveryId: string; messages: CheckMessage[] } {
  if (r.messages.length === 0 || r.deliveryId === null) return { kind: 'empty' };
  if (r.messages.every((m) => m.type === 'heartbeat')) return { kind: 'heartbeat-only', deliveryId: r.deliveryId, heartbeats: r.messages };
  return { kind: 'wake', deliveryId: r.deliveryId, messages: r.messages };
}

/** heartbeat の送り手から、ledger のテーマを引く。引けなければ null */
export function themeForHeartbeat(m: CheckMessage, ledger: HqLedger | null, workers: WorkerRow[] | null): string | null {
  if (!ledger || !m.from_handle) return null;
  let dispatch: string | null = null;
  if (m.from_handle.startsWith('dispatch:')) dispatch = m.from_handle.slice('dispatch:'.length);
  else dispatch = workers?.find((w) => w.agentTerminalHandle === m.from_handle)?.dispatchId ?? null;
  if (!dispatch) return null;
  const fleet = ledger.fleets.find((f) => f.dispatch === dispatch);
  return fleet && typeof fleet.theme === 'string' && fleet.theme ? fleet.theme : null;
}

export function checkArgs(opts: WatchOpts): string[] {
  const args = ['orchestration', 'check', '--wait', '--types', WATCH_TYPES, '--timeout-ms', String(opts.timeoutMs), '--json'];
  if (opts.ack) args.push('--ack', opts.ack);
  if (opts.terminal) args.push('--terminal', opts.terminal);
  return args;
}

export function watch(deps: WatchDeps, opts: WatchOpts): WatchOutcome {
  const deadline = deps.now() + opts.timeoutMs;
  let ack = opts.ack;
  let workersCache: { runId: string; rows: WorkerRow[] | null } | null = null;
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { wake: 'timeout' };
    const r = deps.check(checkArgs({ ack, timeoutMs: remaining, terminal: opts.terminal }));
    ack = null;
    if (!r.ok) return { wake: 'error', error: r.error };
    if (r.messages.length > 0 && r.deliveryId === null) return { wake: 'error', error: '便りに deliveryId がありません' };
    const c = classifyDelivery(r);
    if (c.kind === 'empty') return { wake: 'timeout' };
    if (c.kind === 'wake') return { wake: 'messages', deliveryId: c.deliveryId, messages: c.messages };
    // heartbeat だけの束：本文のあるものがすべてテーマに結びつくときだけ控えて ack する
    const ledger = deps.ledger();
    const withBody = c.heartbeats.filter((m) => (m.body ?? '').trim() !== '');
    let workers: WorkerRow[] | null = null;
    if (ledger?.runId && withBody.some((m) => !m.from_handle?.startsWith('dispatch:'))) {
      if (!workersCache || workersCache.runId !== ledger.runId) workersCache = { runId: ledger.runId, rows: deps.workers(ledger.runId) };
      workers = workersCache.rows;
    }
    const notes = withBody.map((m) => ({ theme: themeForHeartbeat(m, ledger, workers), note: (m.body ?? '').trim() }));
    if (notes.some((n) => n.theme === null)) return { wake: 'messages', deliveryId: c.deliveryId, messages: c.heartbeats };
    for (const n of notes) deps.saveNote(n.theme as string, n.note);
    ack = c.deliveryId;
  }
}

// ---- CLI（import.meta.main の中だけで動く） ----

function orcaJson(args: string[], timeoutMs: number): { ok: true; result: Record<string, unknown> } | { ok: false; error: string } {
  const r = spawnSync(orcaCliCommand(process.platform, process.env), args, { shell: false, encoding: 'utf8', timeout: timeoutMs + 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, error: `Orca を起動できません：${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `Orca が終了コード ${r.status ?? '(シグナル)'} で終わりました：${(r.stderr ?? '').trim().split('\n')[0] ?? ''}` };
  let j: unknown;
  try {
    j = JSON.parse(r.stdout ?? '');
  } catch {
    return { ok: false, error: 'Orca の出力が JSON として読めません' };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, error: 'Orca の出力が JSON として読めません' };
  const o = j as Record<string, unknown>;
  if (o.ok === false) return { ok: false, error: `Orca がエラーを返しました：${JSON.stringify(o.error ?? o).slice(0, 200)}` };
  const result = o.result;
  return { ok: true, result: typeof result === 'object' && result !== null && !Array.isArray(result) ? (result as Record<string, unknown>) : {} };
}

function takeOpts(argv: string[]): WatchOpts {
  const opts: WatchOpts = { ack: null, timeoutMs: DEFAULT_TIMEOUT_MS, terminal: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--ack' && v) { opts.ack = v; i++; }
    else if (a === '--terminal' && v) { opts.terminal = v; i++; }
    else if (a === '--timeout-ms' && v && Number.isFinite(Number(v)) && Number(v) > 0) { opts.timeoutMs = Number(v); i++; }
    else throw new Error(`使い方：hq-watch.ts [--ack <delivery_id>] [--timeout-ms <n>] [--terminal <handle>]（読めない引数：${a}）`);
  }
  return opts;
}

if (import.meta.main) {
  try {
    const opts = takeOpts(process.argv.slice(2));
    const commonDir = gitCommonDir(process.cwd());
    const deps: WatchDeps = {
      check(args) {
        const o = orcaJson(args, Number(args[args.indexOf('--timeout-ms') + 1]));
        if (!o.ok) return o;
        const messages = Array.isArray(o.result.messages) ? (o.result.messages as CheckMessage[]) : [];
        const deliveryId = typeof o.result.deliveryId === 'string' ? o.result.deliveryId : null;
        return { ok: true, deliveryId, messages };
      },
      workers(runId) {
        const o = orcaJson(['orchestration', 'worker-list', '--run', runId, '--json'], 15_000);
        if (!o.ok || !Array.isArray(o.result.workers)) return null;
        return (o.result.workers as Record<string, unknown>[])
          .filter((w) => typeof w.dispatchId === 'string')
          .map((w) => ({ dispatchId: w.dispatchId as string, agentTerminalHandle: typeof w.agentTerminalHandle === 'string' ? w.agentTerminalHandle : null }));
      },
      saveNote(theme, note) {
        if (!commonDir) throw new Error('git の共通ディレクトリが見つかりません');
        const path = heartbeatPath(commonDir);
        writeJson(path, recordHeartbeat(readHeartbeatAt(path), theme, note, new Date().toISOString()));
      },
      ledger: () => (commonDir ? readLedgerFile(commonDir) : null),
      now: () => Date.now(),
    };
    const out = watch(deps, opts);
    if (out.wake === 'error') {
      console.error(out.error);
      process.exit(1);
    }
    console.log(JSON.stringify(out));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
