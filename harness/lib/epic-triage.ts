import type { HarnessConfig } from './config.ts';
import { LABELS } from './config.ts';
import type { IssueComment } from './github.ts';
import type { JevAnswers } from './jev.ts';
import { appRecords } from './state.ts';

/**
 * Epic に入っていない Issue の Epic を Jev に問う材料・問い・判定・記録の読み書きの本文（Epic #436）。
 * GitHub も Jev も呼ばない純粋な関数だけを置く（ゲートへの組み込みは #565、docs は #566）。
 * state には App が API から集めたもの（Issue と Epic のタイトル・本文・子課題のタイトル）だけを入れる。
 */

export const EPIC_TRIAGE_KIND = 'epic-triage';
export const EPIC_TRIAGE_QUESTION_SET = 1;
export const EPIC_TRIAGE_DEFAULTS = { mode: 'shadow', perRun: 3, probability: 0.9, margin: 0.2 } as const;
export const MAX_ISSUE_BODY_CHARS = 4000;
export const MAX_GOAL_CHARS = 1500;
export const MAX_CHILD_TITLES_CHARS = 2000;

export type EpicTriageMode = 'off' | 'shadow' | 'enforce';

export interface EpicTriageSettings {
  mode: EpicTriageMode;
  perRun: number;
  probability: number | null;
  margin: number | null;
}

const isRatio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** 設定の既定の埋め方（decision.ts の decisionMode と同じ置き方。config.ts が epic-triage.ts を import しないため） */
export function epicTriageSettings(config: HarnessConfig): EpicTriageSettings {
  const jev = config.jev;
  const rawMode: unknown = jev.epicTriage;
  const mode: EpicTriageMode =
    rawMode === undefined ? EPIC_TRIAGE_DEFAULTS.mode : rawMode === 'off' || rawMode === 'shadow' || rawMode === 'enforce' ? rawMode : 'off';
  const perRun = Number.isInteger(jev.epicTriagePerRun) && jev.epicTriagePerRun! > 0 ? jev.epicTriagePerRun! : EPIC_TRIAGE_DEFAULTS.perRun;
  const ratio = (v: unknown, fallback: number): number | null => (v === undefined ? fallback : isRatio(v) ? v : null);
  return {
    mode,
    perRun,
    probability: ratio(jev.thresholds.epicProbability, EPIC_TRIAGE_DEFAULTS.probability),
    margin: ratio(jev.thresholds.epicMargin, EPIC_TRIAGE_DEFAULTS.margin),
  };
}

export interface TriageIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  isPullRequest: boolean;
  subIssues: number;
}

export interface OpenEpic {
  number: number;
  title: string;
  body: string | null;
  /** sub-issues の子課題 */
  children: { number: number; title: string }[];
  /** epic-split の記録の children（呼び出し側が渡す） */
  splitChildren: number[];
}

/** Epic の振り分けを問う対象。PR・ダッシュボード・Epic・子を持つ Issue・すでに Epic の子のものを除き、入力の順を保つ */
export function selectTriageTargets(issues: TriageIssue[], epics: OpenEpic[], dashboardTitle: string): TriageIssue[] {
  const excluded = new Set<number>();
  for (const e of epics) {
    excluded.add(e.number);
    for (const c of e.children) excluded.add(c.number);
    for (const n of e.splitChildren) excluded.add(n);
  }
  return issues.filter(
    (i) => !i.isPullRequest && i.title !== dashboardTitle && !i.labels.includes(LABELS.epic) && i.subIssues <= 0 && !excluded.has(i.number),
  );
}

/** Epic の目的。`### Goal` の節、無ければ本文の先頭（MAX_GOAL_CHARS 字まで） */
export function epicGoal(body: string | null): string {
  if (body === null) return '';
  const text = body.replace(/\r\n?/g, '\n');
  const start = /^###[ \t]+Goal[ \t]*$/m.exec(text);
  if (start) {
    const rest = text.slice(start.index + start[0].length);
    const next = /^###[ \t]+/m.exec(rest);
    const section = (next ? rest.slice(0, next.index) : rest).trim();
    if (section !== '' && section !== '_No response_') return section.slice(0, MAX_GOAL_CHARS);
  }
  return text.trim().slice(0, MAX_GOAL_CHARS);
}

export const epicQuestionKey = (epic: number): string => `epic_${epic}`;

const epicQuestion = (epic: number) => {
  const ref = `epics.${epicQuestionKey(epic)}`;
  return {
    type: 'noul' as const,
    instructions:
      `\`issue\` is a GitHub issue that does not belong to any epic yet. \`${ref}\` is one open epic: its title, its goal, and the titles of its existing child issues. ` +
      `Judge this epic on its own, without comparing it with any other epic: is \`issue\` a child task whose completion directly advances the goal of \`${ref}\`? ` +
      'If you are not sure, answer no.',
    criteria: {
      true: `Completing \`issue\` delivers part of what the goal of \`${ref}\` describes, or is one of the steps that goal needs, in the same way as the existing child issues of that epic.`,
      false:
        `\`issue\` only touches the same area, the same files, or the same topic as \`${ref}\` without advancing its goal; ` +
        `or the relation between \`issue\` and that goal cannot be read from the text; or you cannot tell. In each of these cases answer no.`,
    },
  };
};

type EpicQuestion = ReturnType<typeof epicQuestion>;

/** 1つの Issue につき、まだ問っていない開いた Epic ごとに Noul の問いを1つずつ並べる（Epic どうしを比べさせない） */
export function buildEpicTriageRequest(
  config: HarnessConfig,
  issue: { title: string; body: string | null },
  epics: OpenEpic[],
  asked: readonly number[],
):
  | {
      ask: true;
      epics: number[];
      request: {
        model: string;
        state: { issue: { title: string; body: string }; epics: Record<string, { title: string; goal: string; child_titles: string[] }> };
        questions: Record<string, EpicQuestion>;
      };
    }
  | { ask: false; reason: string } {
  const targets = epics.filter((e) => !asked.includes(e.number));
  if (targets.length === 0) return { ask: false, reason: '問っていない開いた Epic がありません' };
  const stateEpics: Record<string, { title: string; goal: string; child_titles: string[] }> = {};
  const questions: Record<string, EpicQuestion> = {};
  for (const e of targets) {
    const titles: string[] = [];
    let used = 0;
    for (const c of e.children) {
      if (used + c.title.length > MAX_CHILD_TITLES_CHARS) break;
      titles.push(c.title);
      used += c.title.length;
    }
    stateEpics[epicQuestionKey(e.number)] = { title: e.title, goal: epicGoal(e.body), child_titles: titles };
    questions[epicQuestionKey(e.number)] = epicQuestion(e.number);
  }
  return {
    ask: true,
    epics: targets.map((e) => e.number),
    request: {
      model: config.jev.model,
      state: { issue: { title: issue.title, body: (issue.body ?? '').slice(0, MAX_ISSUE_BODY_CHARS) }, epics: stateEpics },
      questions,
    },
  };
}

/** answers から Epic ごとの確率（Noul の yes）を取り出す。キーは Epic の番号の文字列 */
export function epicProbabilities(answers: JevAnswers): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, a] of Object.entries(answers)) {
    const m = /^epic_(\d+)$/.exec(key);
    if (m && a.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul)) out[m[1]!] = a.noul;
  }
  return out;
}

export interface EpicTriageHistory {
  probabilities: Record<string, number>;
  asked: number[];
  added: number[];
}

/** 前の記録（App の名義の epic-triage）を古い順に読む。値が null でも問い済み */
export function readEpicTriageHistory(config: HarnessConfig, comments: IssueComment[]): EpicTriageHistory {
  const probabilities: Record<string, number> = {};
  const asked = new Set<number>();
  const added = new Set<number>();
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  for (const { value } of appRecords<{ probabilities?: unknown; added?: unknown }>(config, comments, EPIC_TRIAGE_KIND)) {
    if (!isObject(value)) continue;
    if (isObject(value.probabilities)) {
      for (const [k, v] of Object.entries(value.probabilities)) {
        if (!/^\d+$/.test(k)) continue;
        asked.add(Number(k));
        if (typeof v === 'number' && Number.isFinite(v)) probabilities[k] = v;
      }
    }
    if (Array.isArray(value.added)) for (const n of value.added) if (Number.isInteger(n)) added.add(n as number);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return { probabilities, asked: sorted(asked), added: sorted(added) };
}

export interface EpicRank {
  epic: number;
  probability: number;
}

export interface EpicDecision {
  epic: number | null;
  probability: number | null;
  second: EpicRank | null;
  reason: string;
}

/** 今回の答えと前の記録の確率のうち、今開いている Epic だけで1番目・2番目を決め、足す Epic を1つ返す（返さないときは epic が null） */
export function decideEpic(
  settings: Pick<EpicTriageSettings, 'probability' | 'margin'>,
  current: Record<string, number>,
  history: Pick<EpicTriageHistory, 'probabilities' | 'added'>,
  openEpics: readonly number[],
): EpicDecision {
  const merged = { ...history.probabilities, ...current };
  const ranked: EpicRank[] = Object.entries(merged)
    .filter(([k, v]) => /^\d+$/.test(k) && openEpics.includes(Number(k)) && typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => ({ epic: Number(k), probability: v }))
    .sort((a, b) => b.probability - a.probability || a.epic - b.epic);
  const first = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  const none = (reason: string): EpicDecision => ({ epic: null, probability: first?.probability ?? null, second, reason });
  if (!first) return none('確率がありません');
  const { probability, margin } = settings;
  if (probability === null || margin === null) return none('下限が未設定です');
  if (history.added.includes(first.epic)) return none('前に足した Epic です');
  if (first.probability < probability) return none('確率が下限未満です');
  if (Math.round((first.probability - (second?.probability ?? 0)) * 1e9) / 1e9 < margin) return none('2番目との差が足りません');
  return { epic: first.epic, probability: first.probability, second, reason: '下限以上で、2番目との差も十分です' };
}

export interface EpicTriageRecord {
  version: 1;
  questionSet: number;
  mode: EpicTriageMode;
  model: string | null;
  probabilities: Record<string, number | null>;
  decision: { epic: number | null; probability: number | null; second: EpicRank | null };
  added: number[];
  /** measureRequest(request) と応答の inputTokens（問わずに記録の確率で決めたときは null） */
  size: { chars: number; jaRatio: number; inputTokens: number | null } | null;
}

export function epicTriageRecord(args: {
  mode: EpicTriageMode;
  model: string | null;
  probabilities: Record<string, number | null>;
  decision: EpicDecision;
  added: number[];
  size: EpicTriageRecord['size'];
}): EpicTriageRecord {
  const { epic, probability, second } = args.decision;
  return {
    version: 1,
    questionSet: EPIC_TRIAGE_QUESTION_SET,
    mode: args.mode,
    model: args.model,
    probabilities: args.probabilities,
    decision: { epic, probability, second },
    added: args.added,
    size: args.size,
  };
}

const pct = (p: number | null): string => (p !== null && Number.isFinite(p) ? `${Math.round(p * 100)}%` : '-');

export function renderEpicTriage(record: EpicTriageRecord): string {
  const rows = Object.entries(record.probabilities)
    .sort(([a, x], [b, y]) => (y ?? -1) - (x ?? -1) || Number(a) - Number(b))
    .map(([epic, p]) => `| #${epic} | ${pct(p)} |`);
  const d = record.decision;
  return [
    `Jev による Epic の振り分けです（モード ${record.mode}）。`,
    '',
    '| Epic | 確率 |',
    '| --- | --- |',
    ...rows,
    '',
    d.epic !== null
      ? `判定：Epic #${d.epic} に足す（Jev の確率 ${pct(d.probability)}。2番目は ${d.second ? `#${d.second.epic} の ${pct(d.second.probability)}` : 'なし'}）`
      : '判定：どの Epic にも足しません。',
    ...(record.mode === 'shadow' ? ['', 'shadow のため sub-issues は変えません。'] : []),
  ].join('\n');
}

export function renderEpicAdded(decision: EpicDecision & { epic: number; probability: number }): string {
  const second = decision.second
    ? `2番目は #${decision.second.epic} の ${pct(decision.second.probability)}`
    : 'ほかに確率のある Epic はありません';
  return [
    `Epic #${decision.epic} の sub-issues に足しました（Jev の確率 ${pct(decision.probability)}。${second}）。`,
    '',
    '違っていれば Epic の sub-issues から外してください。App は外された組に二度と足しません。',
  ].join('\n');
}
