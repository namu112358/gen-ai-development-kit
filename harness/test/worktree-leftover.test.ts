// Issue #373：消し残した空のディレクトリの扱い（harness/lib/worktree.ts の addWorktree・removeWorktree と removeEmptyDir）。
// worktree は、登録されていない空のディレクトリなら消して作り直し、消せない（EBUSY など）ならほかのプロセスが使っていると分かる文で止まって
// worktree を作らないこと、空でないディレクトリは今までどおり止まって中身を残すこと、worktree-remove の後にパスが残れば警告を出し、
// 空のディレクトリだけが残っているなら消して成功することを確かめる。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { addWorktree, removeWorktree, worktreePath } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

type Sandbox = ReturnType<typeof sandbox>;

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** git worktree list に載っているか（パスは実パスで比べる） */
const listed = (s: Sandbox, path: string): boolean =>
  s
    .git(s.root, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .some((l) => real(l.slice('worktree '.length)).toLowerCase() === real(path).toLowerCase());

const busy = (): void => {
  throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
};

test('worktree：登録されていない空のディレクトリがあれば、消して作り直してパスを返す', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = worktreePath(s.root, 'claude/empty');
  mkdirSync(path, { recursive: true });
  const removed: string[] = [];
  const removeEmptyDir = (p: string): void => {
    removed.push(p);
    rmdirSync(p);
  };
  assert.equal(addWorktree('claude/empty', false, { ...s.opts, removeEmptyDir }), path);
  assert.deepEqual(removed, [path], 'removeEmptyDir で空のディレクトリを消す');
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), s.git(s.root, 'rev-parse', 'origin/main'));
  assert.equal(s.git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/empty');
  assert.ok(listed(s, path));
});

test('worktree：既定の removeEmptyDir でも、登録されていない空のディレクトリを作り直せる（detach）', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const sha = s.git(s.root, 'rev-parse', 'HEAD');
  const path = worktreePath(s.root, sha);
  mkdirSync(path, { recursive: true });
  assert.equal(addWorktree(sha, true, s.opts), path);
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), sha);
  assert.ok(listed(s, path));
});

test('worktree：空のディレクトリを消せない（EBUSY）なら、ほかのプロセスが使っていると分かる文で止まり、worktree を作らない', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = worktreePath(s.root, 'claude/busy');
  mkdirSync(path, { recursive: true });
  assert.throws(
    () => addWorktree('claude/busy', false, { ...s.opts, removeEmptyDir: busy }),
    (e: unknown) => e instanceof Error && /ほかのプロセスが使っている/.test(e.message) && e.message.includes(path),
  );
  assert.ok(!listed(s, path), 'worktree list に載らない');
  assert.ok(existsSync(path));
  assert.deepEqual(readdirSync(path), []);
});

test('worktree：登録されていない空でないディレクトリは今までどおり止まり、中身を残す', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = worktreePath(s.root, 'claude/full');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'keep.txt'), 'keep\n');
  let called = false;
  const removeEmptyDir = (): void => {
    called = true;
  };
  assert.throws(() => addWorktree('claude/full', false, { ...s.opts, removeEmptyDir }), /worktree として登録されていません/);
  assert.equal(called, false, '空でないディレクトリは消そうとしない');
  assert.deepEqual(readdirSync(path), ['keep.txt']);
  assert.ok(!listed(s, path));
});

test('worktree-remove：普通に消せれば警告を出さない', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = addWorktree('claude/r', false, s.opts);
  const before = s.warnings.length;
  removeWorktree('claude/r', s.opts);
  assert.ok(!existsSync(path));
  assert.deepEqual(s.warnings.slice(before), []);
});

test('worktree-remove：git の削除の後に空のディレクトリが残って消せなければ、パスを示して警告し、投げる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = addWorktree('claude/stuck', false, s.opts);
  // git で先に消し、空のディレクトリだけを残す（ほかのプロセスが掴んでいて消し残した状態）
  s.git(s.root, 'worktree', 'remove', '--force', path);
  mkdirSync(path, { recursive: true });
  const before = s.warnings.length;
  assert.throws(() => removeWorktree('claude/stuck', { ...s.opts, removeEmptyDir: busy }));
  assert.ok(existsSync(path));
  const warned = s.warnings.slice(before);
  assert.equal(warned.length, 1, warned.join('\n'));
  assert.match(warned[0]!, /^警告: /);
  assert.ok(warned[0]!.includes(path), warned[0]);
  assert.match(warned[0]!, /残りました/);
  assert.match(warned[0]!, /ほかのプロセスが使っている/);
});

test('worktree-remove：登録の無い空のディレクトリだけが残っていれば、消して成功し、警告を出さない', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const path = worktreePath(s.root, 'claude/gone');
  mkdirSync(path, { recursive: true });
  const before = s.warnings.length;
  assert.doesNotThrow(() => removeWorktree('claude/gone', s.opts));
  assert.ok(!existsSync(path));
  assert.deepEqual(s.warnings.slice(before), []);
});

test('worktree-remove：パスが無く git の削除も失敗すれば、今までどおり理由付きで投げる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const before = s.warnings.length;
  assert.throws(() => removeWorktree('claude/none', s.opts), /worktree を削除できませんでした/);
  assert.deepEqual(s.warnings.slice(before), [], 'パスが無ければ残ったという警告は出さない');
});
