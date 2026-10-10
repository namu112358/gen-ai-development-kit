/**
 * 判定の⑨（over-implementation・over-testing・over-engineering）のブロッキング指摘を Jev に問う材料・要求・答えのまとめ・
 * enforce での判定の組み替え・受け付けの表の行。GitHub も Jev も呼ばない純粋関数。
 * 材料は diff・⑨の指摘（kind・file・detail）・recent_diff だけで、判定の facts・rationale・PR 本文などセッションの言い分は入れない。
 * jev.overbuild（無ければ shadow）：shadow は記録だけ、enforce は「Merge を止める」確率が下限未満の⑨だけをブロッキングから外す。
 * App への組み込みは #584（Epic #497）。
 */
import type { HarnessConfig } from './config.ts';
import type { JevAnswers } from './jev.ts';
import { OVERBUILD_KINDS, OVERBUILD_MAX_FINDINGS } from './review-panel.ts';
import type { BlockingFinding, Verdict } from './verdict.ts';

export type OverbuildJevMode = 'off' | 'shadow' | 'enforce';

/** 問いの版（問いの文を変えたら上げる） */
export const OVERBUILD_JEV_QUESTION_SET = 1;

export const overbuildJevMode = (config: HarnessConfig): OverbuildJevMode => config.jev.overbuild ?? 'shadow';

export const overbuildJevThreshold = (config: HarnessConfig): number | null => config.jev.thresholds.overbuildBlockProbability ?? null;

export type OverbuildKind = (typeof OVERBUILD_KINDS)[number];

const isOverbuild = (f: BlockingFinding): boolean => (OVERBUILD_KINDS as readonly string[]).includes(f.kind);

/** 判定のブロッキング指摘のうち⑨の種類だけ（元の順） */
export function overbuildBlocking(verdict: Verdict): BlockingFinding[] {
  return verdict.review.blocking.filter(isOverbuild);
}

export type AskableOverbuild = { ask: true } | { ask: false; reason: string };

/** Jev に問えるか。0件・上限超え・diff と recentDiff の文字数の合計が jev.maxDiffChars 超えなら問わない */
export function askableOverbuild(config: HarnessConfig, findings: BlockingFinding[], diff: string, recentDiff: string | null): AskableOverbuild {
  if (findings.length === 0) return { ask: false, reason: '⑨の指摘がありません' };
  if (findings.length > OVERBUILD_MAX_FINDINGS) return { ask: false, reason: `⑨の指摘が多すぎます（${findings.length} 件 > ${OVERBUILD_MAX_FINDINGS}）` };
  const total = diff.length + (recentDiff?.length ?? 0);
  if (total > config.jev.maxDiffChars) return { ask: false, reason: `材料が大きすぎます（${total} 文字 > ${config.jev.maxDiffChars}）` };
  return { ask: true };
}

const blockQuestion = (i: number) => ({
  type: 'noul',
  instructions: `findings[${i}] is a review finding that says part of \`diff\` goes beyond what the change needs (its kind is over-implementation, over-testing, or over-engineering; findings[${i}].file and findings[${i}].detail say where and why). Judging from \`diff\` only, should this finding stop the merge? Answer yes only if the code it points to is in \`diff\`, goes beyond what the change needs, and keeping it causes harm.`,
  criteria: {
    true: 'The code the finding points to is in `diff`, and keeping it causes harm: it adds behavior that can break or that runs in production without being needed, it reads or writes data that production does not use, or its maintenance cost is clearly large compared with the change.',
    false: 'Any of these: the code the finding points to is not in `diff`; the finding is a matter of taste or style; it points to a small fallback or a small extra check that does no harm; or you cannot tell from `diff` that keeping it causes harm.',
  },
});

const recentQuestion = (i: number) => ({
  type: 'noul',
  instructions: `recent_diff is the part of the change made since the previous review. Does findings[${i}] point to lines that recent_diff added or changed?`,
  criteria: {
    true: `The code that findings[${i}] points to appears as added or changed lines in \`recent_diff\`.`,
    false: `The code that findings[${i}] points to is not among the added or changed lines of \`recent_diff\` (it was already there before the previous review), or you cannot tell.`,
  },
});

/** askJev に渡す要求。state は diff・findings（kind・file・detail）と、recentDiff があるときだけ recent_diff */
export function buildOverbuildRequest(config: HarnessConfig, diff: string, findings: BlockingFinding[], recentDiff: string | null) {
  const hasRecent = recentDiff !== null && recentDiff !== '';
  const state: { diff: string; findings: { kind: string; file: string | null; detail: string }[]; recent_diff?: string } = {
    diff,
    findings: findings.map((f) => ({ kind: f.kind, file: f.file ?? null, detail: f.detail })),
  };
  if (hasRecent) state.recent_diff = recentDiff;
  const questions: Record<string, unknown> = {};
  findings.forEach((_, i) => {
    questions[`block_${i}`] = blockQuestion(i);
    if (hasRecent) questions[`recent_${i}`] = recentQuestion(i);
  });
  return { model: config.jev.model, state, questions };
}

export interface OverbuildJevFinding {
  kind: OverbuildKind;
  file: string | null;
  detail: string;
  /** block_<i> の yes（Merge を止める）の確率。答えが欠けたら null */
  block: number | null;
  /** recent_<i> の yes の確率。問わない・欠けたら null。合否には使わない */
  recent: number | null;
  /** block ≥ 下限。下限が無いか block が null なら null */
  wouldBlock: boolean | null;
  /** enforce・下限あり・block が下限未満で、ブロッキングから外す */
  demoted: boolean;
}

export interface OverbuildJevRecord {
  version: 1;
  status: 'ok' | 'skipped' | 'error';
  mode: OverbuildJevMode;
  model: string | null;
  questionSet: number;
  threshold: number | null;
  detail: string | null;
  findings: OverbuildJevFinding[];
}

const finite = (p: number | undefined): number | null => (typeof p === 'number' && Number.isFinite(p) ? p : null);

export function summarizeOverbuildJev(config: HarnessConfig, model: string, answers: JevAnswers, findings: BlockingFinding[], recentAsked: boolean): OverbuildJevRecord {
  const mode = overbuildJevMode(config);
  const threshold = overbuildJevThreshold(config);
  return {
    version: 1,
    status: 'ok',
    mode,
    model,
    questionSet: OVERBUILD_JEV_QUESTION_SET,
    threshold,
    detail: null,
    findings: findings.map((f, i) => {
      const block = finite(answers[`block_${i}`]?.noul);
      const recent = recentAsked ? finite(answers[`recent_${i}`]?.noul) : null;
      const wouldBlock = threshold === null || block === null ? null : block >= threshold;
      return {
        kind: f.kind as OverbuildKind,
        file: f.file ?? null,
        detail: f.detail,
        block,
        recent,
        wouldBlock,
        demoted: mode === 'enforce' && threshold !== null && block !== null && block < threshold,
      };
    }),
  };
}

/** 問わなかった・エラーの記録。指摘はすべて block・recent・wouldBlock が null、demoted が偽 */
export function skippedOverbuildJev(config: HarnessConfig, findings: BlockingFinding[], status: 'skipped' | 'error', detail: string): OverbuildJevRecord {
  return {
    version: 1,
    status,
    mode: overbuildJevMode(config),
    model: null,
    questionSet: OVERBUILD_JEV_QUESTION_SET,
    threshold: overbuildJevThreshold(config),
    detail,
    findings: findings.map((f) => ({ kind: f.kind as OverbuildKind, file: f.file ?? null, detail: f.detail, block: null, recent: null, wouldBlock: null, demoted: false })),
  };
}

const pct = (p: number | null) => (p !== null && Number.isFinite(p) ? `${Math.round(p * 100)}%` : '-');

/**
 * enforce で、Jev が「Merge を止めない」と答えた（下限未満の）⑨をブロッキングから外し、nonBlocking に回して pass を決め直す。
 * 記録が無い・ok でない・enforce でない・外すものが無い・記録の指摘が今の判定の⑨と合わない、なら元の判定をそのまま返す。元の判定は変えない
 */
export function applyOverbuildJev(verdict: Verdict, record: OverbuildJevRecord | undefined): Verdict {
  if (!record || record.status !== 'ok' || record.mode !== 'enforce') return verdict;
  if (!record.findings.some((f) => f.demoted)) return verdict;
  const over = overbuildBlocking(verdict);
  if (over.length !== record.findings.length) return verdict;
  if (!over.every((f, i) => f.kind === record.findings[i]!.kind && (f.file ?? null) === record.findings[i]!.file && f.detail === record.findings[i]!.detail)) return verdict;

  const demoted = new Map<BlockingFinding, OverbuildJevFinding>();
  over.forEach((f, i) => {
    if (record.findings[i]!.demoted) demoted.set(f, record.findings[i]!);
  });
  const blocking = verdict.review.blocking.filter((f) => !demoted.has(f)).map((f) => ({ ...f }));
  const moved = [...demoted].map(([f, r]) => `[${f.kind}]（Jev：Merge を止める確率 ${pct(r.block)}、下限 ${pct(record.threshold)}）${f.detail}`);
  return {
    ...verdict,
    review: { ...verdict.review, pass: blocking.length === 0, blocking, nonBlocking: [...verdict.review.nonBlocking, ...moved] },
  };
}

/** 受け付けの表の行。記録が無いか mode が off なら空の配列 */
export function renderOverbuildJevRow(record: OverbuildJevRecord | undefined): string[] {
  if (!record || record.mode === 'off') return [];
  if (record.status === 'skipped') return [`| ⑨の Jev | 問いませんでした：${record.detail ?? ''} |`];
  if (record.status === 'error') return [`| ⑨の Jev | エラー：${record.detail ?? ''} |`];
  const n = record.findings.length;
  const m = record.findings.filter((f) => f.wouldBlock === true).length;
  const k = record.findings.filter((f) => f.demoted).length;
  const body = record.threshold === null ? `${n} 件中、下限未設定（${record.mode}）` : `${n} 件中、Jev も止める ${m} 件（${record.mode}、外した ${k} 件）`;
  return [`| ⑨の Jev | ${body} |`];
}
