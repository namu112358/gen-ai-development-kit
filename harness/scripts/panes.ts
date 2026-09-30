/**
 * fleet と hq のワークスペースのペイン表示（進み具合・人がすること・PR と費用）。読むだけで、GitHub にもリポジトリにも書かない。
 *
 *   node harness/scripts/panes.ts collect --session <fleet のセッション ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <fleet の作業ディレクトリ>] <Issue 番号>...
 *   node harness/scripts/panes.ts progress|todo|prs (--session <ID> | --snapshot <パス>)（todo は hq がいない間の控えの質問も出す）
 *   node harness/scripts/panes.ts hq --session <ID> [--session <ID>...]
 *   node harness/scripts/panes.ts fleets --session <ID> [--session <ID>...]
 *   node harness/scripts/panes.ts config
 *
 * - collect：GitHub と記録を読むのはこれだけ。harness.config.json の panes.collectIntervalSeconds（既定 180 秒）ごとに、
 *   fleet-status --json（fleet のセッションとして。AGENT_HARNESS_SESSION をその ID にし、CLAUDE_CODE_REMOTE_SESSION_ID を消す）・
 *   行の PR（gh pr view）・fleet のセッションの usage（`~/.claude/projects/<作業ディレクトリ>/<ID>.jsonl`。無ければ読まない）を読み、
 *   スナップショット（harness/lib/panes.ts の PaneSnapshot）を一時ファイルに書いてから名前を変える。このペインは進み具合も描く。
 *   記録のディレクトリは作業ディレクトリごとに分かれるので、fleet のセッションの作業ディレクトリが collect と違えば --cwd で渡す。
 * - progress・todo・prs・hq：スナップショットを数秒ごとに読み直して描くだけ（GitHub を読まない）。
 *   todo は、hq がいない間に fleet が控えた質問（harness/scripts/hq-state.ts の git の共通ディレクトリの下の控え）があれば先頭に出す（Issue #409）。
 *   控えは --session の ID で引き、--snapshot だけのときはスナップショットの session で引く。
 * - fleets：渡した fleet のスナップショットを1回読み、進んでいないかの判定（harness/lib/hq-stall.ts の fleetStall。しきい値は
 *   hq.staleSnapshotMinutes・hq.stuckMinutes）の配列を JSON で出して終わる（hq が読む。Issue #287）。無いスナップショットは missing。
 *   終わった fleet の古いスナップショットも一時ディレクトリに残るので、--session は必ず渡す（無ければ終了コード 1）。
 * - config：fleet.shipMode・hq・panes の設定を JSON で出す。shipModeConfig が止める理由（stopReason）を返したときだけ、理由を標準エラーに出して終了コード 1（今は subagent・worker とも null）。
 * - スナップショットの既定の置き場所は OS の一時ディレクトリの agent-harness-panes/<セッション ID>.json。
 * 段階の読み替えと描き方は harness/lib/panes.ts。CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hqConfig, loadConfig, panesConfig, shipModeConfig } from '../lib/config.ts';
import { fleetStall, hqStallConfig, missingFleet } from '../lib/hq-stall.ts';
import type { FleetStatusData } from '../lib/fleet.ts';
import { CLEAR_SCREEN, HISTORY_LIMIT, nextSince, renderHq, renderProgress, renderPrs, renderTodo, type PanePr, type PaneSnapshot, type PaneUsage } from '../lib/panes.ts';
import { TRANSCRIPT_SESSION_ID } from '../lib/session.ts';
import { gitCommonDir, readPendingFile, renderPending, type PendingFile } from './hq-state.ts';
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
  issues: number[];
}

function parseCli(args: string[]): CliArgs {
  const out: CliArgs = { sessions: [], label: null, snapshot: null, cwd: null, issues: [] };
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
    else if (/^\d+$/.test(a)) out.issues.push(Number(a));
    else throw new Error(`知らない引数：${a}`);
  }
  return out;
}

const USAGE = 'panes.ts collect --session <ID> [--label <テーマ>] [--snapshot <パス>] [--cwd <パス>] <Issue 番号>... | progress|todo|prs (--session <ID> | --snapshot <パス>) | hq --session <ID>... | fleets --session <ID>... | config';

function main(argv: string[]): void {
  const [mode, ...rest] = argv;
  const config = loadConfig();
  const ship = shipModeConfig(config);
  if (mode === 'config') {
    console.log(JSON.stringify({ ...ship, ...hqConfig(config), ...panesConfig(config) }, null, 2));
    if (ship.stopReason) {
      console.error(ship.stopReason);
      process.exit(1);
    }
    return;
  }
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
  if (mode === 'hq') {
    if (args.sessions.length === 0) throw new Error(USAGE);
    const { maxFleets } = hqConfig(config);
    const paths = args.sessions.map((s) => defaultSnapshotPath(tmpdir(), s));
    const w = (): number => Math.max(40, (process.stdout.columns || 80) - 1);
    const tick = (): void => {
      const snaps = paths.map(readSnapshotFile).filter((s): s is PaneSnapshot => s !== null);
      process.stdout.write(`${CLEAR_SCREEN}${renderHq(snaps, Date.now(), w(), maxFleets)}\n`);
    };
    tick();
    every(tick, 5000);
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
