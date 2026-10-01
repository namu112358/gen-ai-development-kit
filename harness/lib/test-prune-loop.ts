import { checkIssueDrafts } from './arch-review.ts';
import type { LoopDraft } from './qa-retro-loop.ts';

/**
 * test-prune を付き添いのセッションの `/loop` から回すときの、手元の状態と回の記録（純粋関数）。スクリプトは harness/scripts/test-prune-loop.ts。
 * test-prune は毎回全部のテストを見るので、qa-retro のような期間（until）は持たず、回ごとに集計の時刻と下書きを残す。
 * 未採用の一覧と採用は qa-retro-loop の pendingDrafts・adoptDraft をそのまま使う。
 *
 * 状態のファイル（既定は git の共通ディレクトリの下の agent-harness/test-prune-loop.json。作業ツリーにも GitHub にも書かない）の書式：
 *   { "version": 1, "rounds": [{ "at", "generatedAt", "headSha": <string | null>, "candidates": <候補の数>,
 *     "drafts": [{ "title", "body", "duplicateOf"?, "created": <Issue 番号 | null> }], "duplicates": [<記録しなかった同じタイトル>] }] }
 * 下書きはループの回では Issue にしない。人が選んで作ったときだけ created に Issue 番号を書く。ラベルは持たせない。
 */

export const TEST_PRUNE_LOOP_MAX_DRAFTS = 3;

export interface TestPruneLoopRound {
  /** 回を記録した時刻 */
  at: string;
  /** 集計の JSON（test-prune.ts の出力）の generatedAt */
  generatedAt: string;
  headSha: string | null;
  /** 集計の候補の数 */
  candidates: number;
  drafts: LoopDraft[];
  /** すでに状態にある下書きと同じタイトルなので記録しなかった下書きのタイトル */
  duplicates: string[];
}
export interface TestPruneLoopState { version: 1; rounds: TestPruneLoopRound[] }

type Result<T> = ({ ok: true } & T) | { ok: false; errors: string[] };

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function roundErrors(r: unknown, at: string): string[] {
  if (!isObject(r)) return [`${at}：オブジェクトではありません`];
  const errors: string[] = [];
  if (!isIso(r.at) || !isIso(r.generatedAt)) errors.push(`${at}：at・generatedAt は ISO の時刻`);
  if (!(r.headSha === null || typeof r.headSha === 'string')) errors.push(`${at}：headSha は文字列か null`);
  if (!(Number.isInteger(r.candidates) && (r.candidates as number) >= 0)) errors.push(`${at}：candidates は0以上の整数`);
  if (!Array.isArray(r.duplicates) || !r.duplicates.every((d) => typeof d === 'string')) errors.push(`${at}：duplicates は文字列の配列`);
  if (!Array.isArray(r.drafts)) errors.push(`${at}：drafts は配列`);
  else {
    r.drafts.forEach((d: unknown, j) => {
      const w = `${at}の${j + 1}件目`;
      if (!isObject(d) || typeof d.title !== 'string' || typeof d.body !== 'string') errors.push(`${w}：title と body は文字列`);
      else {
        if (d.duplicateOf !== undefined && !isPositiveInt(d.duplicateOf)) errors.push(`${w}：duplicateOf は Issue 番号`);
        if (!(d.created === null || isPositiveInt(d.created))) errors.push(`${w}：created は Issue 番号か null`);
      }
    });
  }
  return errors;
}

/** 状態のファイルの中身を読む。text が null（ファイルが無い）なら state は null。壊れた JSON・version の違い・形の誤りは誤り（上書きしない） */
export function parseTestPruneLoopState(text: string | null): Result<{ state: TestPruneLoopState | null }> {
  if (text === null) return { ok: true, state: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`状態のファイルが JSON として読めません：${(e as Error).message}`] };
  }
  if (!isObject(v)) return { ok: false, errors: ['状態のファイルはオブジェクト'] };
  if (v.version !== 1) return { ok: false, errors: [`状態のファイルの version が 1 ではありません：${JSON.stringify(v.version)}`] };
  if (!Array.isArray(v.rounds)) return { ok: false, errors: ['rounds は配列'] };
  const errors = v.rounds.flatMap((r: unknown, i) => roundErrors(r, `${i + 1}回目`));
  return errors.length ? { ok: false, errors } : { ok: true, state: v as unknown as TestPruneLoopState };
}

/**
 * 報告を出した後に回を記録する。report は test-prune.ts の出力の JSON（version 1・generatedAt・files・candidates）。
 * 前回の回の generatedAt と同じか古い集計は誤り（同じ JSON を2回記録しない）。drafts は下書きの配列（無ければ undefined）で、3件まで・ラベルなし。
 * すでに状態にある下書き（未採用・採用済みとも）と同じタイトルの下書きは記録せず duplicates に残す。元の状態は変えない。
 */
export function recordTestPruneRound(state: TestPruneLoopState | null, report: unknown, drafts: unknown, at: Date): Result<{ state: TestPruneLoopState }> {
  const r = report as Record<string, unknown> | null;
  if (!isObject(r) || r.version !== 1 || !isIso(r.generatedAt) || !Array.isArray(r.files) || !Array.isArray(r.candidates)) {
    return { ok: false, errors: ['集計の JSON（test-prune.ts の出力。version 1・generatedAt・files と candidates の配列）ではありません'] };
  }
  const generatedAt = new Date(r.generatedAt as string);
  const errors: string[] = [];
  const last = state?.rounds.at(-1);
  if (last && generatedAt.getTime() <= new Date(last.generatedAt).getTime()) {
    errors.push(`集計の JSON の時刻（${r.generatedAt}）が、前回の回の集計（${last.generatedAt}）より新しくありません（古い JSON・ほかのセッションが同じ状態で回した恐れ）`);
  }
  const known = new Set((state?.rounds ?? []).flatMap((x) => x.drafts.map((d) => d.title)));
  const records: LoopDraft[] = [];
  const duplicates: string[] = [];
  if (drafts !== undefined) {
    const checked = checkIssueDrafts(drafts, TEST_PRUNE_LOOP_MAX_DRAFTS);
    if (!checked.ok) errors.push(...checked.errors);
    else {
      checked.drafts.forEach((x, i) => {
        if (x.labels !== undefined && x.labels.length > 0) errors.push(`${i + 1}件目：下書きにラベルは持たせない（agent:ready も含め、ラベルは付けない）`);
        if (known.has(x.title)) duplicates.push(x.title);
        else {
          known.add(x.title);
          records.push({ title: x.title, body: x.body, ...(x.duplicateOf ? { duplicateOf: x.duplicateOf } : {}), created: null });
        }
      });
    }
  }
  if (errors.length) return { ok: false, errors };
  const round: TestPruneLoopRound = {
    at: at.toISOString(),
    generatedAt: generatedAt.toISOString(),
    headSha: typeof r.headSha === 'string' ? r.headSha : null,
    candidates: r.candidates.length,
    drafts: records,
    duplicates,
  };
  return { ok: true, state: { version: 1, rounds: [...(state?.rounds ?? []), round] } };
}
