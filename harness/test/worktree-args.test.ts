// Issue #373：agent.ts worktree・worktree-remove の引数の検査（harness/lib/worktree.ts の parseWorktreeArgs）。
// ref が無い・`-` で始まる ref（`--detach` だけ、`--detach <SHA>`）は使い方を含むエラーになり、正しい引数は ref・detach・routine を返すこと、
// CLI はそのとき着手宣言の確かめ（gh）より前に終了コード 1 で止まり、標準エラーに使い方を出し、置き場所に何も作らないことを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseWorktreeArgs } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const SHA = 'a'.repeat(40);
const USAGE_ADD = /worktree <ブランチ\|SHA>/;
const USAGE_REMOVE = /worktree-remove <ブランチ\|SHA>/;
const usage = (re: RegExp) => (e: unknown) => e instanceof Error && /使い方/.test(e.message) && re.test(e.message);

test('parseWorktreeArgs：ref が無ければ使い方を含むエラーを投げる（worktree・worktree-remove）', () => {
  assert.throws(() => parseWorktreeArgs('worktree', []), usage(USAGE_ADD));
  assert.throws(() => parseWorktreeArgs('worktree-remove', []), usage(USAGE_REMOVE));
});

test('parseWorktreeArgs：`-` で始まる ref（--detach だけ・--detach <SHA>・--routine だけ）は使い方を含むエラーを投げる', () => {
  for (const args of [['--detach'], ['--detach', SHA], ['--routine']]) {
    assert.throws(() => parseWorktreeArgs('worktree', args), usage(USAGE_ADD), args.join(' '));
  }
  assert.throws(() => parseWorktreeArgs('worktree-remove', ['--detach']), usage(USAGE_REMOVE));
});

test('parseWorktreeArgs：正しい引数は ref・detach・routine を返す', () => {
  assert.deepEqual(parseWorktreeArgs('worktree', ['abc', '--detach']), { ref: 'abc', detach: true, routine: false });
  assert.deepEqual(parseWorktreeArgs('worktree', ['claude/x', '--routine']), { ref: 'claude/x', detach: false, routine: true });
  assert.deepEqual(parseWorktreeArgs('worktree', [SHA, '--detach', '--routine']), { ref: SHA, detach: true, routine: true });
  assert.deepEqual(parseWorktreeArgs('worktree', ['claude/issue-5-x']), { ref: 'claude/issue-5-x', detach: false, routine: false });
  assert.equal(parseWorktreeArgs('worktree-remove', ['claude/x']).ref, 'claude/x');
});

/** sandbox の本体を cwd にして agent.ts を動かす。置き場所は環境変数で一時ディレクトリに向け、Orca と gh の資格情報は渡さない */
function agent(cwd: string, args: string[], worktreeRootEnv: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.AGENT_HARNESS_WORKTREE_ROOT = worktreeRootEnv;
  env.ORCA_CLI_COMMAND = join(cwd, 'no-such-orca-cli');
  delete env.ORCA_DEV_REPO_ROOT;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [join(KIT, 'harness', 'scripts', 'agent.ts'), ...args], { cwd, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const isEmptyOrAbsent = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

for (const args of [['worktree'], ['worktree-remove'], ['worktree', '--detach'], ['worktree', '--detach', SHA]]) {
  test(`CLI：${args.join(' ')} は worktree を作らず、終了コード 1 で使い方を出す（gh より前）`, (t) => {
    const s = sandbox();
    t.after(s.cleanup);
    const place = join(s.dir, 'cli-root');
    const r = agent(s.root, args, place);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.match(r.stderr, /使い方/);
    assert.match(r.stderr, args[0] === 'worktree-remove' ? USAGE_REMOVE : USAGE_ADD);
    assert.ok(isEmptyOrAbsent(place), `置き場所に何も作らない: ${existsSync(place) ? readdirSync(place).join(', ') : ''}`);
    assert.ok(!existsSync(resolve(s.root, '..', 'repo.worktrees')), '既定の置き場所にも作らない');
    const worktrees = s.git(s.root, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
    assert.equal(worktrees.length, 1, worktrees.join('\n'));
  });
}
