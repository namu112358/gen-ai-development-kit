/**
 * hq の判定（空いた枠の割り当て・交代の判定・便りの振り分け）を、hq（モデル）が数えずに済むように、純粋な関数にしたもの（Issue #780）。
 * hq がすでに読んでいる材料（控え・`fleet-status --json`・`hq-watch.ts` の出力）をファイルで受け取り、「次にすること」を JSON で標準出力に書く。
 * GitHub・Orca・git は呼ばない（控えは git の共通ディレクトリから読むだけ）。判定の基準は hq の skill の手順7・8の今の文のまま。
 *
 *   node harness/scripts/hq-decide.ts assign --fleet-status <file> [--epic-children <file>] [--live-fleets <n>] [--ledger <file>]
 *     動いている ship の数と、空いた枠の割り当て（手順8）。--fleet-status は番号を渡さない `fleet-status --json` の出力、
 *     --epic-children は {"<Epic番号>": [Issue 番号…]}（無ければ (a) は判定せず、(c) は単発）、--live-fleets は settle していない fleet の数（無ければ控えの fleets の数）。
 *     出力：{ running, perFleet, free, actions: add | start-fleet | wait }。actions は並びの順に実行する（add の newFleet は同じ回の start-fleet の index）。
 *   node harness/scripts/hq-decide.ts handover --from-handle <送り手> [--workers <file>] --epic <Epic番号|none> --issues <n…> --fleet-status <file> [--ledger <file>]
 *     読み込みが古い交代の質問に、人に聞かずに「交代する」と返してよいか（手順7）。--workers は `worker-list --json` の出力、--fleet-status はその fleet の Issue 番号を渡した `fleet-status --json`。
 *     出力：{ decision: auto | ask, theme, dispatch, failed }。
 *   node harness/scripts/hq-decide.ts route --wake <file>
 *     届いた便りの振り分け（手順7）。--wake は hq-watch.ts の {"wake":"messages",...} の出力。出力：{ deliveryId, items: [{ id, type, subject, from, dispatch, action }] }。
 *
 * 控えの fleets の要素は theme・epic・dispatch・session・issues（Issue 番号の配列）を読む。形の違う値は読み飛ばす。
 * 引数の誤り・読めないファイルは標準エラーに1行書いて終了コード 1。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { readFileSync } from 'node:fs';
import { fleetConfig, hqConfig, loadConfig } from '../lib/config.ts';
import type { FleetStatusData, FleetStatusRow } from '../lib/fleet.ts';
import { gitCommonDir, readLedgerFile, type HqLedger } from './hq-state.ts';
import type { CheckMessage, WorkerRow } from './hq-watch.ts';

export interface LedgerFleet { theme: string; epic: number | null; dispatch: string; session: string | null; issues: number[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** 控えの fleets を読む。形の違う要素は読める値だけを使う。控えが無ければ [] */
export function readLedgerFleets(ledger: Pick<HqLedger, 'fleets'> | null): LedgerFleet[] {
  if (!ledger || !Array.isArray(ledger.fleets)) return [];
  return ledger.fleets.filter(isObj).map((f) => ({
    theme: nonEmpty(f.theme) ?? '',
    epic: posInt(f.epic) ? f.epic : null,
    dispatch: nonEmpty(f.dispatch) ?? '',
    session: nonEmpty(f.session),
    issues: Array.isArray(f.issues) ? f.issues.filter(posInt) : [],
  }));
}

// ---- assign（手順8：動いている ship の数と空いた枠の割り当て） ----

export interface AssignInput {
  status: FleetStatusData;
  ledgerFleets: LedgerFleet[];
  /** {"<Epic番号>": [Issue 番号…]}。空なら (a) は判定せず、(c) は単発 */
  epicChildren: Record<string, number[]>;
  /** settle していない fleet の数 */
  liveFleets: number;
  limits: { hqMaxParallelShips: number; hqMaxFleets: number; fleetMaxParallelShips: number };
}
export type AssignAction =
  | { kind: 'add'; issue: number; theme: string | null; dispatch: string | null; newFleet: number | null }
  | { kind: 'start-fleet'; index: number; issue: number; epic: number | null }
  | { kind: 'wait'; issue: number; reason: string };
export interface AssignResult { running: number; perFleet: { theme: string; dispatch: string; running: number }[]; free: number; actions: AssignAction[] }

/** 行の着手宣言（prClaim を優先）が、動いている ship か（宣言があり、段階が plan-gate でない） */
const isRunning = (row: FleetStatusRow): boolean => {
  const c = row.prClaim ?? row.claim;
  return c !== null && c !== undefined && c.stage !== 'plan-gate';
};

interface Cand { theme: string | null; dispatch: string | null; epic: number | null; issues: Set<number>; running: number; newIndex: number | null }

export function assignSlots(input: AssignInput): AssignResult {
  const { status, ledgerFleets, epicChildren, limits } = input;
  const rowOf = new Map(status.rows.map((r) => [r.issue, r]));
  // 同じ Issue が2つの fleet の集合にあれば、最初の fleet で数える
  const counted = new Set<number>();
  const cands: Cand[] = ledgerFleets.map((f) => {
    let running = 0;
    for (const n of f.issues) {
      if (counted.has(n)) continue;
      counted.add(n);
      const row = rowOf.get(n);
      if (row && isRunning(row)) running++;
    }
    return { theme: f.theme, dispatch: f.dispatch, epic: f.epic, issues: new Set(f.issues), running, newIndex: null };
  });
  const perFleet = cands.map((c) => ({ theme: c.theme as string, dispatch: c.dispatch as string, running: c.running }));
  const running = cands.reduce((s, c) => s + c.running, 0);
  const inAnyFleet = new Set(ledgerFleets.flatMap((f) => f.issues));
  const epics = Object.keys(epicChildren).map(Number).filter(posInt).sort((a, b) => a - b);
  const childrenOf = (epic: number): number[] => {
    const l = epicChildren[String(epic)];
    return Array.isArray(l) ? l : [];
  };

  const free = limits.hqMaxParallelShips - running;
  let left = free;
  let live = input.liveFleets;
  let starts = 0;
  const actions: AssignAction[] = [];
  for (const row of status.rows) {
    if (!row.selected || inAnyFleet.has(row.issue)) continue;
    if (left <= 0) {
      actions.push({ kind: 'wait', issue: row.issue, reason: '空きが無い（動いている ship の数が hq.maxParallelShips に届いている）' });
      continue;
    }
    const target = (c: Cand): AssignAction => ({ kind: 'add', issue: row.issue, theme: c.newIndex === null ? c.theme : null, dispatch: c.newIndex === null ? c.dispatch : null, newFleet: c.newIndex });
    // (a) 今の fleet の Epic の子なら、その fleet に足す（fleet.maxParallelShips は見ない）
    const a = cands.find((c) => c.epic !== null && childrenOf(c.epic).includes(row.issue));
    if (a) {
      a.running++;
      a.issues.add(row.issue);
      actions.push(target(a));
      left--;
      continue;
    }
    // (b) 数が fleet.maxParallelShips 未満の fleet のうち、数の一番少ないもの（同じ数なら先の fleet）
    let b: Cand | null = null;
    for (const c of cands) if (c.running < limits.fleetMaxParallelShips && (b === null || c.running < b.running)) b = c;
    if (b) {
      b.running++;
      b.issues.add(row.issue);
      actions.push(target(b));
      left--;
      continue;
    }
    // (c) fleet の数が hq.maxFleets 未満なら新しい fleet（開いた Epic の子ならその Epic、無ければ単発）
    if (live < limits.hqMaxFleets) {
      const epic = epics.find((e) => childrenOf(e).includes(row.issue)) ?? null;
      const index = starts++;
      cands.push({ theme: null, dispatch: null, epic, issues: new Set([row.issue]), running: 1, newIndex: index });
      actions.push({ kind: 'start-fleet', index, issue: row.issue, epic });
      live++;
      left--;
      continue;
    }
    // (d) 空き待ち
    actions.push({ kind: 'wait', issue: row.issue, reason: '入れる fleet が無い（fleet.maxParallelShips・hq.maxFleets に届いている）' });
  }
  return { running, perFleet, free, actions };
}

// ---- handover（手順7：読み込みが古い交代の質問） ----

export interface HandoverInput {
  fromHandle: string;
  workers: WorkerRow[] | null;
  /** 質問に書かれた Epic 番号（単発は null） */
  epic: number | null;
  issues: number[];
  /** その fleet の Issue 番号を渡した `fleet-status --json` */
  status: FleetStatusData;
  ledgerFleets: LedgerFleet[];
}
export type HandoverFailed = 'claims-remain' | 'no-session' | 'epic-differs' | 'issues-differ' | 'unknown-fleet';
export interface HandoverResult { decision: 'auto' | 'ask'; theme: string | null; dispatch: string | null; failed: HandoverFailed[] }

/** 送り手から Dispatch を引く（hq-watch.ts の themeForHeartbeat と同じ引き方）。引けなければ null */
export function dispatchOf(fromHandle: string | undefined, workers: WorkerRow[] | null): string | null {
  if (!fromHandle) return null;
  if (fromHandle.startsWith('dispatch:')) return fromHandle.slice('dispatch:'.length) || null;
  return workers?.find((w) => w.agentTerminalHandle === fromHandle)?.dispatchId ?? null;
}

const sameSet = (a: number[], b: number[]): boolean => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((n) => y.has(n));
};

export function handoverDecision(input: HandoverInput): HandoverResult {
  const dispatch = dispatchOf(input.fromHandle, input.workers);
  const fleet = dispatch === null ? undefined : input.ledgerFleets.find((f) => f.dispatch === dispatch);
  if (!fleet) return { decision: 'ask', theme: null, dispatch, failed: ['unknown-fleet'] };
  const failed: HandoverFailed[] = [];
  // (a) 宣言が残っていない（セッションは問わない）
  if (input.status.rows.some((r) => r.claim || r.prClaim)) failed.push('claims-remain');
  // (b) セッション ID が届いている
  if (fleet.session === null) failed.push('no-session');
  // (c) Epic・Issue 番号の集合が控えと同じ
  if (input.epic !== fleet.epic) failed.push('epic-differs');
  if (!sameSet(input.issues, fleet.issues)) failed.push('issues-differ');
  return { decision: failed.length === 0 ? 'auto' : 'ask', theme: fleet.theme, dispatch, failed };
}

// ---- route（手順7：届いた便りの振り分け） ----

export type RouteAction = 'heartbeat-save' | 'handover-check' | 'ask-human' | 'escalation' | 'worker-done' | 'tell-now' | 'list';
export interface RouteItem { id: string; type: string; subject: string | null; from: string | null; dispatch: string | null; action: RouteAction }
export interface RouteResult { deliveryId: string | null; items: RouteItem[] }

/** 質問の文（body、無ければ payload の文字列）。読めなければ '' */
function textOf(m: CheckMessage): string {
  if (typeof m.body === 'string') return m.body;
  if (typeof m.payload === 'string') return m.payload;
  if (isObj(m.payload)) for (const k of ['body', 'question', 'text']) if (typeof m.payload[k] === 'string') return m.payload[k] as string;
  return '';
}

/** 交代を聞く質問か（印 [交代] で始まる、または「交代しますか」を含む。古い skill の fleet の文言も見分ける） */
const isHandoverQuestion = (text: string): boolean => text.trimStart().startsWith('[交代]') || text.includes('交代しますか');

function actionOf(m: CheckMessage): RouteAction {
  switch (m.type) {
    case 'heartbeat': return 'heartbeat-save';
    case 'question': return isHandoverQuestion(textOf(m)) ? 'handover-check' : 'ask-human';
    case 'escalation': return 'escalation';
    case 'worker_done': return 'worker-done';
    case 'status': {
      const subject = m.subject ?? '';
      if (/^ready-/.test(subject)) return 'tell-now';
      if (subject === 'notice' && textOf(m).includes('人の判断が要る')) return 'tell-now';
      return 'list';
    }
    default: return 'ask-human';
  }
}

export function routeDelivery(wake: { deliveryId: string | null; messages: CheckMessage[] }): RouteResult {
  return {
    deliveryId: wake.deliveryId,
    items: wake.messages.map((m) => ({
      id: m.id,
      type: m.type,
      subject: m.subject ?? null,
      from: m.from_handle ?? null,
      dispatch: m.from_handle?.startsWith('dispatch:') ? m.from_handle.slice('dispatch:'.length) || null : null,
      action: actionOf(m),
    })),
  };
}

// ---- CLI（import.meta.main の中だけで動く） ----

function readJsonFile(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${what}（${path}）を JSON として読めません`);
  }
}

function takeFlags(argv: string[], names: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!names.includes(a)) throw new Error(`読めない引数：${a}`);
    const vals: string[] = [];
    while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith('--')) vals.push(argv[++i] as string);
    if (vals.length === 0) throw new Error(`${a} に値がありません`);
    out.set(a, vals);
  }
  return out;
}

const one = (f: Map<string, string[]>, name: string, required: boolean): string | null => {
  const v = f.get(name);
  if (!v) {
    if (required) throw new Error(`${name} が必要です`);
    return null;
  }
  if (v.length !== 1) throw new Error(`${name} は1つだけ渡してください`);
  return v[0] ?? null;
};

function loadStatus(path: string): FleetStatusData {
  const j = readJsonFile(path, 'fleet-status の出力');
  if (!isObj(j) || !Array.isArray(j.rows)) throw new Error(`fleet-status の出力（${path}）に rows がありません`);
  return j as unknown as FleetStatusData;
}

function loadLedgerFleets(path: string | null): { fleets: LedgerFleet[]; raw: HqLedger | null } {
  let raw: HqLedger | null;
  if (path) {
    const j = readJsonFile(path, '控え');
    raw = isObj(j) && Array.isArray(j.fleets) ? ({ fleets: j.fleets.filter(isObj) } as HqLedger) : null;
  } else {
    const dir = gitCommonDir(process.cwd());
    raw = dir ? readLedgerFile(dir) : null;
  }
  return { fleets: readLedgerFleets(raw), raw };
}

function posIntArg(s: string, name: string): number {
  const n = Number(s);
  if (!posInt(n)) throw new Error(`${name} は正の整数で書いてください：${s}`);
  return n;
}

function run(argv: string[]): unknown {
  const [cmd, ...rest] = argv;
  if (cmd === 'assign') {
    const f = takeFlags(rest, ['--fleet-status', '--epic-children', '--live-fleets', '--ledger']);
    const { fleets } = loadLedgerFleets(one(f, '--ledger', false));
    const children = one(f, '--epic-children', false);
    const live = one(f, '--live-fleets', false);
    const config = loadConfig();
    return assignSlots({
      status: loadStatus(one(f, '--fleet-status', true) as string),
      ledgerFleets: fleets,
      epicChildren: children ? (readJsonFile(children, 'Epic の子の一覧') as Record<string, number[]>) : {},
      liveFleets: live === null ? fleets.length : Number(live),
      limits: { hqMaxParallelShips: hqConfig(config).maxParallelShips, hqMaxFleets: hqConfig(config).maxFleets, fleetMaxParallelShips: fleetConfig(config).maxParallelShips },
    });
  }
  if (cmd === 'handover') {
    const f = takeFlags(rest, ['--from-handle', '--workers', '--epic', '--issues', '--fleet-status', '--ledger']);
    const epic = one(f, '--epic', true) as string;
    const workers = one(f, '--workers', false);
    let rows: WorkerRow[] | null = null;
    if (workers) {
      const j = readJsonFile(workers, 'worker-list の出力');
      const list = isObj(j) && Array.isArray(j.workers) ? j.workers : isObj(j) && isObj(j.result) && Array.isArray(j.result.workers) ? j.result.workers : null;
      rows = list === null ? null : (list as Record<string, unknown>[]).filter((w) => typeof w.dispatchId === 'string').map((w) => ({ dispatchId: w.dispatchId as string, agentTerminalHandle: typeof w.agentTerminalHandle === 'string' ? w.agentTerminalHandle : null }));
    }
    return handoverDecision({
      fromHandle: one(f, '--from-handle', true) as string,
      workers: rows,
      epic: epic === 'none' ? null : posIntArg(epic, '--epic'),
      issues: (f.get('--issues') ?? (() => { throw new Error('--issues が必要です'); })()).map((s) => posIntArg(s, '--issues')),
      status: loadStatus(one(f, '--fleet-status', true) as string),
      ledgerFleets: loadLedgerFleets(one(f, '--ledger', false)).fleets,
    });
  }
  if (cmd === 'route') {
    const f = takeFlags(rest, ['--wake']);
    const j = readJsonFile(one(f, '--wake', true) as string, 'hq-watch.ts の出力');
    if (!isObj(j) || !Array.isArray(j.messages)) throw new Error('hq-watch.ts の出力に messages がありません');
    return routeDelivery({ deliveryId: typeof j.deliveryId === 'string' ? j.deliveryId : null, messages: j.messages as CheckMessage[] });
  }
  throw new Error('使い方：hq-decide.ts assign|handover|route …（引数は先頭のコメントを見る）');
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
