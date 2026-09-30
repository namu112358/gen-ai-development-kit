/**
 * 書き換えの場所の見張りの hook（.claude/hooks/workspace-guard.ts）のテスト用の git の砂場と補助。一時ディレクトリに本体のリポジトリ（local の pull.ff・pull.rebase を引数で書ける）と Issue の worktree、通す置き場所を作り、hook の入力の組み立てと判定の検査を返す。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realContext, type Decision, type WorkspaceContext } from '../../../.claude/hooks/workspace-guard.ts';

/** git を動かし、失敗したら投げる */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** 一時ディレクトリを作り、実体のパスで返す（短い名前（8.3）やリンクで比べ方がずれないように） */
export function realTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * dir に main ブランチのリポジトリを作り、src/a.ts を1つ commit する。
 * separateGitDir を渡すと `git init --separate-git-dir` の形（作業ツリーと git のディレクトリが離れている）にする
 */
export function initRepo(dir: string, opts: { separateGitDir?: string } = {}): void {
  mkdirSync(dirname(dir), { recursive: true });
  if (opts.separateGitDir !== undefined) mkdirSync(dirname(opts.separateGitDir), { recursive: true });
  const sep = opts.separateGitDir !== undefined ? ['--separate-git-dir', opts.separateGitDir] : [];
  git(dirname(dir), 'init', '-q', '-b', 'main', ...sep, dir);
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@example.com');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'a\n');
  writeFileSync(join(dir, '.gitignore'), '.claude/worktrees/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
}

export interface GuardSandboxOptions {
  /** 本体の local に書く pull.ff（省くと書かない） */
  pullFf?: string;
  /** 本体の local に書く pull.rebase（省くと書かない） */
  pullRebase?: string;
  /** ほかに local に書く設定（branch.main.rebase など） */
  config?: Record<string, string>;
}

export interface GuardSandbox {
  base: string;
  /** 本体（main の checkout） */
  main: string;
  /** 本体の外（../repo.worktrees/）に置いた Issue の worktree（ブランチは claude/issue-1-x） */
  issueWt: string;
  /** 通す置き場所（allowRoots） */
  allowDir: string;
  /** realContext({ allowRoots: [allowDir] }) */
  ctx: WorkspaceContext;
  cleanup: () => void;
}

/** 一時ディレクトリに本体のリポジトリと Issue の worktree、通す置き場所を作る */
export function guardSandbox(opts: GuardSandboxOptions = {}): GuardSandbox {
  const base = realTempDir('workspace-guard-');
  const allowDir = realTempDir('workspace-guard-allow-');
  const main = join(base, 'repo');
  initRepo(main);
  if (opts.pullFf !== undefined) git(main, 'config', 'pull.ff', opts.pullFf);
  if (opts.pullRebase !== undefined) git(main, 'config', 'pull.rebase', opts.pullRebase);
  for (const [k, v] of Object.entries(opts.config ?? {})) git(main, 'config', k, v);
  const issueWt = join(base, 'repo.worktrees', 'claude-issue-1-x');
  git(main, 'worktree', 'add', '-q', '-b', 'claude/issue-1-x', issueWt);
  return {
    base,
    main,
    issueWt,
    allowDir,
    ctx: realContext({ allowRoots: [allowDir] }),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
      rmSync(allowDir, { recursive: true, force: true });
    },
  };
}

// ---- hook の入力 ----

export type Input = { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };

export const write = (file_path: string, cwd: string): Input => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd });
export const bash = (command: string, cwd: string): Input => ({ tool_name: 'Bash', tool_input: { command }, cwd });
/** Bash の文の中に書くパス（区切りを / にする） */
export const sh = (p: string): string => p.replaceAll('\\', '/');
/** Git Bash の形（C:\x → /c/x） */
export const gitBash = (p: string): string => sh(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
/** 同じディレクトリか（区切り・末尾の区切りをそろえ、Windows では大文字小文字を区別しない） */
export function sameDir(a: string, b: string): boolean {
  const n = (p: string): string => {
    const s = sh(p).replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  return n(a) === n(b);
}

// ---- 判定の検査 ----

export function assertDeny(d: Decision, label: string): void {
  assert.equal(d.deny, true, `止めるべき: ${label}`);
  if (d.deny) {
    assert.ok(d.reason.length > 0, `理由が空: ${label}`);
    assert.ok(d.reason.includes('Issue の worktree'), `理由に「Issue の worktree」が無い: ${label}: ${d.reason}`);
  }
}

export function assertAllow(d: Decision, label: string): void {
  assert.deepEqual(d, { deny: false }, `通すべき: ${label}`);
}
