import { areaLabels, AREA_PREFIX } from '../lib/classify.ts';
import { appLogin, LABELS, PRIORITY_LABELS, riskLabel, RISK_LEVELS, typeLabel, type HarnessConfig, type RiskLevel } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
import { buildTriageRequest, renderTriage, summarizeTriage, type TriageSummary } from '../lib/issue-triage.ts';
import { askJev, flattenAnswers } from '../lib/jev.ts';
import { auditLabels } from '../lib/label-rules.ts';
import { appRecords, isAgentPr, lastLabeled, latestPlanGate, type PlanGateRecord, type PullRequest, type TimelineEvent } from '../lib/state.ts';
import { parseTitle, TITLE_TYPES } from '../lib/title.ts';
import { appComment, type GateContext } from './context.ts';
import { onSchedule } from './stale.ts';

/**
 * 足りないラベルを付ける（docs/operations.md の「必須ラベルの規則」）。
 * - App（決定的に決まるもの）：タイトルから type:*、子を持つ Issue に epic、計画ゲートを通った計画の files から area:*
 * - Jev（決まらないもの）：priority:* と、計画の無い Issue の area:*。classification.issueTriage が label で、確率が
 *   jev.thresholds.labelProbability 以上のときだけ付ける。同じ Issue には一度だけ問う（App の記録 issue-triage / label-triage で判断）
 * 人が付けたラベルは外さない。App が前に付けたもの（events API の labeled の actor が App）だけを付け替える。
 * 判断は純粋な関数（planLabelChanges・decideJevLabels ほか）、API の読み書きは applyAppLabels・triageLabels・labelApply。
 */

const TYPE_LABELS: string[] = TITLE_TYPES.map(typeLabel);
const PRIORITIES: string[] = Object.values(PRIORITY_LABELS);

/** 1回の定期実行で Jev に問う Issue の数の上限（残りは次の実行） */
export const JEV_PER_RUN = 5;

export interface LabelTarget {
  kind: 'issue' | 'pr';
  title: string;
  labels: string[];
  /** 子（Sub-issues）の数。Issue のみ */
  subIssues?: number;
  /** 計画ゲートを通った計画の files（Issue のみ。無ければ null / undefined） */
  plannedFiles?: string[] | null;
}

export interface LabelChanges {
  add: string[];
  remove: string[];
  /** 人が付けた（見分けられないものを含む）ため外さなかった type:*。知らせる */
  kept: string[];
  mismatches: string[];
}

const isEpicTarget = (t: LabelTarget): boolean => t.kind === 'issue' && ((t.subIssues ?? 0) > 0 || t.labels.includes(LABELS.epic));

/** 外すべき type:*（Epic の type:*、タイトルと食い違う type:*）。タイトルの形式が違えば type は触らない */
export function wrongTypeLabels(target: LabelTarget): string[] {
  const types = target.labels.filter((l) => TYPE_LABELS.includes(l));
  if (isEpicTarget(target)) return types;
  const title = parseTitle(target.title);
  if (!title.ok) return [];
  return types.filter((l) => l !== typeLabel(title.type));
}

/** App が付けたラベル（最後に付けた labeled の actor が App）。外されていれば含めない */
export function appLabeledSet(config: HarnessConfig, events: TimelineEvent[], labels: string[]): Set<string> {
  return new Set(labels.filter((l) => lastLabeled(events, l)?.actor?.login === appLogin(config)));
}

/** 足す・外す・知らせるを決める。appLabeled は App が付けたと確かめられたラベル */
export function planLabelChanges(config: HarnessConfig, target: LabelTarget, appLabeled: ReadonlySet<string>): LabelChanges {
  const add: string[] = [];
  const remove: string[] = [];
  const kept: string[] = [];
  const mismatches: string[] = [];
  const epic = isEpicTarget(target);
  if (target.kind === 'issue' && (target.subIssues ?? 0) > 0 && !target.labels.includes(LABELS.epic)) add.push(LABELS.epic);

  for (const l of wrongTypeLabels(target)) (appLabeled.has(l) ? remove : kept).push(l);
  const title = parseTitle(target.title);
  if (kept.length > 0) {
    const list = kept.map((l) => `\`${l}\``).join('・');
    mismatches.push(epic
      ? `子課題を持つ Issue（Epic）に ${list} が付いています。人が付けたものなので外しません。Epic には \`type:*\` を付けないので、外してください。`
      : `タイトルの type は \`${title.ok ? title.type : '?'}\` ですが、${list} が付いています。人が付けたものなので付け替えません。タイトルかラベルを直してください。`);
  }
  if (!epic && title.ok) {
    const remaining = target.labels.filter((l) => TYPE_LABELS.includes(l) && !remove.includes(l));
    if (remaining.length === 0) add.push(typeLabel(title.type));
  }

  const audit = auditLabels(config, { kind: target.kind, title: target.title, labels: target.labels, subIssues: target.subIssues });
  if (target.kind === 'issue' && audit.missing.includes('area:*') && target.plannedFiles) add.push(...areaLabels(config, target.plannedFiles));
  return { add: [...new Set(add)].filter((l) => !target.labels.includes(l)), remove, kept, mismatches };
}

/** 計画の files から決まる area:* のうち、まだ付いていないもの（計画ゲートを通ったときに付ける。足すだけ） */
export function planAreaLabels(config: HarnessConfig, files: string[], labels: string[]): string[] {
  return areaLabels(config, files).filter((l) => !labels.includes(l));
}

/** PR の risk:* を、受け付けた判定の段階1つにそろえる */
export function riskLabelChanges(labels: string[], level: RiskLevel): { add: string[]; remove: string[] } {
  const want = riskLabel(level);
  const all: string[] = RISK_LEVELS.map(riskLabel);
  return { add: labels.includes(want) ? [] : [want], remove: labels.filter((l) => all.includes(l) && l !== want) };
}

/** 付け外しの後のラベル */
export const applyChanges = (labels: string[], c: { add: string[]; remove: string[] }): string[] => [...labels.filter((l) => !c.remove.includes(l)), ...c.add.filter((l) => !labels.includes(l))];

// --- Jev ---

export interface JevNeeds {
  priority: boolean;
  area: boolean;
}

/** Jev に問うもの：優先度が無い、計画が無く area:* が無い */
export function jevNeeds(config: HarnessConfig, labels: string[], hasPlan: boolean): JevNeeds {
  const areas = Object.keys(config.classification.areas).map((a) => `${AREA_PREFIX}${a}`);
  return { priority: !labels.some((l) => PRIORITIES.includes(l)), area: !hasPlan && !labels.some((l) => areas.includes(l)) };
}

/** 既に Jev に問った Issue か（シャドーの提案 issue-triage か、label-triage の記録がある） */
export function alreadyTriaged(config: HarnessConfig, comments: IssueComment[]): boolean {
  return appRecords(config, comments, 'issue-triage').length > 0 || appRecords(config, comments, 'label-triage').length > 0;
}

export interface JevLabelResult {
  question: 'priority' | 'area';
  choice: string;
  probability: number;
  /** 付けるラベル（選択肢がラベルに当たらなければ null） */
  label: string | null;
  applied: boolean;
  /** 付けなかった理由 */
  reason?: string;
}

/** Jev の答えから、付けるラベルと付けなかったもの（知らせる）を決める */
export function decideJevLabels(config: HarnessConfig, summary: Pick<TriageSummary, 'priority' | 'area'>, needs: JevNeeds): JevLabelResult[] {
  const threshold = config.jev.thresholds.labelProbability;
  const areas = Object.keys(config.classification.areas);
  const out: JevLabelResult[] = [];
  const decide = (question: 'priority' | 'area', [choice, probability]: [string, number], label: string | null) => {
    let reason: string | undefined;
    if (label === null) reason = `選択肢「${choice}」に当たるラベルがありません`;
    else if (threshold === undefined) reason = '`jev.thresholds.labelProbability` が未設定のため付けません（提案のみ）';
    else if (!(probability >= threshold)) reason = `確率 ${pct(probability)} が下限 ${pct(threshold)} 未満`;
    out.push({ question, choice, probability, label, applied: reason === undefined, ...(reason ? { reason } : {}) });
  };
  if (needs.priority) decide('priority', summary.priority, PRIORITIES.includes(`priority:${summary.priority[0]}`) ? `priority:${summary.priority[0]}` : null);
  if (needs.area) decide('area', summary.area, areas.includes(summary.area[0]) ? `${AREA_PREFIX}${summary.area[0]}` : null);
  return out;
}

const pct = (p: number) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '-');

export function renderLabelTriage(summary: TriageSummary, results: JevLabelResult[]): string {
  const name = { priority: '優先度', area: '領域' };
  const applied = results.filter((r) => r.applied);
  const notApplied = results.filter((r) => !r.applied);
  return [
    renderTriage(summary, 'Jev による分類です（`classification.issueTriage` が `label`。足りない優先度・領域だけを、確率が下限以上のときに付けます）。'),
    '',
    ...(applied.length > 0 ? ['付けたラベル:', ...applied.map((r) => `- \`${r.label}\`（${name[r.question]}、${pct(r.probability)}）`)] : ['付けたラベルはありません。']),
    ...(notApplied.length > 0 ? ['', '付けなかったもの（人が付けてください）:', ...notApplied.map((r) => `- ${name[r.question]}: ${r.label ? `\`${r.label}\`` : r.choice} — ${r.reason}`)] : []),
  ].join('\n');
}

// --- API ---

/** App の付与（type・epic・area）を1件に行う。events は外す候補があるときだけ読む */
export async function applyAppLabels(ctx: GateContext, number: number, target: LabelTarget, getComments: () => Promise<IssueComment[]>): Promise<LabelChanges> {
  const wrong = wrongTypeLabels(target);
  const appLabeled = wrong.length > 0 ? appLabeledSet(ctx.config, await ctx.gh.paginate<TimelineEvent>(`/issues/${number}/events`), wrong) : new Set<string>();
  const change = planLabelChanges(ctx.config, target, appLabeled);
  for (const l of change.remove) await ctx.gh.removeLabel(number, l);
  if (change.add.length > 0) await ctx.gh.addLabels(number, change.add);
  if (change.mismatches.length > 0) await notifyMismatch(ctx, number, target.title, change, await getComments());
  if (change.add.length + change.remove.length > 0) ctx.log(`#${number} のラベル: +${change.add.join(',')} -${change.remove.join(',')}`);
  return change;
}

interface MismatchRecord {
  version: 1;
  title: string;
  labels: string[];
}

/** 人が付けた type:* の食い違いを知らせる（同じタイトルと同じラベルには二重に書かない） */
async function notifyMismatch(ctx: GateContext, number: number, title: string, change: LabelChanges, comments: IssueComment[]): Promise<void> {
  const labels = [...change.kept].sort();
  const last = appRecords<MismatchRecord>(ctx.config, comments, 'label-mismatch').at(-1)?.value;
  if (last && last.title === title && JSON.stringify(last.labels) === JSON.stringify(labels)) return;
  await appComment(ctx, number, 'label-mismatch', change.mismatches.join('\n'), { version: 1, title, labels } satisfies MismatchRecord);
}

const hasPlanRecord = (ctx: GateContext, comments: IssueComment[]): boolean =>
  Boolean((latestPlanGate(ctx.config, comments)?.value as (PlanGateRecord & { plan?: unknown }) | undefined)?.plan);

const passedPlanFiles = (ctx: GateContext, comments: IssueComment[]): string[] | null => {
  const gate = latestPlanGate(ctx.config, comments)?.value as (PlanGateRecord & { plan?: { files?: string[] } }) | undefined;
  return gate?.pass && gate.plan?.files ? gate.plan.files : null;
};

/**
 * Jev に問い、足りない priority:*・area:* を付ける（classification.issueTriage が label のときだけ）。
 * proposal が true（agent:ready が付いたとき）は、足りないものが無くても提案のコメントを出す。
 * 問うたら true（上限の数え方）。
 */
export async function triageLabels(
  ctx: GateContext,
  issue: { number: number; title: string; body: string | null; labels: string[] },
  comments: IssueComment[],
  opts: { proposal: boolean },
): Promise<boolean> {
  const apiKey = ctx.secrets.jevApiKey;
  if (ctx.config.classification.issueTriage !== 'label' || !apiKey) return false;
  if (alreadyTriaged(ctx.config, comments)) return false;
  const needs = jevNeeds(ctx.config, issue.labels, hasPlanRecord(ctx, comments));
  if (!opts.proposal && !needs.priority && !needs.area) return false;
  const form = parseIssueBody(issue.body);
  if (!form.ok) return false;
  const r = await (ctx.askJev ?? askJev)(apiKey, buildTriageRequest(ctx.config, issue.title, form.contract));
  if (r.status !== 'ok') {
    ctx.log(`#${issue.number} の分類に失敗しました: ${r.detail}`);
    return true;
  }
  const summary = summarizeTriage(r.answers);
  const results = decideJevLabels(ctx.config, summary, needs);
  const add = results.filter((x) => x.applied).map((x) => x.label!);
  if (add.length > 0) await ctx.gh.addLabels(issue.number, add);
  await appComment(ctx, issue.number, 'label-triage', renderLabelTriage(summary, results), {
    version: 1,
    model: r.model,
    answers: flattenAnswers(r.answers),
    threshold: ctx.config.jev.thresholds.labelProbability ?? null,
    added: add,
    notApplied: results.filter((x) => !x.applied).map(({ question, choice, probability, label, reason }) => ({ question, choice, probability, label, reason })),
  });
  return true;
}

interface OpenIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  pull_request?: unknown;
  sub_issues_summary?: { total?: number } | null;
}

/**
 * 定期実行：開いた Issue（ダッシュボードと、/issues に混ざる PR を除く。agent:ready の有無は問わない）と Agent PR に、
 * 足りないラベルを付ける。ダッシュボード（onSchedule）より先に動かし、不足の一覧が付与の後の状態を映すようにする。
 */
export async function labelApply(ctx: GateContext): Promise<void> {
  const failures: string[] = [];
  let asked = 0;
  const issues = await ctx.gh.paginate<OpenIssue>('/issues?state=open', 10);
  for (const i of issues) {
    if (i.pull_request || i.title === ctx.config.dashboardIssueTitle) continue;
    try {
      let comments: Promise<IssueComment[]> | undefined;
      const getComments = () => (comments ??= ctx.gh.listComments(i.number));
      const labels = i.labels.map((l) => l.name);
      const subIssues = i.sub_issues_summary?.total ?? 0;
      const audit = auditLabels(ctx.config, { kind: 'issue', title: i.title, labels, subIssues });
      const plannedFiles = audit.missing.includes('area:*') ? passedPlanFiles(ctx, await getComments()) : null;
      const change = await applyAppLabels(ctx, i.number, { kind: 'issue', title: i.title, labels, subIssues, plannedFiles }, getComments);
      const after = applyChanges(labels, change);
      const mayNeedJev = ctx.config.classification.issueTriage === 'label' && ctx.secrets.jevApiKey && asked < JEV_PER_RUN;
      const needs = jevNeeds(ctx.config, after, false);
      if (mayNeedJev && (needs.priority || needs.area)) {
        if (await triageLabels(ctx, { number: i.number, title: i.title, body: i.body, labels: after }, await getComments(), { proposal: false })) asked++;
      }
    } catch (e) {
      failures.push(`#${i.number}: ${(e as Error).message}`);
    }
  }
  const prs = await ctx.gh.paginate<PullRequest>('/pulls?state=open', 5);
  for (const p of prs.filter((x) => isAgentPr(ctx.config, x, ctx.repository))) {
    try {
      await applyAppLabels(ctx, p.number, { kind: 'pr', title: p.title, labels: p.labels.map((l) => l.name) }, () => ctx.gh.listComments(p.number));
    } catch (e) {
      failures.push(`#${p.number}: ${(e as Error).message}`);
    }
  }
  ctx.log(`label-apply: jev=${asked} failures=${failures.length}`);
  if (failures.length > 0) throw new Error(`ラベルの付与に失敗しました: ${failures.join('; ')}`);
}

/**
 * 定期実行（schedule・workflow_dispatch）の入口：label-apply を onSchedule（ダッシュボード）より先に動かす。
 * 付与に失敗してもダッシュボードは書き、失敗は最後に投げ直す（ジョブを失敗にする）
 */
export async function onScheduleWithLabels(ctx: GateContext, now: Date = new Date()): Promise<void> {
  let failed: unknown = null;
  try {
    await labelApply(ctx);
  } catch (e) {
    failed = e;
  }
  await onSchedule(ctx, now);
  if (failed) throw failed;
}
