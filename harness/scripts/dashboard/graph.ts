/**
 * ダッシュボードのグラフを組む純粋関数。GitHub もファイルも読まない。
 * 段階の層（列）は、有効な着手宣言の段階を優先し、無ければ harness/lib/fleet.ts の fleetStatus の段階から決める（fleet-status と同じ判断）。
 * タスクの層（辺）は、依存・Epic と子・Issue と PR・Stacked PR・担当のセッション。
 */
import { shortSession } from '../../lib/blocks.ts';
import { LABELS, PRIORITY_LABELS } from '../../lib/config.ts';
import { parseChildMarker } from '../../lib/epic.ts';
import { fleetStatus, type FleetIssue, type FleetPr, type FleetRow, type FleetStage } from '../../lib/fleet.ts';
import type { Claim, IssueFacts } from '../../lib/queue.ts';
import type { SessionInfo } from './sessions.ts';

export type ColumnId =
  | 'no-plan' | 'plan' | 'plan-critique' | 'plan-gate' | 'plan-review' | 'plan-ok'
  | 'implement' | 'judge' | 'fix' | 'sync' | 'merge' | 'dependency' | 'stopped';

/** 段階の強制のされ方（段階の関所マップと同じ区別）。code：Ruleset の必須チェックか App のゲートが止める、cond：ある状態のときだけ必須、ai：skill の文章だけ（飛ばしても止まらない）、human：人が決める */
export type Enforcement = 'code' | 'cond' | 'ai' | 'human';

/** 左から右への段階。最後の2つ（依存待ち・止まる印）は脇の列。exit は終了条件、stopper は飛ばしたときに何が止めるか */
export const COLUMNS: { id: ColumnId; label: string; enforcement: Enforcement; exit: string; stopper: string }[] = [
  { id: 'no-plan', label: '計画なし', enforcement: 'code', exit: '計画を書いて投稿する', stopper: '必須チェック agent/plan-link（計画ゲートの記録がある Issue への紐付けを求める）' },
  { id: 'plan', label: 'plan', enforcement: 'code', exit: 'agent-plan が書式の検査を通り、post-plan で投稿した', stopper: '必須チェック agent/plan-link' },
  { id: 'plan-critique', label: 'plan-critique', enforcement: 'code', exit: '批評の判定が go。revise なら直して批評し直す（止める条件なら人に聞く）', stopper: 'App の計画ゲート（critique が無い、計画より前に段階 plan-critique の宣言が無い計画は agent:plan-review で止める）。批評の中身は skill の文章だけ' },
  { id: 'plan-gate', label: '計画ゲート待ち', enforcement: 'code', exit: 'App が agent:plan-ok か agent:plan-review を付けた', stopper: 'App の計画ゲート。agent:plan-ok を自分で付けることは禁止' },
  { id: 'plan-review', label: '人の判断待ち', enforcement: 'human', exit: '人が進めると決めた、または計画を直して出し直しゲートが通した', stopper: 'CLAUDE.md の決まりと permissions.deny（保護ラベルの付け外しを拒否）' },
  { id: 'plan-ok', label: '実装待ち', enforcement: 'code', exit: '実装に着手した', stopper: 'App が付けた agent:plan-ok だけを信頼する' },
  { id: 'implement', label: 'implement', enforcement: 'cond', exit: 'claude/issue-番号 のブランチに push し、Closes 付きの Draft PR を出した', stopper: 'Ruleset（main への push 禁止）と worktree の宣言の確認。test-designer は skill の文章だけ' },
  { id: 'judge', label: 'judge', enforcement: 'code', exit: '今の head の判定を App が受け付け、agent/review が書かれた', stopper: '必須チェック agent/review' },
  { id: 'fix', label: 'fix', enforcement: 'cond', exit: '指摘を直して push し、新しい head の判定を App が受け付けた', stopper: '指摘があれば必須チェック agent/review が止める。上限を超えると agent:blocked' },
  { id: 'sync', label: 'sync', enforcement: 'cond', exit: '衝突が無く、新しい head で判定が有効', stopper: '衝突していると CI が動かず Merge できない（Ruleset は main への追従を求める）' },
  { id: 'merge', label: 'Merge 待ち', enforcement: 'human', exit: 'PR が main に入り、Issue が閉じた', stopper: '必須チェック merge-route。Claude の Merge は permissions.deny が拒否する' },
  { id: 'dependency', label: '依存待ち', enforcement: 'cond', exit: '依存先の Issue が閉じた', stopper: 'queue・fleet が依存の残る Issue を選ばない' },
  { id: 'stopped', label: '止まる印', enforcement: 'human', exit: '人が止まる印（hold・blocked・waiting）を外した', stopper: '印は人か App が付け外しする' },
];

export type TaskStatus = 'active' | 'stale' | 'waiting-human' | 'blocked' | 'conflict' | 'idle';
export type EdgeKind = 'depends' | 'epic' | 'closes' | 'stacked' | 'session';

/** 計画ゲートの記録の計画の写し。記録の形は信用せず、issueWarnings で確かめる */
export interface PlanCopy { critique?: unknown }

export interface DashIssue {
  fleet: FleetIssue;
  body: string | null;
  url: string;
  /** 計画ゲートの記録の計画の写し（記録が無ければ null） */
  plan: PlanCopy | null;
}

export interface DashPr {
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
  /** Closes する Issue（無ければ null＝Issue の無い Agent PR） */
  issue: number | null;
  /** GitHub の紐付けが無く、本文の Closes #N で結んだ（紐付けの抜け）。補ったときだけ入る */
  linkGap?: true;
  fleet: FleetPr;
}

export interface TaskClaim { by: 'manual' | 'routine'; stage: string | null; session: string | null; at: string }

export interface Task {
  id: string;
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
  column: ColumnId;
  status: TaskStatus;
  note: string | null;
  claim: TaskClaim | null;
  /** 対応する手元（か claim）のセッションの ID */
  sessions: string[];
  /** コードで強制されていない手順を飛ばした印（例：批評なし） */
  warnings: string[];
}

/** from のタスクが持つ辺 */
export interface Edge { kind: EdgeKind; from: string; to: string }

export interface SessionNode {
  id: string;
  session: string;
  short: string;
  local: boolean;
  running: boolean;
  lastAt: string | null;
  subagents: { type: string; description: string; lastAt: string | null; running: boolean }[];
}

/** 人がすることの1行（Merge・人の判断・止まる印・priority の不足） */
export interface Todo { id: string; kind: 'issue' | 'pr'; number: number; url: string; title: string; reason: string }

export interface Graph { columns: typeof COLUMNS; tasks: Task[]; edges: Edge[]; sessions: SessionNode[]; todos: Todo[] }

export interface BuildOptions { now: Date; humanClaimStaleHours: number }

export type GraphEvent =
  | { type: 'task'; task: Task; edges: Edge[] }
  | { type: 'remove'; id: string }
  | { type: 'sessions'; sessions: SessionNode[] }
  | { type: 'todos'; todos: Todo[] };

const STOP_LABELS: string[] = [LABELS.hold, LABELS.blocked, LABELS.waiting];
const PR_STOP_LABELS: string[] = [LABELS.hold, LABELS.blocked];
const CLAIM_COLUMNS: Record<string, ColumnId> = {
  plan: 'plan', 'plan-critique': 'plan-critique', 'plan-gate': 'plan-gate', implement: 'implement', judge: 'judge', fix: 'fix', sync: 'sync',
};
const STAGE_COLUMNS: Record<FleetStage, ColumnId> = {
  'no-plan': 'no-plan', 'plan-gate': 'plan-gate', 'plan-review': 'plan-review', 'plan-ok': 'plan-ok', judge: 'judge', fix: 'fix',
  'human-merge': 'merge', 'auto-merge': 'merge', merged: 'merge', stopped: 'stopped',
};
const WAITING_HUMAN: FleetStage[] = ['plan-review', 'human-merge', 'auto-merge'];

/** 計画ゲートの記録の計画から、飛ばした手順の注意を決める（批評を飛ばした、必須の指摘を残して進めた） */
export function issueWarnings(plan: PlanCopy | null): string[] {
  if (plan === null) return [];
  const c = plan.critique;
  if (c === undefined) return ['批評なし'];
  if (typeof c !== 'object' || c === null) return ['批評の記録が読めない'];
  const { verdict, mustRemaining } = c as { verdict?: unknown; mustRemaining?: unknown };
  if (typeof verdict !== 'string' || (mustRemaining !== undefined && typeof mustRemaining !== 'number')) return ['批評の記録が読めない'];
  if (verdict === 'revise' && typeof mustRemaining === 'number' && mustRemaining >= 1) return [`必須の指摘を残して進めた（${mustRemaining} 件）`];
  return [];
}

const PRIORITIES: string[] = Object.values(PRIORITY_LABELS);

/**
 * 人がすることの一覧。Human Merge の PR → 計画ゲートで止まった Issue → 止まる印の Issue → priority の無い Issue の順。
 * priority を見るのは label-audit と同じ範囲（agent:* か epic の付いた Issue）。自動 Merge 待ちは人の操作が要らないので出さない
 */
export function buildTodos(issues: DashIssue[], prs: DashPr[], rows: FleetRow[]): Todo[] {
  const byNumber = (a: Todo, b: Todo) => a.number - b.number;
  const issueTodo = (i: DashIssue, key: string, reason: string): Todo =>
    ({ id: `${key}-issue-${i.fleet.facts.number}`, kind: 'issue', number: i.fleet.facts.number, url: i.url, title: i.fleet.facts.title, reason });
  const merge: Todo[] = [];
  for (const r of rows) {
    if (r.stage !== 'human-merge' || r.pr === null) continue;
    const p = prs.find((x) => x.number === r.pr);
    if (p) merge.push({ id: `merge-pr-${p.number}`, kind: 'pr', number: p.number, url: p.url, title: p.title, reason: 'PR を確かめて Merge する' });
  }
  const review = issues.filter((i) => rows.some((r) => r.issue === i.fleet.facts.number && r.stage === 'plan-review'))
    .map((i) => issueTodo(i, 'review', '計画ゲートで止まった。進めるか決める'));
  const stop = issues.flatMap((i) => {
    const on = STOP_LABELS.filter((l) => i.fleet.facts.labels.includes(l));
    return on.length > 0 ? [issueTodo(i, 'stop', `止まる印（${on.join('・')}）の対応`)] : [];
  });
  const priority = issues.filter((i) => {
    const labels = i.fleet.facts.labels;
    return labels.some((l) => l.startsWith('agent:') || l === LABELS.epic) && !labels.some((l) => PRIORITIES.includes(l));
  }).map((i) => issueTodo(i, 'priority', 'priority のラベルが無い'));
  return [merge, review, stop, priority].flatMap((g) => g.sort(byNumber));
}

const issueId = (n: number) => `issue-${n}`;
const prId = (n: number) => `pr-${n}`;
const sessionId = (s: string) => `session-${s}`;

const active = (c: Claim | null): Claim | null => (c && !c.released ? c : null);

function taskClaim(c: Claim | null): TaskClaim | null {
  const a = active(c);
  if (!a) return null;
  return { by: a.by, stage: a.stage ?? null, session: a.session ?? null, at: a.at };
}

function isStale(c: TaskClaim | null, opts: BuildOptions): boolean {
  return c !== null && c.by === 'manual' && opts.now.getTime() - Date.parse(c.at) >= opts.humanClaimStaleHours * 3600_000;
}

function status(o: { blocked: boolean; conflict: boolean; claim: TaskClaim | null; stage: FleetStage }, opts: BuildOptions): TaskStatus {
  if (o.blocked) return 'blocked';
  if (o.conflict) return 'conflict';
  if (isStale(o.claim, opts)) return 'stale';
  if (o.claim) return 'active';
  if (WAITING_HUMAN.includes(o.stage)) return 'waiting-human';
  return 'idle';
}

function column(o: { stopped: boolean; dependency: boolean; claim: TaskClaim | null; stage: FleetStage }): ColumnId {
  if (o.dependency) return 'dependency';
  if (o.stopped) return 'stopped';
  const byClaim = o.claim?.stage ? CLAIM_COLUMNS[o.claim.stage] : undefined;
  return byClaim ?? STAGE_COLUMNS[o.stage];
}

/** Issue の無い PR に fleetStatus を掛けるための仮の Issue（ラベル無し） */
function orphanIssue(pr: DashPr): FleetIssue {
  const facts: IssueFacts = {
    number: -pr.number, title: pr.title, labels: [], readyAt: null, claim: null, openBlockers: [],
    gate: null, latestPlanAt: null, planOkByApp: false, openPr: pr.number,
  };
  return { facts, closed: false, planFiles: null, prs: [pr.fleet] };
}

export function buildGraph(issues: DashIssue[], prs: DashPr[], sessions: SessionInfo[], opts: BuildOptions): Graph {
  const orphans = prs.filter((p) => p.issue === null || !issues.some((i) => i.fleet.facts.number === p.issue));
  // anyMerged が全体で決まるので、毎回すべてに掛ける
  const rows = fleetStatus({ issues: [...issues.map((i) => i.fleet), ...orphans.map(orphanIssue)], prConflicts: [] });
  const stageOf = new Map(rows.map((r) => [r.issue, r]));
  const tasks: Task[] = [];
  const edges: Edge[] = [];
  const issueNumbers = new Set(issues.map((i) => i.fleet.facts.number));

  for (const i of issues) {
    const f = i.fleet.facts;
    const row = stageOf.get(f.number)!;
    const claim = taskClaim(f.claim);
    const stopped = STOP_LABELS.some((l) => f.labels.includes(l)) || f.labels.includes(LABELS.epic);
    const dependency = f.openBlockers.length > 0;
    tasks.push({
      id: issueId(f.number), kind: 'issue', number: f.number, title: f.title, url: i.url,
      column: column({ stopped, dependency, claim, stage: row.stage }),
      status: status({ blocked: dependency || STOP_LABELS.some((l) => f.labels.includes(l)), conflict: false, claim, stage: row.stage }, opts),
      note: row.note, claim, sessions: [], warnings: issueWarnings(i.plan),
    });
    for (const b of f.openBlockers) edges.push({ kind: 'depends', from: issueId(f.number), to: issueId(b) });
    const child = parseChildMarker(i.body);
    if (child && issueNumbers.has(child.parent)) edges.push({ kind: 'epic', from: issueId(child.parent), to: issueId(f.number) });
  }

  const byHead = new Map(prs.map((p) => [p.headRef, p]));
  for (const p of prs) {
    const orphan = orphans.includes(p);
    const row = stageOf.get(orphan ? -p.number : p.issue!)!;
    const parent = orphan ? null : tasks.find((t) => t.id === issueId(p.issue!))!;
    const facts = p.fleet.facts;
    const claim = taskClaim(facts?.claim ?? null);
    const prStopped = PR_STOP_LABELS.some((l) => facts?.labels.includes(l));
    let col: ColumnId;
    if (prStopped) col = 'stopped';
    else if (claim?.stage && CLAIM_COLUMNS[claim.stage]) col = CLAIM_COLUMNS[claim.stage]!;
    else if (parent) col = parent.column;
    else col = column({ stopped: false, dependency: false, claim: null, stage: row.stage });
    tasks.push({
      id: prId(p.number), kind: 'pr', number: p.number, title: p.title, url: p.url, column: col,
      status: status({ blocked: prStopped, conflict: Boolean(facts?.conflicted), claim, stage: row.stage }, opts),
      note: orphan ? row.note : null, claim, sessions: [], warnings: p.linkGap ? ['紐付けの抜け（本文の Closes で結んだ）'] : [],
    });
    if (!orphan) edges.push({ kind: 'closes', from: issueId(p.issue!), to: prId(p.number) });
    const base = byHead.get(p.baseRef);
    if (base && base.number !== p.number) edges.push({ kind: 'stacked', from: prId(p.number), to: prId(base.number) });
  }

  // セッション：手元の記録と、claim に出てくるもの
  const nodes = new Map<string, SessionNode>();
  for (const s of sessions) {
    nodes.set(s.id, {
      id: sessionId(s.id), session: s.id, short: shortSession(s.id), local: true, running: s.running, lastAt: s.lastAt,
      subagents: s.subagents.map((a) => ({ type: a.type, description: a.description, lastAt: a.lastAt, running: a.running })),
    });
  }
  const prHead = new Map(prs.map((p) => [prId(p.number), p.headRef]));
  for (const t of tasks) {
    const linked = new Set<string>();
    if (t.claim?.session) linked.add(t.claim.session);
    for (const s of sessions) {
      if (t.kind === 'issue' && s.issue === t.number) linked.add(s.id);
      if (t.kind === 'pr' && s.branch !== null && s.branch === prHead.get(t.id)) linked.add(s.id);
    }
    for (const s of linked) {
      if (!nodes.has(s)) nodes.set(s, { id: sessionId(s), session: s, short: shortSession(s), local: false, running: false, lastAt: null, subagents: [] });
      edges.push({ kind: 'session', from: t.id, to: sessionId(s) });
    }
    t.sessions = [...linked];
  }

  return { columns: COLUMNS, tasks, edges, sessions: [...nodes.values()], todos: buildTodos(issues, prs, rows) };
}

/** 前後のグラフの差分。変わったタスク（と、そのタスクが持つ辺）だけを送る */
export function diffGraphs(prev: Graph, next: Graph): GraphEvent[] {
  const out: GraphEvent[] = [];
  const edgesOf = (g: Graph, id: string) => g.edges.filter((e) => e.from === id);
  const before = new Map(prev.tasks.map((t) => [t.id, t]));
  const after = new Set(next.tasks.map((t) => t.id));
  for (const t of next.tasks) {
    const old = before.get(t.id);
    const edges = edgesOf(next, t.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(t) || JSON.stringify(edgesOf(prev, t.id)) !== JSON.stringify(edges)) out.push({ type: 'task', task: t, edges });
  }
  for (const t of prev.tasks) if (!after.has(t.id)) out.push({ type: 'remove', id: t.id });
  if (JSON.stringify(prev.sessions) !== JSON.stringify(next.sessions)) out.push({ type: 'sessions', sessions: next.sessions });
  if (JSON.stringify(prev.todos) !== JSON.stringify(next.todos)) out.push({ type: 'todos', todos: next.todos });
  return out;
}
