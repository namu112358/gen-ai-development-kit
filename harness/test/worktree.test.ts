import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { addWorktree, removeWorktree, worktreePath } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

const ROOT = '/home/u/repo';
const expected = (name: string) => resolve(ROOT, '..', 'repo.worktrees', name);

test('worktree はリポジトリの外に、ブランチ名を安全な名前にして置く', () => {
  assert.equal(worktreePath(ROOT, 'claude/issue-5-x'), expected('claude-issue-5-x'));
  assert.equal(worktreePath(ROOT, 'a'.repeat(40)), expected('a'.repeat(40)));
  const escaped = worktreePath(ROOT, '../../etc');
  for (const s of [sep, '/', '\\']) assert.ok(!escaped.includes(`..${s}etc`), escaped);
  assert.ok(escaped.startsWith(`${resolve(ROOT, '..', 'repo.worktrees')}${sep}`), escaped);
});

test('`..` などで置き場所の外に出ない', () => {
  assert.equal(worktreePath(ROOT, '..'), expected('_.'));
  assert.equal(worktreePath(ROOT, '.hidden'), expected('_hidden'));
});

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
  writeFileSync(join(plain, 'keep.txt'), 'keep\n');
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

test('--detach を付け忘れた SHA からは、SHA の名前のブランチを作らずに止まり、後の --detach が通る（#373 の報告の3）', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const old = s.git(s.root, 'rev-parse', 'HEAD');
  s.commit(s.seed, 'b.txt');
  s.git(s.seed, 'push', '-q', 'origin', 'main');

  for (const ref of [old, old.slice(0, 10)]) {
    assert.throws(() => addWorktree(ref, false, s.opts), /コミットの SHA です。SHA を取り出すときは --detach を付けてください/);
    assert.equal(existsSync(worktreePath(s.root, ref)), false);
  }
  assert.equal(s.git(s.root, 'branch', '--list', `${old.slice(0, 7)}*`), '', 'SHA の名前のブランチを作らない');
  assert.equal(s.git(addWorktree(old, true, s.opts), 'rev-parse', 'HEAD'), old);
});
