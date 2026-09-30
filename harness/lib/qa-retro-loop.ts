import { checkIssueDrafts } from './arch-review.ts';

/**
 * qa-retro を付き添いのセッションの `/loop` から回すときの、期間のつなぎ方と手元の状態（純粋関数）。スクリプトは harness/scripts/qa-retro-loop.ts。
 * 期間は時刻で決め、前回の回の終わり（状態の until）を次の回の始まりにする（collectQaRetro の Merge 日時の判定は始まりを含み終わりを含まないので、境目の PR は1回だけ数えられる）。
 * 終わりは今の 7 日前（後追いの修正は Merge 後 7 日以内の fix の PR で数えるので、窓が閉じた PR だけを見る）。状態が無い初回は、終わりの 14 日前から。
 *
 * 状態のファイル（既定は git の共通ディレクトリの下の agent-harness/qa-retro-loop.json。作業ツリーにも GitHub にも書かない）の書式：
 *   { "version": 1, "until": "<ISO 時刻>", "rounds": [{ "since", "until", "advancedAt", "prs": <PR の数>, "drafts": [{ "title", "body", "duplicateOf"?, "created": <Issue 番号 | null> }] }] }
 * 下書きはループの回では Issue にしない。人が選んで作ったときだけ created に Issue 番号を書く（adoptDraft）。ラベルは持たせない。
 */

const DAY = 86400_000;
export const QA_RETRO_LOOP_MAX_DRAFTS = 3;
export const QA_RETRO_LOOP_LAG_DAYS = 7;
export const QA_RETRO_LOOP_FIRST_DAYS = 14;

export interface LoopDraft { title: string; body: string; duplicateOf?: number; created: number | null }
export interface LoopRound { since: string; until: string; advancedAt: string; prs: number; drafts: LoopDraft[] }
export interface LoopState { version: 1; until: string; rounds: LoopRound[] }

type Result<T> = { ok: true } & T | { ok: false; errors: string[] };

const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** 今回の期間。state が null（初回）なら [now-21日, now-7日)、あれば [state.until, now-7日)。empty は始まり ≥ 終わり（まだ見る期間が無い） */
export function loopPeriod(state: LoopState | null, now: Date): { since: Date; until: Date; first: boolean; empty: boolean } {
  const until = new Date(now.getTime() - QA_RETRO_LOOP_LAG_DAYS * DAY);
  const first = state === null;
  const since = first ? new Date(until.getTime() - QA_RETRO_LOOP_FIRST_DAYS * DAY) : new Date(state.until);
  return { since, until, first, empty: since.getTime() >= until.getTime() };
}

function draftErrors(d: unknown, at: string): string[] {
  const x = d as Record<string, unknown> | null;
  if (typeof x !== 'object' || x === null || typeof x.title !== 'string' || typeof x.body !== 'string') return [`${at}：title と body は文字列`];
  const errors: string[] = [];
  if (x.duplicateOf !== undefined && !isPositiveInt(x.duplicateOf)) errors.push(`${at}：duplicateOf は Issue 番号`);
  if (!(x.created === null || isPositiveInt(x.created))) errors.push(`${at}：created は Issue 番号か null`);
  return errors;
}

/** 状態のファイルの中身を読む。text が null（ファイルが無い）なら state は null。壊れた JSON・version の違い・形の誤りは誤り（上書きしない） */
export function parseLoopState(text: string | null): Result<{ state: LoopState | null }> {
  if (text === null) return { ok: true, state: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`状態のファイルが JSON として読めません：${(e as Error).message}`] };
  }
  const s = v as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return { ok: false, errors: ['状態のファイルはオブジェクト'] };
  if (s.version !== 1) return { ok: false, errors: [`状態のファイルの version が 1 ではありません：${JSON.stringify(s.version)}`] };
  const errors: string[] = [];
  if (!isIso(s.until)) errors.push('until は ISO の時刻');
  if (!Array.isArray(s.rounds)) errors.push('rounds は配列');
  else {
    s.rounds.forEach((r: unknown, i) => {
      const at = `${i + 1}回目`;
      const x = r as Record<string, unknown> | null;
      if (typeof x !== 'object' || x === null) {
        errors.push(`${at}：オブジェクトではありません`);
        return;
      }
      if (!isIso(x.since) || !isIso(x.until) || !isIso(x.advancedAt)) errors.push(`${at}：since・until・advancedAt は ISO の時刻`);
      if (!(Number.isInteger(x.prs) && (x.prs as number) >= 0)) errors.push(`${at}：prs は0以上の整数`);
      if (!Array.isArray(x.drafts)) errors.push(`${at}：drafts は配列`);
      else x.drafts.forEach((d: unknown, j) => errors.push(...draftErrors(d, `${at}の${j + 1}件目`)));
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, state: v as LoopState };
}

/**
 * 報告を出した後に期間を進める。集計の JSON（QaRetroData）の period.since が状態の until と一致するか（状態が無ければ、初回の幅 14 日の JSON か）を確かめ、
 * until を period.until にし、回の記録を足した新しい状態を返す（元の状態は変えない）。drafts は下書きの配列（無ければ undefined）。
 */
export function advanceLoopState(state: LoopState | null, data: unknown, drafts: unknown, at: Date): Result<{ state: LoopState }> {
  const d = data as { period?: { since?: unknown; until?: unknown }; prs?: unknown } | null;
  if (typeof d !== 'object' || d === null || !isIso(d.period?.since) || !isIso(d.period?.until) || !Array.isArray(d.prs)) {
    return { ok: false, errors: ['集計の JSON に period.since・period.until（ISO の時刻）と prs（配列）がありません'] };
  }
  const since = new Date(d.period.since as string);
  const until = new Date(d.period.until as string);
  const errors: string[] = [];
  if (since.getTime() >= until.getTime()) errors.push('集計の JSON の期間の始まりが終わり以降です');
  if (state === null) {
    if (until.getTime() - since.getTime() !== QA_RETRO_LOOP_FIRST_DAYS * DAY) {
      errors.push(`状態が無い（初回）のに、集計の JSON の期間が初回の幅（${QA_RETRO_LOOP_FIRST_DAYS} 日）ではありません（別の状態で作った JSON の恐れ）`);
    }
  } else if (since.getTime() !== new Date(state.until).getTime()) {
    errors.push(`集計の JSON の期間の始まり（${d.period.since}）が、前回の回の終わり（${state.until}）と違います（ほかのセッションが同じ状態で回した・古い JSON の恐れ）`);
  }
  let records: LoopDraft[] = [];
  if (drafts !== undefined) {
    const checked = checkIssueDrafts(drafts);
    if (!checked.ok) errors.push(...checked.errors);
    else {
      if (checked.drafts.length > QA_RETRO_LOOP_MAX_DRAFTS) errors.push(`下書きは1回に ${QA_RETRO_LOOP_MAX_DRAFTS} 件まで（${checked.drafts.length} 件）`);
      checked.drafts.forEach((x, i) => {
        if (x.labels !== undefined && x.labels.length > 0) errors.push(`${i + 1}件目：下書きにラベルは持たせない（agent:ready も含め、ラベルは付けない）`);
      });
      records = checked.drafts.map((x) => ({ title: x.title, body: x.body, ...(x.duplicateOf ? { duplicateOf: x.duplicateOf } : {}), created: null }));
    }
  }
  if (errors.length) return { ok: false, errors };
  const round: LoopRound = { since: since.toISOString(), until: until.toISOString(), advancedAt: at.toISOString(), prs: d.prs.length, drafts: records };
  return { ok: true, state: { version: 1, until: round.until, rounds: [...(state?.rounds ?? []), round] } };
}

/** 未採用（created が null）の下書きの一覧と、下書きの数・採用された数。round・draft は1から数える */
export function pendingDrafts(state: LoopState | null): {
  pending: { round: number; draft: number; title: string; body: string; duplicateOf?: number }[];
  total: number;
  adopted: number;
} {
  const pending: { round: number; draft: number; title: string; body: string; duplicateOf?: number }[] = [];
  let total = 0;
  let adopted = 0;
  (state?.rounds ?? []).forEach((r, i) =>
    r.drafts.forEach((d, j) => {
      total++;
      if (d.created !== null) adopted++;
      else pending.push({ round: i + 1, draft: j + 1, title: d.title, body: d.body, ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}) });
    }),
  );
  return { pending, total, adopted };
}

/** 人が選んで作った Issue の番号を下書きの created に書いた新しい状態（期間の until は変えない）。範囲外・採用済みは誤り */
export function adoptDraft(state: LoopState | null, round: number, draft: number, issue: number): Result<{ state: LoopState }> {
  if (!isPositiveInt(issue)) return { ok: false, errors: ['Issue 番号は正の整数'] };
  const r = Number.isInteger(round) ? state?.rounds[round - 1] : undefined;
  if (!state || !r || round < 1) return { ok: false, errors: [`${round}回目の記録がありません`] };
  const d = Number.isInteger(draft) && draft >= 1 ? r.drafts[draft - 1] : undefined;
  if (!d) return { ok: false, errors: [`${round}回目の${draft}件目の下書きがありません`] };
  if (d.created !== null) return { ok: false, errors: [`${round}回目の${draft}件目の下書きは #${d.created} として作成済みです`] };
  const rounds = state.rounds.map((x, i) => (i !== round - 1 ? x : { ...x, drafts: x.drafts.map((y, j) => (j !== draft - 1 ? y : { ...y, created: issue })) }));
  return { ok: true, state: { ...state, rounds } };
}
