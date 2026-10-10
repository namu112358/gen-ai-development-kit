/**
 * 定期実行：開いた Epic に入っていない Issue の Epic を Jev に問い、App の記録 epic-triage を残す（Epic #436・Issue #565）。
 * enforce のときだけ、判定が返した Epic の sub-issues に足す（親のある Issue には足さない）。判断は harness/lib/epic-triage.ts の純粋な関数。
 * 人・ほかのセッションの sub-issues は変えない（外す呼び出しは持たない）。どの Epic にも入らなかった Issue は行にして返し、ダッシュボードに出す。
 */

import { LABELS } from '../lib/config.ts';
import {
  buildEpicTriageRequest,
  decideEpic,
  epicProbabilities,
  epicTriageRecord,
  epicTriageSettings,
  readEpicTriageHistory,
  renderEpicAdded,
  renderEpicTriage,
  selectTriageTargets,
  type EpicDecision,
  type OpenEpic,
} from '../lib/epic-triage.ts';
import { askJev, measureRequest } from '../lib/jev.ts';
import { appRecords } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';
import type { EpicSplitRecord } from './epic-split.ts';

export interface EpicUnassignedRow {
  number: number;
  title: string;
  html_url: string;
  epic: number | null;
  probability: number | null;
}

interface OpenIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: { name: string }[];
  pull_request?: unknown;
  sub_issues_summary?: { total?: number } | null;
}

/** 開いた Issue の一覧から、epic のラベルの Issue を Epic にして、子のタイトルと epic-split の子を読む */
async function readOpenEpics(ctx: GateContext, issues: OpenIssue[]): Promise<OpenEpic[]> {
  const epics: OpenEpic[] = [];
  for (const i of issues) {
    if (i.pull_request || !i.labels.some((l) => l.name === LABELS.epic)) continue;
    const children = await ctx.gh.paginate<{ number: number; title: string }>(`/issues/${i.number}/sub_issues`);
    const comments = await ctx.gh.listComments(i.number);
    const split = appRecords<EpicSplitRecord>(ctx.config, comments, 'epic-split').at(-1)?.value;
    epics.push({
      number: i.number,
      title: i.title,
      body: i.body,
      children: children.map((c) => ({ number: c.number, title: c.title })),
      splitChildren: Array.isArray(split?.children) ? split.children : [],
    });
  }
  return epics;
}

/** 開いた Epic の中で、確率の一番高いもの（同じなら番号の小さい順） */
function topEpic(probabilities: Record<string, number>, openEpics: readonly number[]): { epic: number; probability: number } | null {
  const ranked = Object.entries(probabilities)
    .filter(([k, v]) => /^\d+$/.test(k) && openEpics.includes(Number(k)) && typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => ({ epic: Number(k), probability: v }))
    .sort((a, b) => b.probability - a.probability || a.epic - b.epic);
  return ranked[0] ?? null;
}

async function hasParent(ctx: GateContext, number: number): Promise<boolean> {
  return (await ctx.gh.request('GET', `/issues/${number}/parent`, { allow404: true })) !== null;
}

async function addToEpic(ctx: GateContext, epic: number, issue: OpenIssue): Promise<void> {
  await ctx.gh.request('POST', `/issues/${epic}/sub_issues`, { body: { sub_issue_id: issue.id } });
}

type Chosen = EpicDecision & { epic: number; probability: number };
const isChosen = (d: EpicDecision): d is Chosen => d.epic !== null && d.probability !== null;

export async function epicTriage(ctx: GateContext): Promise<{ unassigned: EpicUnassignedRow[]; failures: string[] } | undefined> {
  const settings = epicTriageSettings(ctx.config);
  if (settings.mode === 'off') return undefined;
  const unassigned: EpicUnassignedRow[] = [];
  const failures: string[] = [];
  const issues = await ctx.gh.paginate<OpenIssue>('/issues?state=open', 10);
  const epics = await readOpenEpics(ctx, issues);
  if (epics.length === 0) return { unassigned, failures };
  const openEpics = epics.map((e) => e.number);
  const byNumber = new Map(issues.map((i) => [i.number, i]));
  const targets = selectTriageTargets(
    issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((l) => l.name),
      isPullRequest: Boolean(i.pull_request),
      subIssues: i.sub_issues_summary?.total ?? 0,
    })),
    epics,
    ctx.config.dashboardIssueTitle,
  );
  const apiKey = ctx.secrets.jevApiKey;
  let asked = 0;
  let added = 0;
  for (const t of targets) {
    const issue = byNumber.get(t.number)!;
    let merged: Record<string, number> = {};
    let done = false;
    try {
      const history = readEpicTriageHistory(ctx.config, await ctx.gh.listComments(issue.number));
      merged = history.probabilities;
      const req = buildEpicTriageRequest(ctx.config, issue, epics, history.asked);
      if (req.ask && apiKey && asked < settings.perRun) {
        asked++;
        const r = await (ctx.askJev ?? askJev)(apiKey, req.request);
        if (r.status !== 'ok') {
          ctx.log(`#${issue.number} の Epic の振り分けに失敗しました: ${r.detail}`);
        } else {
          const current = epicProbabilities(r.answers);
          merged = { ...history.probabilities, ...current };
          const decision = decideEpic(settings, current, history, openEpics);
          let addedTo: number[] = [];
          let note = '';
          if (settings.mode === 'enforce' && isChosen(decision)) {
            if (await hasParent(ctx, issue.number)) {
              note = '\n\nこの Issue には親があるため sub-issues は変えません。';
            } else {
              try {
                await addToEpic(ctx, decision.epic, issue);
                addedTo = [decision.epic];
              } catch (e) {
                failures.push(`#${issue.number}: ${(e as Error).message}`);
              }
            }
          }
          const record = epicTriageRecord({
            mode: settings.mode,
            model: r.model,
            probabilities: Object.fromEntries(req.epics.map((e) => [String(e), current[String(e)] ?? null])),
            decision,
            added: addedTo,
            size: { ...measureRequest(req.request), inputTokens: r.inputTokens ?? null },
          });
          const text = addedTo.length > 0 && isChosen(decision) ? `${renderEpicTriage(record)}\n\n${renderEpicAdded(decision)}` : `${renderEpicTriage(record)}${note}`;
          await appComment(ctx, issue.number, 'epic-triage', text, record);
          done = addedTo.length > 0;
        }
      } else if (!req.ask && settings.mode === 'enforce') {
        // 全部の開いた Epic を問い済み：記録の確率で決める（shadow から enforce に切り替えた後に問い直さずに足す）
        const decision = decideEpic(settings, {}, history, openEpics);
        if (isChosen(decision)) {
          if (await hasParent(ctx, issue.number)) {
            ctx.log(`#${issue.number} には親があるため Epic #${decision.epic} に足しません`);
          } else {
            await addToEpic(ctx, decision.epic, issue);
            const record = epicTriageRecord({ mode: settings.mode, model: null, probabilities: {}, decision, added: [decision.epic], size: null });
            await appComment(ctx, issue.number, 'epic-triage', `${renderEpicTriage(record)}\n\n${renderEpicAdded(decision)}`, record);
            done = true;
          }
        }
      }
    } catch (e) {
      failures.push(`#${issue.number}: ${(e as Error).message}`);
    }
    if (done) {
      added++;
      continue;
    }
    const top = topEpic(merged, openEpics);
    unassigned.push({ number: issue.number, title: issue.title, html_url: issue.html_url, epic: top?.epic ?? null, probability: top?.probability ?? null });
  }
  ctx.log(`epic-triage: mode=${settings.mode} asked=${asked} added=${added} unassigned=${unassigned.length} failures=${failures.length}`);
  return { unassigned, failures };
}
