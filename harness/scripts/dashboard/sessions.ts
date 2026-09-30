/**
 * 手元の Claude Code のセッション記録（`~/.claude/projects/<ディレクトリ>/<セッション ID>.jsonl`）を読み、
 * セッションごとの最後に動いた時刻・ブランチ・サブエージェント（`<ID>/subagents/agent-*.meta.json`）を返す。
 * 会話の中身は返さない。読めない・形の違うファイルは飛ばし、例外を投げない（Claude Code の版の違いで全体を落とさない）。
 * worktree の置き場所は harness/lib/worktree.ts の worktreeRoot で決める（呼び出し元が worktreesDir で渡す。無ければ既定の置き場所）。
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, resolve } from 'node:path';
import { worktreeRoot } from '../../lib/worktree.ts';

export interface SubagentInfo {
  id: string;
  type: string;
  description: string;
  lastAt: string | null;
  running: boolean;
}

export interface SessionInfo {
  /** jsonl のファイル名（.jsonl を除く）＝ セッション ID */
  id: string;
  lastAt: string | null;
  branch: string | null;
  cwd: string | null;
  /** branch の `claude/issue-<n>-`、無ければ cwd の `claude-issue-<n>-` から */
  issue: number | null;
  running: boolean;
  subagents: SubagentInfo[];
}

export interface ReadOptions {
  projectsDir: string;
  repoRoot: string;
  now: Date;
  /** 最後の時刻がこれ以内なら動いているとみなす（既定 90 秒） */
  activeWindowMs?: number;
  /** これより古いセッションは返さない（既定 12 時間） */
  maxAgeMs?: number;
  /** worktree の置き場所（worktreeRoot で決めたもの。無ければ既定の `<親>/<名前>.worktrees`） */
  worktreesDir?: string;
}

const TAIL_BYTES = 64 * 1024;

/** ~/.claude/projects の下のディレクトリ名：パスの英数字以外を '-' にしたもの */
export function projectDirName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/** リポジトリそのものか、その worktree の置き場所（既定は harness/lib/worktree.ts の worktreeRoot の既定）の下のディレクトリ名か */
export function isRepoProjectDir(dirName: string, repoRoot: string, worktreesDir: string = worktreeRoot(repoRoot)): boolean {
  return dirName === projectDirName(resolve(repoRoot)) || dirName.startsWith(`${projectDirName(resolve(worktreesDir))}-`);
}

export function issueFromBranch(branchOrCwd: string | null): number | null {
  if (!branchOrCwd) return null;
  const m = branchOrCwd.match(/claude[/-]issue-(\d+)-/);
  return m ? Number(m[1]) : null;
}

/** ファイルの末尾（最大 64KB）の行。先頭の切れた行は捨てる */
function tailLines(file: string): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim() !== '');
  } catch {
    return [];
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface Tail { lastAt: string | null; branch: string | null; cwd: string | null }

function readTail(file: string): Tail {
  const out: Tail = { lastAt: null, branch: null, cwd: null };
  for (const line of tailLines(file)) {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.timestamp === 'string' && !Number.isNaN(Date.parse(r.timestamp)) && (out.lastAt === null || r.timestamp > out.lastAt)) out.lastAt = r.timestamp;
    if (typeof r.gitBranch === 'string' && r.gitBranch !== '') out.branch = r.gitBranch;
    if (typeof r.cwd === 'string' && r.cwd !== '') out.cwd = r.cwd;
  }
  return out;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readSubagents(dir: string, isRunning: (at: string | null) => boolean): SubagentInfo[] {
  const out: SubagentInfo[] = [];
  for (const name of listDir(dir)) {
    const m = name.match(/^agent-(.+)\.meta\.json$/);
    if (!m) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (typeof meta !== 'object' || meta === null) continue;
    const r = meta as Record<string, unknown>;
    const { lastAt } = readTail(join(dir, `agent-${m[1]}.jsonl`));
    out.push({
      id: m[1]!,
      type: typeof r.agentType === 'string' ? r.agentType : 'unknown',
      description: typeof r.description === 'string' ? r.description : '',
      lastAt,
      running: isRunning(lastAt),
    });
  }
  return out.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

/** リポジトリと worktree のセッションを、最後に動いた順に返す */
export function readSessions(opts: ReadOptions): SessionInfo[] {
  const active = opts.activeWindowMs ?? 90_000;
  const maxAge = opts.maxAgeMs ?? 12 * 3600_000;
  const now = opts.now.getTime();
  const isRunning = (at: string | null) => at !== null && now - Date.parse(at) <= active;
  const out: SessionInfo[] = [];
  for (const dirName of listDir(opts.projectsDir)) {
    if (!isRepoProjectDir(dirName, opts.repoRoot, opts.worktreesDir)) continue;
    const dir = join(opts.projectsDir, dirName);
    for (const name of listDir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      const tail = readTail(join(dir, name));
      const subagents = readSubagents(join(dir, id, 'subagents'), isRunning);
      const lastAt = [tail.lastAt, ...subagents.map((s) => s.lastAt)].filter((t): t is string => t !== null).sort().at(-1) ?? null;
      if (lastAt === null || now - Date.parse(lastAt) > maxAge) continue;
      out.push({
        id,
        lastAt,
        branch: tail.branch,
        cwd: tail.cwd,
        issue: issueFromBranch(tail.branch) ?? issueFromBranch(tail.cwd),
        running: isRunning(lastAt),
        subagents,
      });
    }
  }
  return out.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
}

/**
 * セッション記録の変化を見張り、onChange を呼ぶ（間引いて最大 debounceMs に1回）。
 * recursive の fs.watch が使えなければ intervalMs ごとの呼び出しに切り替える。running の判定を進めるため、どちらでも intervalMs ごとにも呼ぶ。
 */
export function watchSessions(projectsDir: string, onChange: () => void, opts: { intervalMs?: number; debounceMs?: number } = {}): () => void {
  const interval = opts.intervalMs ?? 2000;
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, opts.debounceMs ?? 300);
  };
  let watcher: FSWatcher | null = null;
  if (existsSync(projectsDir)) {
    try {
      watcher = watch(projectsDir, { recursive: true }, fire);
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      watcher = null;
    }
  }
  const tick = setInterval(onChange, interval);
  return () => {
    clearInterval(tick);
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
