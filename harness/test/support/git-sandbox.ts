/**
 * worktree のテスト用の git の砂場。一時ディレクトリに bare の origin と、その clone（本体）を作る。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 一時ディレクトリに bare の origin と、その clone（本体）を作る */
export function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-'));
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-qm', file);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const clone = (name: string) => {
    const path = join(dir, name);
    git(dir, 'clone', '-q', join(dir, 'origin.git'), path);
    git(path, 'config', 'user.name', 't');
    git(path, 'config', 'user.email', 't@example.com');
    return path;
  };
  git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const seed = clone('seed');
  git(seed, 'checkout', '-qb', 'main');
  commit(seed, 'a.txt');
  git(seed, 'push', '-q', 'origin', 'main');
  const root = clone('repo');
  const warnings: string[] = [];
  const opts = { root, defaultBranch: 'main', warn: (m: string) => void warnings.push(m) };
  return { dir, root, seed, git, commit, opts, warnings, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
