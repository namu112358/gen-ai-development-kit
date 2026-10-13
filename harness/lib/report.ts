import { appMarkKind, extractBlock } from './blocks.ts';
import { claimTimeline } from './facts.ts';
import { appLogin, type HarnessConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import { JEV_QUESTION_SET, jevFailures } from './jev.ts';
import type { Acceptance, JevRecord } from './merge-route.ts';
import type { ExemptRecord } from './exempt.ts';
import { tamperAllows, tamperJevThreshold, type TamperJevRecord } from './test-tamper-jev.ts';
import { autoModeConfig, type AutoModeJevRecord } from './auto-mode.ts';
import type { AutoModeTestsRecord } from './auto-mode-tests.ts';
import { RISK_QUESTIONS } from './verdict.ts';

/**
 * 判定の集計（Jev の切り替え判断用）の純粋関数。GitHub は呼ばない（集めるのは harness/scripts/report.ts）。
 *
 * 「外れ」＝ Merge 後 7 日以内に revert された、または元の PR を直す fix の PR が Merge された。
 * fix の PR は、変更ファイルが重なることに加えて、行（元の PR が足した行を消した・消した行を足し戻した）か
 * 参照（題名・本文に元の PR か元の PR が Closes した Issue の番号がある、または元の PR と同じ Issue を Closes する）で結び付ける（`fixLinksFor`）。
 * 比べる相手は Claude ではなく結果。基準の意味は harness/docs/security.md の「Jev」。
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
  /** PR 本文の「実装のモデル:」の行のモデル（無い・null は不明。implementModelOf） */
  implementModel?: string | null;
  /** PR が Closes する Issue の着手宣言で、implement の次の宣言が plan だった回数（無ければ 0。planReturnsOf） */
  planReturns?: number;
  /** 計画ゲートの記録の modelRouting が勧めたモデル（null は記録なし。Issue #139） */
  recommendedModel?: 'opus' | 'sonnet' | null;
  /** 勧めを読んだ計画ゲートの記録が通過か（勧めが無ければ null） */
  recommendedGatePass?: boolean | null;
  /** App の修正要求レビューのブロッキング指摘の合計 */
  blockingFindings?: number;
  /** PR の mutation のジョブのログの survived の数（読めなければ null） */
  mutationSurvived?: number | null;
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
    `Jev の数は問いの版 ${JEV_QUESTION_SET} の記録だけで数える（harness/docs/security.md の「Jev」）。`,
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
    `切り替えの基準（harness/docs/security.md）：否定側 ${c.minNegatives} 件以上、Jev の low の外れ ${c.maxJevLowMisses} 件、Jev だけが「可」${c.maxJevOnly} 件 → ${criteria}`,
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

// ---- 実装のモデルごとの品質（Issue #473） ----

export const UNKNOWN_IMPLEMENT_MODEL = '不明';

/** PR 本文の「実装のモデル:」の行からモデルを読む（無い・空・雛形の `<model>` のままなら不明） */
export function implementModelOf(body: string | null | undefined): string {
  const m = /^[ \t]*(?:[-*][ \t]+)?実装のモデル[:：](.*)$/m.exec(body ?? '');
  if (!m) return UNKNOWN_IMPLEMENT_MODEL;
  const value = m[1]!.trim().replace(/^`+|`+$/g, '').trim();
  if (value === '' || value.startsWith('<')) return UNKNOWN_IMPLEMENT_MODEL;
  return value.toLowerCase();
}

/**
 * Issue のコメントの着手宣言で、implement の次の（解除でない）宣言が plan だった回数（実装が計画に返した回数。表示用）。
 * 読むのは Claude の目印があり、コラボレーターが書いた読める agent-claim だけ（history の段階も1つずつ数える）。id の昇順で見て、持ち主・セッションでは絞らない。
 */
export function planReturnsOf(comments: IssueComment[]): number {
  let prev: string | undefined;
  let count = 0;
  for (const item of claimTimeline([...comments].sort((a, b) => a.id - b.id))) {
    if (item.kind !== 'claim' || item.claim!.released) continue;
    if (prev === 'implement' && item.claim!.stage === 'plan') count++;
    prev = item.claim!.stage;
  }
  return count;
}

export interface ImplementModelRow {
  model: string;
  count: number;
  firstPass: number;
  firstPassRate: number | null;
  fixRequests: number;
  fixRequestsAvg: number | null;
  fixedPrs: number;
  reverted: number;
  planReturns: number;
}

/** 受け付け記録のある Agent PR を、実装のモデルごとに集計する（モデル名の昇順、不明は最後） */
export function implementModelQuality(rows: ReportRow[]): ImplementModelRow[] {
  const by = new Map<string, ImplementModelRow>();
  for (const r of rows) {
    if (r.acceptance === null) continue;
    const model = r.implementModel || UNKNOWN_IMPLEMENT_MODEL;
    let e = by.get(model);
    if (!e) {
      e = { model, count: 0, firstPass: 0, firstPassRate: null, fixRequests: 0, fixRequestsAvg: null, fixedPrs: 0, reverted: 0, planReturns: 0 };
      by.set(model, e);
    }
    e.count++;
    if (r.fixRequests === 0) e.firstPass++;
    e.fixRequests += r.fixRequests;
    if (r.fixedBy.length > 0) e.fixedPrs++;
    if (r.reverted) e.reverted++;
    e.planReturns += r.planReturns ?? 0;
  }
  for (const e of by.values()) {
    e.firstPassRate = e.firstPass / e.count;
    e.fixRequestsAvg = e.fixRequests / e.count;
  }
  const rank = (m: string) => (m === UNKNOWN_IMPLEMENT_MODEL ? 1 : 0);
  return [...by.values()].sort((a, b) => rank(a.model) - rank(b.model) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

export function renderImplementModelQuality(rows: ImplementModelRow[]): string {
  return [
    '## 実装のモデルごとの品質',
    '',
    '母数は受け付け記録のある Agent PR。1回で合格は App の修正要求レビューが0件の PR。モデルは PR 本文の `実装のモデル:` の行（無ければ不明）。',
    '計画に返した回数は、PR が Closes する Issue の着手宣言で implement の次の宣言が plan だった回数（人が計画のやり直しを求めた場合も同じ数に入る。同じ Issue を Closes する PR が複数あれば、それぞれの PR に同じ回数が入る）。',
    '',
    ...(rows.length === 0
      ? ['対象の PR はありません']
      : [
          '| モデル | 件数 | 1回で合格 | 1回で合格の割合 | 修正の回数（合計） | 修正の回数（平均） | fix の PR がある PR | revert | 計画に返した回数 |',
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
          ...rows.map((r) => `| ${r.model} | ${r.count} | ${r.firstPass} | ${pct(r.firstPassRate)} | ${r.fixRequests} | ${num(r.fixRequestsAvg)} | ${r.fixedPrs} | ${r.reverted} | ${r.planReturns} |`),
        ]),
  ].join('\n');
}

// ---- 実装のモデルの勧めと結果（Issue #139） ----

export interface ModelRoutingQualityRow {
  gate: 'pass' | 'stopped' | 'none';
  recommended: string;
  model: string;
  count: number;
  firstPass: number;
  firstPassRate: number | null;
  fixRequestsAvg: number | null;
  blockingAvg: number | null;
  fixedPrs: number;
  reverted: number;
  mutationPrs: number;
  mutationSurvivedAvg: number | null;
}

/** 勧めが無い行の勧めの欄 */
const NO_ROUTING = '記録なし';

/**
 * 受け付け記録のある Agent PR を、計画ゲートの勧め（modelRouting）×使ったモデルごとに集計する。
 * 並びは gate（pass→stopped→none）、勧め（opus→sonnet→記録なし）、モデル（名前の昇順、不明は最後）
 */
export function modelRoutingQuality(rows: ReportRow[]): ModelRoutingQualityRow[] {
  interface Acc extends ModelRoutingQualityRow {
    fixRequests: number;
    blocking: number;
    mutationSurvived: number;
  }
  const by = new Map<string, Acc>();
  for (const r of rows) {
    if (r.acceptance === null) continue;
    const recommended = r.recommendedModel ?? null;
    const gate: Acc['gate'] = recommended === null ? 'none' : r.recommendedGatePass === true ? 'pass' : 'stopped';
    const recommendedName = recommended ?? NO_ROUTING;
    const model = r.implementModel || UNKNOWN_IMPLEMENT_MODEL;
    const key = [gate, recommendedName, model].join('/');
    let e = by.get(key);
    if (!e) {
      e = { gate, recommended: recommendedName, model, count: 0, firstPass: 0, firstPassRate: null, fixRequestsAvg: null, blockingAvg: null, fixedPrs: 0, reverted: 0, mutationPrs: 0, mutationSurvivedAvg: null, fixRequests: 0, blocking: 0, mutationSurvived: 0 };
      by.set(key, e);
    }
    e.count++;
    if (r.fixRequests === 0) e.firstPass++;
    e.fixRequests += r.fixRequests;
    e.blocking += r.blockingFindings ?? 0;
    if (r.fixedBy.length > 0) e.fixedPrs++;
    if (r.reverted) e.reverted++;
    if (typeof r.mutationSurvived === 'number') {
      e.mutationPrs++;
      e.mutationSurvived += r.mutationSurvived;
    }
  }
  const gateRank = { pass: 0, stopped: 1, none: 2 };
  const recRank = (m: string) => (m === 'opus' ? 0 : m === 'sonnet' ? 1 : 2);
  const modelRank = (m: string) => (m === UNKNOWN_IMPLEMENT_MODEL ? 1 : 0);
  const out: ModelRoutingQualityRow[] = [];
  for (const e of by.values()) {
    const { fixRequests, blocking, mutationSurvived, ...row } = e;
    out.push({ ...row, firstPassRate: e.firstPass / e.count, fixRequestsAvg: fixRequests / e.count, blockingAvg: blocking / e.count, mutationSurvivedAvg: e.mutationPrs === 0 ? null : mutationSurvived / e.mutationPrs });
  }
  return out.sort(
    (a, b) => gateRank[a.gate] - gateRank[b.gate] || recRank(a.recommended) - recRank(b.recommended) || modelRank(a.model) - modelRank(b.model) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
}

const GATE_LABELS = { pass: '通過', stopped: '停止', none: '-' } as const;

export function renderModelRoutingQuality(rows: ModelRoutingQualityRow[]): string {
  return [
    '## 実装のモデルの勧めと結果',
    '',
    '勧めは計画ゲートの記録の modelRouting（App の記録）。モデルは PR 本文の `実装のモデル:` の行（セッションが書くので偽れる）。切り替えの基準は docs/plan.md の決定ログ。基準に数えるのはゲートを通過した計画だけ。mutation の survived は PR 側のコードが決めるので参考。',
    '',
    ...(rows.length === 0
      ? ['対象の PR はありません']
      : [
          '| ゲート | 勧め | 使ったモデル | 件数 | 1回で合格 | 1回で合格の割合 | 修正の回数（平均） | ブロッキング指摘（平均） | fix の PR がある PR | revert | mutation の PR | mutation の survived（平均） |',
          '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
          ...rows.map(
            (r) => `| ${GATE_LABELS[r.gate]} | ${r.recommended} | ${r.model} | ${r.count} | ${r.firstPass} | ${pct(r.firstPassRate)} | ${num(r.fixRequestsAvg)} | ${num(r.blockingAvg)} | ${r.fixedPrs} | ${r.reverted} | ${r.mutationPrs} | ${num(r.mutationSurvivedAvg)} |`,
          ),
        ]),
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

/** 見解あり・なしの比べ（auto mode の危険の問いの shadow。#426） */
export interface AutoModeViewShift {
  /** 見解なし・見解ありの両方の確率が読めて比べた件数 */
  compared: number;
  /** 見解なしは安全で、見解ありは危険 */
  safeToDanger: number;
  /** 見解なしは危険で、見解ありは安全 */
  dangerToSafe: number;
  /** 確率の差（見解あり − 見解なし）の平均。比べた件数が 0 なら null */
  meanDiff: number | null;
}

/**
 * 計画ゲートの記録（計画コメントごと）と受け付けの記録（patch-id ごと）から、auto mode の Jev の記録を1件ずつ取り出す。
 * 同じ計画コメント・同じ patch-id の記録が何回出し直されても、最後の1件だけを数える（記録は使い回されるので同じ問いを重ねて数えない）。jev の無いものは除く。
 * main の取り込みで引き継いだ受け付け（carriedFrom あり）は、同じ Jev の記録の写しなので数えない。
 */
export function autoModeViewRecords(
  planGates: { planCommentId: number; autoMode?: { jev?: AutoModeJevRecord } }[],
  acceptances: { patchId: string; carriedFrom?: unknown; autoMode?: { jev?: AutoModeJevRecord } }[],
): AutoModeJevRecord[] {
  const plans = new Map<number, AutoModeJevRecord | undefined>();
  for (const g of planGates) plans.set(g.planCommentId, g.autoMode?.jev);
  const prs = new Map<string, AutoModeJevRecord | undefined>();
  for (const a of acceptances) if (!a.carriedFrom) prs.set(a.patchId, a.autoMode?.jev);
  return [...plans.values(), ...prs.values()].filter((j): j is AutoModeJevRecord => j !== undefined);
}

/** 設定の dangerSafe で、計画ゲート・受け付けの記録から見解あり・なしで結論が変わった件数を数える（autoModeViewRecords → autoModeViewShift。#449） */
export function autoModeViewShiftOf(
  config: Pick<HarnessConfig, 'autoMode'>,
  planGates: Parameters<typeof autoModeViewRecords>[0],
  acceptances: Parameters<typeof autoModeViewRecords>[1],
): AutoModeViewShift {
  return autoModeViewShift(autoModeConfig(config).dangerSafe, autoModeViewRecords(planGates, acceptances));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 見解あり・なしで結論（安全／危険）が変わった件数。見解なしが ok で確率が読め、withView も ok で確率が読める記録だけを比べる。
 * 結論は autoModeDanger と同じ下限で決める（安全側の確率 1 - yes が dangerSafe 未満なら危険）
 */
export function autoModeViewShift(dangerSafe: number, records: AutoModeJevRecord[]): AutoModeViewShift {
  const s: AutoModeViewShift = { compared: 0, safeToDanger: 0, dangerToSafe: 0, meanDiff: null };
  let sum = 0;
  const danger = (yes: number) => 1 - yes < dangerSafe;
  for (const r of records) {
    const w = r.withView;
    if (r.status !== 'ok' || !finite(r.yes) || w?.status !== 'ok' || !finite(w.yes)) continue;
    s.compared++;
    sum += w.yes - r.yes;
    const before = danger(r.yes);
    const after = danger(w.yes);
    if (!before && after) s.safeToDanger++;
    if (before && !after) s.dangerToSafe++;
  }
  if (s.compared > 0) s.meanDiff = Math.round((sum / s.compared) * 1000) / 1000;
  return s;
}

export function renderAutoModeViewShift(s: AutoModeViewShift): string {
  const diff = s.meanDiff === null ? '-' : `${s.meanDiff > 0 ? '+' : ''}${(s.meanDiff * 100).toFixed(1)} ポイント`;
  return [
    '## auto mode の見解あり・なし（shadow）',
    '',
    '作業したセッションの見解（`authorView`）を渡した問いと渡さない問いの、Jev の危険の結論の比べ。保留するかは見解なしだけで決めている。',
    '見解ありの記録（`withView`）が無い・ok でない・確率が読めない記録は比べない。計画コメントごと・patch-id ごとに1件。',
    '',
    '| 比べた件数 | 安全→危険 | 危険→安全 | 危険の確率の差の平均（あり − なし） |',
    '| --- | --- | --- | --- |',
    `| ${s.compared} | ${s.safeToDanger} | ${s.dangerToSafe} | ${diff} |`,
  ].join('\n');
}

/** 保留した計画・PR のその後（そのまま・直させた・閉じた） */
export type AutoModeHoldOutcome = 'as-is' | 'fixed' | 'closed';

/** auto mode で保留した計画（Issue）か PR の1件。yes は記録の Jev の危険の確率（読めなければ null） */
export interface AutoModeHoldRow {
  kind: 'plan' | 'pr';
  target: number;
  yes: number | null;
  outcome: AutoModeHoldOutcome;
}

const holdYes = (jev: AutoModeJevRecord | undefined): number | null => (jev?.status === 'ok' && finite(jev.yes) ? jev.yes : null);

/**
 * 受け付けの記録から、auto mode の危険の判定で保留した PR のその後を1件の行にする（Issue #491）。
 * 保留は記録の事実で決め（autoMode.jev があり eligible が偽の最後の記録。carriedFrom は除く）、今の dangerSafe では決め直さない。
 * 結果は最後の受け付け（carriedFrom を除く）の patch-id が保留の記録と同じ Merge ならそのまま、違えば直させた、Merge されずに閉じたら閉じた（autoModeTestsDecision と同じ比べ方）。
 * 保留の後の関係の無い push でも patch-id が変わるので、直させたは多めに出る
 */
export function autoModePrHold(
  pr: number,
  acceptances: { patchId: string; carriedFrom?: unknown; autoMode?: { eligible: boolean; jev?: AutoModeJevRecord } }[],
  merged: boolean,
): AutoModeHoldRow | null {
  const own = acceptances.filter((a) => !a.carriedFrom);
  const last = own.filter((a) => a.autoMode?.jev && a.autoMode.eligible === false).at(-1);
  if (!last) return null;
  const outcome: AutoModeHoldOutcome = !merged ? 'closed' : own.at(-1)!.patchId === last.patchId ? 'as-is' : 'fixed';
  return { kind: 'pr', target: pr, yes: holdYes(last.autoMode!.jev), outcome };
}

/**
 * 計画ゲートの記録から、auto mode の危険の判定で保留した計画のその後を1件の行にする（Issue #491）。
 * hold が真の最後の記録の後に、別の計画コメントの記録があれば直させた（出し直した）。無ければ Issue が completed で閉じたらそのまま、それ以外で閉じたら閉じた。開いていれば数えない
 */
export function autoModePlanHold(
  issue: number,
  planGates: { planCommentId: number; autoMode?: { jev?: AutoModeJevRecord; hold?: boolean } }[],
  state: { state: string; stateReason?: string | null },
): AutoModeHoldRow | null {
  const at = planGates.findLastIndex((g) => g.autoMode?.hold === true);
  if (at < 0) return null;
  const last = planGates[at]!;
  const yes = holdYes(last.autoMode?.jev);
  if (planGates.slice(at + 1).some((g) => g.planCommentId !== last.planCommentId)) return { kind: 'plan', target: issue, yes, outcome: 'fixed' };
  if (state.state !== 'closed') return null;
  return { kind: 'plan', target: issue, yes, outcome: state.stateReason === 'completed' ? 'as-is' : 'closed' };
}

const HOLD_BANDS = ['〜20%', '20〜50%', '50%〜', '確率なし'] as const;

/** 危険の確率の帯（境は固定。保留の線が変わっても変わらない） */
export function autoModeHoldBand(yes: number | null): (typeof HOLD_BANDS)[number] {
  if (yes === null || !finite(yes)) return '確率なし';
  return yes <= 0.2 ? '〜20%' : yes <= 0.5 ? '20〜50%' : '50%〜';
}

/** 計画・PR ごと、帯ごとに、保留した件数とその後の結果を数える */
export function autoModeHoldStats(rows: AutoModeHoldRow[]): { kind: 'plan' | 'pr'; band: string; held: number; asIs: number; fixed: number; closed: number }[] {
  const out = [];
  for (const kind of ['plan', 'pr'] as const) {
    for (const band of HOLD_BANDS) {
      const hit = rows.filter((r) => r.kind === kind && autoModeHoldBand(r.yes) === band);
      out.push({
        kind,
        band,
        held: hit.length,
        asIs: hit.filter((r) => r.outcome === 'as-is').length,
        fixed: hit.filter((r) => r.outcome === 'fixed').length,
        closed: hit.filter((r) => r.outcome === 'closed').length,
      });
    }
  }
  return out;
}

export function renderAutoModeHolds(stats: ReturnType<typeof autoModeHoldStats>): string {
  const head = '## auto mode で保留した計画・PR のその後';
  if (stats.every((s) => s.held === 0)) return `${head}\n\n結果の出た、保留した計画・PR はありません。`;
  const line = (kind: 'plan' | 'pr') =>
    stats.filter((s) => s.kind === kind).map((s) => `| ${kind === 'plan' ? '計画' : 'PR'} | ${s.band} | ${s.held} | ${s.asIs} | ${s.fixed} | ${s.closed} |`);
  return [
    head,
    '',
    '記録に残った保留（今の保留の線では決め直さない）を、Jev の危険の確率の帯ごとに、その後の結果で数える。結果の出たものだけ。',
    '',
    '| 種類 | 危険の確率 | 保留した件数 | そのまま | 直させた | 閉じた |',
    '| --- | --- | --- | --- | --- | --- |',
    ...line('plan'),
    ...line('pr'),
    '',
    '- PR の「直させた」は、保留の後の関係の無い push でも patch-id が変わると数えるので多めに出る（autoModeTestsDecision と同じ）。',
    '- 計画の「そのまま」は、計画を出し直さずに Issue が完了した意味。PR が直させられたかは PR の行で見る。',
  ].join('\n');
}
