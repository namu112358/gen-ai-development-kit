import { appMarkKind, extractBlock, hasClaudeMark } from './blocks.ts';
import { appLogin, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import { JEV_QUESTION_SET, jevFailures } from './jev.ts';
import type { Acceptance, JevRecord } from './merge-route.ts';
import type { ExemptRecord } from './exempt.ts';
import { parsePanelRecord, type PanelRecord } from './review-panel.ts';
import { isTrustedComment } from './state.ts';
import { tamperAllows, tamperJevThreshold, type TamperJevRecord } from './test-tamper-jev.ts';
import type { AutoModeTestsRecord } from './auto-mode-tests.ts';
import { BLOCKING_KINDS, parseVerdict, RISK_QUESTIONS, type BlockingFinding, type BlockingKind } from './verdict.ts';

/**
 * 判定の集計（Jev の切り替え判断用）の純粋関数。GitHub は呼ばない（集めるのは harness/scripts/report.ts）。
 *
 * 「外れ」＝ Merge 後 7 日以内に revert された、または元の PR を直す fix の PR が Merge された。
 * fix の PR は、変更ファイルが重なることに加えて、行（元の PR が足した行を消した・消した行を足し戻した）か
 * 参照（題名・本文に元の PR か元の PR が Closes した Issue の番号がある、または元の PR と同じ Issue を Closes する）で結び付ける（`fixLinksFor`）。
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
  /** 元の PR を直した fix の PR 番号（`fixLinksFor` で結び付いたもの） */
  fixedBy: number[];
  /** テストの改ざんの Jev の確率と人の判断（tamperDecision。集計しないときは null か省略） */
  tamper?: { probability: number; human: 'pass' | 'fix' } | null;
  /** auto mode でテストを弱める変更を Jev が妥当と答えて通した PR と、その後に人が直させたか（autoModeTestsDecision。数えないときは null か省略） */
  autoModeTests?: { fixed: boolean } | null;
  /** 結び付いた fix の PR ごとの根拠（表の「fix PR」列に出す。無ければ番号だけ出す） */
  fixLinks?: FixLink[];
}

/**
 * テストの改ざんの Jev の記録（kind=test-tamper-jev）に対する人の判断（Q95）。PR ごとに最後の記録 L を1件だけ使う。
 * - pass：L と同じ patch-id の test:exempt の「付けた」記録がある、または Merge され、最後の受け付け記録の patch-id が L と同じ
 * - fix：pass でなく Merge された（L の差分のままでは Merge されなかった）
 * - それ以外（未 Merge で閉じた、記録が無い）と、L が enforce で Jev が通した記録（自分で自分を数えないため）は null
 */
export function tamperDecision(records: TamperJevRecord[], exempts: ExemptRecord[], merged: boolean, finalPatchId: string | null): { probability: number; human: 'pass' | 'fix' } | null {
  const last = records.at(-1);
  if (!last) return null;
  if (last.mode === 'enforce' && last.allows === true) return null;
  const probability = typeof last.probability === 'number' ? last.probability : NaN;
  const exempted = exempts.some((e) => e.action === 'labeled' && e.patchId === last.patchId);
  if (exempted || (merged && finalPatchId === last.patchId)) return { probability, human: 'pass' };
  if (merged) return { probability, human: 'fix' };
  return null;
}

/**
 * auto mode でテストを弱める変更を通した記録（kind=auto-mode-tests）に対する、その後の結果（Issue #349）。PR ごとに最後の記録 L を1件だけ使う。
 * L が通した（allows）ときだけ数える。Merge され、最後の受け付け記録の patch-id が L と違えば、通した差分のまま Merge されなかった（人が直させた。危険側に外れた）とみなす。
 * 通した後に、テストと関係の無い push（Reviewer の指摘の fix など）で差分が変わった PR も「直させた」に数えるので、この件数は多めに出る。
 * 未 Merge（開いている・閉じた）と、L が通さなかった記録は null（tamperDecision と同じく、結果の出たものだけを数える）
 */
export function autoModeTestsDecision(records: AutoModeTestsRecord[], merged: boolean, finalPatchId: string | null): { fixed: boolean } | null {
  const last = records.at(-1);
  if (!last || last.allows !== true || !merged) return null;
  return { fixed: finalPatchId !== last.patchId };
}

/** fix の PR を探すときの PR の形（変更ファイルなどは呼び出し元が集めて渡す） */
export interface MergedPr {
  number: number;
  title: string;
  headRef: string;
  mergedAt: string | null;
  files: string[];
  /** PR の本文 */
  body?: string | null;
  /** ファイル → GitHub の patch（`/pulls/{n}/files` の `patch`）。無いファイルは行で比べない */
  patches?: Record<string, string | undefined>;
  /** この PR が Closes する Issue の番号 */
  closes?: number[];
}

/** 結び付けの根拠：lines＝行の内容が重なる、ref＝fix の PR から元の PR（かその Issue）への参照 */
export type FixBasis = 'lines' | 'ref';

/** 結び付いた fix の PR と根拠。files は根拠になったファイル（lines なら行が重なったファイル、ref だけなら重なるファイル全部） */
export interface FixLink {
  pr: number;
  basis: FixBasis[];
  files: string[];
}

/** タイトルが fix/hotfix で始まるか「修正」を含む、またはブランチ名のセグメントが fix で始まる */
export function isFixPr(pr: { title: string; headRef: string }): boolean {
  return /^(fix|hotfix)|修正/i.test(pr.title) || /(^|\/)fix/i.test(pr.headRef);
}

/** 比べる行か（前後の空白を除いて4文字以上で、文字か数字を含む。空行・記号だけの行は偶然一致するので比べない） */
const comparableLine = (line: string) => line.length >= 4 && /[\p{L}\p{N}]/u.test(line);

/** patch の足した行・消した行の内容（前後の空白を除く。hunk ヘッダ・文脈行・比べない行は除く） */
export function patchLines(patch: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    const sign = raw[0];
    if (sign !== '+' && sign !== '-') continue;
    const line = raw.slice(1).trim();
    if (!comparableLine(line)) continue;
    (sign === '+' ? added : removed).push(line);
  }
  return { added, removed };
}

/** text が番号 n を参照するか（#n・/pull/n・/issues/n。後ろに数字が続くもの、# の直前に英数字があるものは数えない） */
export function references(text: string, n: number): boolean {
  return new RegExp(`(?:(?<![\\p{L}\\p{N}_])#|/pull/|/issues/)${n}(?!\\d)`, 'u').test(text);
}

/** 元の patch の足した行を fix の patch が消したか、元の消した行を fix が足し戻したか */
function linesOverlap(original: string, fix: string): boolean {
  const a = patchLines(original);
  const b = patchLines(fix);
  const added = new Set(a.added);
  const removed = new Set(a.removed);
  return b.removed.some((l) => added.has(l)) || b.added.some((l) => removed.has(l));
}

/**
 * pr の Merge 後 7 日以内に Merge された fix の PR のうち、変更ファイルが重なり、
 * 行（重なるファイルで、fix の PR が pr の足した行を消した・消した行を足し戻した）か
 * 参照（fix の PR の題名・本文に、pr か pr が Closes した Issue の番号がある、または fix の PR が pr と同じ Issue を Closes する）で結び付くもの。
 * Closes する Issue の本文は見ない（背景で過去の PR を名指しする Issue を Closes する PR を結び付けないため）。
 * Jev の low の外れ・Claude の「可」の外れ・合体版の比較の fix-pr の裏付けは、どれもこの結果を使う。
 */
export function fixLinksFor(pr: MergedPr, mergedPrs: MergedPr[]): FixLink[] {
  if (!pr.mergedAt) return [];
  const mergedAt = new Date(pr.mergedAt).getTime();
  const targets = [pr.number, ...(pr.closes ?? [])];
  const mine = new Set(pr.closes ?? []);
  const out: FixLink[] = [];
  for (const other of mergedPrs) {
    if (other.number === pr.number || !other.mergedAt) continue;
    const t = new Date(other.mergedAt).getTime();
    if (t <= mergedAt || t - mergedAt > WEEK) continue;
    if (!isFixPr(other)) continue;
    const theirs = new Set(other.files);
    const shared = [...new Set(pr.files)].filter((f) => theirs.has(f));
    if (shared.length === 0) continue;
    const lineFiles = shared.filter((f) => {
      const a = pr.patches?.[f];
      const b = other.patches?.[f];
      return a !== undefined && b !== undefined && linesOverlap(a, b);
    });
    const text = [other.title, other.body ?? ''].join('\n');
    const ref = targets.some((n) => references(text, n)) || (other.closes ?? []).some((n) => mine.has(n));
    const basis: FixBasis[] = [];
    if (lineFiles.length > 0) basis.push('lines');
    if (ref) basis.push('ref');
    if (basis.length > 0) out.push({ pr: other.number, basis, files: lineFiles.length > 0 ? lineFiles : shared });
  }
  return out;
}

/** 結び付いた fix の PR の番号（`fixLinksFor` の番号だけ） */
export function fixPrsFor(pr: MergedPr, mergedPrs: MergedPr[]): number[] {
  return fixLinksFor(pr, mergedPrs).map((l) => l.pr);
}

/** 合体版の比較（`PanelCompareInput.fixPrFiles`）に渡す fix の PR のファイル（根拠になったファイルだけ） */
export function fixPrFilesOf(links: FixLink[]): Record<number, string[]> {
  return Object.fromEntries(links.map((l) => [l.pr, l.files]));
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
  /**
   * テストの改ざん：Jev（probability ≥ testTamperProbability を「通す」。下限が未設定なら通すは0件）と人の判断（Q95）。
   * jevPassHumanFix（Jev は通す・人は直させた）が enforce で危険側に外れる件数。threshold は数えるのに使った下限（未設定なら null）
   */
  tamper: { rows: number; agreed: number; agreement: number | null; jevPassHumanFix: number; jevFixHumanPass: number; threshold: number | null };
  /** テストの改ざん：auto mode で Jev が妥当と答えて通した件数（Merge 済み）と、そのうち人が後から直させた件数（危険側に外れた。autoModeTestsDecision） */
  autoModeTests: { allowed: number; fixed: number };
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

  const tamperRows = rows.flatMap((r) => (r.tamper ? [{ ...r.tamper, jevPass: tamperAllows(config, r.tamper.probability) }] : []));
  const tamperAgreed = tamperRows.filter((t) => t.jevPass === (t.human === 'pass')).length;

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
    tamper: {
      rows: tamperRows.length,
      agreed: tamperAgreed,
      agreement: tamperRows.length === 0 ? null : tamperAgreed / tamperRows.length,
      jevPassHumanFix: tamperRows.filter((t) => t.jevPass && t.human === 'fix').length,
      jevFixHumanPass: tamperRows.filter((t) => !t.jevPass && t.human === 'pass').length,
      threshold: tamperJevThreshold(config),
    },
    autoModeTests: {
      allowed: rows.filter((r) => r.autoModeTests).length,
      fixed: rows.filter((r) => r.autoModeTests?.fixed === true).length,
    },
  };
}

const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v === null ? '-' : `${Math.round(v * 10) / 10}`);
const prob = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100) / 100}`);
const yn = (v: boolean | null | undefined) => (v === null || v === undefined ? '-' : v ? '可' : '不可');

const FIX_BASIS_LABELS: Record<FixBasis, string> = { lines: '行', ref: '参照' };

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
  const fixCell = (r: ReportRow) =>
    r.fixLinks
      ? r.fixLinks.map((l) => `#${l.pr}（${l.basis.map((b) => FIX_BASIS_LABELS[b]).join('・')}）`).join(' ')
      : r.fixedBy.map((n) => `#${n}`).join(' ');
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
    `| テストの改ざん：Jev と人の判断（件数 / 一致率） | ${s.tamper.rows} / ${pct(s.tamper.agreement)}（Jev が通す下限：${s.tamper.threshold === null ? '未設定' : s.tamper.threshold}） |`,
    `| テストの改ざん：Jev は通す・人は直させた | ${s.tamper.jevPassHumanFix} |`,
    `| テストの改ざん：Jev は止める・人は通した | ${s.tamper.jevFixHumanPass} |`,
    `| テストの改ざん：auto mode で通した | ${s.autoModeTests.allowed} |`,
    `| テストの改ざん：auto mode で通した・人が後から直させた | ${s.autoModeTests.fixed} |`,
    '',
    `切り替えの基準（docs/security.md）：否定側 ${c.minNegatives} 件以上、Jev の low の外れ ${c.maxJevLowMisses} 件、Jev だけが「可」${c.maxJevOnly} 件 → ${criteria}`,
    '',
    'fix PR の根拠：行＝元の PR が足した行を消した・消した行を足し戻した、参照＝題名・本文に元の PR（かその Issue）の番号がある、または同じ Issue を Closes する。',
    '',
    '| PR | Merge | Claude | Jev | revert | fix PR | 修正の往復 | 停滞（時間） | 却下 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| #${r.pr} | ${r.mergedAt?.slice(0, 10) ?? '-'} | ${yn(r.acceptance?.autoEligible)} | ${jevCell(r)} | ${r.reverted ? '○' : ''} | ${fixCell(r)} | ${r.fixRequests || ''} | ${stall(r)} | ${r.rejected || ''} |`,
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

// ---- 合体版のレビューの記録と今の判定の比較（記録だけの期間。Q91） ----

/**
 * 合体版のレビュー（`reviewPanel.mode` を `enforce`）に切り替える基準（Q91）。
 * 満たしても、人が「合体版だけ」の指摘と誤検知の疑いの全件を diff と照らして確かめてから決める。
 */
export const REVIEW_PANEL_SWITCH_CRITERIA = {
  minPairedPrs: 20,
  maxBackedReviewerOnly: 0,
  maxSuspectedFalsePositiveRatio: 0.5,
  maxProvisionalFixRatio: 1.5,
  maxCostMedianRatio: 3,
} as const;

export type PanelSwitchCriterion = keyof typeof REVIEW_PANEL_SWITCH_CRITERIA;

/** 記録を外す理由（1つの記録は最初に当たった理由で数える。reviewer-unknown は組を外した数） */
export const PANEL_EXCLUDE_REASONS = [
  'not-collaborator',
  'no-mark',
  'unreadable',
  'edited',
  'other-pr',
  'enforce',
  'head-mismatch',
  'after-verdict',
  'duplicate',
  'reviewer-unknown',
] as const;
export type PanelExcludeReason = (typeof PANEL_EXCLUDE_REASONS)[number];

const PANEL_EXCLUDE_LABELS: Record<PanelExcludeReason, string> = {
  'not-collaborator': 'コラボレーターでない',
  'no-mark': 'Claude の目印が無い',
  unreadable: 'ブロックが無い・読めない',
  edited: '編集された',
  'other-pr': '別の PR の記録',
  enforce: 'mode が enforce（今の reviewer と比べられない）',
  'head-mismatch': 'head が受け付けの verdictHeadSha と違う',
  'after-verdict': '判定コメントより後',
  duplicate: '同じ head の2つ目以降（判定コメントの直前の1つだけを使う）',
  'reviewer-unknown': '今の reviewer の指摘が読めない（組を外した）',
};

/** App の fix-request のレビュー（harness/scripts/report.ts が App のものだけに絞って渡す） */
export interface FixRequestReview {
  commitId: string;
  submittedAt: string;
  body: string;
}

/** PR のレビューコメント（/pulls/{n}/comments） */
export interface PrReviewComment {
  path: string;
  createdAt: string;
  authorAssociation: string;
  login: string;
  body: string;
}

/** PR ごとの材料（harness/scripts/report.ts が GitHub から集めたもの） */
export interface PanelCompareInput {
  pr: number;
  mergedAt: string | null;
  reverted: boolean;
  /** Merge 後 7 日以内の fix の PR（既存の行と同じ値） */
  fixedBy: number[];
  /** App の修正要求の数（既存の行と同じ値） */
  fixRequests: number;
  /** PR のコメント（記録・判定コメント・受け付けを含む） */
  comments: IssueComment[];
  /** 受け付けの記録（古い順） */
  acceptances: { comment: IssueComment; value: Acceptance }[];
  fixRequestReviews: FixRequestReview[];
  reviewComments: PrReviewComment[];
  /** fix の PR のファイル（結び付けの根拠になったファイル。`fixPrFilesOf`） */
  fixPrFiles: Record<number, string[]>;
  /**
   * 組の head から、その後の最初の合格の head（`laterPassHead`）までの PR 自身のコミットの変更ファイル（キーは組の head）。
   * main の取り込みで入った main 側の変更は含めない。無ければ空とみなす（「後の head で直された」に当たらない）。
   */
  laterHeadFiles?: Record<string, string[]>;
}

export type PanelEvidence = 'fix-request' | 'human-review' | 'fix-pr' | 'revert';
/** backed：裏付けあり、unconfirmed：未確認、suspected：誤検知の疑い（合体版だけ・Merge 済み・裏付け無し） */
export type PanelBacking = 'backed' | 'unconfirmed' | 'suspected';

export interface PanelOnlyFinding extends BlockingFinding {
  backing: PanelBacking;
  evidence: PanelEvidence[];
  /**
   * 後の head で直された：今の reviewer だけの指摘で、指摘のファイルを後の合格の head までのコミットが変えた（合体版だけの指摘は常に false）。
   * 指摘を受けたセッションは誤りでも直すことがあるので、本物の強い証拠ではない。`backing` とは別に数え、Q91 の基準 (2) には数えない。
   */
  fixedLater: boolean;
}

/** 組の行（受け付け1つと、その判定コメントより前の記録1つ） */
export interface PanelPairRow {
  pr: number;
  headSha: string;
  verdictCommentId: number;
  // App・GitHub の事実
  reviewerPass: boolean;
  reviewerBlocking: BlockingFinding[];
  fixRequests: number;
  mergedAt: string | null;
  reverted: boolean;
  fixedBy: number[];
  /** 判定コメントより後の、人（コラボレーター・目印なし）のレビューコメントの数 */
  humanComments: number;
  // セッションの申告
  panelPass: boolean;
  panelBlocking: BlockingFinding[];
  panelUsd: number | null;
  reviewerUsd: number | null;
  // 組み合わせ
  matched: number;
  reviewerOnly: PanelOnlyFinding[];
  panelOnly: PanelOnlyFinding[];
}

/** 作成の前後（同じ時刻なら comment id） */
const isAfter = (a: { created_at: string; id: number }, b: { created_at: string; id: number }): boolean => {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  return ta !== tb ? ta > tb : a.id > b.id;
};

const FIX_REQUEST_LINE = /^- \*\*([\w-]+)\*\*(?: `([^`]+)`)?: (.*)$/;

/** fix-request の本文の行（harness/gates/on-comment.ts の renderBlockingReview の形）からブロッキング指摘を読む */
export function fixRequestFindings(body: string): BlockingFinding[] {
  const out: BlockingFinding[] = [];
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(FIX_REQUEST_LINE);
    if (!m || !(BLOCKING_KINDS as readonly string[]).includes(m[1]!)) continue;
    out.push({ kind: m[1] as BlockingKind, ...(m[2] ? { file: m[2] } : {}), detail: m[3]! });
  }
  return out;
}

const isFixRequest = (r: FixRequestReview) => appMarkKind(r.body) === 'fix-request';

/**
 * 組の head の後の、最初の合格の head。head の最初の受け付けの判定コメント（無ければ受け付けのコメント）より後に作られた、
 * 別の head の最初の受け付けのうち、`reviewPass` が true の最初のもの。無ければ null。
 * push の時刻は GitHub から確かには読めないので、「判定の後に push された head」の代わりに「判定コメントより後の受け付けの head」を使う
 * （受け付けは App がその head の判定コメントを受けて作るので、判定コメントより後の受け付けの head は、組の head の判定の後に判定された head）。
 * harness/scripts/report.ts もこれで compare の相手を決める（取る範囲と数える条件をずらさない）。
 */
export function laterPassHead(input: Pick<PanelCompareInput, 'comments' | 'acceptances'>, head: string): string | null {
  const firstByHead = new Map<string, { comment: IssueComment; value: Acceptance }>();
  for (const a of input.acceptances) if (!firstByHead.has(a.value.verdictHeadSha)) firstByHead.set(a.value.verdictHeadSha, a);
  const own = firstByHead.get(head);
  if (!own) return null;
  const cutoff = input.comments.find((c) => c.id === own.value.verdictCommentId) ?? own.comment;
  for (const [h, a] of firstByHead) if (h !== head && a.value.reviewPass && isAfter(a.comment, cutoff)) return h;
  return null;
}

/** 同じファイル（両方にファイルがあるとき）か、両方ファイルが無いときは同じ種類 */
const sameFinding = (a: BlockingFinding, b: BlockingFinding) => (a.file && b.file ? a.file === b.file : !a.file && !b.file && a.kind === b.kind);

/**
 * 記録を選んで組の行と、外した記録の理由ごとの件数を返す。
 * 数えるのは、コラボレーターが書き、Claude の目印があり、読め、未編集で、同じ PR・shadow・受け付けの head と同じで、
 * その head の最初の受け付けの判定コメントより前に作られた記録（同じ head に複数あれば判定コメントの直前の1つ）。
 */
export function panelPairs(config: HarnessConfig, input: PanelCompareInput): { rows: PanelPairRow[]; excluded: Record<PanelExcludeReason, number> } {
  const excluded = Object.fromEntries(PANEL_EXCLUDE_REASONS.map((r) => [r, 0])) as Record<PanelExcludeReason, number>;
  const app = appLogin(config);
  const byId = new Map(input.comments.map((c) => [c.id, c]));

  // head ごとの最初の受け付け
  const firstByHead = new Map<string, { comment: IssueComment; value: Acceptance }>();
  for (const a of input.acceptances) if (!firstByHead.has(a.value.verdictHeadSha)) firstByHead.set(a.value.verdictHeadSha, a);

  // 記録の候補を絞る
  const counted = new Map<string, { comment: IssueComment; record: PanelRecord }[]>();
  for (const c of input.comments) {
    if (c.user?.login === app || !(c.body ?? '').includes('agent-review-panel')) continue;
    if (!isTrustedComment(c)) { excluded['not-collaborator']++; continue; }
    if (!hasClaudeMark(c.body)) { excluded['no-mark']++; continue; }
    const parsed = parsePanelRecord(c.body);
    if (!parsed.ok) { excluded.unreadable++; continue; }
    if (c.updated_at !== c.created_at) { excluded.edited++; continue; }
    const record = parsed.value;
    if (record.pr !== input.pr) { excluded['other-pr']++; continue; }
    if (record.mode === 'enforce') { excluded.enforce++; continue; }
    const acceptance = firstByHead.get(record.headSha);
    if (!acceptance) { excluded['head-mismatch']++; continue; }
    // 判定コメントが無ければ受け付けの記録（判定コメントより後）で前後を見る。組は reviewer-unknown で外す
    const cutoff = byId.get(acceptance.value.verdictCommentId) ?? acceptance.comment;
    if (!isAfter(cutoff, c)) { excluded['after-verdict']++; continue; }
    counted.set(record.headSha, [...(counted.get(record.headSha) ?? []), { comment: c, record }]);
  }

  const rows: PanelPairRow[] = [];
  for (const [head, acceptance] of firstByHead) {
    const records = counted.get(head);
    if (!records || records.length === 0) continue;
    // 判定コメントの直前の1つ
    const sorted = [...records].sort((a, b) => (isAfter(a.comment, b.comment) ? 1 : -1));
    excluded.duplicate += sorted.length - 1;
    const { record } = sorted.at(-1)!;

    const verdictComment = byId.get(acceptance.value.verdictCommentId);
    if (!verdictComment) { excluded['reviewer-unknown']++; continue; }
    let reviewerBlocking: BlockingFinding[] = [];
    if (!acceptance.value.reviewPass) {
      const own = input.fixRequestReviews.find((r) => isFixRequest(r) && r.commitId === head);
      if (own) reviewerBlocking = fixRequestFindings(own.body);
      else {
        const block = verdictComment.updated_at === verdictComment.created_at ? extractBlock(verdictComment.body, 'agent-verdict') : null;
        const parsed = block?.found && block.ok ? parseVerdict(block.value) : null;
        if (!parsed?.ok) { excluded['reviewer-unknown']++; continue; }
        reviewerBlocking = parsed.value.review.blocking;
      }
    }

    const verdictAt = Date.parse(verdictComment.created_at);
    const laterFixFiles = new Set(
      input.fixRequestReviews
        .filter((r) => isFixRequest(r) && r.commitId !== head && Date.parse(r.submittedAt) > verdictAt)
        .flatMap((r) => fixRequestFindings(r.body).flatMap((b) => (b.file ? [b.file] : []))),
    );
    const humanComments = input.reviewComments.filter(
      (rc) => Date.parse(rc.createdAt) > verdictAt && rc.login !== app && TRUSTED_ASSOCIATIONS.has(rc.authorAssociation) && !hasClaudeMark(rc.body),
    );
    const humanFiles = new Set(humanComments.map((rc) => rc.path));
    const fixPrFiles = new Set(input.fixedBy.flatMap((n) => input.fixPrFiles[n] ?? []));
    const fixedLaterFiles = new Set(laterPassHead(input, head) ? (input.laterHeadFiles?.[head] ?? []) : []);
    const back = (b: BlockingFinding, panelOnly: boolean): PanelOnlyFinding => {
      const evidence: PanelEvidence[] = [];
      if (b.file && laterFixFiles.has(b.file)) evidence.push('fix-request');
      if (b.file && humanFiles.has(b.file)) evidence.push('human-review');
      if (b.file && fixPrFiles.has(b.file)) evidence.push('fix-pr');
      if (input.reverted) evidence.push('revert');
      const backing: PanelBacking = evidence.length > 0 ? 'backed' : panelOnly && input.mergedAt ? 'suspected' : 'unconfirmed';
      return { ...b, backing, evidence, fixedLater: !panelOnly && Boolean(b.file && fixedLaterFiles.has(b.file)) };
    };

    // 前から順に1対1で対応させる
    const used = new Set<number>();
    const reviewerOnly: PanelOnlyFinding[] = [];
    let matched = 0;
    for (const r of reviewerBlocking) {
      const i = record.review.blocking.findIndex((p, j) => !used.has(j) && sameFinding(r, p));
      if (i === -1) reviewerOnly.push(back(r, false));
      else { used.add(i); matched++; }
    }
    const panelOnly = record.review.blocking.flatMap((p, j) => (used.has(j) ? [] : [back(p, true)]));

    rows.push({
      pr: input.pr,
      headSha: head,
      verdictCommentId: acceptance.value.verdictCommentId,
      reviewerPass: acceptance.value.reviewPass,
      reviewerBlocking,
      fixRequests: input.fixRequests,
      mergedAt: input.mergedAt,
      reverted: input.reverted,
      fixedBy: input.fixedBy,
      humanComments: humanComments.length,
      panelPass: record.review.pass,
      panelBlocking: record.review.blocking,
      panelUsd: record.cost.panel?.totalUsd ?? null,
      reviewerUsd: record.cost.reviewer?.totalUsd ?? null,
      matched,
      reviewerOnly,
      panelOnly,
    });
  }
  return { rows, excluded };
}

export interface PanelComparison {
  /** 組になった PR の数 */
  pairedPrs: number;
  /** 組（head）の数 */
  pairs: number;
  passMatrix: { reviewerPass: { panelPass: number; panelFail: number }; reviewerFail: { panelPass: number; panelFail: number } };
  matched: number;
  reviewerOnly: number;
  reviewerOnlyBacked: number;
  /** 今の reviewer だけの指摘のうち、裏付けが無く後の head で直されたもの（Q91 の基準 (2) には数えない） */
  reviewerOnlyFixedLater: number;
  panelOnly: number;
  panelOnlyBacked: number;
  suspectedFalsePositives: number;
  /** actual：組になった PR の fixRequests の合計、provisional：合体版が不合格の組の数、reviewerFailPairs：今の reviewer が不合格の組の数（参考） */
  fixRounds: { actual: number; provisional: number; reviewerFailPairs: number };
  costMedianUsd: { panel: number | null; reviewer: number | null };
  /** 料金の値が無い組の数 */
  costMissing: { panel: number; reviewer: number };
  criteria: { met: boolean; failed: PanelSwitchCriterion[] };
}

/** 浮動小数の誤差で境目がずれないように */
const EPS = 1e-9;

export function panelComparison(rows: PanelPairRow[]): PanelComparison {
  const c = REVIEW_PANEL_SWITCH_CRITERIA;
  const prs = new Map<number, PanelPairRow>();
  for (const r of rows) if (!prs.has(r.pr)) prs.set(r.pr, r);
  const count = (reviewerPass: boolean, panelPass: boolean) => rows.filter((r) => r.reviewerPass === reviewerPass && r.panelPass === panelPass).length;
  const reviewerOnly = rows.flatMap((r) => r.reviewerOnly);
  const panelOnly = rows.flatMap((r) => r.panelOnly);
  const reviewerOnlyBacked = reviewerOnly.filter((x) => x.backing === 'backed').length;
  const suspectedFalsePositives = panelOnly.filter((x) => x.backing === 'suspected').length;
  const actual = [...prs.values()].reduce((a, r) => a + r.fixRequests, 0);
  const provisional = rows.filter((r) => !r.panelPass).length;
  const panelCosts = rows.flatMap((r) => (r.panelUsd === null ? [] : [r.panelUsd]));
  const reviewerCosts = rows.flatMap((r) => (r.reviewerUsd === null ? [] : [r.reviewerUsd]));
  const costMedianUsd = { panel: median(panelCosts), reviewer: median(reviewerCosts) };

  const failed: PanelSwitchCriterion[] = [];
  if (prs.size < c.minPairedPrs) failed.push('minPairedPrs');
  if (reviewerOnlyBacked > c.maxBackedReviewerOnly) failed.push('maxBackedReviewerOnly');
  if (suspectedFalsePositives > panelOnly.length * c.maxSuspectedFalsePositiveRatio + EPS) failed.push('maxSuspectedFalsePositiveRatio');
  if (provisional > actual * c.maxProvisionalFixRatio + EPS) failed.push('maxProvisionalFixRatio');
  if (costMedianUsd.panel === null || costMedianUsd.reviewer === null || costMedianUsd.panel > costMedianUsd.reviewer * c.maxCostMedianRatio + EPS) {
    failed.push('maxCostMedianRatio');
  }

  return {
    pairedPrs: prs.size,
    pairs: rows.length,
    passMatrix: {
      reviewerPass: { panelPass: count(true, true), panelFail: count(true, false) },
      reviewerFail: { panelPass: count(false, true), panelFail: count(false, false) },
    },
    matched: rows.reduce((a, r) => a + r.matched, 0),
    reviewerOnly: reviewerOnly.length,
    reviewerOnlyBacked,
    reviewerOnlyFixedLater: reviewerOnly.filter((x) => x.backing !== 'backed' && x.fixedLater).length,
    panelOnly: panelOnly.length,
    panelOnlyBacked: panelOnly.filter((x) => x.backing === 'backed').length,
    suspectedFalsePositives,
    fixRounds: { actual, provisional, reviewerFailPairs: rows.filter((r) => !r.reviewerPass).length },
    costMedianUsd,
    costMissing: { panel: rows.length - panelCosts.length, reviewer: rows.length - reviewerCosts.length },
    criteria: { met: failed.length === 0, failed },
  };
}

const PANEL_CRITERIA_LABELS: Record<PanelSwitchCriterion, string> = {
  minPairedPrs: `組になった PR ${REVIEW_PANEL_SWITCH_CRITERIA.minPairedPrs} 件以上`,
  maxBackedReviewerOnly: `今の reviewer だけが出して裏付けのあるブロッキング ${REVIEW_PANEL_SWITCH_CRITERIA.maxBackedReviewerOnly} 件`,
  maxSuspectedFalsePositiveRatio: `合体版だけのブロッキングのうち誤検知の疑いが ${REVIEW_PANEL_SWITCH_CRITERIA.maxSuspectedFalsePositiveRatio * 100}% 以下`,
  maxProvisionalFixRatio: `合体版の仮の往復が実際の ${REVIEW_PANEL_SWITCH_CRITERIA.maxProvisionalFixRatio} 倍以下`,
  maxCostMedianRatio: `1判定あたりの推定料金の中央値が今の reviewer の ${REVIEW_PANEL_SWITCH_CRITERIA.maxCostMedianRatio} 倍以下`,
};

const EVIDENCE_LABELS: Record<PanelEvidence, string> = {
  'fix-request': '後の head の変更要求',
  'human-review': '人のレビューコメント',
  'fix-pr': 'fix の PR',
  revert: 'revert',
};

/** 表のセルに入れる文字列（| と改行を逃がし、max 字で切る） */
const cell = (text: string, max = Infinity): string => {
  const chars = [...text.replace(/\r?\n/g, ' ')];
  return (chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('')).replace(/\|/g, '\\|');
};
const passCell = (pass: boolean) => (pass ? '合格' : '不合格');
const usdCell = (v: number | null) => (v === null ? '-' : `$${Math.round(v * 1000) / 1000}`);

export function renderPanelComparison(summary: PanelComparison, rows: PanelPairRow[], excluded: Record<string, number>): string {
  const s = summary;
  const c = REVIEW_PANEL_SWITCH_CRITERIA;
  const failed = s.criteria.failed.map((k) => PANEL_CRITERIA_LABELS[k]);
  const criteria = s.criteria.met ? '**満たす**（切り替えは人が全件を確かめてから決める）' : `満たさない（満たさない項目：${failed.join('、')}）`;
  const fixedLaterNote =
    s.reviewerOnlyFixedLater > 0 ? `。後の head で直された今の reviewer だけの指摘 ${s.reviewerOnlyFixedLater} 件（基準 (2) には数えない。切り替えの前に人が確かめる）` : '';
  const reasons = [...PANEL_EXCLUDE_REASONS, ...Object.keys(excluded).filter((k) => !(PANEL_EXCLUDE_REASONS as readonly string[]).includes(k))];
  const backingCell = (x: PanelOnlyFinding) =>
    x.backing === 'backed'
      ? `あり：${x.evidence.map((e) => EVIDENCE_LABELS[e]).join('・')}${x.fixedLater ? '・後の head で直された' : ''}`
      : x.backing === 'suspected'
        ? '誤検知の疑い'
        : x.fixedLater
          ? '未確認（後の head で直された）'
          : '未確認';
  const findingRows = (side: string, pick: (r: PanelPairRow) => PanelOnlyFinding[]) =>
    rows.flatMap((r) => pick(r).map((x) => `| ${side} | #${r.pr} | ${r.headSha.slice(0, 7)} | ${x.kind} | ${x.file ? `\`${cell(x.file)}\`` : '-'} | ${backingCell(x)} | ${cell(x.detail, 120)} |`));
  const list = [...findingRows('今の reviewer だけ', (r) => r.reviewerOnly), ...findingRows('合体版だけ', (r) => r.panelOnly)];
  return [
    '## 合体版のレビュー（記録だけの期間の比較）',
    '',
    `組になった PR ${s.pairedPrs} / ${c.minPairedPrs}（組になった head ${s.pairs}）`,
    '',
    '数える記録：コラボレーターが書き、Claude の目印があり、ブロックが読め、未編集で、head が App の受け付けの verdictHeadSha と同じで、判定コメントより前に作られた shadow の記録。',
    '合体版の指摘・合否・料金はセッションの申告（偽れる）。本物・誤検知は App・GitHub の事実の裏付け（後の head の変更要求・人のレビューコメント・Merge 後 7 日以内の fix の PR・revert）だけで数える。',
    '「後の head で直された」は、今の reviewer だけの指摘のファイルを、その後の最初の合格の head までの PR 自身のコミットが変えたもの。指摘を受けたセッションは誤りでも直すことがあるので本物の強い証拠ではなく、裏付けとは別に数え、基準 (2) には数えない。',
    '',
    '| 指標 | 値 |',
    '| --- | --- |',
    `| 指摘の一致（同じファイル、ファイルが無ければ同じ種類） | ${s.matched} |`,
    `| 今の reviewer だけ（うち裏付けあり・裏付けは無いが後の head で直された） | ${s.reviewerOnly}（${s.reviewerOnlyBacked}・${s.reviewerOnlyFixedLater}） |`,
    `| 合体版だけ（うち裏付けあり・誤検知の疑い） | ${s.panelOnly}（${s.panelOnlyBacked}・${s.suspectedFalsePositives}） |`,
    `| 修正の往復：実際（組になった PR の変更要求の合計） | ${s.fixRounds.actual} |`,
    `| 修正の往復：合体版の仮（合体版が不合格の組） | ${s.fixRounds.provisional} |`,
    `| 参考：今の reviewer が不合格の組 | ${s.fixRounds.reviewerFailPairs} |`,
    `| 1判定あたりの推定料金の中央値：合体版（値の無い組） | ${usdCell(s.costMedianUsd.panel)}（${s.costMissing.panel}） |`,
    `| 1判定あたりの推定料金の中央値：今の reviewer（値の無い組） | ${usdCell(s.costMedianUsd.reviewer)}（${s.costMissing.reviewer}） |`,
    '',
    '実際の往復は PR の全部の head、仮は組になった head だけを数えるので範囲がずれる。仮は参考の「今の reviewer が不合格の組」と並べて見る（記録の抜けた head があると仮が少なく出る）。',
    '',
    '| 今の reviewer（App の事実） ＼ 合体版（申告） | 合格 | 不合格 |',
    '| --- | --- | --- |',
    `| 合格 | ${s.passMatrix.reviewerPass.panelPass} | ${s.passMatrix.reviewerPass.panelFail} |`,
    `| 不合格 | ${s.passMatrix.reviewerFail.panelPass} | ${s.passMatrix.reviewerFail.panelFail} |`,
    '',
    '外した記録：',
    '',
    '| 理由 | 内容 | 件数 |',
    '| --- | --- | --- |',
    ...reasons.map((k) => `| ${k} | ${PANEL_EXCLUDE_LABELS[k as PanelExcludeReason] ?? '-'} | ${excluded[k] ?? 0} |`),
    '',
    `切り替えの基準（docs/plan.md の Q91）：${Object.values(PANEL_CRITERIA_LABELS).join('、')} → ${criteria}${fixedLaterNote}`,
    '',
    '組ごとの表：「PR」〜「人のコメント」の列は App・GitHub の事実、「合体版」〜「料金」の列はセッションの申告。',
    '',
    '| PR | head | 今の reviewer | 指摘 | 変更要求 | Merge | revert | fix PR | 人のコメント | 合体版 | ブロッキング | 一致 | 合体版だけ | 料金（合体版 / 今の reviewer） |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| #${r.pr} | ${r.headSha.slice(0, 7)} | ${passCell(r.reviewerPass)} | ${r.reviewerBlocking.length} | ${r.fixRequests} | ${r.mergedAt?.slice(0, 10) ?? '-'} | ${r.reverted ? '○' : ''} | ${r.fixedBy.map((n) => `#${n}`).join(' ')} | ${r.humanComments || ''} | ${passCell(r.panelPass)} | ${r.panelBlocking.length} | ${r.matched} | ${r.panelOnly.length} | ${usdCell(r.panelUsd)} / ${usdCell(r.reviewerUsd)} |`,
    ),
    '',
    '### 片方だけのブロッキング指摘',
    '',
    ...(list.length === 0
      ? ['ありません。']
      : ['| 側 | PR | head | 種類 | ファイル | 裏付け | 指摘（120 字まで） |', '| --- | --- | --- | --- | --- | --- | --- |', ...list]),
  ].join('\n');
}

// ---- 人の決定の記録（Jev の判定と人の判断、#151） ----

/** shadow の plan-decision の記録1件と、人がその後進めたか（true：進めた、false：進めなかった、null：未決） */
export interface DecisionRow {
  issue: number;
  decisionCommentId: number;
  recordedAt: string;
  jevPass: boolean | null;
  humanProceeded: boolean | null;
}

/**
 * Issue の shadow の plan-decision の記録（status: ok）ごとに、人がその後進めたかを決める。
 * 進めた＝記録の後、次の計画ゲートの記録より前に、App 以外が agent:plan-review を外した、またはこの Issue を Closes する PR が作られた。
 * 進めなかった＝進めないまま次の計画ゲートの記録が付いた（計画の出し直し）か、PR 無しで Issue が閉じた。どちらでもなければ未決。
 */
export function decisionRows(
  config: HarnessConfig,
  issue: number,
  comments: IssueComment[],
  events: { event: string; created_at?: string; actor?: { login: string } | null; label?: { name: string } }[],
  closingPrs: { number: number; createdAt: string }[],
): DecisionRow[] {
  const app = appLogin(config);
  const fromApp = (c: IssueComment) => c.user?.login === app;
  const time = (s: string | undefined) => (s ? Date.parse(s) : NaN);
  const gates = comments.filter((c) => fromApp(c) && appMarkKind(c.body) === 'plan-gate').map((c) => time(c.created_at));
  const rows: DecisionRow[] = [];
  for (const c of comments) {
    if (!fromApp(c) || appMarkKind(c.body) !== 'plan-decision') continue;
    const block = extractBlock(c.body, 'agent-app');
    if (!block.found || !block.ok) continue;
    const v = block.value as { decisionCommentId?: number; mode?: string; status?: string; pass?: boolean | null };
    if (v.mode !== 'shadow' || v.status !== 'ok' || typeof v.decisionCommentId !== 'number') continue;
    const at = time(c.created_at);
    const next = gates.filter((t) => t > at).sort((a, b) => a - b)[0] ?? Infinity;
    const within = (t: number) => t > at && t < next;
    const unlabeled = events.some((e) => e.event === 'unlabeled' && e.label?.name === 'agent:plan-review' && e.actor?.login !== app && within(time(e.created_at)));
    const pr = closingPrs.some((p) => within(time(p.createdAt)));
    const closed = events.some((e) => e.event === 'closed' && within(time(e.created_at)));
    const humanProceeded = unlabeled || pr ? true : next !== Infinity || closed ? false : null;
    rows.push({ issue, decisionCommentId: v.decisionCommentId, recordedAt: c.created_at, jevPass: typeof v.pass === 'boolean' ? v.pass : null, humanProceeded });
  }
  return rows;
}

export interface DecisionAgreement {
  /** 未決・Jev の可否が無いものを除いた件数 */
  decided: number;
  undecided: number;
  both: number;
  jevOnly: number;
  humanOnly: number;
  neither: number;
  /** 一致率（decided が 0 なら null） */
  agreement: number | null;
}

/** Jev の可否 × 人が進めたか の 2×2 と一致率 */
export function decisionAgreement(rows: DecisionRow[]): DecisionAgreement {
  const s: DecisionAgreement = { decided: 0, undecided: 0, both: 0, jevOnly: 0, humanOnly: 0, neither: 0, agreement: null };
  for (const r of rows) {
    if (r.jevPass === null || r.humanProceeded === null) {
      s.undecided++;
      continue;
    }
    s.decided++;
    if (r.jevPass && r.humanProceeded) s.both++;
    else if (r.jevPass) s.jevOnly++;
    else if (r.humanProceeded) s.humanOnly++;
    else s.neither++;
  }
  s.agreement = s.decided === 0 ? null : Math.round(((s.both + s.neither) / s.decided) * 1000) / 1000;
  return s;
}

export function renderDecisionAgreement(stats: DecisionAgreement, rows: DecisionRow[]): string {
  const yn = (v: boolean | null, yes: string, no: string) => (v === null ? '未決' : v ? yes : no);
  return [
    '## 人の決定の記録（Jev の判定と人の判断）',
    '',
    `shadow の記録 ${rows.length} 件（判断が決まったもの ${stats.decided}、未決 ${stats.undecided}）。一致率：${stats.agreement === null ? '-' : `${(stats.agreement * 100).toFixed(1)}%`}`,
    '',
    '進めた＝記録の後、次の計画ゲートの記録より前に、App 以外が `agent:plan-review` を外したか Issue を Closes する PR が作られた。進めなかった＝計画を出し直したか PR 無しで閉じた。',
    '',
    '| Jev ＼ 人 | 進めた | 進めなかった |',
    '| --- | --- | --- |',
    `| 可 | ${stats.both} | ${stats.jevOnly} |`,
    `| 不可 | ${stats.humanOnly} | ${stats.neither} |`,
    '',
    ...(rows.length === 0
      ? ['記録はありません。']
      : [
          '| Issue | 決定の記録 | 記録の日時 | Jev | 人 |',
          '| --- | --- | --- | --- | --- |',
          ...rows.map((r) => `| #${r.issue} | ${r.decisionCommentId} | ${r.recordedAt.slice(0, 16)} | ${yn(r.jevPass, '可', '不可')} | ${yn(r.humanProceeded, '進めた', '進めなかった')} |`),
        ]),
  ].join('\n');
}
