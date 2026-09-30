import { OBSERVE_SECTIONS, type ObserveReport, type ObserveSection } from './observe.ts';

/**
 * 見直しのまとめ役（patrol の skill）が、観測の差と前回からの経過で今回まわす見直しを決める（純粋関数）。スクリプトは harness/scripts/patrol.ts。
 * 見直しごとに、見る観測の節と間隔の下限・上限を PATROL_REVIEWS に持つ。形が suggest の見直し（test-prune）は動かさず、人に勧めるだけにする。
 *
 * 状態のファイル（既定は git の共通ディレクトリの下の agent-harness/patrol.json。作業ツリーにも GitHub にも書かない）の書式：
 *   { "version": 1, "reviews": { "<名前>": { "lastRunAt"?: "<ISO 時刻>", "lastSuggestedAt"?: "<ISO 時刻>" } },
 *     "observe": "<写した観測の JSON のファイル名>" | null, "rounds": [{ "at", "ran": [名前], "suggested": [名前] }]（直近 50 件） }
 */

export type PatrolReviewName = 'arch-review' | 'qa-retro' | 'test-prune';
export type PatrolMode = 'run' | 'suggest';
export interface PatrolReviewDef {
  name: PatrolReviewName;
  /** run はループの回の形で動かす。suggest は動かさず、人に勧めるだけ */
  mode: PatrolMode;
  /** 見る観測の節（diff.sections） */
  sections: ObserveSection[];
  /** これより短いと回さない・勧めない（時間） */
  minHours: number;
  /** これを過ぎたら差が無くても回す・勧める（時間） */
  maxHours: number;
}

/** 表の順（同じ順位のときの並び）。arch-review に hotspots を入れないのは、上位が Merge のたびに入れ替わり、差がほぼ毎回出るため */
export const PATROL_REVIEWS: readonly PatrolReviewDef[] = [
  { name: 'arch-review', mode: 'run', sections: ['docs'], minHours: 12, maxHours: 72 },
  { name: 'qa-retro', mode: 'run', sections: ['flakyTests', 'mutants'], minHours: 24, maxHours: 168 },
  { name: 'test-prune', mode: 'suggest', sections: ['slowTests', 'flakyTests', 'mutants'], minHours: 24, maxHours: 336 },
];
export const PATROL_DEFAULT_MAX = 2;
export const PATROL_MAX_ROUNDS = 50;

export interface PatrolReviewState { lastRunAt?: string; lastSuggestedAt?: string }
export interface PatrolRound { at: string; ran: PatrolReviewName[]; suggested: PatrolReviewName[] }
export interface PatrolState {
  version: 1;
  reviews: Partial<Record<PatrolReviewName, PatrolReviewState>>;
  /** 写した観測の JSON のファイル名（状態のファイルと同じディレクトリ）。まだ無ければ null */
  observe: string | null;
  rounds: PatrolRound[];
}

export type PatrolReason = 'never' | 'overdue' | 'too-soon' | 'diff' | 'no-diff' | 'limit';
export interface PatrolDecision { name: PatrolReviewName; mode: PatrolMode; reason: PatrolReason; detail: string }
export interface PatrolSelection {
  /** 回す見直し（回す順） */
  run: PatrolReviewName[];
  /** 人に勧めるだけの見直し */
  suggest: PatrolReviewName[];
  /** 回さない・勧めないものと理由 */
  skipped: { name: PatrolReviewName; reason: PatrolReason }[];
  /** 見直しごとの理由（表の順） */
  reasons: PatrolDecision[];
}

type Result<T> = ({ ok: true } & T) | { ok: false; errors: string[] };

const HOUR = 3600_000;
const NAMES = PATROL_REVIEWS.map((r) => r.name) as string[];
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hours = (ms: number): string => `${Math.round((ms / HOUR) * 10) / 10} 時間`;

interface Candidate { def: PatrolReviewDef; reason: PatrolReason; detail: string; overdueMs: number; diffCount: number }

function decide(def: PatrolReviewDef, state: PatrolState | null, observe: ObserveReport, now: Date): Candidate {
  const r = state?.reviews[def.name];
  const last = def.mode === 'run' ? r?.lastRunAt : r?.lastSuggestedAt;
  const verb = def.mode === 'run' ? '回した' : '勧めた';
  const notes: string[] = [];
  let diffCount = 0;
  if (!observe.diff) notes.push('前回の観測が無いので差なしとして数える');
  else {
    for (const s of def.sections) {
      const d = observe.diff.sections[s];
      if (d === null || d === undefined) notes.push(`${s} は読めないので差なしとして数える`);
      else diffCount += d.added.length + d.removed.length;
    }
  }
  const tail = notes.length ? `（${notes.join('。')}）` : '';
  const base = { def, overdueMs: 0, diffCount };
  if (!last) return { ...base, reason: 'never', detail: `一度も${verb}ことが無い${tail}` };
  const elapsed = now.getTime() - new Date(last).getTime();
  if (elapsed >= def.maxHours * HOUR) {
    return { ...base, reason: 'overdue', overdueMs: elapsed - def.maxHours * HOUR, detail: `前回${verb}時刻から ${hours(elapsed)}（上限 ${def.maxHours} 時間以上）${tail}` };
  }
  if (elapsed < def.minHours * HOUR) return { ...base, reason: 'too-soon', detail: `前回${verb}時刻から ${hours(elapsed)}（下限 ${def.minHours} 時間未満）${tail}` };
  if (diffCount > 0) return { ...base, reason: 'diff', detail: `観測の差が ${diffCount} 件（${def.sections.join('・')}）${tail}` };
  return { ...base, reason: 'no-diff', detail: `観測の差が無い（${def.sections.join('・')}）${tail}` };
}

const RANK: Partial<Record<PatrolReason, number>> = { never: 0, overdue: 1, diff: 2 };

/** 今回まわす見直しを決める。max は run の形で回す数の上限（suggest の形は枠を使わない）。状態は変えない */
export function selectReviews(state: PatrolState | null, observe: ObserveReport, now: Date, max: number): PatrolSelection {
  const all = PATROL_REVIEWS.map((def) => decide(def, state, observe, now));
  const chosen = (c: Candidate): boolean => RANK[c.reason] !== undefined;
  const order = (a: Candidate, b: Candidate): number =>
    RANK[a.reason]! - RANK[b.reason]! ||
    (a.reason === 'overdue' ? b.overdueMs - a.overdueMs : 0) ||
    (a.reason === 'diff' ? b.diffCount - a.diffCount : 0) ||
    PATROL_REVIEWS.indexOf(a.def) - PATROL_REVIEWS.indexOf(b.def);
  const runs = all.filter((c) => c.def.mode === 'run' && chosen(c)).sort(order);
  const run = runs.slice(0, Math.max(0, max));
  const limited = new Set(runs.slice(run.length).map((c) => c.def.name));
  const reasons: PatrolDecision[] = all.map((c) =>
    limited.has(c.def.name)
      ? { name: c.def.name, mode: c.def.mode, reason: 'limit', detail: `${c.detail}。1回に回す数の上限（${max}）を超えたので次の回に回す` }
      : { name: c.def.name, mode: c.def.mode, reason: c.reason, detail: c.detail },
  );
  return {
    run: run.map((c) => c.def.name),
    suggest: all.filter((c) => c.def.mode === 'suggest' && chosen(c)).map((c) => c.def.name),
    // limit も RANK に無いので、ここに入る
    skipped: reasons.filter((d) => RANK[d.reason] === undefined).map((d) => ({ name: d.name, reason: d.reason })),
    reasons,
  };
}

/** 状態のファイルの中身を読む。text が null（ファイルが無い）なら state は null。壊れた JSON・version の違い・形の誤りは誤り（上書きしない） */
export function parsePatrolState(text: string | null): Result<{ state: PatrolState | null }> {
  if (text === null) return { ok: true, state: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`状態のファイルが JSON として読めません：${(e as Error).message}`] };
  }
  if (!isObject(v)) return { ok: false, errors: ['状態のファイルはオブジェクト'] };
  if (v.version !== 1) return { ok: false, errors: [`状態のファイルの version が 1 ではありません：${JSON.stringify(v.version)}`] };
  const errors: string[] = [];
  if (!isObject(v.reviews)) errors.push('reviews はオブジェクト');
  else {
    for (const [name, r] of Object.entries(v.reviews)) {
      if (!NAMES.includes(name)) errors.push(`reviews に知らない見直しがあります：${name}`);
      else if (!isObject(r)) errors.push(`reviews.${name} はオブジェクト`);
      else {
        for (const k of ['lastRunAt', 'lastSuggestedAt']) if (r[k] !== undefined && !isIso(r[k])) errors.push(`reviews.${name}.${k} は ISO の時刻`);
      }
    }
  }
  if (!(v.observe === null || (typeof v.observe === 'string' && v.observe !== '' && !/[\\/]/.test(v.observe)))) errors.push('observe はファイル名（パスの区切りを含まない）か null');
  if (!Array.isArray(v.rounds)) errors.push('rounds は配列');
  else {
    v.rounds.forEach((r: unknown, i) => {
      const ok = isObject(r) && isIso(r.at) && Array.isArray(r.ran) && Array.isArray(r.suggested) && [...r.ran, ...r.suggested].every((n) => NAMES.includes(n as string));
      if (!ok) errors.push(`rounds の ${i + 1} 件目：at は ISO の時刻、ran・suggested は見直しの名前の配列`);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, state: v as unknown as PatrolState };
}

/** 回を記録した新しい状態（元の状態は変えない）。ran は run の形、suggested は suggest の形の名前だけ。observe は写した観測の JSON のファイル名 */
export function recordRound(state: PatrolState | null, ran: string[], suggested: string[], at: Date, observe: string): Result<{ state: PatrolState }> {
  const errors: string[] = [];
  const check = (names: string[], mode: PatrolMode, flag: string): void => {
    const seen = new Set<string>();
    for (const n of names) {
      const def = PATROL_REVIEWS.find((r) => r.name === n);
      if (!def) errors.push(`${flag}：知らない見直しです：${n}（${NAMES.join('・')}）`);
      else if (def.mode !== mode) errors.push(`${flag}：${n} は ${def.mode === 'run' ? '回す（--ran）' : '勧める（--suggested）'}形の見直しです`);
      if (seen.has(n)) errors.push(`${flag}：${n} が2回あります`);
      seen.add(n);
    }
  };
  check(ran, 'run', '--ran');
  check(suggested, 'suggest', '--suggested');
  if (observe === '' || /[\\/]/.test(observe)) errors.push('observe はファイル名（パスの区切りを含まない）');
  if (errors.length) return { ok: false, errors };
  const time = at.toISOString();
  const reviews: PatrolState['reviews'] = {};
  for (const [k, r] of Object.entries(state?.reviews ?? {})) reviews[k as PatrolReviewName] = { ...r };
  for (const n of ran as PatrolReviewName[]) reviews[n] = { ...reviews[n], lastRunAt: time };
  for (const n of suggested as PatrolReviewName[]) reviews[n] = { ...reviews[n], lastSuggestedAt: time };
  const round: PatrolRound = { at: time, ran: [...ran] as PatrolReviewName[], suggested: [...suggested] as PatrolReviewName[] };
  const rounds = [...(state?.rounds ?? []), round].slice(-PATROL_MAX_ROUNDS);
  return { ok: true, state: { version: 1, reviews, observe, rounds } };
}

/** 観測の JSON（ObserveReport）として使えるか。selectReviews が読むのは diff だけなので、そこを確かめる */
export function checkObserveReport(v: unknown): Result<{ report: ObserveReport }> {
  if (!isObject(v) || v.version !== 1 || !isIso(v.generatedAt)) return { ok: false, errors: ['観測の JSON（observe.ts の出力。version 1・generatedAt）ではありません'] };
  if (v.diff !== undefined) {
    const d = v.diff;
    const ok = isObject(d) && isObject(d.sections) &&
      OBSERVE_SECTIONS.every((s) => {
        const x = (d.sections as Record<string, unknown>)[s];
        return x === null || x === undefined || (isObject(x) && Array.isArray(x.added) && Array.isArray(x.removed));
      });
    if (!ok) return { ok: false, errors: ['観測の JSON の diff.sections の形が違います'] };
  }
  return { ok: true, report: v as unknown as ObserveReport };
}

/** harness/scripts/patrol.ts の引数（process.argv.slice(2)。先頭がサブコマンド） */
export function parsePatrolArgs(args: string[]): Result<{ sub: string; positional: string[]; max: number; state: string | null; ran: string[]; suggested: string[] }> {
  const [sub, ...rest] = args;
  const out = { sub: sub ?? '', positional: [] as string[], max: PATROL_DEFAULT_MAX, state: null as string | null, ran: [] as string[], suggested: [] as string[] };
  const errors: string[] = [];
  let maxSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--max' || a === '--state' || a === '--ran' || a === '--suggested') {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) {
        errors.push(`${a} の値がありません`);
        if (v !== undefined) i--;
        continue;
      }
      if (a === '--max') {
        if (maxSeen) errors.push('--max が2回あります');
        maxSeen = true;
        if (!/^[1-9]\d*$/.test(v)) errors.push(`--max は正の整数：${v}`);
        else out.max = Number(v);
      } else if (a === '--state') {
        if (out.state !== null) errors.push('--state が2回あります');
        out.state = v;
      } else (a === '--ran' ? out.ran : out.suggested).push(v);
    } else if (a.startsWith('--')) errors.push(`知らない引数です：${a}`);
    else out.positional.push(a);
  }
  return errors.length ? { ok: false, errors } : { ok: true, ...out };
}
