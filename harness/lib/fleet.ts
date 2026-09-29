import { appLogin, LABELS, priorityRank, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import { describeClaim, isOwnClaim, type Claim, type IssueFacts, type PrFacts } from './queue.ts';

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

/** fleet-status が番号なしで集める Issue の一覧の1件（/issues の応答の一部） */
export interface FleetTargetItem {
  number: number;
  title: string;
  labels: { name: string }[];
  pull_request?: unknown;
  user?: { login: string } | null;
  author_association?: string;
}

const TARGET_LABELS: string[] = [LABELS.ready, LABELS.planOk, LABELS.planReview];

/**
 * fleet-status が番号なしのときの対象。PR とダッシュボードの Issue を除き、
 * agent:ready・agent:plan-ok・agent:plan-review のどれかが付いた Issue（作成者は問わない。ラベルを付けたのが書き込み権限のある人）と、
 * agent: のラベルが1つも無く、作成者がコラボレーター（TRUSTED_ASSOCIATIONS）か App（Epic の子課題など）の Issue（作ったまま計画に進んでいないもの）を、元の順に返す。
 * コラボレーター以外が立てたラベルの無い Issue は対象にしない（人が進めると決めた印が無いため）
 */
export function fleetTargets<T extends FleetTargetItem>(items: T[], config: HarnessConfig): T[] {
  return items.filter((i) => {
    if (i.pull_request) return false;
    if (i.title === config.dashboardIssueTitle && i.user?.login === appLogin(config)) return false;
    const names = i.labels.map((l) => l.name);
    if (names.some((n) => TARGET_LABELS.includes(n))) return true;
    // App が作った Issue（Epic の子課題など）は GitHub 上 CONTRIBUTOR になるが、信頼できる印を付ける側なので含める
    return !names.some((n) => n.startsWith('agent:')) && (TRUSTED_ASSOCIATIONS.has(i.author_association ?? '') || i.user?.login === appLogin(config));
  });
}

/** git merge-tree で試して衝突した（または試せなかった）PR の組 */
export interface PrConflict {
  /** PR 番号の組 */
  prs: [number, number];
  /** 試せなかった（git が古い・fetch に失敗したなど）ため、衝突ありとして扱った */
  untested: boolean;
}

export interface FleetFacts {
  issues: FleetIssue[];
  /** fleet の Issue の開いた PR 同士のうち、衝突する（または試せなかった）組 */
  prConflicts: PrConflict[];
}

/** `git merge-tree --write-tree` の終了コードの解釈。0＝衝突なし、1＝衝突、それ以外（git が 2.38 未満・head が無いなど）＝試せなかった */
export function mergeTreeResult(status: number | null): 'clean' | 'conflict' | 'untested' {
  if (status === 0) return 'clean';
  if (status === 1) return 'conflict';
  return 'untested';
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
  /** 重なる Issue の組。両方に PR があれば実際に衝突する組、そうでなければ触るファイル（計画の files）が重なる組 */
  overlaps: Map<number, number[]>;
  /** 表のメモの列に足す文（衝突を試せなかった組など） */
  notes: Map<number, string>;
}

/** 行の PR（issueStage が選んだ開いた PR）の着手宣言。PR の事実が無ければ null */
function openPrClaim(i: FleetIssue, r: FleetRow): Claim | null {
  return i.prs.find((p) => p.number === r.pr && !p.merged)?.facts?.claim ?? null;
}

function filesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => patternsOverlap(x, y)));
}

/**
 * 並行して進める Issue を選ぶ。PR のある Issue（既に進めているもの）を先に、残りを優先度 → agent:ready が付いた順（agent:ready の無い Issue はその後）に、
 * 止まる印・依存・ほかのセッションの着手宣言（PR の無い Issue は Issue の宣言、PR のある Issue はその行の PR の宣言。currentSession と同じ session の手動の宣言は自分のもの）のあるものを除いて、衝突しない範囲で選ぶ。本数は max（--max）を渡したときだけ制限する。
 * 重なりの相手にする着手宣言は、ほかのセッションの解除されていない宣言と、このセッションの実装中（段階 implement）の宣言だけ。
 * このセッションのほかの段階（plan・plan-gate など）の宣言どうしは並び順の先の側を選ぶ（互いを相手にして両方とも待たないため）。
 * 領域の上限（areaConcurrency）は見ない（config は呼び出しの形を保つために受け取るだけ）。
 * 両方に PR がある組は、実際に試して衝突した組（prConflicts）だけ、既に選んだ PR と衝突する後の側が待つ。
 * PR がまだ無い Issue は、既に選んだ Issue や PR 段階・実装中の Issue と計画の files が重なれば選ばない（重なりのため待つ）。
 * 計画の無い Issue は重なりが分からないので、その判定から外して選ぶ（計画の後に重なれば、後から選んだほうが待つ）。
 */
export function selectFleet(_config: HarnessConfig, facts: FleetFacts, rows: FleetRow[], max: number | null, currentSession: string | null = null): FleetSelection {
  const byNumber = new Map(facts.issues.map((i) => [i.facts.number, i]));
  const rowOf = new Map(rows.map((r) => [r.issue, r]));
  const inFlight = (r: FleetRow): boolean => r.pr !== null && r.stage !== 'merged';
  const order = [...rows].sort((a, b) => {
    const fa = byNumber.get(a.issue)!.facts;
    const fb = byNumber.get(b.issue)!.facts;
    return Number(inFlight(b)) - Number(inFlight(a)) || priorityRank(fa.labels) - priorityRank(fb.labels) || (fa.readyAt ?? '9999').localeCompare(fb.readyAt ?? '9999') || a.issue - b.issue;
  });

  // 重なりの相手：選んだ Issue と、PR 段階の Issue と、ほかのセッションの宣言かこのセッションの実装中の宣言がある Issue
  const claimedBusy = (c: Claim | null): boolean => c !== null && !c.released && (!isOwnClaim(c, currentSession) || c.stage === 'implement');
  const busy = facts.issues.filter((i) => {
    const r = rowOf.get(i.facts.number);
    return r !== undefined && r.stage !== 'merged' && (inFlight(r) || claimedBusy(i.facts.claim));
  });
  const openPrOf = (i: FleetIssue): number | null => {
    const r = rowOf.get(i.facts.number);
    return r !== undefined && inFlight(r) ? r.pr : null;
  };
  const conflictOf = (a: number, b: number): PrConflict | undefined =>
    facts.prConflicts.find((c) => (c.prs[0] === a && c.prs[1] === b) || (c.prs[0] === b && c.prs[1] === a));
  const selected: FleetIssue[] = [];
  const excluded = new Map<number, string>();

  for (const r of order) {
    const i = byNumber.get(r.issue)!;
    if (r.stage === 'merged') { excluded.set(r.issue, 'Merge 済み'); continue; }
    if (r.stage === 'stopped') { excluded.set(r.issue, r.note ?? '止まる印あり'); continue; }
    // PR の無い段階は Issue の宣言、PR の段階はその行の PR の宣言（claim <PR番号> --stage judge|fix|sync）を見る
    const claim = inFlight(r) ? openPrClaim(i, r) : i.facts.claim;
    if (claim && !claim.released && !isOwnClaim(claim, currentSession)) {
      const detail = describeClaim(claim);
      excluded.set(r.issue, `着手宣言あり（ほかのセッションが着手中${detail ? `・${detail}` : ''}）`);
      continue;
    }
    if (max !== null && selected.length >= max) { excluded.set(r.issue, `--max で指定した、人が1回にさばける数（${max}）に達した`); continue; }
    const pr = openPrOf(i);
    if (pr !== null) {
      // 衝突を見る相手は既に選んだ PR だけ（待つ側とだけ衝突する PR は選ぶ）
      const hit = selected.find((o) => { const q = openPrOf(o); return q !== null && conflictOf(pr, q) !== undefined; });
      if (hit) { excluded.set(r.issue, `#${hit.facts.number} と衝突するため待つ（先に Merge された側に合わせて sync）`); continue; }
    } else if (i.planFiles !== null) {
      const others = [...selected, ...busy].filter((o) => o.facts.number !== r.issue && o.planFiles !== null);
      const hit = others.find((o) => filesOverlap(i.planFiles!, o.planFiles!));
      if (hit) { excluded.set(r.issue, `#${hit.facts.number} と触るファイルが重なるため待つ`); continue; }
    }
    selected.push(i);
  }

  // 重なり：PR 同士は実際に衝突する組だけ、PR が無い Issue が絡む組は計画の files の重なり
  const live = facts.issues.filter((i) => rowOf.get(i.facts.number)?.stage !== 'merged');
  const overlaps = new Map<number, number[]>();
  const notes = new Map<number, string>();
  for (const a of live) {
    const pa = openPrOf(a);
    const hits = live.filter((b) => {
      if (b === a) return false;
      const pb = openPrOf(b);
      if (pa !== null && pb !== null) return conflictOf(pa, pb) !== undefined;
      return a.planFiles !== null && b.planFiles !== null && filesOverlap(a.planFiles, b.planFiles);
    });
    if (hits.length > 0) overlaps.set(a.facts.number, hits.map((b) => b.facts.number));
    const untested = pa === null ? [] : live.filter((b) => { const pb = openPrOf(b); return b !== a && pb !== null && conflictOf(pa, pb)?.untested === true; });
    const noteParts: string[] = [];
    if (untested.length > 0) noteParts.push(`${untested.map((b) => `#${b.facts.number}`).join(', ')} との衝突は試せなかったため衝突ありとして扱う`);
    // 着手宣言の段階（自分の宣言も、ほかのセッションの宣言も）
    const claim = a.facts.claim;
    if (claim && !claim.released) noteParts.push(`着手宣言${isOwnClaim(claim, currentSession) ? '（このセッション）' : ''}${describeClaim(claim) ? `：${describeClaim(claim)}` : ''}`);
    const ar = rowOf.get(a.facts.number);
    const prClaim = ar !== undefined && inFlight(ar) ? openPrClaim(a, ar) : null;
    if (prClaim && !prClaim.released) noteParts.push(`PR の着手宣言${isOwnClaim(prClaim, currentSession) ? '（このセッション）' : ''}${describeClaim(prClaim) ? `：${describeClaim(prClaim)}` : ''}`);
    if (noteParts.length > 0) notes.set(a.facts.number, noteParts.join('。'));
  }

  return { selected: selected.map((i) => i.facts.number), excluded, overlaps, notes };
}

const NEXT_LABELS: Record<FleetNext, string> = { plan: 'plan', implement: 'implement', judge: 'judge', fix: 'fix', sync: 'sync', none: '—' };

/**
 * fleet-status の表（Markdown）。mode（fleetConfig）を渡すと、末尾に進め方の行を足す。
 * 入れ子（orca）で同時に動かす ship の数は、--max があれば --max、無ければ maxParallelShips
 */
export function renderFleetStatus(rows: FleetRow[], sel: FleetSelection, max: number | null, mode?: { nesting: 'orca' | 'flat'; maxParallelShips: number }): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const lines = [
    '| Issue | PR | 段階 | 次にやること | 選択 | 重なり | メモ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const sorted = [...rows].sort((a, b) => Number(sel.selected.includes(b.issue)) - Number(sel.selected.includes(a.issue)) || sel.selected.indexOf(a.issue) - sel.selected.indexOf(b.issue) || a.issue - b.issue);
  for (const r of sorted) {
    const chosen = sel.selected.includes(r.issue) ? '選ぶ' : `待つ：${sel.excluded.get(r.issue) ?? ''}`;
    const overlap = (sel.overlaps.get(r.issue) ?? []).map((n) => `#${n}`).join(', ') || '—';
    const note = [r.note, sel.notes.get(r.issue)].filter((x) => x).join('。');
    lines.push(`| #${r.issue} ${cell(r.title)} | ${r.pr === null ? '—' : `#${r.pr}`} | ${FLEET_STAGES[r.stage]} | ${NEXT_LABELS[r.next]} | ${cell(chosen)} | ${overlap} | ${cell(note)} |`);
  }
  lines.push('', max === null ? `選んだ数：${sel.selected.length}（衝突しない範囲で本数を制限しない。絞るときは --max）` : `選んだ数：${sel.selected.length}/${max}（--max で指定した本数）`);
  if (mode) {
    lines.push(mode.nesting === 'orca'
      ? `進め方：入れ子（orca）。ship をサブエージェントで並行に動かす。同時に動かす ship は ${max ?? mode.maxParallelShips} まで`
      : '進め方：交互（flat）。1つのセッションで段階を交互に進める');
  }
  return lines.join('\n');
}
