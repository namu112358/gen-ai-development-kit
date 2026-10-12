import { LABELS, RISK_LEVELS, type RiskLevel } from './config.ts';
import { guardrailPatterns, type GuardrailConfig } from './guardrail.ts';
import { parseTitle } from './title.ts';
import { OBSERVE_SECTIONS, type ObserveReport, type ObserveSection } from './observe.ts';
import { OPS_ITEM_IDS, type OpsItemId } from './ops-health.ts';

/**
 * 見直しのまとめ役（patrol の skill）が、観測の差と前回からの経過で今回まわす見直しを決める（純粋関数）。スクリプトは harness/scripts/patrol.ts。
 * 運用の健康（観測の opsHealth）の超えた項目・前回から値が増えた項目は alerts として知らせるだけで、見直しの選び方には使わない。
 * 見直しごとに、見る観測の節と間隔の下限・上限を PATROL_REVIEWS に持つ。形が suggest の見直しは動かさず、人に勧めるだけにする（今は3つとも run。suggest の形は、人に勧めるだけの見直しを足すときと、今までの状態のファイルを読むために残す）。
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
  { name: 'test-prune', mode: 'run', sections: ['slowTests', 'flakyTests', 'mutants'], minHours: 24, maxHours: 336 },
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
  /** 運用の健康のうち、しきい値を超えた項目と前回から値が増えた項目（OPS_ITEM_IDS の順。超えた項目が先）。知らせるだけ */
  alerts: PatrolAlert[];
  /** alerts が空・一部の理由（無ければ null） */
  alertsNote: string | null;
}
/** exceeded は今回しきい値を超えた、newlyExceeded は前回は超えていなかった、previous は前回から値が増えたときの前回の値（増えていなければ null） */
export interface PatrolAlert { id: OpsItemId; title: string; value: number; threshold: number; exceeded: boolean; newlyExceeded: boolean; previous: number | null }

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

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOpsId = (v: unknown): v is OpsItemId => typeof v === 'string' && (OPS_ITEM_IDS as readonly string[]).includes(v);

/**
 * 観測の opsHealth から知らせを組む。形は信じず読む。opsHealth が無い・読めない・形が違うときは空（note に理由）。
 * diff.opsHealth が使えないときは超えた項目だけを出す（初回に今回超えた項目を見落とさない）。
 */
export function opsAlerts(report: ObserveReport): { alerts: PatrolAlert[]; note: string | null } {
  const ops: unknown = (report as { opsHealth?: unknown }).opsHealth;
  if (ops === undefined || ops === null) return { alerts: [], note: '観測の JSON に運用の健康（opsHealth）が無いので、知らせは空' };
  const malformed = { alerts: [], note: '観測の JSON の opsHealth の形が違うので、知らせは空' };
  if (!isObject(ops)) return malformed;
  if (ops.available === false) return { alerts: [], note: `運用の健康が読めないので、知らせは空：${typeof ops.reason === 'string' ? ops.reason : '理由なし'}` };
  if (ops.available !== true || !Array.isArray(ops.items)) return malformed;
  const judged = new Map<OpsItemId, { title: string; value: number; threshold: number; exceeded: boolean }>();
  for (const it of ops.items as unknown[]) {
    if (!isObject(it) || !isOpsId(it.id) || typeof it.title !== 'string') return malformed;
    if (it.available === true) {
      if (!isNum(it.value) || !isNum(it.threshold) || typeof it.exceeded !== 'boolean') return malformed;
      judged.set(it.id, { title: it.title, value: it.value, threshold: it.threshold, exceeded: it.exceeded });
    } else if (it.available !== false || typeof it.reason !== 'string') return malformed;
  }
  const d: unknown = (report as { diff?: unknown }).diff;
  const od: unknown = isObject(d) ? d.opsHealth : undefined;
  const added = new Set<string>();
  const previous = new Map<string, number>();
  let note: string | null = null;
  if (isObject(od) && isObject(od.exceeded) && Array.isArray(od.exceeded.added) && Array.isArray(od.increased)) {
    for (const id of od.exceeded.added) if (typeof id === 'string') added.add(id);
    for (const x of od.increased) if (isObject(x) && typeof x.id === 'string' && isNum(x.previous)) previous.set(x.id, x.previous);
  } else note = '前回との差が無い（読めない）ので、増えた項目は出していない';
  const alerts: PatrolAlert[] = [];
  const make = (id: OpsItemId, j: { title: string; value: number; threshold: number; exceeded: boolean }): PatrolAlert =>
    ({ id, title: j.title, value: j.value, threshold: j.threshold, exceeded: j.exceeded, newlyExceeded: j.exceeded && added.has(id), previous: previous.get(id) ?? null });
  for (const id of OPS_ITEM_IDS) {
    const j = judged.get(id);
    if (j?.exceeded) alerts.push(make(id, j));
  }
  for (const id of OPS_ITEM_IDS) {
    const j = judged.get(id);
    if (j && !j.exceeded && previous.has(id)) alerts.push(make(id, j));
  }
  return { alerts, note };
}

const RANK: Partial<Record<PatrolReason, number>> = { never: 0, overdue: 1, diff: 2 };

/** 今回まわす見直しを決める。max は run の形で回す数の上限（suggest の形は枠を使わない）。defs は見直しの定義の一覧（既定は PATROL_REVIEWS）。状態は変えない */
export function selectReviews(state: PatrolState | null, observe: ObserveReport, now: Date, max: number, defs: readonly PatrolReviewDef[] = PATROL_REVIEWS): PatrolSelection {
  const all = defs.map((def) => decide(def, state, observe, now));
  const chosen = (c: Candidate): boolean => RANK[c.reason] !== undefined;
  const order = (a: Candidate, b: Candidate): number =>
    RANK[a.reason]! - RANK[b.reason]! ||
    (a.reason === 'overdue' ? b.overdueMs - a.overdueMs : 0) ||
    (a.reason === 'diff' ? b.diffCount - a.diffCount : 0) ||
    defs.indexOf(a.def) - defs.indexOf(b.def);
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
    ...(({ alerts, note }) => ({ alerts, alertsNote: note }))(opsAlerts(observe)),
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

/** 回を記録した新しい状態（元の状態は変えない）。ran は run の形、suggested は suggest の形の名前だけ（形は defs で決まる。既定は PATROL_REVIEWS）。observe は写した観測の JSON のファイル名 */
export function recordRound(state: PatrolState | null, ran: string[], suggested: string[], at: Date, observe: string, defs: readonly PatrolReviewDef[] = PATROL_REVIEWS): Result<{ state: PatrolState }> {
  const errors: string[] = [];
  const check = (names: string[], mode: PatrolMode, flag: string): void => {
    const seen = new Set<string>();
    for (const n of names) {
      const def = defs.find((r) => r.name === n);
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

/** 観測の JSON（ObserveReport）として使えるか。selectReviews が読むのは diff.sections と opsHealth で、確かめるのは diff.sections だけ（opsHealth の形は opsAlerts が読み、違えば知らせを空にする。誤りにしない） */
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

// --- auto mode の間の自動の供給（Issue #827。GitHub は読まない） ---

export type AutoSupplyOverlap = 'new' | 'comment' | 'related';
export interface AutoSupplyCandidate {
  ref: string;
  title: string;
  risk: RiskLevel | null;
  files: string[];
  overlap: AutoSupplyOverlap | null;
  draftPath: string | null;
}
export type AutoSupplyReason = 'auto-mode-off' | 'type' | 'risk' | 'files-unknown' | 'guardrail' | 'overlap' | 'limit';

const AUTO_SUPPLY_REF = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AUTO_SUPPLY_OVERLAPS: readonly string[] = ['new', 'comment', 'related'];
const AUTO_SUPPLY_TYPES: readonly string[] = ['test', 'docs', 'fix'];

/** 候補の JSON（{ "version": 1, "candidates": [...] }）を読む。形の誤りは throw せず誤りの文の一覧で返す。candidates が空の配列も受け付ける */
export function parseAutoSupplyCandidates(text: string): Result<{ candidates: AutoSupplyCandidate[] }> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`候補の JSON が読めません：${(e as Error).message}`] };
  }
  if (!isObject(v)) return { ok: false, errors: ['候補の JSON はオブジェクト'] };
  if (v.version !== 1) return { ok: false, errors: [`候補の JSON の version が 1 ではありません：${JSON.stringify(v.version)}`] };
  if (!Array.isArray(v.candidates)) return { ok: false, errors: ['candidates は配列'] };
  const errors: string[] = [];
  const candidates: AutoSupplyCandidate[] = [];
  const seen = new Set<string>();
  v.candidates.forEach((c: unknown, i) => {
    const at = `candidates の ${i + 1} 件目`;
    if (!isObject(c)) return void errors.push(`${at}はオブジェクト`);
    const before = errors.length;
    if (typeof c.ref !== 'string' || !AUTO_SUPPLY_REF.test(c.ref)) errors.push(`${at}：ref は英数字で始まり、英数字と . _ - だけの文字列`);
    else if (seen.has(c.ref)) errors.push(`${at}：ref「${c.ref}」が重複しています`);
    else seen.add(c.ref);
    if (typeof c.title !== 'string' || c.title === '') errors.push(`${at}：title は空でない文字列`);
    if (!(c.risk === null || (typeof c.risk === 'string' && (RISK_LEVELS as readonly string[]).includes(c.risk)))) errors.push(`${at}：risk は ${RISK_LEVELS.join(' / ')} か null`);
    if (!Array.isArray(c.files) || !c.files.every((f) => typeof f === 'string' && f !== '')) errors.push(`${at}：files は空でない文字列の配列`);
    if (!(c.overlap === null || (typeof c.overlap === 'string' && AUTO_SUPPLY_OVERLAPS.includes(c.overlap)))) errors.push(`${at}：overlap は new / comment / related か null`);
    if (!(c.draftPath === undefined || c.draftPath === null || typeof c.draftPath === 'string')) errors.push(`${at}：draftPath は文字列か null`);
    if (errors.length === before) candidates.push({ ref: c.ref as string, title: c.title as string, risk: c.risk as RiskLevel | null, files: c.files as string[], overlap: c.overlap as AutoSupplyOverlap | null, draftPath: (c.draftPath as string | null | undefined) ?? null });
  });
  return errors.length ? { ok: false, errors } : { ok: true, candidates };
}

export interface AutoSupplySelection {
  active: boolean;
  limit: number;
  used: number;
  /** max(0, limit - used)。create を引く前の値 */
  remaining: number;
  create: AutoSupplyCandidate[];
  manual: { ref: string; title: string; reason: AutoSupplyReason; detail: string }[];
}

/** 候補のうち自動で Issue にするものと、人が選ぶ側に残すもの（理由つき）。候補ごとに上から順に見て、最初に当たった理由で残す。auto mode でなければ全部残す */
export function selectAutoSupply(input: {
  autoMode: { active: boolean; reason: string };
  candidates: AutoSupplyCandidate[];
  guardrail: GuardrailConfig;
  dailyLimit: number;
  createdLast24h: number;
}): AutoSupplySelection {
  const { autoMode, candidates, guardrail, dailyLimit, createdLast24h } = input;
  const remaining = Math.max(0, dailyLimit - createdLast24h);
  const create: AutoSupplyCandidate[] = [];
  const manual: AutoSupplySelection['manual'] = [];
  const keep = (c: AutoSupplyCandidate, reason: AutoSupplyReason, detail: string): void => void manual.push({ ref: c.ref, title: c.title, reason, detail });
  for (const c of candidates) {
    const t = parseTitle(c.title);
    const hit = guardrailPatterns(guardrail, c.files);
    if (!autoMode.active) keep(c, 'auto-mode-off', autoMode.reason);
    else if (!t.ok || !AUTO_SUPPLY_TYPES.includes(t.type)) keep(c, 'type', t.ok ? `種類は ${t.type}（test・docs・fix だけ）` : '題の種類が読めない');
    else if (c.risk !== 'low') keep(c, 'risk', `想定 Risk は ${c.risk ?? '見積りなし'}（low だけ）`);
    else if (c.files.length === 0) keep(c, 'files-unknown', '触るファイルの見込みが0件');
    else if (hit.length > 0) keep(c, 'guardrail', `ガードレールに当たる：${hit.join('、')}`);
    else if (c.overlap !== 'new') keep(c, 'overlap', `重複の判定は ${c.overlap ?? '未判定'}（new だけ）`);
    else if (create.length >= remaining) keep(c, 'limit', `1日の上限 ${dailyLimit} 件のうち直近 24 時間に ${createdLast24h} 件作成済み`);
    else create.push(c);
  }
  return { active: autoMode.active, limit: dailyLimit, used: createdLast24h, remaining, create, manual };
}

/** Issue の本文の出どころの目印（<!-- agent-harness:issue-source from=patrol ref=<ref> -->）から patrol の ref。無ければ null（from が patrol 以外は数えない） */
export function autoSupplySourceRef(body: string): string | null {
  const m = body.match(/<!--\s*agent-harness:issue-source\s+from=patrol\s+ref=([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->/);
  return m ? m[1]! : null;
}

export interface AutoSupplyIssue { number: number; body: string; author: string; createdAt: string; labels: string[]; pullRequest: boolean }
export type AutoSupplyReadyReason = 'auto-mode-off' | 'pull-request' | 'no-marker' | 'not-self' | 'too-old' | 'limit' | 'already-ready';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 自動で作った Issue に agent:ready を付けてよいか。満たさない条件は全部 reasons に並べる（auto mode でなければ常に ready は偽） */
export function autoSupplyReady(input: {
  autoMode: { active: boolean };
  issue: AutoSupplyIssue;
  recent: AutoSupplyIssue[];
  self: string;
  now: Date;
  dailyLimit: number;
}): { ready: boolean; reasons: AutoSupplyReadyReason[] } {
  const { autoMode, issue, recent, self, now, dailyLimit } = input;
  const counts = (i: AutoSupplyIssue): { pullRequest: boolean; marker: boolean; self: boolean; fresh: boolean } => {
    const at = Date.parse(i.createdAt);
    return {
      pullRequest: i.pullRequest,
      marker: autoSupplySourceRef(i.body) !== null,
      self: i.author === self,
      fresh: Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= DAY_MS,
    };
  };
  const me = counts(issue);
  const reasons: AutoSupplyReadyReason[] = [];
  if (!autoMode.active) reasons.push('auto-mode-off');
  if (me.pullRequest) reasons.push('pull-request');
  if (!me.marker) reasons.push('no-marker');
  if (!me.self) reasons.push('not-self');
  if (!me.fresh) reasons.push('too-old');
  if (!me.pullRequest && me.marker && me.self && me.fresh) {
    const byNumber = new Map<number, AutoSupplyIssue>();
    for (const i of [...recent, issue]) if (i.number === issue.number || !byNumber.has(i.number)) byNumber.set(i.number, i.number === issue.number ? issue : i);
    const counted = [...byNumber.values()].filter((i) => { const c = counts(i); return !c.pullRequest && c.marker && c.self && c.fresh; });
    counted.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
    if (counted.findIndex((i) => i.number === issue.number) >= dailyLimit) reasons.push('limit');
  }
  if (issue.labels.includes(LABELS.ready)) reasons.push('already-ready');
  return { ready: reasons.length === 0, reasons };
}
