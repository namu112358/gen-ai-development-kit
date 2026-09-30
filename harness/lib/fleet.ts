import { assigneeExclusion, requireAssignee } from './assignee.ts';
import { appLogin, LABELS, priorityRank, TRUSTED_ASSOCIATIONS, type HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import { fleetStageOf, stepOf, type FlowFleetStage, type FlowNodeId, type FlowStep, type FlowStopLabel } from './flow.ts';
import { globToRegExp } from './scope.ts';
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
  /** Issue の Assignee の login（requireAssignee が true のときだけ見る。無ければ誰もいないとみなす） */
  assignees?: string[];
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
} as const satisfies Record<FlowFleetStage, string>;

export type FleetStage = keyof typeof FLEET_STAGES;
/** 次にやること（段階のグラフ flow.ts の FlowStep） */
export type FleetNext = FlowStep;

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

/** fleet の表に段階として出るノード（作業中のノードと、next だけを上書きする sync は除く） */
export type StageNode = Exclude<FlowNodeId, 'plan' | 'plan-critique' | 'implement' | 'sync'>;

/** 段階のグラフ（flow.ts）のノードから、fleet の段階と次にやることを引く */
function at(node: StageNode, pr: number | null, note: string | null): Stage {
  return { stage: fleetStageOf(node), next: stepOf(node), pr, note };
}

/**
 * Issue の今のノード（issueNode の結果）。fleet の表（issueStage）と agent.ts step（harness/lib/step.ts）が同じ判断を使う（Issue #306）。
 * sync：衝突・main の追従で、段階は残して次にやることを sync にする。
 * humanPr：人の PR で、次にやることが fix・sync になる（人が行うので、fleet は none・step は人を待つ）。
 * stopReason：node が stopped のときの理由（ラベル・Epic・依存）。
 */
export interface IssueNode {
  node: StageNode;
  pr: number | null;
  note: string | null;
  sync: boolean;
  humanPr: boolean;
  stopReason: FlowStopLabel | null;
}

const node = (n: StageNode, pr: number | null, note: string | null, stopReason: FlowStopLabel | null = null): IssueNode => ({ node: n, pr, note, sync: false, humanPr: false, stopReason });

function prNode(p: FleetPr, anyMerged: boolean): IssueNode {
  const f = p.facts!;
  const stop = ([LABELS.hold, LABELS.blocked] as const).find((l) => f.labels.includes(l));
  if (stop) return node('stopped', p.number, `PR に \`${stop}\``, stop === LABELS.hold ? 'hold' : 'blocked');
  const acc = f.acceptance;
  let s: IssueNode;
  if (f.humanFeedbackSincePush > 0) s = node('fix', p.number, '人のレビューがある');
  else if (acc?.reviewPass && p.autoMerge) s = node('auto-merge', p.number, null);
  else if (acc?.reviewPass && p.humanReview && !p.draft) s = node('human-merge', p.number, null);
  else if (acc && !acc.reviewPass) s = node('fix', p.number, 'ブロッキング指摘');
  else if (acc) s = node('merge-route-pending', p.number, '合格。App の Merge 経路（auto-merge か kind=human-review）待ち');
  else if (f.verdictAwaitingGate) s = node('verdict-pending', p.number, '判定の受け付け待ち');
  else s = node('judge', p.number, null);
  // 衝突や main の追従は何より先にする（衝突していると CI も判定の反映も進まない）。段階は残し、次にやることだけ sync にする
  if (f.conflicted) s = { ...s, sync: true, note: 'main と衝突' };
  else if (anyMerged && p.behindMain) s = { ...s, sync: true, note: 'Merge 済みの PR があり、main に追従していない' };
  // 人の PR は修正・取り込みを人が行う
  const next = s.sync ? stepOf('sync') : stepOf(s.node);
  if (!f.agent && (next === stepOf('fix') || next === stepOf('sync'))) s = { ...s, humanPr: true, note: `人の PR（${next} は人が行う）` };
  return s;
}

const STOP_REASON: Record<string, FlowStopLabel> = { [LABELS.hold]: 'hold', [LABELS.blocked]: 'blocked', [LABELS.waiting]: 'waiting' };

/** Issue の今のノード。anyMerged は、同じ集合に Merge 済みの PR があるか（あれば main に追従していない PR を sync にする） */
export function issueNode(i: FleetIssue, anyMerged: boolean): IssueNode {
  const f = i.facts;
  const merged = i.prs.find((p) => p.merged);
  if (merged || i.closed) return node('merged', merged?.number ?? null, merged ? null : 'Issue は Close 済み');
  const open = i.prs.find((p) => !p.merged && p.facts !== null);
  const stop = STOP_LABELS.find((l) => f.labels.includes(l));
  if (stop) return node('stopped', open?.number ?? null, `\`${stop}\``, STOP_REASON[stop]!);
  if (f.labels.includes(LABELS.epic)) return node('stopped', null, 'Epic（子課題で進める）', 'epic');
  if (open) return prNode(open, anyMerged);
  if (f.openBlockers.length > 0) return node('stopped', null, `依存 ${f.openBlockers.map((b) => `#${b}`).join(', ')} が未解決`, 'dependency');
  if (f.labels.includes(LABELS.planReview)) return node('plan-review', null, '人が進めると決めれば implement');
  const pending = f.latestPlanAt !== null && (f.gate === null || f.gate.at < f.latestPlanAt);
  if (pending) return node('plan-gate', null, null);
  if (f.gate === null) return node('issue', null, null);
  if (!f.gate.pass) return node('plan-review', null, '計画ゲートで停止中');
  if (!f.labels.includes(LABELS.planOk) || !f.planOkByApp) return node('plan-gate', null, '`agent:plan-ok` が App によって付けられていません');
  return node('plan-ok', null, null);
}

/** issueNode の結果を fleet の表の段階と次にやることにする（sync は段階を残して次にやることだけ sync、人の PR の fix・sync は none） */
function issueStage(i: FleetIssue, anyMerged: boolean): Stage {
  const n = issueNode(i, anyMerged);
  const s = at(n.node, n.pr, n.note);
  if (n.humanPr) return { ...s, next: 'none' };
  return n.sync ? { ...s, next: stepOf('sync') } : s;
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
  /** 重なる Issue の組。両方に PR があれば実際に衝突する組、そうでなければ触るファイル（計画の files）が重なる組。共有ファイルだけの重なり（sharedOnlyOverlaps）は含まない */
  overlaps: Map<number, number[]>;
  /** overlaps には出さない、共有ファイル（fleet.sharedFiles）だけで重なる組（除外はしないが表には残す） */
  sharedOnlyOverlaps: Map<number, number[]>;
  /** 表のメモの列に足す文（衝突を試せなかった組など） */
  notes: Map<number, string>;
}

/** 行の PR（issueStage が選んだ開いた PR）の着手宣言。PR の事実が無ければ null */
function openPrClaim(i: FleetIssue, r: FleetRow): Claim | null {
  return i.prs.find((p) => p.number === r.pr && !p.merged)?.facts?.claim ?? null;
}

/** file が共有ファイルのパターンに完全に収まるか（片方向の判定）。file 自身がワイルドカードを含むときは、
 *  共有ファイル以外も広く含みうるので false（＝重なれば blocking 側）にする */
function isSharedPath(file: string, sharedFiles: string[]): boolean {
  if (file.includes('*')) return false;
  return sharedFiles.some((p) => globToRegExp(p).test(file));
}

/** a・b の重なりの種類。重なる項目が無ければ 'none'、重なる項目のうち1つでも両側とも共有ファイルでなければ 'blocking'、
 *  重なる項目がすべて両側とも共有ファイルなら 'shared-only'（除外はしないが表に残す）。重なりの有無は patternsOverlap（疑わしければ重なりとする）で見る */
function overlapKind(a: string[], b: string[], sharedFiles: string[]): 'none' | 'blocking' | 'shared-only' {
  let sawOverlap = false;
  for (const x of a) {
    for (const y of b) {
      if (!patternsOverlap(x, y)) continue;
      sawOverlap = true;
      if (!(isSharedPath(x, sharedFiles) && isSharedPath(y, sharedFiles))) return 'blocking';
    }
  }
  return sawOverlap ? 'shared-only' : 'none';
}

/**
 * 並行して進める Issue を選ぶ。PR のある Issue（既に進めているもの）を先に、残りを優先度 → agent:ready が付いた順（agent:ready の無い Issue はその後）に、
 * 止まる印・依存・ほかのセッションの着手宣言（PR の無い Issue は Issue の宣言、PR のある Issue はその行の PR の宣言。currentSession と同じ session の手動の宣言は自分のもの）のあるものを除いて、衝突しない範囲で選ぶ。本数は max（--max）を渡したときだけ制限する。
 * 重なりの相手にする着手宣言は、ほかのセッションの解除されていない宣言と、このセッションの実装中（段階 implement）の宣言だけ。
 * このセッションのほかの段階（plan・plan-gate など）の宣言どうしは並び順の先の側を選ぶ（互いを相手にして両方とも待たないため）。
 * requireAssignee が true なら、Assignee が自分（me）1人でない Issue を理由付きで外す（PR の段階も Issue の Assignee で見る。Issue #172）。
 * 領域の上限（areaConcurrency）は見ない。config.fleet?.sharedFiles は、計画の files が重なるかの判定でだけ使う（共有ファイルだけの重なりでは待たない）。
 * 両方に PR がある組は、実際に試して衝突した組（prConflicts）だけ、既に選んだ PR と衝突する後の側が待つ。
 * PR がまだ無い Issue は、既に選んだ Issue や PR 段階・実装中の Issue と計画の files が重なれば選ばない（重なりのため待つ）。
 * 既に選んだ Issue のうち段階が plan-review（人の判断待ち）のものは、この重なりの相手にしない（今は進まないので、進められる Issue を待たせない。Issue #312）。人が進めると決めて段階が変われば、読み直した表で相手になる。
 * 計画の無い Issue は重なりが分からないので、その判定から外して選ぶ（計画の後に重なれば、後から選んだほうが待つ）。
 */
export function selectFleet(config: HarnessConfig, facts: FleetFacts, rows: FleetRow[], max: number | null, currentSession: string | null = null, me: string | null = null): FleetSelection {
  const checkAssignee = requireAssignee(config);
  const sharedFiles = config.fleet?.sharedFiles ?? [];
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
    const notMine = checkAssignee ? assigneeExclusion(i.assignees ?? [], me) : null;
    if (notMine) { excluded.set(r.issue, notMine); continue; }
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
      const movable = selected.filter((o) => rowOf.get(o.facts.number)?.stage !== 'plan-review');
      const others = [...movable, ...busy].filter((o) => o.facts.number !== r.issue && o.planFiles !== null);
      const hit = others.find((o) => overlapKind(i.planFiles!, o.planFiles!, sharedFiles) === 'blocking');
      if (hit) { excluded.set(r.issue, `#${hit.facts.number} と触るファイルが重なるため待つ`); continue; }
    }
    selected.push(i);
  }

  // 重なり：PR 同士は実際に衝突する組だけ、PR が無い Issue が絡む組は計画の files の重なり
  const live = facts.issues.filter((i) => rowOf.get(i.facts.number)?.stage !== 'merged');
  const overlaps = new Map<number, number[]>();
  const sharedOnlyOverlaps = new Map<number, number[]>();
  const notes = new Map<number, string>();
  for (const a of live) {
    const pa = openPrOf(a);
    const hits: number[] = [];
    const sharedHits: number[] = [];
    for (const b of live) {
      if (b === a) continue;
      const pb = openPrOf(b);
      if (pa !== null && pb !== null) {
        if (conflictOf(pa, pb) !== undefined) hits.push(b.facts.number);
        continue;
      }
      if (a.planFiles === null || b.planFiles === null) continue;
      const kind = overlapKind(a.planFiles, b.planFiles, sharedFiles);
      if (kind === 'blocking') hits.push(b.facts.number);
      else if (kind === 'shared-only') sharedHits.push(b.facts.number);
    }
    if (hits.length > 0) overlaps.set(a.facts.number, hits);
    if (sharedHits.length > 0) sharedOnlyOverlaps.set(a.facts.number, sharedHits);
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

  return { selected: selected.map((i) => i.facts.number), excluded, overlaps, sharedOnlyOverlaps, notes };
}

const NEXT_LABELS: Record<FleetNext, string> = { plan: 'plan', implement: 'implement', judge: 'judge', fix: 'fix', sync: 'sync', none: '—' };

type FleetMode = { nesting: 'orca' | 'flat'; maxParallelShips: number };

/** 表と JSON の行の並び順（選んだものを選んだ順に先、残りは Issue 番号順） */
function sortedRows(rows: FleetRow[], sel: FleetSelection): FleetRow[] {
  return [...rows].sort((a, b) => Number(sel.selected.includes(b.issue)) - Number(sel.selected.includes(a.issue)) || sel.selected.indexOf(a.issue) - sel.selected.indexOf(b.issue) || a.issue - b.issue);
}

/** 行ごとの選択・待つ理由・重なり・メモ（表と JSON が同じ判断から作るための共通部分） */
function rowView(r: FleetRow, sel: FleetSelection): { selected: boolean; waitReason: string; overlaps: number[]; sharedOnlyOverlaps: number[]; note: string } {
  return {
    selected: sel.selected.includes(r.issue),
    waitReason: sel.excluded.get(r.issue) ?? '',
    overlaps: [...(sel.overlaps.get(r.issue) ?? [])],
    sharedOnlyOverlaps: [...(sel.sharedOnlyOverlaps.get(r.issue) ?? [])],
    note: [r.note, sel.notes.get(r.issue)].filter((x) => x).join('。'),
  };
}

/** 入れ子のときに同時に動かす ship の数。--max があれば --max、無ければ maxParallelShips */
const parallelShips = (max: number | null, mode: FleetMode): number => max ?? mode.maxParallelShips;

/**
 * fleet-status の表（Markdown）。mode（fleetConfig）を渡すと、末尾に進め方の行を足す。
 * 入れ子（orca）で同時に動かす ship の数は、--max があれば --max、無ければ maxParallelShips
 */
export function renderFleetStatus(rows: FleetRow[], sel: FleetSelection, max: number | null, mode?: FleetMode): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const lines = [
    '| Issue | PR | 段階 | 次にやること | 選択 | 重なり | メモ |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of sortedRows(rows, sel)) {
    const v = rowView(r, sel);
    const chosen = v.selected ? '選ぶ' : `待つ：${v.waitReason}`;
    const blocking = v.overlaps.map((n) => `#${n}`).join(', ');
    const shared = v.sharedOnlyOverlaps.map((n) => `#${n}`).join(', ');
    const overlap = [blocking, shared ? `共有ファイルのみ（並行可）：${shared}` : ''].filter((x) => x).join('。') || '—';
    lines.push(`| #${r.issue} ${cell(r.title)} | ${r.pr === null ? '—' : `#${r.pr}`} | ${FLEET_STAGES[r.stage]} | ${NEXT_LABELS[r.next]} | ${cell(chosen)} | ${overlap} | ${cell(v.note)} |`);
  }
  lines.push('', max === null ? `選んだ数：${sel.selected.length}（衝突しない範囲で本数を制限しない。絞るときは --max）` : `選んだ数：${sel.selected.length}/${max}（--max で指定した本数）`);
  if (mode) {
    lines.push(mode.nesting === 'orca'
      ? `進め方：入れ子（orca）。ship をサブエージェントで並行に動かす。同時に動かす ship は ${parallelShips(max, mode)} まで`
      : '進め方：交互（flat）。1つのセッションで段階を交互に進める');
  }
  return lines.join('\n');
}

/** fleet-status --json の着手宣言。stage・session は宣言に無ければ null（鍵を落とさない） */
export interface FleetClaimInfo {
  by: 'manual' | 'routine';
  stage: string | null;
  session: string | null;
  /** このセッションの手動の宣言か（isOwnClaim） */
  own: boolean;
}

/** fleet-status --json の1行。表の1行と同じ中身 */
export interface FleetStatusRow {
  issue: number;
  title: string;
  pr: number | null;
  stage: FleetStage;
  /** 表の段階の列の文言（FLEET_STAGES） */
  stageLabel: string;
  next: FleetNext;
  selected: boolean;
  /** 待つ理由（表の「待つ：」の後ろ）。選ぶときは null */
  waitReason: string | null;
  /** 衝突・触るファイルが重なる Issue（表の重なりの列） */
  overlaps: number[];
  /** 共有ファイルだけで重なる Issue（表の「共有ファイルのみ（並行可）」） */
  sharedOnlyOverlaps: number[];
  /** 表のメモの列と同じ文。無ければ null */
  note: string | null;
  /** Issue の解除されていない着手宣言 */
  claim: FleetClaimInfo | null;
  /** 行の開いた PR の解除されていない着手宣言 */
  prClaim: FleetClaimInfo | null;
}

/** fleet-status --json の出力 */
export interface FleetStatusData {
  version: 1;
  /** 表と同じ順の行 */
  rows: FleetStatusRow[];
  selectedCount: number;
  /** 選んだ Issue（選んだ順） */
  selected: number[];
  /** --max。無ければ null */
  max: number | null;
  /** 進め方。parallel は入れ子で同時に動かす ship の数（表の進め方の行と同じ）。mode を渡さなければ null */
  mode: { nesting: 'orca' | 'flat'; parallel: number } | null;
}

function claimInfo(claim: Claim | null, currentSession: string | null): FleetClaimInfo | null {
  if (claim === null || claim.released) return null;
  return { by: claim.by, stage: claim.stage ?? null, session: claim.session ?? null, own: isOwnClaim(claim, currentSession) };
}

/**
 * fleet-status の表（renderFleetStatus）と同じ中身を、機械が読める形で返す（fleet-status --json）。
 * 表示のペインや hq が Markdown の表を読み直さずに済むようにする。並び順・理由・重なり・メモは表と同じ関数から作る。
 */
export function fleetStatusData(facts: FleetFacts, rows: FleetRow[], sel: FleetSelection, max: number | null, currentSession: string | null, mode?: FleetMode): FleetStatusData {
  const byNumber = new Map(facts.issues.map((i) => [i.facts.number, i]));
  return {
    version: 1,
    rows: sortedRows(rows, sel).map((r) => {
      const v = rowView(r, sel);
      const i = byNumber.get(r.issue);
      const prClaim = i !== undefined && r.pr !== null && r.stage !== 'merged' ? openPrClaim(i, r) : null;
      return {
        issue: r.issue,
        title: r.title,
        pr: r.pr,
        stage: r.stage,
        stageLabel: FLEET_STAGES[r.stage],
        next: r.next,
        selected: v.selected,
        waitReason: v.selected ? null : v.waitReason,
        overlaps: v.overlaps,
        sharedOnlyOverlaps: v.sharedOnlyOverlaps,
        note: v.note === '' ? null : v.note,
        claim: claimInfo(i?.facts.claim ?? null, currentSession),
        prClaim: claimInfo(prClaim, currentSession),
      };
    }),
    selectedCount: sel.selected.length,
    selected: [...sel.selected],
    max,
    mode: mode ? { nesting: mode.nesting, parallel: parallelShips(max, mode) } : null,
  };
}
