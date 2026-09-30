/**
 * fleet の待つ間の読み直しの判断（Issue #199、人の決定 2026-09-30）。選んだ Issue が App・CI や人の Merge を待つ間に、fleet が間隔ごとに
 * `fleet-status --watch` を読み直すときの判断。App 待ちの行が一定の時間を過ぎても動かなければ1回だけ知らせ、Merge 済みで見届けの
 * 済んでいない行（Issue が開いている・worktree が残る）を返す。GitHub も git も呼ばない（事実は呼び出し元が渡す）。
 * 見張りの記録は git の共通ディレクトリの下の `agent-harness/watch/<セッションの ID>.json`（書式は docs/formats.md の「見張りの記録」）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TRANSCRIPT_SESSION_ID } from './session.ts';

/** 待つ間の読み直しの既定値（harness.config.json の fleet.watch で変えられる） */
export const FLEET_WATCH_DEFAULTS = { intervalMinutes: 3, appStallMinutes: 20 } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/**
 * 待つ間の読み直しの設定（harness.config.json の fleet.watch。無い項目は既定値）。書式の誤りは throw する（fleet-status --watch の実行時に止まる）。
 * HarnessConfig.fleet の型に watch は足さず、ここで読む（harness/lib/config.ts は #196 と重なるため触らない。shipModeConfig と同じく fleet の節を読む）。
 */
export function fleetWatchConfig(config: { fleet?: unknown }): { intervalMinutes: number; appStallMinutes: number } {
  const fleet = config.fleet;
  if (fleet !== undefined && !isObject(fleet)) throw new Error('fleet はオブジェクトで書いてください');
  const watch = fleet?.watch;
  if (watch !== undefined && !isObject(watch)) throw new Error('fleet.watch はオブジェクトで書いてください（例：{ "intervalMinutes": 3, "appStallMinutes": 20 }）');
  const { intervalMinutes = FLEET_WATCH_DEFAULTS.intervalMinutes, appStallMinutes = FLEET_WATCH_DEFAULTS.appStallMinutes } = (watch ?? {}) as Record<string, unknown>;
  if (!isPositiveInt(intervalMinutes)) throw new Error('fleet.watch.intervalMinutes は正の整数で書いてください');
  if (!isPositiveInt(appStallMinutes)) throw new Error('fleet.watch.appStallMinutes は正の整数で書いてください');
  return { intervalMinutes, appStallMinutes };
}

/** App が動くのを待つ段階（計画ゲートの記録待ち・auto-merge が付いたまま Merge 待ち）。人の番（human-merge・plan-review）は数えない */
export const APP_WAIT_STAGES: readonly string[] = ['plan-gate', 'auto-merge'];

export interface WatchRow {
  issue: number;
  pr: number | null;
  stage: string;
}

export interface WatchRecord {
  version: 1;
  session: string;
  /** 鍵（`<Issue>:<PR か ->:<段階>`）→ その状態を最初に見た時刻と、知らせ済みか */
  entries: Record<string, { since: string; notified: boolean }>;
}

export interface WatchStall {
  issue: number;
  pr: number | null;
  stage: string;
  minutes: number;
  text: string;
}

/** 見張りの記録のパス。ID が記録のファイル名に使える形でなければ null */
export function watchRecordPath(gitCommonDir: string, session: string | null): string | null {
  if (!session || !TRANSCRIPT_SESSION_ID.test(session)) return null;
  return join(gitCommonDir, 'agent-harness', 'watch', `${session}.json`);
}

/** 見張りの記録を読む。無い・読めない・書式が違えば null（空から始める） */
export function readWatchRecord(path: string): WatchRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(v) || v.version !== 1 || typeof v.session !== 'string' || !isObject(v.entries)) return null;
  for (const e of Object.values(v.entries)) {
    if (!isObject(e) || typeof e.since !== 'string' || Number.isNaN(Date.parse(e.since)) || typeof e.notified !== 'boolean') return null;
  }
  return v as unknown as WatchRecord;
}

/** 見張りの記録を書く（途中で読まれても壊れた中身が見えないよう、一時ファイルから置き換える） */
export function writeWatchRecord(path: string, record: WatchRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

const keyOf = (r: WatchRow): string => `${r.issue}:${r.pr ?? '-'}:${r.stage}`;

/**
 * 見張りの記録を今の行で更新し、App が appStallMinutes 分以上動いていない行の知らせを返す。
 * App 待ちの段階の行だけを記録し、前回と同じ鍵なら最初に見た時刻を引き継ぐ。App 待ちでなくなった行・鍵が変わった行は消える。
 * 同じ行の知らせは1回だけ（知らせ済みを記録に残す）。前の記録が無い・壊れているときは空から始める（最初の読み直しでは知らせない）。
 */
export function updateWatch(prev: WatchRecord | null, rows: WatchRow[], now: Date, cfg: { appStallMinutes: number }, session: string): { record: WatchRecord; stalls: WatchStall[] } {
  const entries: WatchRecord['entries'] = {};
  const stalls: WatchStall[] = [];
  for (const row of rows) {
    if (!APP_WAIT_STAGES.includes(row.stage)) continue;
    const key = keyOf(row);
    const before = prev?.entries[key];
    const entry = before ? { ...before } : { since: now.toISOString(), notified: false };
    const minutes = Math.floor((now.getTime() - Date.parse(entry.since)) / 60000);
    if (!entry.notified && minutes >= cfg.appStallMinutes) {
      entry.notified = true;
      const pr = row.pr !== null ? `（PR #${row.pr}）` : '';
      stalls.push({ ...row, minutes, text: `#${row.issue}${pr} は ${row.stage} のまま ${minutes} 分、App が動いていない` });
    }
    entries[key] = entry;
  }
  return { record: { version: 1, session, entries }, stalls };
}

/**
 * Merge 後の見届けが済んでいない Issue（昇順）。段階が merged の行のうち、Issue がまだ開いている、またはその Issue の worktree
 * （ブランチ `claude/issue-<番号>-`）が残っているもの。見張りの記録は使わず、事実だけで毎回同じ結果を返す（最初の読み直しでも、交代の後でも出る）。
 */
export function pendingFollowUps(rows: { issue: number; stage: string }[], facts: { openIssues: number[]; worktreeBranches: string[] }): number[] {
  const out = new Set<number>();
  for (const row of rows) {
    if (row.stage !== 'merged') continue;
    const prefix = `claude/issue-${row.issue}-`;
    if (facts.openIssues.includes(row.issue) || facts.worktreeBranches.some((b) => b.replace(/^refs\/heads\//, '').startsWith(prefix))) out.add(row.issue);
  }
  return [...out].sort((a, b) => a - b);
}
