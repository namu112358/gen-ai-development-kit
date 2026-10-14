/**
 * fleet と hq のワークスペースのペイン表示（進み具合・人がすること・PR と費用）。読むだけで、GitHub にもリポジトリにも書かない。
 *
 *   node harness/scripts/panes.ts collect --session <fleet のセッション ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...
 *   node harness/scripts/panes.ts progress|todo|prs (--session <ID> | --snapshot <パス>)（todo は hq がいない間の控えの質問も出す）
 *   node harness/scripts/panes.ts hq [todo|board|log] [--once] [--fleets <控えのパス>]（ペインの名前が無ければ todo。todo・board だけ --json で1行の JSON を出す。Claude Code の mod が読む）
 *   node harness/scripts/panes.ts fleets --session <ID> [--session <ID>...]
 *   node harness/scripts/panes.ts line (--session <ID> | --snapshot <パス>)（スナップショットを1回読み、「fleet #508 実装 · #517 ゲート（人）」の1行を出す。Claude Code の mod の status line が読む。スナップショットが無い・読めなければ何も出さず終了コード 0）
 *   node harness/scripts/panes.ts idle [--minutes <分>] [--exclude <handle>]...（Orca の全タブから、長く出力の無い claude のタブを1行ずつ出す。hq の見回しが読む。Issue #826）
 *   node harness/scripts/panes.ts config
 *
 * - collect：GitHub と記録を読むのはこれだけ。harness.config.json の panes.collectIntervalSeconds（既定 180 秒）ごとに、
 *   fleet-status --json（fleet のセッションとして。AGENT_HARNESS_SESSION をその ID にし、CLAUDE_CODE_REMOTE_SESSION_ID を消す）・
 *   Epic（開いた `epic` のラベルの Issue を gh issue list で一覧し、Epic ごとに子課題＝sub-issues をページで全部（gh api graphql）と
 *   App の epic-split の記録（コメント）を読んで、fleet の Issue ごとの親の Epic を決める。1つの Epic が読めなくてもほかは出る（読めない Epic は
 *   前回の値）。`epic` のラベルの無い Epic は拾えない＝label-apply が子を持つ Issue に付ける前提。Issue #402・#437）・
 *   行の PR（gh pr view）・fleet のセッションの usage（`~/.claude/projects/<作業ディレクトリ>/<ID>.jsonl`。無ければ読まない）を読み、
 *   スナップショット（harness/lib/panes.ts の PaneSnapshot）を一時ファイルに書いてから名前を変える。このペインは進み具合も描く。
 *   記録のディレクトリは作業ディレクトリごとに分かれるので、fleet のセッションの作業ディレクトリが collect と違えば --cwd で渡す。
 * - progress・todo・prs：スナップショットを数秒ごとに読み直して描くだけ（GitHub を読まない）。
 *   todo は、hq がいない間に fleet が控えた質問（harness/scripts/hq-state.ts の git の共通ディレクトリの下の控え）があれば先頭に出す（Issue #409）。
 *   控えは --session の ID で引き、--snapshot だけのときはスナップショットの session で引く。
 * - hq todo|board|log：hq の3つのペイン（① Epic/Issue・② 人待ち・③ ログ（上から）。描き方は harness/lib/panes-hq.ts。Issue #402）。GitHub を読まない。
 *   数秒ごとに hq の控え（hq-state.ts の git の共通ディレクトリの下の hq-fleets.json。--fleets で別のパス）を読み直し、控えの fleets の
 *   session のスナップショットだけを読む（--session は渡さない。起こし直しで hq が控えの session を書き換えれば、ペインを作り直さずに追う）。
 *   log は控えの隣の hq-heartbeat.json（hq-state.ts heartbeat-save）の古くない一言もまぜる（Issue #438）。
 *   board は標準入力が端末なら Tab・e・i でページ（Epic・Issue）を切り替える（q・Ctrl+C で終わる）。--once は1回だけ色なしで描いて終わる。
 * - fleets：渡した fleet のスナップショットを1回読み、進んでいないかの判定（harness/lib/hq-stall.ts の fleetStall。しきい値は
 *   HQ_STALL_DEFAULTS の 30・120 分）の配列を JSON で出して終わる（hq が読む。Issue #287）。無いスナップショットは missing。
 *   終わった fleet の古いスナップショットも一時ディレクトリに残るので、--session は必ず渡す（無ければ終了コード 1）。
 * - idle：Orca の `terminal list --json` を1回読み、agentIdentity が claude で lastOutputAt が 120 分（HQ_STALL_DEFAULTS.stuckMinutes。--minutes で上書き）以上前のタブを、
 *   --exclude の handle を除いて「長く出力の無いタブ：<handle>・<分>分・<title>（<worktreePath>）」の1行ずつ出す。無ければ何も出さない。
 *   Orca の一覧を読めなければ「Orca のタブの一覧を読めません（理由）」の1行を出して終了コード 0（hq の見回しを止めない）。タブは閉じない。
 * - config：fleet.shipMode・fleet.implementModel・hq・panes の設定を JSON で出す。shipModeConfig が止める理由（stopReason）を返したときだけ、理由を標準エラーに出して終了コード 1（今は subagent・worker とも null）。
 * - スナップショットの既定の置き場所は OS の一時ディレクトリの agent-harness-panes/<セッション ID>.json。
 * 段階の読み替えと描き方は harness/lib/panes.ts・harness/lib/panes-hq.ts。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, hqConfig, implementModelConfig, loadConfig, panesConfig, shipModeConfig, type HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import { epicChildrenFromRecords } from '../lib/session-inputs.ts';
import { fleetStall, HQ_STALL_DEFAULTS, missingFleet } from '../lib/hq-stall.ts';
import type { FleetStatusData } from '../lib/fleet.ts';
import { CLEAR_SCREEN, HISTORY_LIMIT, MARKS, PANE_STEPS, WHO_MARK, ago, locateRow, nextSince, renderProgress, renderPrs, renderTodo, shortTitle, stripAnsi, todoItems, type PaneEpic, type PaneEpicIssue, type PanePr, type PaneSnapshot, type PaneUsage } from '../lib/panes.ts';
import { groupByEpic, hqWarning, nextBoardPage, readHqView, renderHqBoard, renderHqLog, renderHqTodo, type BoardPage, type EpicGroup, type FleetRow, type HqView } from '../lib/panes-hq.ts';
import { writeLocalFile } from '../lib/local-state.ts';
import { TRANSCRIPT_SESSION_ID } from '../lib/session.ts';
import { HEARTBEAT_FILE, freshHeartbeats, gitCommonDir, ledgerPath, parseLedger, readHeartbeatAt, readPendingFile, renderPending, type PendingFile } from './hq-state.ts';
import { projectTranscriptDir } from '../lib/usage.ts';
import { orcaCliCommand } from '../lib/worktree.ts';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** collect が外に触るもの（テストは偽物を渡す） */
export interface CollectDeps {
  run(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }): RunResult;
  exists(path: string): boolean;
  readSnapshot(path: string): PaneSnapshot | null;
  writeSnapshot(path: string, snap: PaneSnapshot): void;
  now(): Date;
  env: Record<string, string | undefined>;
  /** agent.ts を動かす作業ディレクトリ（このリポジトリ） */
  root: string;
  /** ~/.claude/projects を探す home */
  home: string;
  /** node の実行ファイル */
  node: string;
}

export interface CollectOptions {
  session: string;
  label: string | null;
  issues: number[];
  snapshotPath: string;
  /** fleet のセッションの作業ディレクトリ（記録のディレクトリを決める） */
  transcriptCwd: string;
  intervalSeconds: number;
  /** harness.config.json（App の名義と epic のラベルを読む） */
  config: HarnessConfig;
}

/** fleet のセッションとして動かす子のプロセスの環境（fleet 自身の宣言が own: true＝「このセッション」になる） */
export function childEnv(env: Record<string, string | undefined>, session: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, AGENT_HARNESS_SESSION: session };
  delete out.CLAUDE_CODE_REMOTE_SESSION_ID;
  return out;
}

const lastLine = (s: string): string => s.trim().split('\n').slice(-1)[0] ?? '';

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** agent.ts usage の出力を PaneUsage にする。読めなければ null */
function usageOf(stdout: string): PaneUsage | null {
  const j = parseJson(stdout) as { estimatedUsd?: unknown; perModel?: Record<string, { estimatedUsd?: unknown }> } | null;
  if (!j || typeof j !== 'object' || !j.perModel || typeof j.perModel !== 'object') return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { totalUsd: num(j.estimatedUsd), perModel: Object.fromEntries(Object.entries(j.perModel).map(([m, v]) => [m, num(v?.estimatedUsd)])) };
}

interface GhPr {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  autoMergeRequest: unknown;
  labels: { name: string }[];
  statusCheckRollup: { name?: string; context?: string; conclusion?: string | null; state?: string | null }[] | null;
}

/** gh pr view --json の出力を PanePr にする。読めなければ null */
function prOf(stdout: string): PanePr | null {
  const j = parseJson(stdout) as GhPr | null;
  if (!j || typeof j.number !== 'number') return null;
  return {
    number: j.number,
    title: String(j.title ?? ''),
    state: String(j.state ?? ''),
    isDraft: j.isDraft === true,
    autoMerge: j.autoMergeRequest !== null && j.autoMergeRequest !== undefined,
    labels: (j.labels ?? []).map((l) => l.name),
    checks: (j.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context ?? '', conclusion: c.conclusion || c.state || null })),
  };
}

const PR_FIELDS = 'number,title,state,isDraft,autoMergeRequest,labels,statusCheckRollup';

interface GhIssueNode { number?: unknown; title?: unknown; state?: unknown }

const issueOf = (n: GhIssueNode | null | undefined): PaneEpicIssue | null =>
  n && typeof n.number === 'number' ? { number: n.number, title: String(n.title ?? ''), state: String(n.state ?? '') } : null;

/** Epic の子課題（sub-issues）を1ページ読む graphql のクエリ（owner・name・number・after は変数） */
export function subIssuesQuery(): string {
  return 'query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(first: 100, after: $after) { nodes { number title state } pageInfo { hasNextPage endCursor } } } } }';
}

/** 記録にだけある子課題を、別名 c<番号> で1回読むクエリ */
function aliasQuery(numbers: number[]): string {
  const fields = numbers.map((n) => `c${n}: issue(number: ${n}) { number title state }`);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

interface SubIssuesPage { data?: { repository?: { issue?: { subIssues?: { nodes?: GhIssueNode[] | null; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } | null } | null } | null } }

/** Epic 1つの子課題（sub-issues をページで全部と、App の epic-split の記録）を読む。どれかが読めなければ null */
function readEpicChildren(deps: CollectDeps, config: HarnessConfig, epic: number, env: Record<string, string | undefined>): PaneEpicIssue[] | null {
  const gql = (query: string, extra: string[] = []): RunResult =>
    deps.run('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', ...extra, '-f', `query=${query}`], { cwd: deps.root, env });
  const children = new Map<number, PaneEpicIssue>();
  let after: string | null = null;
  for (;;) {
    const r = gql(subIssuesQuery(), ['-F', `number=${epic}`, ...(after === null ? [] : ['-f', `after=${after}`])]);
    const subs = ((r.status === 0 ? parseJson(r.stdout) : null) as SubIssuesPage | null)?.data?.repository?.issue?.subIssues;
    if (!subs || !Array.isArray(subs.nodes)) return null;
    for (const c of subs.nodes.map(issueOf)) if (c) children.set(c.number, c);
    if (subs.pageInfo?.hasNextPage !== true) break;
    const next = subs.pageInfo.endCursor;
    if (typeof next !== 'string' || next === '' || next === after) return null;
    after = next;
  }
  const rc = deps.run('gh', ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${epic}/comments`], { cwd: deps.root, env });
  const pages = rc.status === 0 ? parseJson(rc.stdout) : null;
  if (!Array.isArray(pages)) return null;
  const recorded = epicChildrenFromRecords(config, pages.flat() as IssueComment[]) ?? [];
  const missing = recorded.filter((n) => !children.has(n));
  if (missing.length > 0) {
    const r = gql(aliasQuery(missing));
    const repo = ((r.status === 0 ? parseJson(r.stdout) : null) as { data?: { repository?: Record<string, GhIssueNode | null> | null } } | null)?.data?.repository;
    if (!repo || typeof repo !== 'object') return null;
    for (const n of missing) {
      const c = issueOf(repo[`c${n}`]);
      if (!c) return null;
      children.set(c.number, c);
    }
  }
  return [...children.values()];
}

/**
 * 開いた epic のラベルの Issue を一覧し、Epic ごとに子課題を読んで、fleet の Issue ごとの親の Epic を決める。
 * 一覧が読めなければ null。1つの Epic が読めなければ、その Epic だけ前回の値を使い、errors に書く
 */
function collectEpics(deps: CollectDeps, opts: CollectOptions, prev: PaneSnapshot | null, env: Record<string, string | undefined>): { epics: PaneEpic[]; issueEpic: Record<string, number | null>; errors: string[] } | null {
  const list = deps.run('gh', ['issue', 'list', '--label', LABELS.epic, '--state', 'open', '--json', 'number,title,state', '--limit', '1000'], { cwd: deps.root, env });
  const listed = (list.status === 0 ? parseJson(list.stdout) : null) as GhIssueNode[] | null;
  if (!Array.isArray(listed)) return null;
  const heads = listed.map(issueOf).filter((e): e is PaneEpicIssue => e !== null).sort((a, b) => a.number - b.number);

  const read: PaneEpic[] = [];
  const stale: PaneEpic[] = [];
  const errors: string[] = [];
  for (const head of heads) {
    const children = readEpicChildren(deps, opts.config, head.number, env);
    if (children) {
      read.push({ ...head, children });
      continue;
    }
    errors.push(`Epic #${head.number} が読めませんでした`);
    const old = prev?.epics?.find((e) => e.number === head.number);
    if (old) stale.push(old);
  }

  const issueEpic: Record<string, number | null> = {};
  const used = new Set<number>(stale.map((e) => e.number));
  for (const n of opts.issues) {
    const parents = read.filter((e) => e.children.some((c) => c.number === n)).map((e) => e.number);
    for (const e of stale) if (prev?.issueEpic?.[String(n)] === e.number) parents.push(e.number);
    const parent = parents.length > 0 ? Math.min(...parents) : null;
    issueEpic[String(n)] = parent;
    if (parent !== null) used.add(parent);
  }
  const epics = [...read, ...stale].filter((e) => used.has(e.number)).sort((a, b) => a.number - b.number);
  return { epics, issueEpic, errors };
}

/** 1回分を読み、スナップショットを書いて返す。読めなかったものは前回の値を使い、error に書く */
export function collectOnce(deps: CollectDeps, opts: CollectOptions): PaneSnapshot {
  const prev = deps.readSnapshot(opts.snapshotPath);
  const env = childEnv(deps.env, opts.session);
  const errors: string[] = [];
  const agent = (args: string[]): RunResult => deps.run(deps.node, ['harness/scripts/agent.ts', ...args], { cwd: deps.root, env });

  let status: FleetStatusData | null = prev?.status ?? null;
  const fs = agent(['fleet-status', '--json', ...opts.issues.map(String)]);
  const parsed = fs.status === 0 ? (parseJson(fs.stdout) as FleetStatusData | null) : null;
  if (parsed && parsed.version === 1 && Array.isArray(parsed.rows)) status = parsed;
  else errors.push(`fleet-status が読めませんでした${lastLine(fs.stderr) ? `（${lastLine(fs.stderr)}）` : ''}`);

  // Epic の子課題（読めなければ前回の値。fleet の Issue が0件なら graphql を呼ばない）
  let epics = prev?.epics;
  let issueEpic = prev?.issueEpic;
  if (opts.issues.length > 0) {
    const e = collectEpics(deps, opts, prev, env);
    if (e) {
      ({ epics, issueEpic } = e);
      errors.push(...e.errors);
    } else errors.push('Epic が読めませんでした');
  }

  const prs: PanePr[] = [];
  for (const n of [...new Set((status?.rows ?? []).map((r) => r.pr).filter((p): p is number => p !== null))]) {
    const r = deps.run('gh', ['pr', 'view', String(n), '--json', PR_FIELDS], { cwd: deps.root, env });
    const pr = r.status === 0 ? prOf(r.stdout) : null;
    if (pr) {
      prs.push(pr);
      continue;
    }
    errors.push(`PR #${n} が読めませんでした`);
    const old = prev?.prs.find((p) => p.number === n);
    if (old) prs.push(old);
  }

  // fleet のセッションの記録だけを読む（無ければ最も新しい記録に戻らない）
  const file = join(projectTranscriptDir(opts.transcriptCwd, deps.home), `${opts.session}.jsonl`);
  let usage: PaneUsage | null = null;
  if (deps.exists(file)) {
    const r = agent(['usage', file]);
    usage = r.status === 0 ? usageOf(r.stdout) : null;
  }

  const at = deps.now().toISOString();
  const snap: PaneSnapshot = {
    version: 1,
    at,
    session: opts.session,
    label: opts.label,
    intervalSeconds: opts.intervalSeconds,
    issues: [...opts.issues],
    status,
    prs,
    usage,
    history: [...(prev?.history ?? []), { at, totalUsd: usage?.totalUsd ?? null }].slice(-HISTORY_LIMIT),
    since: nextSince(prev?.since ?? null, status?.rows ?? [], at),
    ...(epics !== undefined ? { epics } : {}),
    ...(issueEpic !== undefined ? { issueEpic } : {}),
    error: errors.length > 0 ? errors.join(' / ') : null,
  };
  deps.writeSnapshot(opts.snapshotPath, snap);
  return snap;
}

export type Schedule = (fn: () => void, ms: number) => unknown;

/** すぐ1回読み、以後は設定の間隔（秒 × 1000）ごとに読む。1回の失敗で止めない */
export function startCollect(deps: CollectDeps, opts: CollectOptions, schedule: Schedule): void {
  const tick = (): void => {
    try {
      collectOnce(deps, opts);
    } catch (e) {
      console.error(e);
    }
  };
  tick();
  schedule(tick, opts.intervalSeconds * 1000);
}

/** 描くだけのペインが外に触るもの（スナップショットを読むことと、画面に書くことだけ） */
export interface RenderDeps {
  readSnapshot(): PaneSnapshot | null;
  write(text: string): void;
  now(): number;
  width(): number;
}

/** すぐ1回描き、以後は ms ごとにスナップショットを読み直して描く */
export function startRender(deps: RenderDeps, draw: (snap: PaneSnapshot | null, now: number, width: number) => string, schedule: Schedule, ms = 5000): void {
  const tick = (): void => deps.write(`${CLEAR_SCREEN}${draw(deps.readSnapshot(), deps.now(), deps.width())}`);
  tick();
  schedule(tick, ms);
}

/** 描く hq のペインが外に触るもの（控えとスナップショットを読むことと、画面に書くことだけ。run は無いので GitHub を読めない） */
export interface HqRenderDeps {
  readLedger(): { fleets: Record<string, unknown>[] } | null;
  readSnapshot(session: string): PaneSnapshot | null;
  write(text: string): void;
  now(): number;
  width(): number;
  height(): number;
  /** HQ_STALL_DEFAULTS.staleSnapshotMinutes */
  staleMinutes: number;
}

/** すぐ1回描き、以後は ms ごとに控えとスナップショットを読み直して描く。描き直す関数を返す（キーでページを変えたときに呼ぶ） */
export function startHqRender(deps: HqRenderDeps, draw: (view: HqView, now: number, width: number, height: number) => string, schedule: Schedule, ms = 5000): () => void {
  const tick = (): void => {
    const now = deps.now();
    const view = readHqView(deps.readLedger(), (s) => deps.readSnapshot(s), now, deps.staleMinutes);
    deps.write(`${CLEAR_SCREEN}${draw(view, now, deps.width(), deps.height())}`);
  };
  tick();
  schedule(tick, ms);
  return tick;
}

/** todo のペインの描き方。hq がいない間の fleet の控え（答えの無い質問）があれば先頭に出す。session が無ければスナップショットの session で引く */
export function todoDraw(session: string | null, readPending: (session: string) => PendingFile | null): (snap: PaneSnapshot | null, now: number, width: number) => string {
  return (snap, now, width) => {
    const body = renderTodo(snap, now, width);
    const id = session ?? snap?.session ?? null;
    const lines = id ? renderPending(readPending(id)) : [];
    return lines.length > 0 ? [...lines, '', body].join('\n') : body;
  };
}

/** スナップショットの既定の置き場所。セッション ID は記録のファイル名に使える形だけを受け付ける */
export function defaultSnapshotPath(tmp: string, session: string): string {
  if (!TRANSCRIPT_SESSION_ID.test(session)) throw new Error(`セッション ID の形が違います：${session}`);
  return join(tmp, 'agent-harness-panes', `${session}.json`);
}

/** Claude Code の status line に出す1行。スナップショットが無い・status が無い・行が無ければ null。古ければ末尾に更新の時刻を足す */
export function fleetStatusLine(snap: PaneSnapshot | null, now: number): string | null {
  const rows = snap?.status?.rows ?? [];
  if (!snap || rows.length === 0) return null;
  const parts = rows.map((row) => {
    const at = locateRow(row);
    const step = typeof at.step === 'number' ? (PANE_STEPS[at.step] ?? '') : at.step === 'done' ? '済' : at.step === 'stopped' ? '停止' : 'Epic';
    const mark = at.other ? '（他）' : at.who === 'human' ? '（人）' : at.who === 'wait' ? '（待ち）' : '';
    return `#${row.issue} ${step}${mark}`;
  });
  const stale = now - Date.parse(snap.at) > snap.intervalSeconds * 3000;
  return `fleet ${parts.join(' · ')}${stale ? ` · 更新 ${ago(snap.at, now)}` : ''}`;
}

// ---- CLI（import.meta.main の中だけで動く） ----

function readSnapshotFile(path: string): PaneSnapshot | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as PaneSnapshot;
    return j && j.version === 1 ? j : null;
  } catch {
    return null;
  }
}

/** 一時ファイルに書いてから名前を変える（読む側が書きかけを読まない） */
function writeSnapshotFile(path: string, snap: PaneSnapshot): void {
  writeLocalFile(path, JSON.stringify(snap));
}

/** hq todo --json の出力（Claude Code の mod が読む。mods/agent-harness/types/index.d.ts の HqTodo と同じ形） */
export interface HqTodoJson {
  version: 1;
  ledger: boolean;
  count: number;
  items: { theme: string; issue: number; pr: number | null; text: string; sub: string }[];
  warning: string | null;
}

/** renderHqTodo と同じ集め方（全 fleet の todoItems を rank 順）を、色なしの JSON の形にする */
export function hqTodoJson(view: HqView, now: number): HqTodoJson {
  const items = view.fleets
    .flatMap((v) => (v.snap ? todoItems(v.snap).map((it) => ({ it, theme: v.fleet.theme })) : []))
    .sort((a, b) => a.it.rank - b.it.rank)
    .map(({ it, theme }) => ({ theme, issue: it.issue, pr: it.pr, text: it.text, sub: it.sub }));
  return { version: 1, ledger: view.ledger, count: items.length, items, warning: hqWarning(view, now) };
}

/** hq board --json の出力（Claude Code の mod が読む。mods/agent-harness/types/index.d.ts の HqBoard と同じ形） */
export interface HqBoardJson {
  version: 1;
  ledger: boolean;
  warning: string | null;
  steps: string[];
  epics: { number: number; title: string | null; closed: number | null; total: number | null; waiting: number; themes: string[]; done: boolean }[];
  none: { issues: number[]; done: boolean } | null;
  groups: {
    title: string;
    epic: number | null;
    done: boolean;
    rows: { issue: number; title: string; marks: string[]; kind: keyof typeof MARKS; label: string; what: string; pr: number | null; since: string; waitReason: string | null }[];
    merged: number[];
  }[];
}

const allMerged = (rows: FleetRow[]): boolean => rows.length > 0 && rows.every(({ row }) => row.stage === 'merged');

/** progressBar と同じ判定で、6つの段階の記号（色なし）を返す */
function boardMarks(at: ReturnType<typeof locateRow>): string[] {
  return PANE_STEPS.map((_, i) => {
    if (at.step === 'stopped') return MARKS.stopped.mark;
    if (at.step === 'epic') return i === 0 ? MARKS.epic.mark : ' ';
    if (at.step === 'done' || i < at.step) return MARKS.done.mark;
    if (i === at.step) return MARKS[WHO_MARK[at.who]].mark;
    return MARKS.todo.mark;
  });
}

const todoCountOf = (rows: FleetRow[]): number => rows.filter(({ view: v, row }) => v.snap && todoItems(v.snap).some((it) => it.issue === row.issue)).length;
const byDone = <T>(items: T[], done: (t: T) => boolean): T[] => [...items.filter((t) => !done(t)), ...items.filter(done)];

function boardRows(rows: FleetRow[], now: number): HqBoardJson['groups'][number]['rows'] {
  return rows
    .filter(({ row }) => row.stage !== 'merged')
    .map(({ view: v, row }) => {
      const at = locateRow(row);
      const kind = at.other ? 'ai' : WHO_MARK[at.who];
      return {
        issue: row.issue,
        title: shortTitle(row.title),
        marks: boardMarks(at),
        kind,
        label: at.other ? `${MARKS.ai.mark} ほかのセッションが作業中` : `${MARKS[kind].mark} ${MARKS[kind].meaning}`,
        what: at.what,
        pr: row.pr,
        since: ago(v.snap?.since[String(row.issue)]?.at, now),
        waitReason: !row.selected ? row.waitReason : null,
      };
    });
}

/** renderHqBoard の Epic のページ・Issue のページと同じ集め方を、色なしの JSON の形にする。終わったものは done にして下に回す */
export function hqBoardJson(view: HqView, now: number): HqBoardJson {
  const warning = hqWarning(view, now);
  if (!view.ledger) return { version: 1, ledger: false, warning, steps: [...PANE_STEPS], epics: [], none: null, groups: [] };
  const { epics, none } = groupByEpic(view);
  const epicDone = (g: EpicGroup): boolean =>
    (g.children !== null && g.children.length > 0 && g.children.every((c) => c.state === 'CLOSED')) || allMerged(g.rows) || g.state === 'CLOSED';
  const noneDone = allMerged(none);
  const merged = (rows: FleetRow[]): number[] => rows.filter(({ row }) => row.stage === 'merged').map(({ row }) => row.issue);
  const epicItems = epics.map((g) => ({ g, done: epicDone(g) }));
  const groups: HqBoardJson['groups'] = byDone(
    [
      ...epicItems.map(({ g, done }) => ({
        title: `#${g.number}${g.title ? ` ${shortTitle(g.title)}` : ''}（${[...g.themes].join('・')}）`,
        epic: g.number as number | null,
        done,
        rows: boardRows(g.rows, now),
        merged: merged(g.rows),
      })),
      ...(none.length > 0 ? [{ title: 'Epic なし', epic: null as number | null, done: noneDone, rows: boardRows(none, now), merged: merged(none) }] : []),
    ],
    (g) => g.done,
  );
  return {
    version: 1,
    ledger: true,
    warning,
    steps: [...PANE_STEPS],
    epics: byDone(
      epicItems.map(({ g, done }) => ({
        number: g.number,
        title: g.title,
        closed: g.children ? g.children.filter((c) => c.state === 'CLOSED').length : null,
        total: g.children ? g.children.length : null,
        waiting: todoCountOf(g.rows),
        themes: [...g.themes],
        done,
      })),
      (e) => e.done,
    ),
    none: none.length > 0 ? { issues: none.map(({ row }) => row.issue), done: noneDone } : null,
    groups,
  };
}

interface CliArgs {
  sessions: string[];
  label: string | null;
  snapshot: string | null;
  cwd: string | null;
  fleets: string | null;
  once: boolean;
  json: boolean;
  issues: number[];
}

function parseCli(args: string[]): CliArgs {
  const out: CliArgs = { sessions: [], label: null, snapshot: null, cwd: null, fleets: null, once: false, json: false, issues: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} に値がありません`);
      return v;
    };
    if (a === '--session') out.sessions.push(value());
    else if (a === '--label') out.label = value();
    else if (a === '--snapshot') out.snapshot = value();
    else if (a === '--cwd') out.cwd = value();
    else if (a === '--fleets') out.fleets = value();
    else if (a === '--once') out.once = true;
    else if (a === '--json') out.json = true;
    else if (/^\d+$/.test(a)) out.issues.push(Number(a));
    else throw new Error(`知らない引数：${a}`);
  }
  return out;
}

// ---- idle（長く出力の無い claude のタブ。Issue #826） ----

export interface IdleTab {
  handle: string;
  minutes: number;
  title: string;
  worktreePath: string;
}

/** lastOutputAt（エポックのミリ秒の数か Date.parse できる文字列）をミリ秒にする。読めなければ null */
function outputAtMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

/** Orca の terminal list --json の結果から、minutes 分以上（境界は以上）出力の無い claude のタブを選ぶ（exclude の handle は除く） */
export function idleTabs(list: unknown, now: number, minutes: number, exclude: readonly string[]): { ok: true; tabs: IdleTab[] } | { ok: false; reason: string } {
  const terminals = (list as { result?: { terminals?: unknown } } | null)?.result?.terminals;
  if (!Array.isArray(terminals)) return { ok: false, reason: 'result.terminals が配列ではありません' };
  const tabs: IdleTab[] = [];
  for (const t of terminals as Record<string, unknown>[]) {
    if (!t || typeof t.handle !== 'string' || t.agentIdentity !== 'claude' || exclude.includes(t.handle)) continue;
    const at = outputAtMs(t.lastOutputAt);
    if (at === null) continue;
    const idle = Math.floor((now - at) / 60000);
    if (idle < minutes) continue;
    tabs.push({ handle: t.handle, minutes: idle, title: typeof t.title === 'string' ? t.title : '', worktreePath: typeof t.worktreePath === 'string' ? t.worktreePath : '' });
  }
  return { ok: true, tabs };
}

export function renderIdleTab(tab: IdleTab): string {
  return `長く出力の無いタブ：${tab.handle}・${tab.minutes}分・${tab.title}（${tab.worktreePath}）`;
}

/** Orca を1回呼び、出す行を返す。読めなければ1行の案内だけ（hq の見回しを止めない） */
export function readIdleTabs(run: (cmd: string, args: string[]) => RunResult, cmd: string, now: number, minutes: number, exclude: readonly string[]): string[] {
  const unreadable = (why: string): string[] => [`Orca のタブの一覧を読めません（${why}）`];
  const r = run(cmd, ['terminal', 'list', '--json']);
  if (r.status !== 0) {
    const last = r.stderr.trim().split('\n').pop() || '';
    return unreadable(last || `終了コード ${r.status}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return unreadable('JSON ではありません');
  }
  const res = idleTabs(json, now, minutes, exclude);
  return res.ok ? res.tabs.map(renderIdleTab) : unreadable(res.reason);
}

export function parseIdleArgs(args: string[]): { excludes: string[]; minutes: number | null } {
  const out: { excludes: string[]; minutes: number | null } = { excludes: [], minutes: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--exclude') {
      const v = args[++i];
      if (!v) throw new Error('--exclude には handle を渡してください');
      out.excludes.push(v);
    } else if (a === '--minutes') {
      const v = args[++i];
      if (!v || !/^[1-9]\d*$/.test(v)) throw new Error('--minutes は正の整数で渡してください');
      out.minutes = Number(v);
    } else throw new Error(`知らない引数：${a}`);
  }
  return out;
}

function mainIdle(rest: string[]): void {
  const a = parseIdleArgs(rest);
  const minutes = a.minutes ?? HQ_STALL_DEFAULTS.stuckMinutes;
  const run = (cmd: string, args: string[]): RunResult => {
    const r = spawnSync(cmd, args, { shell: false, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error) return { status: null, stdout: '', stderr: r.error.message };
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  for (const line of readIdleTabs(run, orcaCliCommand(process.platform, process.env), Date.now(), minutes, a.excludes)) console.log(line);
}

const USAGE = 'panes.ts collect --session <ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <パス>] <Issue 番号>... | progress|todo|prs (--session <ID> | --snapshot <パス>) | hq todo|board|log [--once] [--fleets <パス>] | hq todo|board --json [--fleets <パス>] | fleets --session <ID>... | idle [--minutes <分>] [--exclude <handle>]... | line (--session <ID> | --snapshot <パス>) | config';

function main(argv: string[]): void {
  const [mode, ...rest] = argv;
  if (mode === 'line') {
    const a = parseCli(rest);
    const path = a.snapshot ?? (a.sessions[0] ? defaultSnapshotPath(tmpdir(), a.sessions[0]) : null);
    if (!path) throw new Error(`--session か --snapshot を渡してください（${USAGE}）`);
    const text = fleetStatusLine(readSnapshotFile(path), Date.now());
    if (text !== null) console.log(text);
    return;
  }
  const config = loadConfig();
  const ship = shipModeConfig(config);
  if (mode === 'config') {
    console.log(JSON.stringify({ ...ship, ...implementModelConfig(config), ...hqConfig(config), ...panesConfig(config) }, null, 2));
    if (ship.stopReason) {
      console.error(ship.stopReason);
      process.exit(1);
    }
    return;
  }
  if (mode === 'hq') return mainHq(rest, config);
  if (mode === 'idle') return mainIdle(rest);
  const args = parseCli(rest);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const every: Schedule = (fn, ms) => setInterval(fn, ms);
  const renderDeps = (path: string): RenderDeps => ({
    readSnapshot: () => readSnapshotFile(path),
    write: (t) => void process.stdout.write(t),
    now: () => Date.now(),
    width: () => Math.max(40, (process.stdout.columns || 80) - 1),
  });
  const pathOf = (session: string | undefined): string => {
    if (args.snapshot) return args.snapshot;
    if (!session) throw new Error(`--session か --snapshot を渡してください（${USAGE}）`);
    return defaultSnapshotPath(tmpdir(), session);
  };

  if (mode === 'collect') {
    const session = args.sessions[0];
    if (!session || args.issues.length === 0) throw new Error(USAGE);
    const opts: CollectOptions = {
      session,
      label: args.label,
      issues: args.issues,
      snapshotPath: pathOf(session),
      transcriptCwd: args.cwd ?? process.cwd(),
      intervalSeconds: panesConfig(config).collectIntervalSeconds,
      config,
    };
    const deps: CollectDeps = {
      run: (cmd, a, o) => {
        const r = spawnSync(cmd, a, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
      exists: existsSync,
      readSnapshot: readSnapshotFile,
      writeSnapshot: writeSnapshotFile,
      now: () => new Date(),
      env: process.env,
      root,
      home: homedir(),
      node: process.execPath,
    };
    startCollect(deps, opts, every);
    startRender(renderDeps(opts.snapshotPath), renderProgress, every);
    return;
  }
  if (mode === 'progress' || mode === 'todo' || mode === 'prs') {
    const commonDir = mode === 'todo' ? gitCommonDir(root) : null;
    const readPending = (id: string): PendingFile | null => {
      if (!commonDir) return null;
      try {
        return readPendingFile(commonDir, id);
      } catch {
        return null;
      }
    };
    const draw = { progress: renderProgress, todo: todoDraw(args.sessions[0] ?? null, readPending), prs: renderPrs }[mode];
    startRender(renderDeps(pathOf(args.sessions[0])), draw, every);
    return;
  }
  if (mode === 'fleets') {
    if (args.sessions.length === 0) {
      console.error(`--session を1つ以上渡してください（${USAGE}）`);
      process.exit(1);
    }
    const cfg = HQ_STALL_DEFAULTS;
    const now = Date.now();
    const out = args.sessions.map((s) => {
      const snap = readSnapshotFile(defaultSnapshotPath(tmpdir(), s));
      return snap ? fleetStall(snap, now, cfg) : missingFleet(s);
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  throw new Error(USAGE);
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** hq todo|board|log（Issue #402）。控えから fleet を読むので --session・--snapshot・Issue 番号は受け付けない */
function mainHq(argv: string[], config: ReturnType<typeof loadConfig>): void {
  // ペインの名前が無ければ todo（hq の人待ち）。`panes.ts hq` だけで呼ぶ案内（intel の skill など）もそのまま動く
  const [first, ...more] = argv;
  const named = first === 'todo' || first === 'board' || first === 'log';
  const pane = named ? first : 'todo';
  const rest = named ? more : argv;
  if (pane !== 'todo' && pane !== 'board' && pane !== 'log') throw new Error(USAGE);
  const args = parseCli(rest);
  if (args.sessions.length > 0 || args.snapshot || args.issues.length > 0) throw new Error(`hq のペインは --session・--snapshot・Issue 番号を受け付けません（hq の控えから今動いている fleet を読みます。${USAGE}）`);
  if (args.json && pane !== 'todo' && pane !== 'board') throw new Error(`--json は hq todo・hq board だけです（${USAGE}）`);
  const { maxFleets } = hqConfig(config);
  const { staleSnapshotMinutes } = HQ_STALL_DEFAULTS;
  const root = fileURLToPath(new URL('../..', import.meta.url));
  let path = args.fleets;
  if (!path) {
    const common = gitCommonDir(root);
    if (!common) throw new Error('git の共通ディレクトリが分かりません（--fleets で控えのパスを渡してください）');
    path = ledgerPath(common);
  }
  const ledgerFile = path;
  const heartbeatFile = join(dirname(ledgerFile), HEARTBEAT_FILE);
  let page: BoardPage = 'epic';
  const draw = (view: HqView, now: number, width: number, height: number): string => {
    if (pane === 'todo') return renderHqTodo(view, now, width, maxFleets);
    if (pane === 'board') return renderHqBoard(view, page, now, width);
    return renderHqLog(view, now, width, height, freshHeartbeats(readHeartbeatAt(heartbeatFile), view.fleets.map((f) => f.fleet.theme), now, staleSnapshotMinutes));
  };
  const deps: HqRenderDeps = {
    readLedger: () => parseLedger(readJsonFile(ledgerFile)),
    readSnapshot: (session) => {
      try {
        return readSnapshotFile(defaultSnapshotPath(tmpdir(), session));
      } catch {
        return null;
      }
    },
    write: (t) => void process.stdout.write(t),
    now: () => Date.now(),
    width: () => Math.max(40, (process.stdout.columns || 80) - 1),
    height: () => Math.max(5, (process.stdout.rows || 24) - 1),
    staleMinutes: staleSnapshotMinutes,
  };
  if (args.json) {
    const now = deps.now();
    const view = readHqView(deps.readLedger(), (s) => deps.readSnapshot(s), now, staleSnapshotMinutes);
    console.log(JSON.stringify(pane === 'board' ? hqBoardJson(view, now) : hqTodoJson(view, now)));
    return;
  }
  if (args.once) {
    const now = deps.now();
    const view = readHqView(deps.readLedger(), (s) => deps.readSnapshot(s), now, staleSnapshotMinutes);
    console.log(stripAnsi(draw(view, now, deps.width(), pane === 'log' ? 1000 : deps.height())));
    return;
  }
  const redraw = startHqRender(deps, draw, (fn, ms) => setInterval(fn, ms));
  if (pane === 'board' && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\u0003') process.exit(0);
      const next = nextBoardPage(page, key);
      if (next !== page) {
        page = next;
        redraw();
      }
    });
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
