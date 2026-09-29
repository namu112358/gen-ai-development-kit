import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * 作業用の git worktree（リポジトリの外の作業場所）の作成（`node_modules` が無ければ `npm ci` まで）と削除。
 * 作業は常に git worktree で行う。置き場所はリポジトリの外（`../<リポジトリ名>.worktrees/<ブランチ名>`）にし、
 * 作業中の変更やほかの作業ツリーがコミットに紛れ込まないようにする。
 */

/** 本体のリポジトリのルート（worktree の中から呼ばれても本体を返す） */
export function mainRepoRoot(cwd: string = process.cwd()): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git リポジトリではありません: ${cwd}`);
  return dirname(r.stdout.trim());
}

export function worktreePath(repoRoot: string, ref: string): string {
  // 先頭の . は _ にする（`..` などで置き場所の外に出ないように）
  const name = ref.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\./, '_');
  return resolve(repoRoot, '..', `${basename(repoRoot)}.worktrees`, name);
}

export interface WorktreeOptions {
  /** 本体のリポジトリのルート */
  root: string;
  /** 新しいブランチの起点（`harness.config.json` の `defaultBranch`） */
  defaultBranch: string;
  /** 警告の出力先（既定は標準エラー） */
  warn?: (message: string) => void;
}

function run(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function git(root: string, ...args: string[]): string {
  const r = run(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** `git worktree list --porcelain` からパスの worktree を探す */
function findWorktree(root: string, path: string): { head: string; branch: string | null } | null {
  const target = real(path);
  for (const block of git(root, 'worktree', 'list', '--porcelain').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!at || real(at) !== target) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '';
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null;
    return { head, branch };
  }
  return null;
}

/**
 * 作業用の worktree を作り、パスを返す。ブランチがリモートにあればそれを、無ければ origin/<既定ブランチ> から新しく作る。
 * detach は判定のテスト実行用（head SHA をそのまま取り出す）。
 * 既にパスがあれば、同じブランチ（detach なら同じコミット）の worktree のときだけそのパスを返し、違えば止める。
 * fetch の失敗は警告だけ出して手元の ref で続ける。
 */
export function addWorktree(ref: string, detach: boolean, opts: WorktreeOptions): string {
  const { root, defaultBranch, warn = console.error } = opts;
  const path = worktreePath(root, ref);
  if (existsSync(path)) {
    const wt = findWorktree(root, path);
    if (!wt) throw new Error(`${path} は既にありますが、worktree として登録されていません`);
    if (detach) {
      const r = run(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      const sha = r.status === 0 ? r.stdout.trim() : null;
      if (sha === null || wt.head !== sha) throw new Error(`${path} の worktree は ${wt.branch ?? wt.head} を指していて、${ref} ではありません`);
    } else if (wt.branch !== ref) {
      throw new Error(`${path} の worktree は ${wt.branch ?? `${wt.head}（detach）`} を指していて、${ref} ではありません`);
    }
    return path;
  }

  // 必要な ref だけ取る。ブランチがリモートに無いことは失敗ではないので、先に確かめて既定ブランチだけにする
  let refs: string[] | null = [defaultBranch, ref];
  if (!detach) {
    const r = run(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`]);
    if (r.status === 2) refs = [defaultBranch];
    else if (r.status !== 0) {
      warn(`警告: origin の ${ref} を確かめられませんでした。手元の ref で続けます: ${r.stderr.trim()}`);
      refs = null;
    }
  }
  if (refs) {
    const r = run(root, ['fetch', '-q', 'origin', ...refs]);
    if (r.status !== 0) warn(`警告: git fetch origin ${refs.join(' ')} が失敗しました。手元の ref で続けます: ${r.stderr.trim()}`);
  }

  if (detach) {
    const r = run(root, ['worktree', 'add', '-q', '--detach', path, ref]);
    if (r.status !== 0) throw new Error(`${ref} の worktree を作れませんでした（手元にそのコミットが無い可能性があります）: ${r.stderr.trim()}`);
  } else if (run(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}`]).status === 0) {
    git(root, 'worktree', 'add', '-q', '-B', ref, path, `origin/${ref}`);
  } else {
    git(root, 'worktree', 'add', '-q', '-b', ref, path, `origin/${defaultBranch}`);
  }
  return path;
}

/** `npm ci` の結果（`spawnSync` の結果のうち使うところ） */
export type NpmCiResult = { status: number | null; error?: Error };

/**
 * `npm ci` の起動の仕方。Windows の npm は `npm.cmd` で、Node は shell を通さないと `.cmd` を起動できないので shell を通す。
 * 引数は固定の `ci` だけで外から来る文字列を渡さない。shell: true に引数の配列を渡すと Node 24 が DEP0190 の警告を出すので、1つの文字列にする
 */
export function npmCiCommand(platform: NodeJS.Platform): { command: string; args: string[]; shell: boolean } {
  return platform === 'win32' ? { command: 'npm ci', args: [], shell: true } : { command: 'npm', args: ['ci'], shell: false };
}

/** 既定の `npm ci`。npm の出力は標準エラーへ流し、標準出力（worktree のパス）を汚さない */
function defaultNpmCi(cwd: string): NpmCiResult {
  const { command, args, shell } = npmCiCommand(process.platform);
  return spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2], shell });
}

/**
 * worktree の依存を用意する。`node_modules` があれば何もしない（'present'）。
 * `package-lock.json` が無ければ `npm ci` は必ず失敗するので何もしない（'skipped'）。
 * それ以外は `npm ci` を1回動かし（'installed'）、起動できないか 0 以外で終われば理由付きで投げる。
 */
export function ensureNodeModules(path: string, runNpmCi: (cwd: string) => NpmCiResult = defaultNpmCi): 'present' | 'installed' | 'skipped' {
  if (existsSync(join(path, 'node_modules'))) return 'present';
  if (!existsSync(join(path, 'package-lock.json'))) return 'skipped';
  const r = runNpmCi(path);
  if (r.error) throw new Error(`npm ci を起動できませんでした（${path}）: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`npm ci が失敗しました（${path}）: 終了コード ${r.status ?? '(シグナルで終了)'}`);
  return 'installed';
}

/** worktree を削除する。削除に失敗したら理由付きで投げる（prune の失敗は無視する） */
export function removeWorktree(ref: string, opts: Pick<WorktreeOptions, 'root'>): void {
  const { root } = opts;
  const r = run(root, ['worktree', 'remove', '--force', worktreePath(root, ref)]);
  run(root, ['worktree', 'prune']);
  if (r.status !== 0) throw new Error(`worktree を削除できませんでした: ${r.stderr.trim()}`);
}
