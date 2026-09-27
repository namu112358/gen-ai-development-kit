import { AREA_PREFIX, areaLabels } from './classify.ts';
import { describeFullAreas, fullAreas } from './concurrency.ts';
import { LABELS, priorityRank, type HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import type { IssueFacts, PrFacts } from './queue.ts';

/**
 * fleet（付き添いのセッションで複数の Issue を並行して進める）の段階の判定と選び方。GitHub から集めた事実だけを入力にする純粋関数。
 * 状態は毎回 GitHub から読み直すので、途中で止まっても同じ手順で続きから再開できる。
 */

/** Issue を Closes する PR（開いたもの・Merge 済みのもの） */
export interface FleetPr {
  number: number;
  merged: boolean;
  draft: boolean;
  /** App が auto-merge を付けた */
  autoMerge: boolean;
  /** App の `kind=human-review` のコメントがある */
  humanReview: boolean;
  /** main に、PR の head に無い commit がある */
  behindMain: boolean;
  /** 開いた PR の事実（facts.ts の prFacts）。Merge 済みなら null */
  facts: PrFacts | null;
}

export interface FleetIssue {
  facts: IssueFacts;
  /** Issue が Close 済み */
  closed: boolean;
  /** 計画ゲートの記録の計画の files。記録が無ければ null（領域・重なりが分からない） */
  planFiles: string[] | null;
  prs: FleetPr[];
}

export interface FleetFacts {
  issues: FleetIssue[];
  /** 同じリポジトリの開いた PR のラベル（領域の上限に数える） */
  openPrLabels: string[][];
}

export const FLEET_STAGES = {
  'no-plan': '計画なし',
  'plan-gate': '計画ゲート待ち',
  'plan-review': 'plan-review',
  'plan-ok': 'plan-ok（実装待ち）',
  judge: '判定待ち',
  fix: '修正待ち',
  'human-merge': 'Ready・人の Merge 待ち',
  'auto-merge': '自動 Merge 待ち',
  merged: 'Merge 済み',
  stopped: '止まる印あり',
} as const;

export type FleetStage = keyof typeof FLEET_STAGES;
export type FleetNext = 'plan' | 'implement' | 'judge' | 'fix' | 'sync' | 'none';

export interface FleetRow {
  issue: number;
  title: string;
  stage: FleetStage;
  next: FleetNext;
  /** 開いた PR（Merge 済みなら Merge された PR） */
  pr: number | null;
  note: string | null;
}

const STOP_LABELS = [LABELS.hold, LABELS.blocked, LABELS.waiting];
/** 人の判断か人の Merge を待つ段階（fleet の終わりの状態） */
export const WAITING_FOR_HUMAN: FleetStage[] = ['plan-review', 'human-merge', 'auto-merge', 'stopped'];

type Stage = Omit<FleetRow, 'issue' | 'title'>;

function prStage(p: FleetPr, anyMerged: boolean): Stage {
  const f = p.facts!;
  const stop = [LABELS.hold, LABELS.blocked].find((l) => f.labels.includes(l));
  if (stop) return { stage: 'stopped', next: 'none', pr: p.number, note: `PR に \`${stop}\`` };
  const acc = f.acceptance;
  let s: Stage;
  if (f.humanFeedbackSincePush > 0) s = { stage: 'fix', next: 'fix', pr: p.number, note: '人のレビューがある' };
  else if (acc?.reviewPass && p.autoMerge) s = { stage: 'auto-merge', next: 'none', pr: p.number, note: null };
  else if (acc?.reviewPass && p.humanReview && !p.draft) s = { stage: 'human-merge', next: 'none', pr: p.number, note: null };
  else if (acc && !acc.reviewPass) s = { stage: 'fix', next: 'fix', pr: p.number, note: 'ブロッキング指摘' };
  else if (acc) s = { stage: 'judge', next: 'none', pr: p.number, note: '合格。App の Merge 経路（auto-merge か kind=human-review）待ち' };
  else if (f.verdictAwaitingGate) s = { stage: 'judge', next: 'none', pr: p.number, note: '判定の受け付け待ち' };
  else s = { stage: 'judge', next: 'judge', pr: p.number, note: null };
  // 衝突や main の追従は何より先にする（衝突していると CI も判定の反映も進まない）
  if (f.conflicted) s = { ...s, next: 'sync', note: 'main と衝突' };
  else if (anyMerged && p.behindMain) s = { ...s, next: 'sync', note: 'Merge 済みの PR があり、main に追従していない' };
  // 人の PR は修正・取り込みを人が行う
  if (!f.agent && (s.next === 'fix' || s.next === 'sync')) s = { ...s, next: 'none', note: `人の PR（${s.next} は人が行う）` };
  return s;
}

function issueStage(i: FleetIssue, anyMerged: boolean): Stage {
  const f = i.facts;
  const merged = i.prs.find((p) => p.merged);
  if (merged || i.closed) return { stage: 'merged', next: 'none', pr: merged?.number ?? null, note: merged ? null : 'Issue は Close 済み' };
  const open = i.prs.find((p) => !p.merged && p.facts !== null);
  const stop = STOP_LABELS.find((l) => f.labels.includes(l));
  if (stop) return { stage: 'stopped', next: 'none', pr: open?.number ?? null, note: `\`${stop}\`` };
  if (f.labels.includes(LABELS.epic)) return { stage: 'stopped', next: 'none', pr: null, note: 'Epic（子課題で進める）' };
  if (open) return prStage(open, anyMerged);
  if (f.openBlockers.length > 0) return { stage: 'stopped', next: 'none', pr: null, note: `依存 ${f.openBlockers.map((b) => `#${b}`).join(', ')} が未解決` };
  if (f.labels.includes(LABELS.planReview)) return { stage: 'plan-review', next: 'none', pr: null, note: '人が進めると決めれば implement' };
  const pending = f.latestPlanAt !== null && (f.gate === null || f.gate.at < f.latestPlanAt);
  if (pending) return { stage: 'plan-gate', next: 'none', pr: null, note: null };
  if (f.gate === null) return { stage: 'no-plan', next: 'plan', pr: null, note: null };
  if (!f.gate.pass) return { stage: 'plan-review', next: 'none', pr: null, note: '計画ゲートで停止中' };
  if (!f.labels.includes(LABELS.planOk) || !f.planOkByApp) return { stage: 'plan-gate', next: 'none', pr: null, note: '`agent:plan-ok` が App によって付けられていません' };
  return { stage: 'plan-ok', next: 'implement', pr: null, note: null };
}

/** Issue ごとの段階と次にやること。Merge 済みの Issue があれば、main に追従していない残りの PR の次にやることを sync にする */
export function fleetStatus(facts: FleetFacts): FleetRow[] {
  const anyMerged = facts.issues.some((i) => i.prs.some((p) => p.merged));
  return facts.issues.map((i) => ({ issue: i.facts.number, title: i.facts.title, ...issueStage(i, anyMerged) }));
}

export interface FleetSelection {
  selected: number[];
  /** 選ばなかった Issue と理由 */
  excluded: Map<number, string>;
  /** 領域ごとの上限：開いた PR の数・この実行で選んだ（PR がまだ無い）Issue の数・上限 */
  areas: { area: string; open: number; selected: number; limit: number }[];
  /** 触るファイル（計画の files）が重なる Issue の組 */
  overlaps: Map<number, number[]>;
}

function filesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => patternsOverlap(x, y)));
}

/**
 * 並行して進める Issue を選ぶ。PR のある Issue（既に進めているもの）を先に、残りを優先度 → agent:ready が付いた順に、
 * 止まる印・依存・ほかのセッションの着手宣言のあるものを除いて、人が1回にさばける数（max）まで選ぶ。
 * PR がまだ無い Issue は、計画の files の領域が上限（開いた PR ＋ この実行で既に選んだ Issue）に達していれば選ばず、
 * 既に選んだ Issue や PR 段階・実装中の Issue と計画の files が重なれば選ばない（重なりのため待つ）。
 * 計画の無い Issue は領域・重なりが分からないので、その判定から外して選ぶ（計画の後に重なれば、後から選んだほうが待つ）。
 */
export function selectFleet(config: HarnessConfig, facts: FleetFacts, rows: FleetRow[], max: number): FleetSelection {
  const byNumber = new Map(facts.issues.map((i) => [i.facts.number, i]));
  const rowOf = new Map(rows.map((r) => [r.issue, r]));
  const inFlight = (r: FleetRow): boolean => r.pr !== null && r.stage !== 'merged';
  const order = [...rows].sort((a, b) => {
    const fa = byNumber.get(a.issue)!.facts;
    const fb = byNumber.get(b.issue)!.facts;
    return Number(inFlight(b)) - Number(inFlight(a)) || priorityRank(fa.labels) - priorityRank(fb.labels) || (fa.readyAt ?? '9999').localeCompare(fb.readyAt ?? '9999') || a.issue - b.issue;
  });

  // 重なりの相手：選んだ Issue と、PR 段階・実装中（着手宣言あり）の Issue
  const busy = facts.issues.filter((i) => {
    const r = rowOf.get(i.facts.number);
    return r !== undefined && r.stage !== 'merged' && (inFlight(r) || i.facts.claim !== null);
  });
  const selected: FleetIssue[] = [];
  const newAreaLabels: string[][] = [];
  const excluded = new Map<number, string>();

  for (const r of order) {
    const i = byNumber.get(r.issue)!;
    if (r.stage === 'merged') { excluded.set(r.issue, 'Merge 済み'); continue; }
    if (r.stage === 'stopped') { excluded.set(r.issue, r.note ?? '止まる印あり'); continue; }
    if (!inFlight(r) && i.facts.claim !== null) { excluded.set(r.issue, '着手宣言あり（ほかのセッションが着手中）'); continue; }
    if (selected.length >= max) { excluded.set(r.issue, `人が1回にさばける数（${max}）に達した`); continue; }
    if (!inFlight(r) && i.planFiles !== null) {
      const full = fullAreas(config, i.planFiles, [...facts.openPrLabels, ...newAreaLabels]);
      if (full.length > 0) { excluded.set(r.issue, `${describeFullAreas(full)}（この実行で選んだ分を含む）`); continue; }
      const others = [...selected, ...busy].filter((o) => o.facts.number !== r.issue && o.planFiles !== null);
      const hit = others.find((o) => filesOverlap(i.planFiles!, o.planFiles!));
      if (hit) { excluded.set(r.issue, `#${hit.facts.number} と触るファイルが重なるため待つ`); continue; }
    }
    selected.push(i);
    if (!inFlight(r) && i.planFiles !== null) newAreaLabels.push(areaLabels(config, i.planFiles));
  }

  const areas = Object.entries(config.areaConcurrency ?? {}).map(([area, limit]) => {
    const label = `${AREA_PREFIX}${area}`;
    return {
      area,
      open: facts.openPrLabels.filter((l) => l.includes(label)).length,
      selected: newAreaLabels.filter((l) => l.includes(label)).length,
      limit,
    };
  });

  const overlaps = new Map<number, number[]>();
  for (const a of facts.issues) {
    if (a.planFiles === null || rowOf.get(a.facts.number)?.stage === 'merged') continue;
    const hits = facts.issues.filter((b) => b !== a && b.planFiles !== null && rowOf.get(b.facts.number)?.stage !== 'merged' && filesOverlap(a.planFiles!, b.planFiles!));
    if (hits.length > 0) overlaps.set(a.facts.number, hits.map((b) => b.facts.number));
  }

  return { selected: selected.map((i) => i.facts.number), excluded, areas, overlaps };
}

const NEXT_LABELS: Record<FleetNext, string> = { plan: 'plan', implement: 'implement', judge: 'judge', fix: 'fix', sync: 'sync', none: '—' };

/** fleet-status の表（Markdown） */
export function renderFleetStatus(rows: FleetRow[], sel: FleetSelection, max: number): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const lines = [
    '| Issue | PR | 段階 | 次にやること | 選択 | 重なり | メモ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const sorted = [...rows].sort((a, b) => Number(sel.selected.includes(b.issue)) - Number(sel.selected.includes(a.issue)) || sel.selected.indexOf(a.issue) - sel.selected.indexOf(b.issue) || a.issue - b.issue);
  for (const r of sorted) {
    const chosen = sel.selected.includes(r.issue) ? '選ぶ' : `待つ：${sel.excluded.get(r.issue) ?? ''}`;
    const overlap = (sel.overlaps.get(r.issue) ?? []).map((n) => `#${n}`).join(', ') || '—';
    lines.push(`| #${r.issue} ${cell(r.title)} | ${r.pr === null ? '—' : `#${r.pr}`} | ${FLEET_STAGES[r.stage]} | ${NEXT_LABELS[r.next]} | ${cell(chosen)} | ${overlap} | ${cell(r.note ?? '')} |`);
  }
  lines.push('', `選んだ数：${sel.selected.length}/${max}（人が1回にさばける数。--max で変える）`);
  if (sel.areas.length > 0) {
    lines.push('', '| 領域 | 開いた PR | この実行で選んだ（PR なし） | 上限 |', '| --- | --- | --- | --- |');
    for (const a of sel.areas) lines.push(`| \`${AREA_PREFIX}${a.area}\` | ${a.open} | ${a.selected} | ${a.limit} |`);
  }
  return lines.join('\n');
}
