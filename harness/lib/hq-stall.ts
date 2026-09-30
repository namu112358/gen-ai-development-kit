import { locateRow, type PaneSnapshot } from './panes.ts';

/**
 * hq が、動いてはいるが進んでいない fleet を見つける判定（Issue #287、人の決定はコメント 5905221457）。純粋関数だけ。
 * 入力は fleet の collect が書いたペインのスナップショット（harness/lib/panes.ts の PaneSnapshot）で、
 * `at`（最後に読んだ時刻）が古ければ collect が止まっている、AI の番の行の `since` が長ければ進んでいない、とみなす。
 * しきい値は harness.config.json の hq.staleSnapshotMinutes・hq.stuckMinutes（無ければ既定値）。
 * hq.maxFleets は config.ts の hqConfig が読む（config.ts は delegateMergeExclude に入るので、ここで同じ hq の節を読む）。
 * CLI は harness/scripts/panes.ts の fleets。
 */

/** 進んでいない fleet の判定の既定値（分） */
export const HQ_STALL_DEFAULTS = { staleSnapshotMinutes: 30, stuckMinutes: 120 } as const;

export interface HqStallConfig {
  /** スナップショットの at がこれ以上古ければ、collect が止まっている */
  staleSnapshotMinutes: number;
  /** AI の番の行がこれ以上同じ状態なら、進んでいない */
  stuckMinutes: number;
}

/** hq の節から判定のしきい値を読む（無い項目は既定値）。hq がオブジェクトでない、値が正の整数でなければ throw する */
export function hqStallConfig(config: { hq?: unknown }): HqStallConfig {
  const raw = config.hq;
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error('hq はオブジェクトで書いてください（例：{ "maxFleets": 2, "staleSnapshotMinutes": 30, "stuckMinutes": 120 }）');
  }
  const hq = (raw ?? {}) as Record<string, unknown>;
  const read = (key: keyof HqStallConfig): number => {
    const v = hq[key] === undefined ? HQ_STALL_DEFAULTS[key] : hq[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`hq.${key} は正の整数（分）で書いてください`);
    return v;
  };
  return { staleSnapshotMinutes: read('staleSnapshotMinutes'), stuckMinutes: read('stuckMinutes') };
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
