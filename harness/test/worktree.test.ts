import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addWorktree, removeWorktree, worktreePath } from '../lib/worktree.ts';

test('worktree はリポジトリの外に、ブランチ名を安全な名前にして置く', () => {
  assert.equal(worktreePath('/home/u/repo', 'claude/issue-5-x'), '/home/u/repo.worktrees/claude-issue-5-x');
  assert.equal(worktreePath('/home/u/repo', 'a'.repeat(40)), `/home/u/repo.worktrees/${'a'.repeat(40)}`);
  assert.ok(!worktreePath('/home/u/repo', '../../etc').includes('..'.concat('/etc')));
});

test('`..` などで置き場所の外に出ない', () => {
  assert.equal(worktreePath('/home/u/repo', '..'), '/home/u/repo.worktrees/_.');
  assert.equal(worktreePath('/home/u/repo', '.hidden'), '/home/u/repo.worktrees/_hidden');
});

/** 一時ディレクトリに bare の origin と、その clone（本体）を作る */
function sandbox() {
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

test('ブランチの worktree を作り、同じブランチなら同じパスを返す。リモートに無ければ既定ブランチから作る', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.git(s.seed, 'checkout', '-qb', 'claude/x');
  const sha = s.commit(s.seed, 'x.txt');
  s.git(s.seed, 'push', '-q', 'origin', 'claude/x');

  const path = addWorktree('claude/x', false, s.opts);
  assert.equal(path, worktreePath(s.root, 'claude/x'));
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), sha);
  assert.equal(addWorktree('claude/x', false, s.opts), path);

  const fresh = addWorktree('claude/new', false, s.opts);
  assert.equal(s.git(fresh, 'rev-parse', 'HEAD'), s.git(s.root, 'rev-parse', 'origin/main'));
  assert.deepEqual(s.warnings, []);
});

test('fetch に失敗すると警告を出し、手元の ref で続ける', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const sha = s.git(s.root, 'rev-parse', 'HEAD');
  s.git(s.root, 'remote', 'set-url', 'origin', join(s.dir, 'missing.git'));

  const path = addWorktree('claude/y', false, s.opts);
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), sha);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /警告/);

  s.warnings.length = 0;
  assert.equal(s.git(addWorktree(sha, true, s.opts), 'rev-parse', 'HEAD'), sha);
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /git fetch origin main/);
});

test('PR ブランチにしか無い SHA を --detach で取り出せ、短い SHA でも同じ worktree を再利用する', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.git(s.seed, 'checkout', '-qb', 'pr-branch');
  const sha = s.commit(s.seed, 'pr.txt');
  s.git(s.seed, 'push', '-q', 'origin', 'pr-branch');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: s.root }).status, 0, '本体にはまだ無い');

  const path = addWorktree(sha, true, s.opts);
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), sha);
  assert.deepEqual(s.warnings, []);

  const short = sha.slice(0, 10);
  const shortPath = addWorktree(short, true, s.opts);
  assert.equal(addWorktree(short, true, s.opts), shortPath);
  assert.equal(addWorktree(sha, true, s.opts), path);
});

test('手元に無い SHA は理由付きのエラーで止まる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  assert.throws(() => addWorktree('f'.repeat(40), true, s.opts), /worktree を作れませんでした/);
});

test('既にあるパスが別ブランチの worktree や、登録されていないディレクトリならエラーで止まる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = worktreePath(s.root, 'claude/z');
  s.git(s.root, 'worktree', 'add', '-q', '-b', 'other', path, 'origin/main');
  assert.throws(() => addWorktree('claude/z', false, s.opts), /other を指していて、claude\/z ではありません/);

  const sha = s.git(s.root, 'rev-parse', 'HEAD');
  const detached = worktreePath(s.root, sha);
  s.git(s.root, 'worktree', 'add', '-q', '-b', 'other2', detached, 'origin/main');
  s.git(detached, 'commit', '-q', '--allow-empty', '-m', 'moved');
  assert.throws(() => addWorktree(sha, true, s.opts), /ではありません/);

  const plain = worktreePath(s.root, 'claude/plain');
  mkdirSync(plain, { recursive: true });
  assert.throws(() => addWorktree('claude/plain', false, s.opts), /worktree として登録されていません/);
});

test('worktree-remove：削除できれば消え、失敗すれば理由付きで投げる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = addWorktree('claude/r', false, s.opts);
  removeWorktree('claude/r', s.opts);
  assert.equal(existsSync(path), false);
  assert.throws(() => removeWorktree('claude/r', s.opts), /worktree を削除できませんでした/);
});
