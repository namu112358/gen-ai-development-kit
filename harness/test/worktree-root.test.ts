// Issue #196：worktree の置き場所（環境変数 AGENT_HARNESS_WORKTREE_ROOT → 設定 worktreeRoot → 既定 ../<名前>.worktrees）。
// 決め方（worktreeRoot）・リポジトリの中を拒むこと・別の置き場所での作成と削除（worktree コマンド・review-panel の経路）・
// ダッシュボードが同じ置き場所を読むことを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { addWorktree, removeWorktree, WORKTREE_ROOT_ENV, worktreeOptions, worktreePath, worktreeRoot } from '../lib/worktree.ts';
import { isRepoProjectDir, projectDirName, readSessions } from '../scripts/dashboard/sessions.ts';
import { sandbox } from './support/git-sandbox.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const ROOT = resolve('/home/u/repo');
const HOME = resolve('/users/me');
const DEFAULT = resolve(ROOT, '..', 'repo.worktrees');

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const isUnder = (child: string, parent: string): boolean => real(child).startsWith(`${real(parent)}${sep}`);

test('環境変数の名前は AGENT_HARNESS_WORKTREE_ROOT', () => {
  assert.equal(WORKTREE_ROOT_ENV, 'AGENT_HARNESS_WORKTREE_ROOT');
});

test('設定も環境変数も無ければ、置き場所は今と同じ ../<リポジトリ名>.worktrees', () => {
  assert.equal(worktreeRoot(ROOT), DEFAULT);
  assert.equal(worktreeRoot(ROOT, {}, {}, HOME), DEFAULT);
  assert.equal(worktreeRoot(ROOT, { worktreeRoot: undefined }, { AGENT_HARNESS_WORKTREE_ROOT: undefined }, HOME), DEFAULT);
  assert.equal(worktreePath(ROOT, 'claude/issue-5-x'), resolve(DEFAULT, 'claude-issue-5-x'));
  assert.equal(worktreePath(ROOT, 'claude/issue-5-x', worktreeRoot(ROOT)), worktreePath(ROOT, 'claude/issue-5-x'));
});

test('空・空白だけの設定や環境変数は無いとみなす', () => {
  assert.equal(worktreeRoot(ROOT, { worktreeRoot: '' }, {}, HOME), DEFAULT);
  assert.equal(worktreeRoot(ROOT, { worktreeRoot: '   ' }, {}, HOME), DEFAULT);
  assert.equal(worktreeRoot(ROOT, {}, { AGENT_HARNESS_WORKTREE_ROOT: '' }, HOME), DEFAULT);
  assert.equal(worktreeRoot(ROOT, {}, { AGENT_HARNESS_WORKTREE_ROOT: ' \t ' }, HOME), DEFAULT);
  // 空の環境変数は設定を消さない
  assert.equal(worktreeRoot(ROOT, { worktreeRoot: '../cfg' }, { AGENT_HARNESS_WORKTREE_ROOT: '' }, HOME), resolve(ROOT, '..', 'cfg'));
});

test('設定の worktreeRoot：~ はホーム、相対は本体のルートから、絶対はそのまま、{repo} はリポジトリ名', () => {
  const cfg = (v: string) => worktreeRoot(ROOT, { worktreeRoot: v }, {}, HOME);
  assert.equal(cfg('~/wt/{repo}'), resolve(HOME, 'wt', 'repo'));
  assert.equal(cfg('~\\wt\\{repo}'), resolve(HOME, 'wt', 'repo'));
  assert.equal(cfg('~'), HOME);
  assert.equal(cfg('../elsewhere'), resolve(ROOT, '..', 'elsewhere'));
  assert.equal(cfg('../wt/{repo}'), resolve(ROOT, '..', 'wt', 'repo'));
  const abs = resolve('/data/worktrees');
  assert.equal(cfg(abs), abs);
  assert.equal(cfg(join(abs, '{repo}')), join(abs, 'repo'));
  assert.equal(cfg(resolve('/home/u/repo-wt')), resolve('/home/u/repo-wt'), '本体の隣の似た名前は中ではない');
});

test('環境変数が設定より優先される', () => {
  const env = { AGENT_HARNESS_WORKTREE_ROOT: '~/from-env/{repo}' };
  assert.equal(worktreeRoot(ROOT, { worktreeRoot: '../from-config' }, env, HOME), resolve(HOME, 'from-env', 'repo'));
  assert.equal(worktreeRoot(ROOT, {}, env, HOME), resolve(HOME, 'from-env', 'repo'));
});

test('env の既定は空（process.env を読まない）', () => {
  const before = process.env.AGENT_HARNESS_WORKTREE_ROOT;
  process.env.AGENT_HARNESS_WORKTREE_ROOT = resolve('/somewhere/else');
  try {
    assert.equal(worktreeRoot(ROOT), DEFAULT);
    assert.equal(worktreePath(ROOT, 'a'), resolve(DEFAULT, 'a'));
  } finally {
    if (before === undefined) delete process.env.AGENT_HARNESS_WORKTREE_ROOT;
    else process.env.AGENT_HARNESS_WORKTREE_ROOT = before;
  }
});

test('リポジトリの中になる値は、値の出どころと展開後のパスを示して拒む（設定・環境変数のそれぞれ）', () => {
  const inside: [string, string][] = [
    ['.', ROOT],
    ['sub/dir', resolve(ROOT, 'sub', 'dir')],
    ['{repo}-wt', resolve(ROOT, 'repo-wt')],
    ['../repo/{repo}', resolve(ROOT, 'repo')],
    [ROOT, ROOT],
    [join(ROOT, '.worktrees'), join(ROOT, '.worktrees')],
  ];
  for (const [value, expanded] of inside) {
    assert.throws(
      () => worktreeRoot(ROOT, { worktreeRoot: value }, {}, HOME),
      (e: Error) => /worktreeRoot/.test(e.message) && !e.message.includes('AGENT_HARNESS_WORKTREE_ROOT') && e.message.includes(expanded),
      `設定 ${value}`,
    );
    assert.throws(
      () => worktreeRoot(ROOT, {}, { AGENT_HARNESS_WORKTREE_ROOT: value }, HOME),
      (e: Error) => e.message.includes('AGENT_HARNESS_WORKTREE_ROOT') && e.message.includes(expanded),
      `環境変数 ${value}`,
    );
  }
});

test('本体のルートを含む祖先（.. や / など）も拒む', () => {
  for (const value of ['..', resolve('/home/u'), resolve('/'), '../..']) {
    assert.throws(() => worktreeRoot(ROOT, { worktreeRoot: value }, {}, HOME), /worktreeRoot/, `設定 ${value}`);
    assert.throws(() => worktreeRoot(ROOT, {}, { AGENT_HARNESS_WORKTREE_ROOT: value }, HOME), /AGENT_HARNESS_WORKTREE_ROOT/, `環境変数 ${value}`);
  }
  // ホームが本体の祖先なら ~ も祖先
  assert.throws(() => worktreeRoot(ROOT, { worktreeRoot: '~' }, {}, resolve('/home/u')), /worktreeRoot/);
});

test('在るパスは実体でそろえて比べる（本体のルートの別名でも中なら拒む）。返す値は resolve のまま', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  assert.equal(worktreeRoot(s.root), resolve(s.root, '..', 'repo.worktrees'));
  assert.throws(() => worktreeRoot(s.root, { worktreeRoot: join(real(s.root), 'x') }, {}), /worktreeRoot/);
  assert.throws(() => worktreeRoot(real(s.root), { worktreeRoot: join(s.root, 'x') }, {}), /worktreeRoot/);
});

test('worktreeOptions は root・defaultBranch と、決めた置き場所をまとめる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const elsewhere = join(s.dir, 'elsewhere');
  assert.deepEqual(worktreeOptions({ defaultBranch: 'main' }, {}, s.root), {
    root: s.root,
    defaultBranch: 'main',
    worktreeRoot: resolve(s.root, '..', 'repo.worktrees'),
  });
  assert.deepEqual(worktreeOptions({ defaultBranch: 'dev', worktreeRoot: elsewhere }, {}, s.root), { root: s.root, defaultBranch: 'dev', worktreeRoot: elsewhere });
  const fromEnv = join(s.dir, 'from-env');
  assert.equal(worktreeOptions({ defaultBranch: 'main', worktreeRoot: elsewhere }, { AGENT_HARNESS_WORKTREE_ROOT: fromEnv }, s.root).worktreeRoot, fromEnv);
  assert.throws(() => worktreeOptions({ defaultBranch: 'main', worktreeRoot: 'inside' }, {}, s.root), /worktreeRoot/);
});

test('設定の置き場所にブランチの worktree を作って消せる（既定の repo.worktrees には作らない）', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const elsewhere = join(s.dir, 'elsewhere', '{repo}');
  const opts = { ...worktreeOptions({ defaultBranch: 'main', worktreeRoot: elsewhere }, {}, s.root), warn: s.opts.warn };
  assert.equal(opts.worktreeRoot, join(s.dir, 'elsewhere', 'repo'));

  const path = addWorktree('claude/issue-5-x', false, opts);
  assert.equal(path, worktreePath(s.root, 'claude/issue-5-x', opts.worktreeRoot));
  assert.ok(isUnder(path, opts.worktreeRoot), path);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(resolve(s.root, '..', 'repo.worktrees', 'claude-issue-5-x')), '既定の置き場所には作らない');
  assert.equal(s.git(path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'claude/issue-5-x');
  assert.equal(addWorktree('claude/issue-5-x', false, opts), path, '同じブランチなら同じパス');

  removeWorktree('claude/issue-5-x', opts);
  assert.ok(!existsSync(path));
  assert.ok(!s.git(s.root, 'worktree', 'list', '--porcelain').includes('claude-issue-5-x'));
  assert.deepEqual(s.warnings, []);
});

test('環境変数の置き場所を渡すと、設定よりそちらに作られる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const fromEnv = join(s.dir, 'from-env');
  const opts = { ...worktreeOptions({ defaultBranch: 'main', worktreeRoot: join(s.dir, 'from-config') }, { AGENT_HARNESS_WORKTREE_ROOT: fromEnv }, s.root), warn: s.opts.warn };
  const path = addWorktree('claude/y', false, opts);
  assert.ok(isUnder(path, fromEnv), path);
  assert.ok(!existsSync(join(s.dir, 'from-config')));
  removeWorktree('claude/y', opts);
  assert.ok(!existsSync(path));
});

test('review-panel の経路：detach の worktree も設定どおりの置き場所に作られ、消える', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const sha = s.git(s.root, 'rev-parse', 'HEAD');
  const opts = { ...worktreeOptions({ defaultBranch: 'main', worktreeRoot: join(s.dir, 'panel') }, {}, s.root), warn: s.opts.warn };
  const path = addWorktree(sha, true, opts);
  assert.ok(isUnder(path, join(s.dir, 'panel')), path);
  assert.equal(s.git(path, 'rev-parse', 'HEAD'), sha);
  removeWorktree(sha, opts);
  assert.ok(!existsSync(path));
});

test('review-panel.ts と worktree コマンドは worktreeOptions(config) で opts を組み、root の直書きをしない', () => {
  for (const file of ['harness/scripts/review-panel.ts', 'harness/scripts/agent/commands/worktree.ts']) {
    const src = readFileSync(join(KIT, file), 'utf8');
    assert.match(src, /worktreeOptions\(config\)/, file);
    assert.doesNotMatch(src, /\{\s*root:\s*mainRepoRoot\(\)/, file);
  }
});

/** sandbox の本体を cwd にして agent.ts を動かす。worktreeRoot が undefined なら環境変数を消す。Orca は呼ばない */
function agent(cwd: string, args: string[], worktreeRootEnv: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_HARNESS_WORKTREE_ROOT;
  if (worktreeRootEnv !== undefined) env.AGENT_HARNESS_WORKTREE_ROOT = worktreeRootEnv;
  env.ORCA_CLI_COMMAND = join(cwd, 'no-such-orca-cli');
  delete env.ORCA_DEV_REPO_ROOT;
  const r = spawnSync(process.execPath, [join(KIT, 'harness', 'scripts', 'agent.ts'), ...args], { cwd, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const lastLine = (out: string) => out.trimEnd().split('\n').at(-1)?.trim() ?? '';

test('worktree コマンド：環境変数の置き場所に作り、パスを出し、worktree-remove で消せる', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const elsewhere = join(s.dir, 'cli-root');
  const r = agent(s.root, ['worktree', 'claude/x', '--routine'], elsewhere);
  assert.equal(r.status, 0, r.stderr);
  const path = lastLine(r.stdout);
  assert.ok(isUnder(path, elsewhere), path);
  assert.ok(existsSync(path));
  assert.ok(!existsSync(resolve(s.root, '..', 'repo.worktrees')), '既定の置き場所には作らない');

  const rm = agent(s.root, ['worktree-remove', 'claude/x'], elsewhere);
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(path));
});

test('worktree コマンド：環境変数も設定も無ければ既定の ../repo.worktrees に作る', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const r = agent(s.root, ['worktree', 'claude/x', '--routine'], undefined);
  assert.equal(r.status, 0, r.stderr);
  const path = lastLine(r.stdout);
  assert.equal(real(path), real(resolve(s.root, '..', 'repo.worktrees', 'claude-x')));
  const rm = agent(s.root, ['worktree-remove', 'claude/x'], undefined);
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(!existsSync(path));
});

test('worktree コマンド：環境変数にリポジトリの中を渡すと、終了コード 1 で標準出力に何も出さない', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const r = agent(s.root, ['worktree', 'claude/x', '--routine'], join(s.root, 'inside'));
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /AGENT_HARNESS_WORKTREE_ROOT/);
  assert.ok(!existsSync(join(s.root, 'inside')));
  const rm = agent(s.root, ['worktree-remove', 'claude/x'], '.');
  assert.equal(rm.status, 1);
  assert.match(rm.stderr, /AGENT_HARNESS_WORKTREE_ROOT/);
});

test('ダッシュボード：isRepoProjectDir は渡した置き場所の下を読み、既定の repo.worktrees の下は読まない', () => {
  const elsewhere = resolve('/data/wt/repo');
  const inElsewhere = projectDirName(join(elsewhere, 'claude-issue-5-a'));
  const inDefault = projectDirName(join(DEFAULT, 'claude-issue-5-a'));
  assert.equal(isRepoProjectDir(inElsewhere, ROOT, elsewhere), true);
  assert.equal(isRepoProjectDir(inDefault, ROOT, elsewhere), false);
  assert.equal(isRepoProjectDir(projectDirName(ROOT), ROOT, elsewhere), true, '本体はそのまま読む');
  assert.equal(isRepoProjectDir(`${projectDirName(elsewhere)}2-claude-issue-5-a`, ROOT, elsewhere), false, '似た名前の別の場所は読まない');
  // 置き場所を渡さなければ今の既定
  assert.equal(isRepoProjectDir(inDefault, ROOT), true);
  assert.equal(isRepoProjectDir(inElsewhere, ROOT), false);
});

test('ダッシュボード：readSessions は worktreesDir の下のセッション記録を返す', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const projectsDir = join(s.dir, 'projects');
  const elsewhere = join(s.dir, 'wt', 'repo');
  const wtPath = join(elsewhere, 'claude-issue-8-b');
  const now = new Date('2026-09-30T00:00:00Z');
  const put = (dir: string, id: string, cwd: string, branch: string) => {
    mkdirSync(join(projectsDir, dir), { recursive: true });
    writeFileSync(join(projectsDir, dir, `${id}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: new Date(now.getTime() - 10_000).toISOString(), gitBranch: branch, cwd })}\n`);
  };
  put(projectDirName(wtPath), 'sess-elsewhere', wtPath, 'claude/issue-8-b');
  const defaultPath = resolve(s.root, '..', 'repo.worktrees', 'claude-issue-9-c');
  put(projectDirName(defaultPath), 'sess-default', defaultPath, 'claude/issue-9-c');

  const got = readSessions({ projectsDir, repoRoot: s.root, worktreesDir: elsewhere, now });
  assert.deepEqual(got.map((x) => x.id), ['sess-elsewhere']);
  assert.equal(got[0]!.issue, 8);
  // 渡さなければ今の既定の置き場所を読む
  assert.deepEqual(readSessions({ projectsDir, repoRoot: s.root, now }).map((x) => x.id), ['sess-default']);
});

test('dashboard.ts は置き場所を worktreeRoot(repoRoot, config, process.env) で1回だけ決め、readSessions に渡す', () => {
  const src = readFileSync(join(KIT, 'harness', 'scripts', 'dashboard.ts'), 'utf8');
  assert.equal(src.match(/worktreeRoot\(repoRoot, config, process\.env\)/g)?.length, 1);
  const calls = src.match(/readSessions\(\{[^}]*\}/g) ?? [];
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /worktreesDir/, c);
});

test('sessions.ts は置き場所を自前で書かず、harness/lib/worktree.ts の worktreeRoot を使う', () => {
  const src = readFileSync(join(KIT, 'harness', 'scripts', 'dashboard', 'sessions.ts'), 'utf8');
  assert.doesNotMatch(src, /function worktreesDir\(/);
  assert.match(src, /import \{[^}]*\bworktreeRoot\b[^}]*\} from '\.\.\/\.\.\/lib\/worktree\.ts'/);
});
