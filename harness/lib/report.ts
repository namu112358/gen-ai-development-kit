import type { HarnessConfig } from './config.ts';
import type { Acceptance, JevRecord } from './merge-route.ts';

/**
 * 判定の集計（Jev の切り替え判断用）の純粋関数。GitHub は呼ばない（集めるのは harness/scripts/report.ts）。
 *
 * 「外れ」＝ Merge 後 7 日以内に revert された、または同じファイルを直す fix の PR が Merge された。
 * 比べる相手は Claude ではなく結果。基準の意味は docs/security.md の「Jev」。
 */

const WEEK = 7 * 86400_000;
const HOUR = 3600_000;

/** PR ごとの集計の行（GitHub から集めた事実だけ） */
export interface ReportRow {
  pr: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  /** 最後の受け付け記録（無ければ null） */
  acceptance: Acceptance | null;
  /** 受け付けられなかった判定コメントの数 */
  rejected: number;
  /** App の修正要求レビューの数（修正の往復） */
  fixRequests: number;
  reverted: boolean;
  /** 同じファイルを直した fix の PR 番号 */
  fixedBy: number[];
}

/** fix の PR を探すときの PR の形（変更ファイルは呼び出し元が集めて渡す） */
export interface MergedPr {
  number: number;
  title: string;
  headRef: string;
  mergedAt: string | null;
  files: string[];
}

/** タイトルが fix/hotfix で始まるか「修正」を含む、またはブランチ名のセグメントが fix で始まる */
export function isFixPr(pr: { title: string; headRef: string }): boolean {
  return /^(fix|hotfix)|修正/i.test(pr.title) || /(^|\/)fix/i.test(pr.headRef);
}

/** pr の Merge 後 7 日以内に Merge された fix の PR のうち、変更ファイルが重なるものの番号 */
export function fixPrsFor(pr: MergedPr, mergedPrs: MergedPr[]): number[] {
  if (!pr.mergedAt) return [];
  const mergedAt = new Date(pr.mergedAt).getTime();
  const mine = new Set(pr.files);
  const out: number[] = [];
  for (const other of mergedPrs) {
    if (other.number === pr.number || !other.mergedAt) continue;
    const t = new Date(other.mergedAt).getTime();
    if (t <= mergedAt || t - mergedAt > WEEK) continue;
    if (!isFixPr(other)) continue;
    if (other.files.some((f) => mine.has(f))) out.push(other.number);
  }
  return out;
}

/** Jev が応答し、P(low) が閾値以上だったか */
export function isJevLow(config: HarnessConfig, jev: JevRecord | null | undefined): boolean {
  if (jev?.status !== 'ok') return false;
  const low = jev.answers?.q1_risk?.low;
  return typeof low === 'number' && low >= config.jev.thresholds.lowProbability;
}

/**
 * `jev.mode` を `enforce` に切り替える基準。docs/plan.md の「Jev の『可』に外れがない」を、
 * より厳しい「Jev の low の外れ 0 件」に置き換えたもの（『可』の外れは参考として表に残す）。
 */
export const JEV_ENFORCE_CRITERIA = { minNegatives: 20, maxJevLowMisses: 0, maxJevOnly: 0 } as const;

export interface ReportSummary {
  total: number;
  /** 判定を受け付けた PR */
  judged: number;
  /** 否定側（Claude が自動 Merge 不可） */
  negatives: number;
  /** Jev の応答あり */
  jevOk: number;
  jevLow: number;
  jevLowMisses: number;
  jevLowMissRate: number | null;
  jevLowAccuracy: number | null;
  /** Jev の「可」の外れ（参考） */
  jevMisses: number;
  claudeMisses: number;
  /** Jev だけが「可」 */
  jevOnly: number;
  /** Claude と Jev の「可/不可」の一致率（参考） */
  agreement: number | null;
  fixRequestsTotal: number;
  fixRequestsAverage: number | null;
  /** 作成から Merge（未 Merge は Close）までの時間の中央値（時間） */
  stallMedianHours: number | null;
  rejectedTotal: number;
  criteria: { met: boolean; unmet: string[] };
}

const isMiss = (r: ReportRow) => r.reverted || r.fixedBy.length > 0;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarize(config: HarnessConfig, rows: ReportRow[]): ReportSummary {
  const judged = rows.filter((r) => r.acceptance !== null);
  const negatives = judged.filter((r) => r.acceptance!.autoEligible === false).length;
  const jevOk = judged.filter((r) => r.acceptance!.jev?.status === 'ok');
  const jevLow = jevOk.filter((r) => isJevLow(config, r.acceptance!.jev));
  const jevLowMisses = jevLow.filter(isMiss).length;
  const jevLowMissRate = jevLow.length === 0 ? null : jevLowMisses / jevLow.length;
  const jevMisses = jevOk.filter((r) => r.acceptance!.jev!.allows === true && isMiss(r)).length;
  const claudeMisses = judged.filter((r) => r.acceptance!.autoEligible === true && isMiss(r)).length;
  const jevOnly = jevOk.filter((r) => r.acceptance!.jev!.allows === true && r.acceptance!.autoEligible === false).length;
  const agreed = jevOk.filter((r) => (r.acceptance!.jev!.allows === true) === r.acceptance!.autoEligible).length;
  const fixRequestsTotal = rows.reduce((a, r) => a + r.fixRequests, 0);
  const stalls = rows.flatMap((r) => {
    const end = r.mergedAt ?? r.closedAt;
    return end ? [(new Date(end).getTime() - new Date(r.createdAt).getTime()) / HOUR] : [];
  });

  const c = JEV_ENFORCE_CRITERIA;
  const unmet: string[] = [];
  if (negatives < c.minNegatives) unmet.push(`否定側が ${negatives} 件（${c.minNegatives} 件以上が要る）`);
  if (jevLowMisses > c.maxJevLowMisses) unmet.push(`Jev の low の外れが ${jevLowMisses} 件（${c.maxJevLowMisses} 件であること）`);
  if (jevOnly > c.maxJevOnly) unmet.push(`Jev だけが「可」が ${jevOnly} 件（${c.maxJevOnly} 件であること）`);

  return {
    total: rows.length,
    judged: judged.length,
    negatives,
    jevOk: jevOk.length,
    jevLow: jevLow.length,
    jevLowMisses,
    jevLowMissRate,
    jevLowAccuracy: jevLowMissRate === null ? null : 1 - jevLowMissRate,
    jevMisses,
    claudeMisses,
    jevOnly,
    agreement: jevOk.length === 0 ? null : agreed / jevOk.length,
    fixRequestsTotal,
    fixRequestsAverage: rows.length === 0 ? null : fixRequestsTotal / rows.length,
    stallMedianHours: median(stalls),
    rejectedTotal: rows.reduce((a, r) => a + r.rejected, 0),
    criteria: { met: unmet.length === 0, unmet },
  };
}

const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v === null ? '-' : `${Math.round(v * 10) / 10}`);
const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? '-' : v ? '可' : '不可');

export function renderReport(summary: ReportSummary, rows: ReportRow[], days: number): string {
  const s = summary;
  const c = JEV_ENFORCE_CRITERIA;
  const criteria = s.criteria.met ? '**満たす**' : `満たさない（${s.criteria.unmet.join('、')}）`;
  const jevCell = (r: ReportRow) => {
    const jev = r.acceptance?.jev;
    if (!jev) return '-';
    if (jev.status !== 'ok') return jev.status;
    const low = jev.answers?.q1_risk?.low;
    return `${yn(jev.allows)}${typeof low === 'number' ? `（P(low) ${Math.round(low * 100) / 100}）` : ''}`;
  };
  const stall = (r: ReportRow) => {
    const end = r.mergedAt ?? r.closedAt;
    return end ? num((new Date(end).getTime() - new Date(r.createdAt).getTime()) / HOUR) : '-';
  };
  return [
    `# 判定の集計（直近 ${days} 日、Agent PR ${s.total} 件）`,
    '',
    '| 指標 | 値 |',
    '| --- | --- |',
    `| 判定を受け付けた PR | ${s.judged} |`,
    `| 否定側（Claude が自動 Merge 不可） | ${s.negatives} |`,
    `| Jev の応答あり | ${s.jevOk} |`,
    `| Jev の low | ${s.jevLow} |`,
    `| Jev の low の外れ（revert / fix） | ${s.jevLowMisses} |`,
    `| Jev の low の外れ率 | ${pct(s.jevLowMissRate)} |`,
    `| Jev の low の一致率（1 − 外れ率） | ${pct(s.jevLowAccuracy)} |`,
    `| Jev の「可」の外れ（参考） | ${s.jevMisses} |`,
    `| Claude の「可」の外れ（revert / fix） | ${s.claudeMisses} |`,
    `| Jev だけが「可」 | ${s.jevOnly} |`,
    `| Claude と Jev の「可/不可」の一致率（参考） | ${pct(s.agreement)} |`,
    `| 修正の往復（合計 / 平均） | ${s.fixRequestsTotal} / ${num(s.fixRequestsAverage)} |`,
    `| 停滞時間の中央値（作成から Merge・Close まで、時間） | ${num(s.stallMedianHours)} |`,
    `| 受け付けられなかった判定コメント | ${s.rejectedTotal} |`,
    '',
    `切り替えの基準（docs/security.md）：否定側 ${c.minNegatives} 件以上、Jev の low の外れ ${c.maxJevLowMisses} 件、Jev だけが「可」${c.maxJevOnly} 件 → ${criteria}`,
    '',
    '| PR | Merge | Claude | Jev | revert | fix PR | 修正の往復 | 停滞（時間） | 却下 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| #${r.pr} | ${r.mergedAt?.slice(0, 10) ?? '-'} | ${yn(r.acceptance?.autoEligible)} | ${jevCell(r)} | ${r.reverted ? '○' : ''} | ${r.fixedBy.map((n) => `#${n}`).join(' ')} | ${r.fixRequests || ''} | ${stall(r)} | ${r.rejected || ''} |`,
    ),
  ].join('\n');
}
