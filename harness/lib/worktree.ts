import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

/**
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
