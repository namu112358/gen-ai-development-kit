import type { HarnessConfig } from './config.ts';
import { JEV_QUESTION_SET, jevFailures } from './jev.ts';
import type { Acceptance, JevRecord } from './merge-route.ts';
import { RISK_QUESTIONS } from './verdict.ts';

/**
 * 判定の集計（Jev の切り替え判断用）の純粋関数。GitHub は呼ばない（集めるのは harness/scripts/report.ts）。
 *
 * 「外れ」＝ Merge 後 7 日以内に revert された、または同じファイルを直す fix の PR が Merge された。
 * 比べる相手は Claude ではなく結果。基準の意味は docs/security.md の「Jev」。
 * Jev の数と切り替えの基準は、今の問いの版（`JEV_QUESTION_SET`）の記録だけで数える（Q88）。
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

/** 記録の問いの版（`questionSet` の無い古い記録は版 1） */
const questionSetOf = (jev: JevRecord) => jev.questionSet ?? 1;

/** 問いごとの確率の分布と、しきい値で落とした件数（q1_risk は P(low)、q2〜q8 は yes の確率） */
export interface JevQuestionStat {
  key: string;
  /** 値が有限の記録の数 */
  count: number;
  min: number | null;
  q25: number | null;
  median: number | null;
  q75: number | null;
  max: number | null;
  /** しきい値で落とした記録の数（`jevFailures` に含まれた数。値が無い記録も含む） */
  failed: number;
  /** その問いだけで落とした記録の数 */
  onlyFailed: number;
}

export interface JevQuestionSetStats {
  questionSet: number;
  records: number;
  questions: JevQuestionStat[];
}

/** 小さい順に並べた位置 round(p×(n−1)) の値 */
const quantile = (sorted: number[], p: number) => (sorted.length === 0 ? null : sorted[Math.round(p * (sorted.length - 1))]!);

/**
 * 各 PR の最後の受け付け記録のうち Jev が ok のものを、問いの版ごとに分けて、問いごとの確率の分布と落とした件数を出す。
 * しきい値の解釈はゲートと同じ `jevFailures`。
 */
export function jevQuestionStats(config: HarnessConfig, rows: ReportRow[]): JevQuestionSetStats[] {
  const bySet = new Map<number, JevRecord[]>();
  for (const r of rows) {
    const jev = r.acceptance?.jev;
    if (jev?.status !== 'ok') continue;
    const set = questionSetOf(jev);
    bySet.set(set, [...(bySet.get(set) ?? []), jev]);
  }
  const keys = [{ key: 'q1_risk', field: 'low' }, ...RISK_QUESTIONS.map((q) => ({ key: q.key, field: 'yes' }))];
  return [...bySet.entries()]
    .sort(([a], [b]) => a - b)
    .map(([questionSet, records]) => {
      const failures = records.map((j) => jevFailures(config, j.answers));
      const questions = keys.map(({ key, field }) => {
        const values = records
          .map((j) => j.answers?.[key]?.[field])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
          .sort((a, b) => a - b);
        return {
          key,
          count: values.length,
          min: quantile(values, 0),
          q25: quantile(values, 0.25),
          median: quantile(values, 0.5),
          q75: quantile(values, 0.75),
          max: quantile(values, 1),
          failed: failures.filter((f) => f.includes(key)).length,
          onlyFailed: failures.filter((f) => f.length === 1 && f[0] === key).length,
        };
      });
      return { questionSet, records: records.length, questions };
    });
}

export interface ReportSummary {
  total: number;
  /** 判定を受け付けた PR */
  judged: number;
  /** 否定側（Claude が自動 Merge 不可。表示用、版に関わらず数える） */
  negatives: number;
  /** 基準の否定側：Claude が不可で、今の問いの版で Jev が応答した PR */
  negativesJev: number;
  /** Jev の数から除いた、今の版でない Jev の記録 */
  jevOtherSets: number;
  /** Jev の応答あり（今の問いの版） */
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
  /** 問いごとの確率（版ごと）と、使ったしきい値 */
  jevQuestions: { sets: JevQuestionSetStats[]; lowProbability: number; noulSafe: number };
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
  const jevAll = judged.filter((r) => r.acceptance!.jev?.status === 'ok');
  // Jev の数は今の問いの版の記録だけで数える（版の違う記録を混ぜると、今の問いを見ないまま基準を満たしうるため）
  const jevOk = jevAll.filter((r) => questionSetOf(r.acceptance!.jev!) === JEV_QUESTION_SET);
  const negativesJev = jevOk.filter((r) => r.acceptance!.autoEligible === false).length;
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
  if (negativesJev < c.minNegatives) unmet.push(`否定側が ${negativesJev} 件（${c.minNegatives} 件以上が要る）`);
  if (jevLowMisses > c.maxJevLowMisses) unmet.push(`Jev の low の外れが ${jevLowMisses} 件（${c.maxJevLowMisses} 件であること）`);
  if (jevOnly > c.maxJevOnly) unmet.push(`Jev だけが「可」が ${jevOnly} 件（${c.maxJevOnly} 件であること）`);

  return {
    total: rows.length,
    judged: judged.length,
    negatives,
    negativesJev,
    jevOtherSets: jevAll.length - jevOk.length,
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
    jevQuestions: { sets: jevQuestionStats(config, rows), ...config.jev.thresholds },
  };
}

const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v === null ? '-' : `${Math.round(v * 10) / 10}`);
const prob = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100) / 100}`);
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
  const { lowProbability, noulSafe } = s.jevQuestions;
  const questionSections = s.jevQuestions.sets.flatMap((set) => [
    '',
    `### 問いの版 ${set.questionSet}（${set.records} 件）`,
    '',
    '| 問い | 件数 | 最小 | 25% | 中央 | 75% | 最大 | 落とした件数 | その問いだけで落とした件数 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...set.questions.map(
      (q) => `| ${q.key} | ${q.count} | ${prob(q.min)} | ${prob(q.q25)} | ${prob(q.median)} | ${prob(q.q75)} | ${prob(q.max)} | ${q.failed} | ${q.onlyFailed} |`,
    ),
  ]);
  return [
    `# 判定の集計（直近 ${days} 日、Agent PR ${s.total} 件）`,
    '',
    `Jev の数は問いの版 ${JEV_QUESTION_SET} の記録だけで数える（docs/security.md の「Jev」）。`,
    '',
    '| 指標 | 値 |',
    '| --- | --- |',
    `| 判定を受け付けた PR | ${s.judged} |`,
    `| 否定側（Claude が自動 Merge 不可） | ${s.negatives} |`,
    `| 否定側のうち今の問いの版で Jev が応答したもの | ${s.negativesJev} |`,
    `| Jev の数から除いた、版の違う記録 | ${s.jevOtherSets} |`,
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
    '',
    '## 問いごとの確率（Jev）',
    '',
    `しきい値：P(low) ≥ ${lowProbability}、yes が安全な問いは yes ≥ ${noulSafe}、no が安全な問いは yes ≤ ${Math.round((1 - noulSafe) * 1000) / 1000}（q1_risk は P(low)、ほかは yes の確率。落とした件数には値の無い記録も含む）`,
    ...(s.jevQuestions.sets.length === 0 ? ['', 'Jev が応答した記録はありません。'] : questionSections),
  ].join('\n');
}

/**
 * 日本語の割合（受け付けの記録の `jev.size.jaRatio`）の区分。下限を含み上限を含まない（Q90）。
 * `jaRatio` は要求全体（英語の問いの文とガードレールの一覧を含む）での割合なので、diff だけの割合より薄まる。
 */
export const JA_RATIO_BUCKETS = [
  { label: '0〜5%', min: 0, max: 0.05 },
  { label: '5〜20%', min: 0.05, max: 0.2 },
  { label: '20〜50%', min: 0.2, max: 0.5 },
  { label: '50%以上', min: 0.5, max: Infinity },
] as const;

export interface TokenRatioRow {
  label: string;
  count: number;
  /** 文字数の合計 */
  chars: number;
  /** トークン数（`usage.input_tokens`）の合計 */
  tokens: number;
  /** 文字数の合計 / トークン数の合計（件数 0 なら null） */
  ratio: number | null;
}

export interface TokenRatios {
  buckets: TokenRatioRow[];
  /** Jev の記録はあるが数えなかった件数（Jev が応答しなかった、大きさの無い古い記録、トークン数が報告されなかった） */
  skipped: number;
}

/**
 * 各 PR の最後の受け付け記録から、日本語の割合の区分ごとに「文字数 / トークン数」を出す（上限をトークンで見積もる方式を決めるための実測。Q90）。
 * `summarize` とは独立（切り替えの基準には関わらない）。
 */
export function tokenRatios(rows: ReportRow[]): TokenRatios {
  const buckets: TokenRatioRow[] = JA_RATIO_BUCKETS.map((b) => ({ label: b.label, count: 0, chars: 0, tokens: 0, ratio: null }));
  let skipped = 0;
  for (const r of rows) {
    const jev = r.acceptance?.jev;
    if (!jev) continue;
    const size = jev.size;
    const tokens = size?.inputTokens;
    if (jev.status !== 'ok' || !size || typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) {
      skipped++;
      continue;
    }
    const i = JA_RATIO_BUCKETS.findIndex((b) => size.jaRatio >= b.min && size.jaRatio < b.max);
    const bucket = buckets[i === -1 ? 0 : i]!;
    bucket.count++;
    bucket.chars += size.chars;
    bucket.tokens += tokens;
  }
  for (const b of buckets) b.ratio = b.count === 0 ? null : b.chars / b.tokens;
  return { buckets, skipped };
}

export function renderTokenRatios(r: TokenRatios): string {
  return [
    '## 文字数とトークン数の比（Jev の受け付けの記録）',
    '',
    '文字数は Jev に送った state と問いを JSON にした文字数、トークン数は応答の `usage.input_tokens`。日本語の割合は要求全体での割合（diff だけの割合より薄まる）。',
    '',
    '| 区分 | 件数 | 文字数 | トークン数 | 文字数/トークン |',
    '| --- | --- | --- | --- | --- |',
    ...r.buckets.map((b) => `| ${b.label} | ${b.count} | ${b.chars} | ${b.tokens} | ${b.ratio === null ? '-' : Math.round(b.ratio * 100) / 100} |`),
    '',
    `数えなかった記録（Jev が応答しなかった、大きさの無い古い記録、トークン数が報告されなかった）：${r.skipped} 件`,
  ].join('\n');
}
