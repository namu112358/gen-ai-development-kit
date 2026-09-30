// Issue #296：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）が、git-dir と git-common-dir が同じ作業ツリーを main の checkout と見分けるか（`git init --separate-git-dir` の本体を止め、その worktree は通す。ふつうの本体・worktree・submodule の見分けは今までどおり）
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, git, guardSandbox, initRepo, sameDir, sh, write } from './support/workspace-guard-sandbox.ts';

// ---- 砂場：ふつうの本体と worktree、--separate-git-dir の本体と worktree、submodule ----

const sb = guardSandbox();
after(() => sb.cleanup());
const { base, main, issueWt, ctx } = sb;

/** 本体の中の .claude/worktrees/ に置いた worktree */
const innerWt = join(main, '.claude', 'worktrees', 'x');
git(main, 'worktree', 'add', '-q', '-b', 'claude/issue-2-x', innerWt);

/** --separate-git-dir の本体（作業ツリーは base/sep、git のディレクトリは base/gitdirs/sep.git） */
const sepMain = join(base, 'sep');
const sepGitDir = join(base, 'gitdirs', 'sep.git');
initRepo(sepMain, { separateGitDir: sepGitDir });
/** --separate-git-dir の本体から git worktree add した Issue の worktree */
const sepWt = join(base, 'sep.worktrees', 'claude-issue-4-x');
git(sepMain, 'worktree', 'add', '-q', '-b', 'claude/issue-4-x', sepWt);

/** submodule（本体の中の sub。元は base/subsrc） */
const subSrc = join(base, 'subsrc');
initRepo(subSrc);
git(main, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sh(subSrc), 'sub');
git(main, 'commit', '-qm', 'add sub');
const sub = join(main, 'sub');

// ---- AC4：--separate-git-dir の本体を main の checkout と見分ける ----

test('AC4：realContext の locate は、--separate-git-dir の本体で mainRoot を toplevel（本体）にする', () => {
  const m = ctx.locate(sepMain);
  assert.equal(m.kind, 'repo');
  if (m.kind === 'repo') {
    assert.ok(sameDir(m.toplevel, sepMain), `toplevel: ${m.toplevel}`);
    assert.ok(sameDir(m.mainRoot, sepMain), `mainRoot は本体（git-dir と git-common-dir が同じ）: ${m.mainRoot}`);
  }
  const d = ctx.locate(join(sepMain, 'src'));
  assert.equal(d.kind, 'repo');
  if (d.kind === 'repo') assert.ok(sameDir(d.mainRoot, sepMain), `下のディレクトリからも本体: ${d.mainRoot}`);
  const n = ctx.locate(join(sepMain, 'no', 'such', 'dir'));
  assert.equal(n.kind, 'repo', 'まだ無いディレクトリは今ある一番近い祖先で読む');
  if (n.kind === 'repo') assert.ok(sameDir(n.mainRoot, sepMain), `まだ無いディレクトリも本体: ${n.mainRoot}`);
});

test('AC4：--separate-git-dir の本体への Write と git add・git commit を止める（まだ無いディレクトリ・相対パス・git -C・cd も）', () => {
  assertDeny(decide(write(join(sepMain, 'src', 'a.ts'), sepMain), ctx), 'Write sep/src/a.ts');
  assertDeny(decide(write(join(sepMain, 'README.md'), sepMain), ctx), 'Write sep の一番上');
  assertDeny(decide(write(join(sepMain, 'new', 'deep', 'x.ts'), sepMain), ctx), 'Write sep のまだ無いディレクトリ');
  assertDeny(decide(write('src/a.ts', sepMain), ctx), '相対パス（cwd が sep）');
  assertDeny(decide(bash('git add .', sepMain), ctx), 'git add .（sep）');
  assertDeny(decide(bash('git commit -m x', sepMain), ctx), 'git commit（sep）');
  assertDeny(decide(bash('git commit -m x', join(sepMain, 'src')), ctx), 'git commit（sep/src）');
  assertDeny(decide(bash('git reset --hard', sepMain), ctx), 'git reset --hard（sep）');
  assertDeny(decide(bash(`git -C ${sh(sepMain)} commit -m x`, sepWt), ctx), 'git -C sep commit（cwd は sep の worktree）');
  assertDeny(decide(bash(`cd ${sh(sepMain)} && git add .`, sepWt), ctx), 'cd sep && git add .');
  // 止めないものは今までどおり通す
  assertAllow(decide(bash('git status', sepMain), ctx), 'git status（sep）');
  assertAllow(decide(bash('git pull --ff-only', sepMain), ctx), 'git pull --ff-only（sep）');
  assertAllow(decide(bash('git worktree add ../sep.worktrees/claude-issue-9-y -b claude/issue-9-y', sepMain), ctx), 'git worktree add（sep）');
});

test('AC4：--separate-git-dir の本体から git worktree add した worktree では、Write と git add・git commit を通す', () => {
  const w = ctx.locate(sepWt);
  assert.equal(w.kind, 'repo');
  if (w.kind === 'repo') {
    assert.ok(sameDir(w.toplevel, sepWt), `toplevel: ${w.toplevel}`);
    assert.ok(!sameDir(w.mainRoot, sepWt), `worktree の mainRoot は worktree ではない: ${w.mainRoot}`);
  }
  assertAllow(decide(write(join(sepWt, 'src', 'a.ts'), sepWt), ctx), 'Write sep の worktree');
  assertAllow(decide(write(join(sepWt, 'new', 'x.ts'), sepWt), ctx), 'Write sep の worktree のまだ無いディレクトリ');
  assertAllow(decide(bash('git add . && git commit -m x', sepWt), ctx), 'git add . && git commit（sep の worktree）');
  assertAllow(decide(bash(`git -C ${sh(sepWt)} commit -m x`, sepMain), ctx), 'git -C sep の worktree commit（cwd は sep）');
});

// ---- ふつうの本体・worktree・submodule の見分けは今までどおり ----

test('realContext の locate：ふつうの本体・外と中の worktree では、mainRoot が今と同じ（git-common-dir の親）', () => {
  for (const [dir, top] of [
    [main, main],
    [join(main, 'src'), main],
    [issueWt, issueWt],
    [join(issueWt, 'src'), issueWt],
    [innerWt, innerWt],
    [join(innerWt, 'src'), innerWt],
  ] as const) {
    const l = ctx.locate(dir);
    assert.equal(l.kind, 'repo', dir);
    if (l.kind === 'repo') {
      assert.ok(sameDir(l.toplevel, top), `toplevel（${dir}）: ${l.toplevel}`);
      assert.ok(sameDir(l.mainRoot, main), `mainRoot は本体（${dir}）: ${l.mainRoot}`);
    }
  }
  assertDeny(decide(write(join(main, 'src', 'a.ts'), main), ctx), 'Write ふつうの本体');
  assertAllow(decide(write(join(issueWt, 'src', 'a.ts'), issueWt), ctx), 'Write 外の worktree');
  assertAllow(decide(write(join(innerWt, 'src', 'a.ts'), innerWt), ctx), 'Write 中の worktree');
});

test('submodule の中は、今までどおり main の checkout とみなさない', () => {
  const l = ctx.locate(sub);
  assert.equal(l.kind, 'repo');
  if (l.kind === 'repo') {
    assert.ok(sameDir(l.toplevel, sub), `toplevel: ${l.toplevel}`);
    assert.ok(!sameDir(l.mainRoot, sub), `submodule の mainRoot は submodule ではない: ${l.mainRoot}`);
    assert.ok(sameDir(l.mainRoot, join(main, '.git', 'modules')), `mainRoot は git-common-dir の親: ${l.mainRoot}`);
  }
  assertAllow(decide(write(join(sub, 'src', 'a.ts'), sub), ctx), 'Write submodule の中');
  assertAllow(decide(bash('git add . && git commit -m x', sub), ctx), 'git add . && git commit（submodule の中）');
  assertDeny(decide(write(join(main, 'src', 'a.ts'), sub), ctx), 'submodule の外の本体は止める');
});
