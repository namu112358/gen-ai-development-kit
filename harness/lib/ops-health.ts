import { extractBlock } from './blocks.ts';
import { areaLimitLabels, describeFullAreas, fullAreas } from './concurrency.ts';
import type { HarnessConfig, OpsHealthThresholds } from './config.ts';
import { GitHub, type IssueComment, type RequestOptions, type Transport } from './github.ts';
import { stalledClaims, renderStalledClaimLine, type StalledClaimInput } from './stalled-claim.ts';
import { bodyIssueRefs, isTrustedComment, type PullRequest } from './state.ts';
import type { Unavailable } from './test-health.ts';
import { renderUnclaimedJudgeLine, unclaimedJudgePrs, type UnclaimedJudgeInput } from './unclaimed-judge.ts';

/**
 * 保守の観測（harness/scripts/observe.ts）の運用の健康：定期実行の抜け・API の上限・CI の過剰な実行・PR の滞留など 14 項目の判定と、GitHub を読む数の上限。
 * 項目の判定は GitHub・git を呼ばない純粋関数で、どのパスを何回読むか・ログを何件読むか・worktree の読み方は observe-ops.ts（#701）が持つ。
 * 値（value）としきい値（threshold）は同じ単位の数で、exceeded は value >= threshold か、項目の第2の条件（ci の重なり・計画の無い Issue の数）。
 * 入力の欄が Unavailable なら、その項目だけ読めない扱い（available: false と理由）にする。時刻の読めない実行・宣言は数えない（誤って超えたと出さない）。
 * budgetedGitHub は渡された GitHub に GET だけを取り次ぎ、上限を超える GET と GET 以外は呼ばずに誤りにする（Epic #417、Issue #690）。
 */

export type { OpsHealthThresholds };

export const OPS_ITEM_IDS = [
  'schedule-gap', 'rate-limit', 'failed-gate', 'gate-runs', 'ci-load', 'pr-stall', 'requeue',
  'stalled-claim', 'plan-backlog', 'epic-drift', 'link-mismatch', 'stale-worktree', 'area-full', 'review-panel',
] as const;
export type OpsItemId = (typeof OPS_ITEM_IDS)[number];

export type OpsItem =
  | { id: OpsItemId; title: string; available: true; value: number; threshold: number; exceeded: boolean; evidence: string[] }
  | { id: OpsItemId; title: string; available: false; reason: string };
type Judged = Extract<OpsItem, { available: true }>;

export const OPS_HEALTH_DEFAULTS: OpsHealthThresholds = {
  scheduleGapMinutes: 90, rateLimitFailures: 1, failedGateMinutes: 60, gateRunsPerDay: 600, ciJobMinutes: 10,
  readyHours: 2, prOpenHours: 24, requeueCount: 2, claimIdleMinutes: 60, planReviewCount: 5, unplannedIssueCount: 10,
  epicDrift: 1, linkMismatch: 1, staleWorktrees: 1, areaFullMinutes: 60, reviewPanelFailures: 1, maxGets: 200,
};

/** override のうち値が undefined でないキーだけを既定に重ねる（型と範囲の検査は observe.ts がする） */
export function opsHealthThresholds(override: Partial<OpsHealthThresholds> = {}): OpsHealthThresholds {
  const out = { ...OPS_HEALTH_DEFAULTS };
  for (const [k, v] of Object.entries(override)) if (v !== undefined) (out as Record<string, number>)[k] = v;
  return out;
}

/** Actions の workflow run（REST の欄名のうち使うものだけ） */
export interface OpsRun {
  id: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  display_title?: string;
  pull_requests?: { number: number }[];
}
export interface CiJob { run_id: number; name: string; started_at: string | null; completed_at: string | null }
export interface OpsPr { pr: number; draft: boolean; createdAt: string; readyAt: string | null }
export interface RequeueInput {
  pr: number;
  timeline: { event: string }[];
  comments: Pick<IssueComment, 'body' | 'author_association'>[];
}
/** linked は GitHub の紐付け（timeline から読んだ Issue の番号）。読めなければ null */
export interface LinkInput { pr: number; body: string | null; linked: number[] | null }
/** closed は Issue が Close か PR が Merge 済み、dirty は commit されていない変更がある（どちらも observe.ts が決める） */
export interface WorktreeInput { path: string; closed: boolean; dirty: boolean }
/** agent:plan-ok で待つ Issue。since は待ち始めた時刻 */
export interface AreaWaitInput { issue: number; files: string[]; since: string }
/** 合体版の記録・判定コメント（PR・head・時刻） */
export interface PanelRun { pr: number; head: string; at: string }

type Field<T> = T | Unavailable;
export interface OpsHealthInput {
  since: Date;
  scheduleRuns: Field<OpsRun[]>;
  rateLimitLogs: Field<{ logs: string[]; unread: number }>;
  gateRuns: Field<OpsRun[]>;
  ci: Field<{ runs: OpsRun[]; jobs: CiJob[] }>;
  prs: Field<OpsPr[]>;
  requeue: Field<RequeueInput[]>;
  claims: Field<{ stalled: StalledClaimInput[]; unclaimed: UnclaimedJudgeInput[] }>;
  planBacklog: Field<{ planReview: number; unplanned: number }>;
  epicDrift: Field<{ closedEpics: number[]; orphanIssues: number[] }>;
  links: Field<LinkInput[]>;
  worktrees: Field<WorktreeInput[]>;
  area: Field<{ config: HarnessConfig; repository: string; openPrs: PullRequest[]; waiting: AreaWaitInput[] }>;
  reviewPanel: Field<{ records: PanelRun[]; verdicts: PanelRun[] }>;
}

export const RATE_LIMIT_PATTERN = /API rate limit exceeded|secondary rate limit/i;

const TITLES: Record<OpsItemId, string> = {
  'schedule-gap': '定期実行の抜け', 'rate-limit': 'API の上限', 'failed-gate': '失敗したままのゲート', 'gate-runs': 'ゲートの実行の数',
  'ci-load': 'CI の過剰な実行', 'pr-stall': 'PR の滞留', requeue: '判定のやり直し', 'stalled-claim': '止まった着手宣言',
  'plan-backlog': '計画の滞り', 'epic-drift': 'Epic のずれ', 'link-mismatch': 'Closes と紐付けの食い違い',
  'stale-worktree': '残った worktree', 'area-full': '領域の上限で待つ Issue', 'review-panel': '合体版の判定の抜け',
};

const ms = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : NaN);
const minutesBetween = (fromMs: number, toMs: number): number => (toMs - fromMs) / 60_000;
const minutesSince = (iso: string | null | undefined, now: Date): number => minutesBetween(ms(iso), now.getTime());

function item(id: OpsItemId, value: number, threshold: number, evidence: string[], extra = false): Judged {
  return { id, title: TITLES[id], available: true, value, threshold, exceeded: value >= threshold || extra, evidence };
}

/** 1：schedule の実行の間隔（since・各実行・now の間）のいちばん長いもの（分） */
export function judgeScheduleGap(runs: OpsRun[], t: OpsHealthThresholds, now: Date, since: Date): Judged {
  const times = runs.map((r) => ms(r.created_at)).filter((x) => !Number.isNaN(x) && x >= since.getTime() && x <= now.getTime());
  const points = [since.getTime(), ...times.sort((a, b) => a - b), now.getTime()];
  let gap = 0;
  for (let i = 1; i < points.length; i++) gap = Math.max(gap, minutesBetween(points[i - 1]!, points[i]!));
  return item('schedule-gap', Math.floor(gap), t.scheduleGapMinutes, [`schedule の実行 ${times.length} 件・いちばん長い間隔 ${Math.floor(gap)} 分`]);
}

/** 2：読んだログのうち API の上限に当たったものの数 */
export function judgeRateLimit(input: { logs: string[]; unread: number }, t: OpsHealthThresholds): Judged {
  const hits = input.logs.filter((l) => RATE_LIMIT_PATTERN.test(l)).length;
  return item('rate-limit', hits, t.rateLimitFailures, [`上限に当たったログ ${hits}/${input.logs.length} 件`, ...(input.unread > 0 ? [`読まなかったログ ${input.unread} 件`] : [])]);
}

/** 3 の「同じ対象」：最初の PR の番号、無ければ event と display_title の組。どちらも無ければ null */
function runTarget(r: OpsRun): string | null {
  const pr = r.pull_requests?.[0]?.number;
  if (pr !== undefined) return `pr:${pr}`;
  return r.display_title ? `${r.event}:${r.display_title}` : null;
}

/** 3：失敗のまま（同じ対象の後の成功が無い）のゲートの実行のうち、いちばん古いものの経過（分） */
export function judgeFailedGate(runs: OpsRun[], t: OpsHealthThresholds, now: Date): Judged {
  let worst = 0, unknown = 0;
  for (const r of runs) {
    if (r.conclusion !== 'failure' || Number.isNaN(ms(r.created_at))) continue;
    const target = runTarget(r);
    if (target === null) { unknown++; continue; }
    const fixed = runs.some((s) => s.conclusion === 'success' && runTarget(s) === target && ms(s.created_at) > ms(r.created_at));
    if (!fixed) worst = Math.max(worst, Math.floor(minutesSince(r.created_at, now)));
  }
  return item('failed-gate', worst, t.failedGateMinutes, [`失敗のままの実行のいちばん長い経過 ${worst} 分`, ...(unknown > 0 ? [`対象を見分けられない実行 ${unknown} 件`] : [])]);
}

/** 4：直近 24 時間のゲートの実行の数 */
export function judgeGateRuns(runs: OpsRun[], t: OpsHealthThresholds, now: Date): Judged {
  const n = runs.filter((r) => { const m = minutesSince(r.created_at, now); return !Number.isNaN(m) && m <= 1440; }).length;
  return item('gate-runs', n, t.gateRunsPerDay, [`直近 24 時間のゲートの実行 ${n} 回`]);
}

/** 5：いちばん長い ci のジョブ（分）。同じ PR で時間の重なった ci の実行があっても超えた扱い */
export function judgeCiLoad(input: { runs: OpsRun[]; jobs: CiJob[] }, t: OpsHealthThresholds): Judged {
  let longest = 0;
  for (const j of input.jobs) {
    const m = minutesBetween(ms(j.started_at), ms(j.completed_at));
    if (!Number.isNaN(m)) longest = Math.max(longest, m);
  }
  const overlaps = new Set<number>();
  const runs = input.runs.filter((r) => r.pull_requests?.[0] && !Number.isNaN(ms(r.created_at)) && !Number.isNaN(ms(r.updated_at)));
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length; k++) {
      const [a, b] = [runs[i]!, runs[k]!];
      const pr = a.pull_requests![0]!.number;
      if (pr !== b.pull_requests![0]!.number) continue;
      if (ms(a.created_at) < ms(b.updated_at) && ms(b.created_at) < ms(a.updated_at)) overlaps.add(pr);
    }
  }
  const evidence = [`いちばん長い ci のジョブ ${Math.floor(longest)} 分`, ...(overlaps.size > 0 ? [`ci の実行が重なった PR：${[...overlaps].map((n) => `#${n}`).join('、')}`] : [])];
  return item('ci-load', Math.floor(longest), t.ciJobMinutes, evidence, overlaps.size > 0);
}

/** 6：Ready のまま readyHours 以上か、開いてから prOpenHours 以上の PR の数 */
export function judgePrStall(prs: OpsPr[], t: OpsHealthThresholds, now: Date): Judged {
  const stalled = prs.filter((p) => (!p.draft && p.readyAt !== null && minutesSince(p.readyAt, now) >= t.readyHours * 60) || minutesSince(p.createdAt, now) >= t.prOpenHours * 60);
  return item('pr-stall', stalled.length, 1, stalled.map((p) => `#${p.pr}（${p.draft ? 'Draft' : 'Ready'}）`));
}

/** 7：PR ごとの Draft に戻した数と、コラボレーターの判定コメントの数 − 1 の大きいほう。PR のうちの最大 */
export function judgeRequeue(inputs: RequeueInput[], t: OpsHealthThresholds): Judged {
  let worst = 0;
  const evidence: string[] = [];
  for (const r of inputs) {
    const drafts = r.timeline.filter((e) => e.event === 'convert_to_draft').length;
    const verdicts = r.comments.filter((c) => isTrustedComment(c) && extractBlock(c.body, 'agent-verdict').found).length;
    const n = Math.max(drafts, verdicts - 1, 0);
    if (n > 0) evidence.push(`#${r.pr}：Draft に戻した ${drafts} 回・判定 ${verdicts} 回`);
    worst = Math.max(worst, n);
  }
  return item('requeue', worst, t.requeueCount, evidence);
}

/** 8：止まっていそうな着手宣言と担当のいない判定待ちの PR の数（stalled-claim.ts・unclaimed-judge.ts の判定をそのまま使う） */
export function judgeStalledClaim(input: { stalled: StalledClaimInput[]; unclaimed: UnclaimedJudgeInput[] }, t: OpsHealthThresholds, now: Date): Judged {
  const stalled = stalledClaims(input.stalled, now, t.claimIdleMinutes);
  const unclaimed = unclaimedJudgePrs(input.unclaimed, now, t.claimIdleMinutes);
  const evidence = [...stalled.map((r) => renderStalledClaimLine(r, now)), ...unclaimed.map((r) => renderUnclaimedJudgeLine(r, now))];
  return item('stalled-claim', evidence.length, 1, evidence);
}

/** 9：agent:plan-review の数。計画の無い開いた Issue が unplannedIssueCount 以上でも超えた扱い */
export function judgePlanBacklog(input: { planReview: number; unplanned: number }, t: OpsHealthThresholds): Judged {
  return item('plan-backlog', input.planReview, t.planReviewCount, [`agent:plan-review ${input.planReview} 件・計画の無い開いた Issue ${input.unplanned} 件`], input.unplanned >= t.unplannedIssueCount);
}

/** 10：子が全部 Close の開いた Epic と、Epic の子でない Agent PR のある Issue の数 */
export function judgeEpicDrift(input: { closedEpics: number[]; orphanIssues: number[] }, t: OpsHealthThresholds): Judged {
  const evidence = [...input.closedEpics.map((n) => `#${n}：子が全部 Close の開いた Epic`), ...input.orphanIssues.map((n) => `#${n}：Epic の子でない Agent PR のある Issue`)];
  return item('epic-drift', evidence.length, t.epicDrift, evidence);
}

/** 11：PR の本文の Closes #N のうち GitHub の紐付けに無いものの数。紐付けを読めない PR は数えない */
export function judgeLinkMismatch(inputs: LinkInput[], t: OpsHealthThresholds): Judged {
  const evidence: string[] = [];
  let unread = 0;
  for (const l of inputs) {
    if (l.linked === null) { unread++; continue; }
    for (const ref of bodyIssueRefs(l.body)) if (ref.keyword === 'closes' && !l.linked.includes(ref.number)) evidence.push(`#${l.pr}：Closes #${ref.number} が紐付けに無い`);
  }
  return item('link-mismatch', evidence.length, t.linkMismatch, [...evidence, ...(unread > 0 ? [`紐付けを読めなかった PR ${unread} 件`] : [])]);
}

/** 12：Close・Merge 済みか、commit されていない変更のある worktree の数 */
export function judgeStaleWorktree(inputs: WorktreeInput[], t: OpsHealthThresholds): Judged {
  const stale = inputs.filter((w) => w.closed || w.dirty);
  return item('stale-worktree', stale.length, t.staleWorktrees, stale.map((w) => `${w.path}（${[w.closed ? 'Close 済み' : null, w.dirty ? '未 commit の変更' : null].filter(Boolean).join('・')}）`));
}

/** 13：上限に達した領域で待つ Issue のいちばん長い待ち（分）。上限の判定は concurrency.ts をそのまま使う */
export function judgeAreaFull(input: { config: HarnessConfig; repository: string; openPrs: PullRequest[]; waiting: AreaWaitInput[] }, t: OpsHealthThresholds, now: Date): Judged {
  const labels = areaLimitLabels(input.config, input.openPrs, input.repository);
  let worst = 0;
  const evidence: string[] = [];
  for (const w of input.waiting) {
    const full = fullAreas(input.config, w.files, labels);
    const waited = minutesSince(w.since, now);
    if (full.length === 0 || Number.isNaN(waited)) continue;
    worst = Math.max(worst, Math.floor(waited));
    evidence.push(`#${w.issue}：${Math.floor(waited)} 分待ち（${describeFullAreas(full)}）`);
  }
  return item('area-full', worst, t.areaFullMinutes, evidence);
}

/** 14：合体版の記録のうち、同じ PR・同じ head で記録の時刻以後の判定コメントが無いものの数 */
export function judgeReviewPanel(input: { records: PanelRun[]; verdicts: PanelRun[] }, t: OpsHealthThresholds): Judged {
  const missing = input.records.filter((r) => !input.verdicts.some((v) => v.pr === r.pr && v.head === r.head && ms(v.at) >= ms(r.at)));
  return item('review-panel', missing.length, t.reviewPanelFailures, [...missing.map((r) => `#${r.pr}（head ${r.head.slice(0, 7)}）：記録の後に判定が無い`), '担当の失敗の数は読めない']);
}

function isUnavailable(x: unknown): x is Unavailable {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && (x as { available?: unknown }).available === false;
}

/** OPS_ITEM_IDS の順に判定する。欄が Unavailable の項目だけ available: false と理由を出す */
export function judgeOpsHealth(input: OpsHealthInput, t: OpsHealthThresholds, now: Date): OpsItem[] {
  const judges: Record<OpsItemId, () => OpsItem> = {
    'schedule-gap': () => field(input.scheduleRuns, 'schedule-gap', (x) => judgeScheduleGap(x, t, now, input.since)),
    'rate-limit': () => field(input.rateLimitLogs, 'rate-limit', (x) => judgeRateLimit(x, t)),
    'failed-gate': () => field(input.gateRuns, 'failed-gate', (x) => judgeFailedGate(x, t, now)),
    'gate-runs': () => field(input.gateRuns, 'gate-runs', (x) => judgeGateRuns(x, t, now)),
    'ci-load': () => field(input.ci, 'ci-load', (x) => judgeCiLoad(x, t)),
    'pr-stall': () => field(input.prs, 'pr-stall', (x) => judgePrStall(x, t, now)),
    requeue: () => field(input.requeue, 'requeue', (x) => judgeRequeue(x, t)),
    'stalled-claim': () => field(input.claims, 'stalled-claim', (x) => judgeStalledClaim(x, t, now)),
    'plan-backlog': () => field(input.planBacklog, 'plan-backlog', (x) => judgePlanBacklog(x, t)),
    'epic-drift': () => field(input.epicDrift, 'epic-drift', (x) => judgeEpicDrift(x, t)),
    'link-mismatch': () => field(input.links, 'link-mismatch', (x) => judgeLinkMismatch(x, t)),
    'stale-worktree': () => field(input.worktrees, 'stale-worktree', (x) => judgeStaleWorktree(x, t)),
    'area-full': () => field(input.area, 'area-full', (x) => judgeAreaFull(x, t, now)),
    'review-panel': () => field(input.reviewPanel, 'review-panel', (x) => judgeReviewPanel(x, t)),
  };
  return OPS_ITEM_IDS.map((id) => judges[id]());
}

function field<T>(value: Field<T>, id: OpsItemId, judge: (x: T) => OpsItem): OpsItem {
  return isUnavailable(value) ? { id, title: TITLES[id], available: false, reason: value.reason } : judge(value);
}

export class GetBudgetError extends Error {
  readonly max: number;
  constructor(max: number) {
    super(`GitHub を読む数の上限（${max} 回）に達しました`);
    this.name = 'GetBudgetError';
    this.max = max;
  }
}

/** 渡された GitHub に GET だけを取り次ぐ GitHub（同じ owner/repo）。maxGets 回を超える GET と GET 以外は呼ばずに誤りにする */
export function budgetedGitHub(gh: GitHub, maxGets: number): { gh: GitHub; used(): number } {
  let used = 0;
  const transport: Transport = {
    request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
      if (method.toUpperCase() !== 'GET') return Promise.reject(new Error(`GitHub を読む包みは GET 以外を呼ばない（${method} ${path}）`));
      if (used >= maxGets) return Promise.reject(new GetBudgetError(maxGets));
      used++;
      return gh.request(method, path, opts);
    },
  };
  return { gh: new GitHub(transport, `${gh.owner}/${gh.repo}`), used: () => used };
}

/** 前回と今回のどちらでも読めた同じ id で、値が増えたものを今回の順に返す */
export function increasedItems(previous: OpsItem[] | null | undefined, current: OpsItem[]): { id: OpsItemId; previous: number; current: number }[] {
  if (!previous) return [];
  const out: { id: OpsItemId; previous: number; current: number }[] = [];
  for (const c of current) {
    const p = previous.find((x) => x.id === c.id);
    if (p?.available && c.available && c.value > p.value) out.push({ id: c.id, previous: p.value, current: c.value });
  }
  return out;
}
