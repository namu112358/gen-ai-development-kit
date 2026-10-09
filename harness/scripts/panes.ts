/**
 * fleet と hq のワークスペースのペイン表示（進み具合・人がすること・PR と費用）。読むだけで、GitHub にもリポジトリにも書かない。
 *
 *   node harness/scripts/panes.ts collect --session <fleet のセッション ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...
 *   node harness/scripts/panes.ts progress|todo|prs (--session <ID> | --snapshot <パス>)（todo は hq がいない間の控えの質問も出す）
 *   node harness/scripts/panes.ts hq [todo|board|log] [--once] [--fleets <控えのパス>]（ペインの名前が無ければ todo）
 *   node harness/scripts/panes.ts fleets --session <ID> [--session <ID>...]
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
 * - hq todo|board|log：hq の3つのペイン（① 人待ち・② Epic/Issue・③ ログ。描き方は harness/lib/panes-hq.ts。Issue #402）。GitHub を読まない。
 *   数秒ごとに hq の控え（hq-state.ts の git の共通ディレクトリの下の hq-fleets.json。--fleets で別のパス）を読み直し、控えの fleets の
 *   session のスナップショットだけを読む（--session は渡さない。起こし直しで hq が控えの session を書き換えれば、ペインを作り直さずに追う）。
 *   board は標準入力が端末なら Tab・e・i でページ（Epic・Issue）を切り替える（q・Ctrl+C で終わる）。--once は1回だけ色なしで描いて終わる。
 * - fleets：渡した fleet のスナップショットを1回読み、進んでいないかの判定（harness/lib/hq-stall.ts の fleetStall。しきい値は
 *   hq.staleSnapshotMinutes・hq.stuckMinutes）の配列を JSON で出して終わる（hq が読む。Issue #287）。無いスナップショットは missing。
 *   終わった fleet の古いスナップショットも一時ディレクトリに残るので、--session は必ず渡す（無ければ終了コード 1）。
 * - config：fleet.shipMode・fleet.implementModel・hq・panes の設定を JSON で出す。shipModeConfig が止める理由（stopReason）を返したときだけ、理由を標準エラーに出して終了コード 1（今は subagent・worker とも null）。
 * - スナップショットの既定の置き場所は OS の一時ディレクトリの agent-harness-panes/<セッション ID>.json。
 * 段階の読み替えと描き方は harness/lib/panes.ts・harness/lib/panes-hq.ts。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, hqConfig, implementModelConfig, loadConfig, panesConfig, shipModeConfig, type HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import { epicChildrenFromRecords } from '../lib/session-inputs.ts';
import { fleetStall, hqStallConfig, missingFleet } from '../lib/hq-stall.ts';
import type { FleetStatusData } from '../lib/fleet.ts';
import { CLEAR_SCREEN, HISTORY_LIMIT, nextSince, renderProgress, renderPrs, renderTodo, stripAnsi, type PaneEpic, type PaneEpicIssue, type PanePr, type PaneSnapshot, type PaneUsage } from '../lib/panes.ts';
import { nextBoardPage, readHqView, renderHqBoard, renderHqLog, renderHqTodo, type BoardPage, type HqView } from '../lib/panes-hq.ts';
import { TRANSCRIPT_SESSION_ID } from '../lib/session.ts';
import { gitCommonDir, ledgerPath, parseLedger, readPendingFile, renderPending, type PendingFile } from './hq-state.ts';
import { projectTranscriptDir } from '../lib/usage.ts';

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
  /** hq.staleSnapshotMinutes */
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
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, path);
}

interface CliArgs {
  sessions: string[];
  label: string | null;
  snapshot: string | null;
  cwd: string | null;
  fleets: string | null;
  once: boolean;
  issues: number[];
}

function parseCli(args: string[]): CliArgs {
  const out: CliArgs = { sessions: [], label: null, snapshot: null, cwd: null, fleets: null, once: false, issues: [] };
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
    else if (/^\d+$/.test(a)) out.issues.push(Number(a));
    else throw new Error(`知らない引数：${a}`);
  }
  return out;
}

const USAGE = 'panes.ts collect --session <ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <パス>] <Issue 番号>... | progress|todo|prs (--session <ID> | --snapshot <パス>) | hq todo|board|log [--once] [--fleets <パス>] | fleets --session <ID>... | config';

function main(argv: string[]): void {
  const [mode, ...rest] = argv;
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
    const cfg = hqStallConfig(config);
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
  const { maxFleets } = hqConfig(config);
  const { staleSnapshotMinutes } = hqStallConfig(config);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  let path = args.fleets;
  if (!path) {
    const common = gitCommonDir(root);
    if (!common) throw new Error('git の共通ディレクトリが分かりません（--fleets で控えのパスを渡してください）');
    path = ledgerPath(common);
  }
  const ledgerFile = path;
  let page: BoardPage = 'epic';
  const draw = (view: HqView, now: number, width: number, height: number): string => {
    if (pane === 'todo') return renderHqTodo(view, now, width, maxFleets);
    if (pane === 'board') return renderHqBoard(view, page, now, width);
    return renderHqLog(view, now, width, height);
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
