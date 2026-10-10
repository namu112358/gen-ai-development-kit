import type { HarnessConfig } from './config.ts';
import { LABELS } from './config.ts';
import { epicGoal } from './epic-triage.ts';
import type { JevAnswers } from './jev.ts';
import { measureRequest } from './jev.ts';
import { parseTitle } from './title.ts';

/**
 * Issue の下書きが開いた Issue と同じ件かを Jev に問う材料・問い・判定・記録の本文（Issue #499）。
 * GitHub も Jev も呼ばない純粋な関数だけを置く（Jev を呼ぶ経路・記録の置き場所・手順への組み込みは別の Issue）。
 * 下書きの材料はタイトルと Goal だけ。候補は語の重なりで上限の数まで絞り、問いの大きさにも上限を置く。
 */

export const ISSUE_OVERLAP_KIND = 'issue-overlap';
export const ISSUE_OVERLAP_QUESTION_SET = 1;
export const ISSUE_OVERLAP_DEFAULTS = { mode: 'shadow', maxCandidates: 5, probability: 0.9 } as const;
export const MAX_TITLE_CHARS = 200;
export const MAX_GOAL_CHARS = 1500;
export const MAX_REQUEST_CHARS = 20000;

export type IssueOverlapMode = 'off' | 'shadow' | 'enforce';

export interface IssueOverlapSettings {
  mode: IssueOverlapMode;
  maxCandidates: number;
  probability: number | null;
}

const isRatio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/** 設定の既定の埋め方（epicTriageSettings と同じ置き方。config.ts が issue-overlap.ts を import しないため） */
export function issueOverlapSettings(config: HarnessConfig): IssueOverlapSettings {
  const jev = config.jev;
  const rawMode: unknown = jev.issueOverlap;
  const mode: IssueOverlapMode =
    rawMode === undefined ? ISSUE_OVERLAP_DEFAULTS.mode : rawMode === 'off' || rawMode === 'shadow' || rawMode === 'enforce' ? rawMode : 'off';
  const max = jev.issueOverlapMaxCandidates;
  const maxCandidates = Number.isInteger(max) && max! > 0 ? max! : ISSUE_OVERLAP_DEFAULTS.maxCandidates;
  const raw: unknown = jev.thresholds.issueOverlapProbability;
  const probability = raw === undefined ? ISSUE_OVERLAP_DEFAULTS.probability : isRatio(raw) ? raw : null;
  return { mode, maxCandidates, probability };
}

export interface OverlapDraft {
  title: string;
  body: string | null;
}

export interface OpenIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  isPullRequest: boolean;
}

// jev.ts の JA_CHAR と同じ範囲（あちらは export されていない）
const JA_RUN = /[　-ヿ㐀-鿿＀-￯]+/g;

const subjectOf = (title: string): string => {
  const parsed = parseTitle(title);
  return (parsed.ok ? parsed.subject : title).toLowerCase();
};

const featuresOf = (title: string): { words: Set<string>; grams: Set<string> } => {
  const subject = subjectOf(title);
  const words = new Set(subject.split(/[\s\p{P}\p{S}]+/u).filter((w) => w.length >= 2));
  const grams = new Set<string>();
  for (const run of subject.match(JA_RUN) ?? []) for (let i = 0; i + 2 <= run.length; i++) grams.add(run.slice(i, i + 2));
  return { words, grams };
};

/** 2つのタイトルの件名の重なり：共通の語の数＋日本語の文字の2-gram の共通数（英字・数字には2-gram を作らない） */
export function overlapScore(a: string, b: string): number {
  const x = featuresOf(a);
  const y = featuresOf(b);
  let score = 0;
  for (const w of x.words) if (y.words.has(w)) score++;
  for (const g of x.grams) if (y.grams.has(g)) score++;
  return score;
}

/** 候補の Issue。PR・ダッシュボード・Epic・重なり0を除き、重なりの多い順（同じなら番号の大きい順）に max 件まで */
export function selectOverlapCandidates(draft: OverlapDraft, issues: OpenIssue[], dashboardTitle: string, max: number): OpenIssue[] {
  return issues
    .filter((i) => !i.isPullRequest && i.title !== dashboardTitle && !i.labels.includes(LABELS.epic))
    .map((issue) => ({ issue, score: overlapScore(draft.title, issue.title) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.issue.number - a.issue.number)
    .slice(0, max)
    .map((s) => s.issue);
}

export const overlapQuestionKey = (n: number): string => `same_${n}`;
const issueKey = (n: number): string => `issue_${n}`;

const overlapQuestion = (n: number) => {
  const ref = `issues.${issueKey(n)}`;
  return {
    type: 'noul' as const,
    instructions:
      `\`draft\` is a draft of a new GitHub issue (title and goal). \`${ref}\` is one open issue. ` +
      `Judge this issue on its own, without comparing it with other issues: is \`draft\` the same piece of work as \`${ref}\`, so that finishing one would also achieve the goal of the other? ` +
      'If you are not sure, answer no.',
    criteria: {
      true: `\`draft\` and \`${ref}\` ask for the same change or the same fix, so creating \`draft\` would duplicate that issue.`,
      false:
        `\`draft\` only touches the same area, the same files, or the same topic as \`${ref}\`; ` +
        'or one is only a part of, or a precondition for, the other; or the relation cannot be read from the text; or you cannot tell. In each of these cases answer no.',
    },
  };
};

type OverlapQuestion = ReturnType<typeof overlapQuestion>;

export interface IssueOverlapRequest {
  model: string;
  state: { draft: { title: string; goal: string }; issues: Record<string, { title: string; goal: string }> };
  questions: Record<string, OverlapQuestion>;
}

const buildRequest = (config: HarnessConfig, draft: OverlapDraft, candidates: OpenIssue[]): IssueOverlapRequest => {
  const issues: IssueOverlapRequest['state']['issues'] = {};
  const questions: Record<string, OverlapQuestion> = {};
  for (const c of candidates) {
    issues[issueKey(c.number)] = { title: c.title.slice(0, MAX_TITLE_CHARS), goal: epicGoal(c.body).slice(0, MAX_GOAL_CHARS) };
    questions[overlapQuestionKey(c.number)] = overlapQuestion(c.number);
  }
  return {
    model: config.jev.model,
    state: { draft: { title: draft.title.slice(0, MAX_TITLE_CHARS), goal: epicGoal(draft.body).slice(0, MAX_GOAL_CHARS) }, issues },
    questions,
  };
};

/** 候補ごとに独立した Noul の問いを1つずつ並べる（候補どうしを比べさせない）。大きさが上限を超える間は末尾の候補から外す */
export function buildIssueOverlapRequest(
  config: HarnessConfig,
  draft: OverlapDraft,
  candidates: OpenIssue[],
): { ask: true; issues: number[]; request: IssueOverlapRequest } | { ask: false; reason: string } {
  if (candidates.length === 0) return { ask: false, reason: '候補の Issue がありません' };
  for (let n = candidates.length; n >= 1; n--) {
    const used = candidates.slice(0, n);
    const request = buildRequest(config, draft, used);
    if (measureRequest(request).chars <= MAX_REQUEST_CHARS) return { ask: true, issues: used.map((c) => c.number), request };
  }
  return { ask: false, reason: '問いが大きすぎます' };
}

/** answers から候補ごとの確率（Noul の yes）を取り出す。キーは Issue の番号の文字列 */
export function overlapProbabilities(answers: JevAnswers): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, a] of Object.entries(answers)) {
    const m = /^same_(\d+)$/.exec(key);
    if (m && a.type === 'noul' && typeof a.noul === 'number' && Number.isFinite(a.noul)) out[m[1]!] = a.noul;
  }
  return out;
}

export interface OverlapDecision {
  duplicateOf: number | null;
  probability: number | null;
  reason: string;
}

/** 確率の1番目が下限以上なら、その Issue を重なる Issue にする */
export function decideOverlap(settings: Pick<IssueOverlapSettings, 'probability'>, probabilities: Record<string, number>): OverlapDecision {
  const ranked = Object.entries(probabilities)
    .filter(([k, v]) => /^\d+$/.test(k) && typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => ({ issue: Number(k), probability: v }))
    .sort((a, b) => b.probability - a.probability || a.issue - b.issue);
  const first = ranked[0] ?? null;
  const none = (reason: string): OverlapDecision => ({ duplicateOf: null, probability: first?.probability ?? null, reason });
  if (!first) return none('確率がありません');
  if (settings.probability === null) return none('下限が未設定です');
  if (first.probability < settings.probability) return none('確率が下限未満です');
  return { duplicateOf: first.issue, probability: first.probability, reason: '下限以上です' };
}

export interface IssueOverlapRecord {
  version: 1;
  questionSet: number;
  mode: IssueOverlapMode;
  model: string | null;
  draftTitle: string;
  pairs: { issue: number; probability: number | null }[];
  decision: { duplicateOf: number | null; probability: number | null };
  /** セッションが同じ件と見た Issue の番号（見なかった・判断が無いときは null） */
  sessionDuplicateOf: number | null;
  /** decision.duplicateOf とセッションの判断が同じか（セッションの判断が無ければ null） */
  agree: boolean | null;
  size: { chars: number; jaRatio: number; inputTokens: number | null } | null;
}

export function issueOverlapRecord(args: {
  mode: IssueOverlapMode;
  model: string | null;
  draftTitle: string;
  issues: number[];
  probabilities: Record<string, number>;
  decision: OverlapDecision;
  sessionDuplicateOf: number | null | undefined;
  size: IssueOverlapRecord['size'];
}): IssueOverlapRecord {
  const session = args.sessionDuplicateOf;
  return {
    version: 1,
    questionSet: ISSUE_OVERLAP_QUESTION_SET,
    mode: args.mode,
    model: args.model,
    draftTitle: args.draftTitle,
    pairs: args.issues.map((issue) => ({ issue, probability: args.probabilities[String(issue)] ?? null })),
    decision: { duplicateOf: args.decision.duplicateOf, probability: args.decision.probability },
    sessionDuplicateOf: session ?? null,
    agree: session === undefined ? null : args.decision.duplicateOf === session,
    size: args.size,
  };
}
