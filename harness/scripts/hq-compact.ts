/**
 * hq が fleet と hq 自身の端末へ `/compact` を送る判定と送り方（Issue #737）。長く動く fleet・hq の context を縮める。
 *
 *   node harness/scripts/hq-compact.ts fleet --theme <テーマ> [--dry-run]（標準出力に { theme, decision, sent } の JSON）
 *
 * - 送るのは、前に縮めてから（無ければ起こしてから）hq.compactMinutes（既定 180 分）以上経ち、受け持ちの Issue に plan-gate 以外の着手宣言が無く、
 *   端末がターンを終えている（Orca の tui-idle）ときだけ。ターンの途中・ship が動いている間は送らない。
 * - hq 自身は hq-watch.ts が timeout で戻る切れ目で maybeCompactHq を呼ぶ。縮めた記録は git の共通ディレクトリの下の agent-harness/hq/hq-compact.json
 *   （hq の控え hq-fleets.json とは別のファイル。ledger-save で消えない）。
 * - 判定は純粋関数で、Orca・GitHub を呼ぶ部分は deps で差し替える。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.ts';
import type { FleetStatusRow } from '../lib/fleet.ts';
import { writeLocalJson } from '../lib/local-state.ts';
import { orcaCliCommand } from '../lib/worktree.ts';
import { gitCommonDir, hqStateDir, readLedgerFile, type HqLedger } from './hq-state.ts';

export const HQ_COMPACT_DEFAULTS = { compactMinutes: 180 } as const;
export const IDLE_PROBE_MS = 5000;
export const COMPACT_SETTLE_MS = 15_000;
export const COMPACT_WAIT_MS = 600_000;

export const FLEET_COMPACT_NOTE = 'hq の Orca の worker の fleet。前置き（実行ファイル・Task ID・Dispatch ID・handle・capability）、受け持つ Epic と Issue の集合、各 Issue の段階と次にすること、hq への返事待ちの質問を残す。縮めた後は `node harness/scripts/hq-state.ts ledger` の自分の Dispatch の要素と `fleet-status` を読み直して続ける';
export const HQ_COMPACT_NOTE = 'hq。控えの場所（`hq-state.ts ledger`）、hq の Run と端末の handle、人に聞いている質問と返せていない答え、見張りを必ず置くことを残す。縮めた後は控えを読み直して手順8から続ける';

/** hq の節から縮める間隔（分）を読む（無ければ既定値）。正の整数でなければ throw する */
export function hqCompactConfig(config: { hq?: unknown }): { compactMinutes: number } {
  const raw = config.hq;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('hq はオブジェクトで書いてください');
  const v = (raw as Record<string, unknown> | undefined)?.compactMinutes ?? HQ_COMPACT_DEFAULTS.compactMinutes;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error('hq.compactMinutes は正の整数（分）で書いてください');
  return { compactMinutes: v };
}

export type CompactReason = 'due' | 'not-due' | 'busy' | 'not-idle' | 'unknown-start';
export interface CompactDecision { send: boolean; reason: CompactReason; busy?: number[] }

/** 動いている着手宣言（plan-gate は App の計画ゲート待ちなので数えない。宣言の stage が null なら動いているとみなす）のある行の Issue 番号 */
export function busyIssues(rows: FleetStatusRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const active = [r.claim, r.prClaim].some((c) => c !== null && c !== undefined && c.stage !== 'plan-gate');
    if (active) out.push(r.issue);
  }
  return out;
}

const ms = (iso: string | null): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 順は 基準 → 経過 → busy → idle。not-due なら busy・idle を呼ばない（Orca・GitHub を使いすぎない） */
export function compactDecision(a: {
  now: number; lastAt: string | null; startedAt: string | null; compactMinutes: number; busy: () => number[]; idle: () => boolean | null;
}): CompactDecision {
  const times = [ms(a.lastAt), ms(a.startedAt)].filter((t): t is number => t !== null);
  if (times.length === 0) return { send: false, reason: 'unknown-start' };
  if (a.now - Math.max(...times) < a.compactMinutes * 60_000) return { send: false, reason: 'not-due' };
  const busy = a.busy();
  if (busy.length > 0) return { send: false, reason: 'busy', busy };
  if (a.idle() !== true) return { send: false, reason: 'not-idle' };
  return { send: true, reason: 'due' };
}

// ---- 記録 ----

export interface CompactFile {
  version: 1;
  fleets: Record<string, { at: string; count: number; dispatch: string }>;
  hq: { session: string; at: string; count: number } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseCompactFile(v: unknown): CompactFile | null {
  if (!isObj(v) || v.version !== 1 || !isObj(v.fleets)) return null;
  const fleets: CompactFile['fleets'] = {};
  for (const [k, f] of Object.entries(v.fleets)) {
    if (!isObj(f) || typeof f.at !== 'string' || typeof f.count !== 'number' || typeof f.dispatch !== 'string') return null;
    fleets[k] = { at: f.at, count: f.count, dispatch: f.dispatch };
  }
  let hq: CompactFile['hq'] = null;
  if (v.hq !== null && v.hq !== undefined) {
    const h = v.hq;
    if (!isObj(h) || typeof h.session !== 'string' || typeof h.at !== 'string' || typeof h.count !== 'number') return null;
    hq = { session: h.session, at: h.at, count: h.count };
  }
  return { version: 1, fleets, hq };
}

const emptyFile = (): CompactFile => ({ version: 1, fleets: {}, hq: null });

/** 縮めたことを記録する（count は引き継いで +1、at と dispatch は新しく） */
export function recordCompact(file: CompactFile | null, theme: string, dispatch: string, at: string): CompactFile {
  const base = file ?? emptyFile();
  const prev = base.fleets[theme];
  return { ...base, fleets: { ...base.fleets, [theme]: { at, count: (prev?.count ?? 0) + 1, dispatch } } };
}

/** hq 自身の判定。記録に今の session が無ければ基準を now にして送らない（起こした直後に縮めない） */
export function hqSelfDecision(file: CompactFile | null, session: string, now: number, compactMinutes: number, idle: () => boolean | null): { decision: CompactDecision; file: CompactFile } {
  const base = file ?? emptyFile();
  if (base.hq?.session !== session) {
    return { decision: { send: false, reason: 'unknown-start' }, file: { ...base, hq: { session, at: new Date(now).toISOString(), count: 0 } } };
  }
  const decision = compactDecision({ now, lastAt: base.hq.at, startedAt: null, compactMinutes, busy: () => [], idle });
  return { decision, file: base };
}

// ---- 実行（deps を差し替えられる） ----

export interface FleetCompactDeps {
  ledger(): HqLedger | null;
  record(): CompactFile | null;
  saveRecord(f: CompactFile): void;
  fleetStatusRows(issues: number[]): FleetStatusRow[] | null;
  terminalOf(dispatch: string): string | null;
  idle(handle: string): boolean | null;
  send(handle: string, text: string): boolean;
  now(): number;
}

export async function runFleetCompact(deps: FleetCompactDeps, theme: string, opts: { dryRun: boolean; compactMinutes: number }): Promise<{ theme: string; decision: CompactDecision; sent: boolean }> {
  const none = (reason: CompactReason): { theme: string; decision: CompactDecision; sent: boolean } => ({ theme, decision: { send: false, reason }, sent: false });
  const fleet = deps.ledger()?.fleets.find((f) => f.theme === theme);
  if (!fleet || typeof fleet.dispatch !== 'string' || !fleet.dispatch || !Array.isArray(fleet.issues)) return none('unknown-start');
  const dispatch = fleet.dispatch;
  const issues = fleet.issues.filter((n): n is number => typeof n === 'number');
  const file = deps.record();
  let handle: string | null = null;
  const decision = compactDecision({
    now: deps.now(),
    lastAt: file?.fleets[theme]?.at ?? null,
    startedAt: typeof fleet.startedAt === 'string' ? fleet.startedAt : null,
    compactMinutes: opts.compactMinutes,
    busy: () => {
      const rows = deps.fleetStatusRows(issues);
      return rows === null ? (issues.length > 0 ? issues : [0]) : busyIssues(rows);
    },
    idle: () => {
      handle = deps.terminalOf(dispatch);
      return handle === null ? null : deps.idle(handle);
    },
  });
  if (!decision.send || opts.dryRun || handle === null) return { theme, decision, sent: false };
  let sent = false;
  try { sent = deps.send(handle, `/compact ${FLEET_COMPACT_NOTE}`); } catch { sent = false; }
  if (sent) deps.saveRecord(recordCompact(file, theme, dispatch, new Date(deps.now()).toISOString()));
  return { theme, decision, sent };
}

export interface HqCompactDeps {
  ledger(): HqLedger | null;
  record(): CompactFile | null;
  saveRecord(f: CompactFile): void;
  idle(handle: string): boolean | null;
  send(handle: string, text: string): boolean;
  /** 縮め終わり（再び tui-idle）を待つ。縮めが始まる前の idle を拾わない待ちは実装の中で持つ */
  waitIdle(handle: string): boolean | null | Promise<boolean | null>;
  now(): number;
}

/** hq 自身を縮める。投げない（見張りを止めない） */
export async function maybeCompactHq(deps: HqCompactDeps, terminal: string | null, compactMinutes: number): Promise<{ compacted: boolean; reason: string }> {
  try {
    const ledger = deps.ledger();
    const handle = terminal ?? ledger?.hqHandle ?? null;
    const session = ledger?.hqSession ?? null;
    if (!handle || !session) return { compacted: false, reason: 'no-hq' };
    const { decision, file } = hqSelfDecision(deps.record(), session, deps.now(), compactMinutes, () => deps.idle(handle));
    if (!decision.send) {
      if (decision.reason === 'unknown-start') deps.saveRecord(file);
      return { compacted: false, reason: decision.reason };
    }
    if (!deps.send(handle, `/compact ${HQ_COMPACT_NOTE}`)) return { compacted: false, reason: 'send-failed' };
    deps.saveRecord({ ...file, hq: { session, at: new Date(deps.now()).toISOString(), count: (file.hq?.count ?? 0) + 1 } });
    await deps.waitIdle(handle);
    return { compacted: true, reason: 'due' };
  } catch (e) {
    return { compacted: false, reason: `error: ${(e as Error).message}` };
  }
}

// ---- 本物の依存（CLI と hq-watch.ts が使う） ----

export function compactPath(commonDir: string): string {
  return join(hqStateDir(commonDir), 'hq-compact.json');
}

function orca(args: string[], timeoutMs: number): Record<string, unknown> | null {
  const r = spawnSync(orcaCliCommand(process.platform, process.env), args, { shell: false, encoding: 'utf8', timeout: timeoutMs + 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return null;
  try {
    const j: unknown = JSON.parse(r.stdout ?? '');
    return isObj(j) ? j : null;
  } catch {
    return null;
  }
}

/** terminal wait --for tui-idle が ok: true なら true。timeout・失敗・読めないは false（送らない側に倒す） */
export function isTuiIdle(handle: string, timeoutMs: number = IDLE_PROBE_MS): boolean {
  const j = orca(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', String(timeoutMs), '--json'], timeoutMs);
  return j !== null && j.ok === true;
}

function sendText(handle: string, text: string): boolean {
  const j = orca(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '30', '--json'], 40_000);
  return j !== null && j.ok !== false;
}

function sleep(msWait: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, msWait));
}

export function realRecord(commonDir: string): { record(): CompactFile | null; saveRecord(f: CompactFile): void } {
  const path = compactPath(commonDir);
  return {
    record() {
      if (!existsSync(path)) return null;
      try { return parseCompactFile(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
    },
    saveRecord: (f) => writeLocalJson(path, f),
  };
}

export function realHqDeps(commonDir: string): HqCompactDeps {
  return {
    ledger: () => readLedgerFile(commonDir),
    ...realRecord(commonDir),
    idle: (h) => isTuiIdle(h),
    send: sendText,
    waitIdle: async (h) => {
      await sleep(COMPACT_SETTLE_MS);
      return isTuiIdle(h, COMPACT_WAIT_MS);
    },
    now: () => Date.now(),
  };
}

function main(argv: string[]): Promise<void> {
  const usage = '使い方：hq-compact.ts fleet --theme <テーマ> [--dry-run]';
  if (argv[0] !== 'fleet') throw new Error(usage);
  let theme: string | null = null;
  let dryRun = false;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--theme' && argv[i + 1]) { theme = argv[i + 1] as string; i++; }
    else if (argv[i] === '--dry-run') dryRun = true;
    else throw new Error(`${usage}（読めない引数：${argv[i]}）`);
  }
  if (!theme) throw new Error(usage);
  const commonDir = gitCommonDir(process.cwd());
  if (!commonDir) throw new Error('git の共通ディレクトリが見つかりません');
  const { compactMinutes } = hqCompactConfig(loadConfig() as { hq?: unknown });
  const deps: FleetCompactDeps = {
    ledger: () => readLedgerFile(commonDir),
    ...realRecord(commonDir),
    fleetStatusRows(issues) {
      const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'fleet-status', '--json', ...issues.map(String)], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) return null;
      try {
        const j: unknown = JSON.parse(r.stdout ?? '');
        return isObj(j) && Array.isArray(j.rows) ? (j.rows as FleetStatusRow[]) : null;
      } catch {
        return null;
      }
    },
    terminalOf(dispatch) {
      const j = orca(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'], 15_000);
      const result = j !== null && isObj(j.result) ? j.result : j;
      const worker = result !== null && isObj(result.worker) ? result.worker : null;
      const h = result?.agentTerminalHandle ?? worker?.agentTerminalHandle;
      return typeof h === 'string' && h ? h : null;
    },
    idle: (h) => isTuiIdle(h),
    send: sendText,
    now: () => Date.now(),
  };
  return runFleetCompact(deps, theme, { dryRun, compactMinutes }).then((r) => { console.log(JSON.stringify(r)); });
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
