import { readFileSync } from 'node:fs';
import { sessionFilePath, writeLocalJson } from './local-state.ts';
import { locateRow, type PaneSnapshot } from './panes.ts';

/**
 * 止まっているかの判定（しきい値の表はこのファイルの STALL_DEFAULTS の1か所）。
 * hq：動いてはいるが進んでいない fleet を見つける判定（Issue #287、人の決定はコメント 5905221457）。
 * 入力は fleet の collect が書いたペインのスナップショット（harness/lib/panes.ts の PaneSnapshot）で、
 * `at`（最後に読んだ時刻）が古ければ collect が止まっている、AI の番の行の `since` が長ければ進んでいない、とみなす。
 * しきい値は STALL_DEFAULTS.hq（設定では変えない定数）。
 * CLI は harness/scripts/panes.ts の fleets。
 * fleet：待つ間の読み直しの判断（Issue #199、人の決定 2026-09-30。下の節）。選んだ Issue が App・CI や人の Merge を待つ間に、fleet が間隔ごとに
 * `fleet-status --watch` を読み直すときの判断。App 待ちの行が一定の時間を過ぎても動かなければ1回だけ知らせ、Merge 済みで見届けの
 * 済んでいない行（Issue が開いている・worktree が残る）を返す。GitHub も git も呼ばない（事実は呼び出し元が渡す）。
 * 見張りの記録は git の共通ディレクトリの下の `agent-harness/watch/<セッションの ID>.json`（書式は harness/docs/formats.md の「見張りの記録」）を
 * readWatchRecord・writeWatchRecord（local-state.ts の writeLocalJson）で読み書きする。ほかは純粋関数。
 */

/** 止まっているかの判定のしきい値（分）。設定では変えない定数（変えるときはここを直す） */
export const STALL_DEFAULTS = {
  hq: { staleSnapshotMinutes: 30, stuckMinutes: 120 },
  fleetWatch: { intervalMinutes: 3, appStallMinutes: 20 },
} as const;

/** 進んでいない fleet の判定の既定値（分）。STALL_DEFAULTS.hq の別名 */
export const HQ_STALL_DEFAULTS = STALL_DEFAULTS.hq;

export interface HqStallConfig {
  /** スナップショットの at がこれ以上古ければ、collect が止まっている */
  staleSnapshotMinutes: number;
  /** AI の番の行がこれ以上同じ状態なら、進んでいない */
  stuckMinutes: number;
}

/** fleet 1つの判定。missing はスナップショットが無い・読めない（collect が動いていない） */
export interface FleetStall {
  session: string;
  missing?: true;
  label?: string | null;
  at?: string;
  snapshotAgeMinutes?: number;
  staleSnapshot?: boolean;
  /** AI の番のまま stuckMinutes 以上経った行 */
  stuck?: { issue: number; minutes: number }[];
  totalUsd?: number | null;
  /** hq が状況を聞く対象か */
  stalled: boolean;
}

const minutesSince = (iso: string | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 60_000);
};

/** スナップショットの無い fleet（collect が動いていないとみなす） */
export function missingFleet(session: string): FleetStall {
  return { session, missing: true, stalled: true };
}

/**
 * スナップショットから、collect が止まっているか（staleSnapshot）と、AI の番のまま長い行（stuck）を出す。
 * stuck に入れるのは、自分の番が AI で、ほかのセッションの宣言でない行だけ（人・App の番、待ち、終わった行は入れない）。
 * 時刻が読めない行は入れない。境界は「以上」
 */
export function fleetStall(snap: PaneSnapshot, now: number, cfg: HqStallConfig): FleetStall {
  const age = minutesSince(snap.at, now);
  const staleSnapshot = age === null || age >= cfg.staleSnapshotMinutes;
  const stuck: { issue: number; minutes: number }[] = [];
  for (const row of snap.status?.rows ?? []) {
    const l = locateRow(row);
    if (l.who !== 'ai' || l.other) continue;
    const minutes = minutesSince(snap.since?.[String(row.issue)]?.at, now);
    if (minutes !== null && minutes >= cfg.stuckMinutes) stuck.push({ issue: row.issue, minutes });
  }
  return {
    session: snap.session,
    label: snap.label,
    at: snap.at,
    snapshotAgeMinutes: age ?? undefined,
    staleSnapshot,
    stuck,
    totalUsd: snap.usage?.totalUsd ?? null,
    stalled: staleSnapshot || stuck.length > 0,
  };
}

// --- fleet の待つ間の読み直し（旧 harness/lib/fleet-watch.ts） ---

/** 待つ間の読み直しの間隔と、App が止まったとみなす時間（分）。STALL_DEFAULTS.fleetWatch の別名 */
export const FLEET_WATCH_DEFAULTS = STALL_DEFAULTS.fleetWatch;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  return sessionFilePath(gitCommonDir, 'watch', session);
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
  writeLocalJson(path, record);
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
