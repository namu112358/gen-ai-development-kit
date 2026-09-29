// Issue #286：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）が、main の checkout と印のあるワークスペースの中の書き換え（Edit・Write・NotebookEdit と git の書き換え）を止め、Issue の worktree・一時ディレクトリ・~/.claude と、Orca・hq を使わない今の手順を止めないか
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decide, decideRaw, MARKER, realContext, type Decision, type WorkspaceContext } from '../../.claude/hooks/workspace-guard.ts';

const root = join(import.meta.dirname, '..', '..');
const RUN = join(root, '.claude', 'hooks', 'run.mjs');
const HOOK = join(root, '.claude', 'hooks', 'workspace-guard.ts');

// ---- 砂場：本体・外の worktree・中の .claude/worktrees/x・印のあるワークスペース・その下の worktree ----

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// 短い名前（8.3）やリンクで比べ方がずれないよう、実体のパスにしておく
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'workspace-guard-')));
const allowDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'workspace-guard-allow-')));
after(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(allowDir, { recursive: true, force: true });
});

const main = join(base, 'repo');
mkdirSync(main);
git(main, 'init', '-q', '-b', 'main');
git(main, 'config', 'user.name', 't');
git(main, 'config', 'user.email', 't@example.com');
mkdirSync(join(main, 'src'));
writeFileSync(join(main, 'src', 'a.ts'), 'a\n');
writeFileSync(join(main, '.gitignore'), '.claude/worktrees/\n');
git(main, 'add', '.');
git(main, 'commit', '-qm', 'init');

/** 本体の外（../repo.worktrees/）に置いた Issue の worktree */
const issueWt = join(base, 'repo.worktrees', 'claude-issue-1-x');
git(main, 'worktree', 'add', '-q', '-b', 'claude/issue-1-x', issueWt);
/** 本体の中の .claude/worktrees/ に置いた worktree */
const innerWt = join(main, '.claude', 'worktrees', 'x');
git(main, 'worktree', 'add', '-q', '-b', 'claude/issue-2-x', innerWt);
/** 印のあるワークスペース（本体とは別の git worktree の一番上に MARKER を置く） */
const marked = join(base, 'hq');
git(main, 'worktree', 'add', '-q', '-b', 'hq', marked);
writeFileSync(join(marked, MARKER), '');
/** 印のあるワークスペースの下に置いた別の worktree */
const nestedWt = join(marked, 'issues', 'claude-issue-3-x');
git(main, 'worktree', 'add', '-q', '-b', 'claude/issue-3-x', nestedWt);
/** git の外で、印のあるディレクトリ */
const markedPlain = join(base, 'fleet');
mkdirSync(markedPlain);
writeFileSync(join(markedPlain, MARKER), '');
/** git の外で、印のないディレクトリ */
const plain = join(base, 'plain');
mkdirSync(plain);

const ctx: WorkspaceContext = realContext({ allowRoots: [allowDir] });

// ---- 補助 ----

type Input = { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };

const write = (file_path: string, cwd: string = main): Input => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd });
const edit = (file_path: string, cwd: string = main): Input => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' }, cwd });
const notebook = (notebook_path: string, cwd: string = main): Input => ({ tool_name: 'NotebookEdit', tool_input: { notebook_path, new_source: 'x' }, cwd });
const bash = (command: string, cwd: string): Input => ({ tool_name: 'Bash', tool_input: { command }, cwd });
/** Bash の文の中に書くパス（区切りを / にする） */
const sh = (p: string): string => p.replaceAll('\\', '/');

function assertDeny(d: Decision, label: string): void {
  assert.equal(d.deny, true, `止めるべき: ${label}`);
  if (d.deny) {
    assert.ok(d.reason.length > 0, `理由が空: ${label}`);
    assert.ok(d.reason.includes('Issue の worktree'), `理由に「Issue の worktree」が無い: ${label}: ${d.reason}`);
  }
}
function assertAllow(d: Decision, label: string): void {
  assert.deepEqual(d, { deny: false }, `通すべき: ${label}`);
}

// ---- 形 ----

test('MARKER は .agent-harness-workspace', () => {
  assert.equal(MARKER, '.agent-harness-workspace');
});

test('realContext の locate：main の checkout・worktree・リポジトリの外・まだ無いディレクトリ', () => {
  const same = (a: string, b: string) => sh(a).toLowerCase() === sh(b).toLowerCase();
  const m = ctx.locate(main);
  assert.equal(m.kind, 'repo');
  if (m.kind === 'repo') {
    assert.ok(same(m.toplevel, main), `toplevel: ${m.toplevel}`);
    assert.ok(same(m.mainRoot, main), `mainRoot: ${m.mainRoot}`);
  }
  const w = ctx.locate(join(issueWt, 'src'));
  assert.equal(w.kind, 'repo');
  if (w.kind === 'repo') {
    assert.ok(same(w.toplevel, issueWt), `toplevel: ${w.toplevel}`);
    assert.ok(same(w.mainRoot, main), `mainRoot は git-common-dir の親: ${w.mainRoot}`);
  }
  const n = ctx.locate(join(main, 'no', 'such', 'dir'));
  assert.equal(n.kind, 'repo', 'まだ無いディレクトリは今ある一番近い祖先で読む');
  assert.equal(ctx.locate(plain).kind, 'none');
});

test('realContext の hasMarker：直下に MARKER があるかだけを見る', () => {
  assert.equal(ctx.hasMarker(marked), true);
  assert.equal(ctx.hasMarker(markedPlain), true);
  assert.equal(ctx.hasMarker(main), false);
  assert.equal(ctx.hasMarker(join(marked, 'issues')), false, '祖先の印は見ない');
});

// ---- AC1：Edit・Write・NotebookEdit ----

test('AC1：main の checkout の中への Edit・Write・NotebookEdit を止める（まだ無いディレクトリ・相対パスも）', () => {
  assertDeny(decide(write(join(main, 'src', 'a.ts')), ctx), 'Write main/src/a.ts');
  assertDeny(decide(edit(join(main, 'src', 'a.ts')), ctx), 'Edit main/src/a.ts');
  assertDeny(decide(notebook(join(main, 'n.ipynb')), ctx), 'NotebookEdit main/n.ipynb');
  assertDeny(decide(write(join(main, 'README.md')), ctx), 'Write main の一番上');
  assertDeny(decide(write(join(main, 'new', 'deep', 'x.ts')), ctx), 'Write main のまだ無いディレクトリ');
  assertDeny(decide(write('src/a.ts', main), ctx), '相対パス（cwd が main）');
  assertDeny(decide(write('../repo/src/a.ts', join(base, 'repo.worktrees')), ctx), '相対パス（cwd の外から main へ）');
  assertDeny(decide(write(sh(join(main, 'src', 'a.ts'))), ctx), '区切りが /');
});

test('AC1：印のあるワークスペースの中への書き換えを止める（git の中でも外でも、まだ無いディレクトリでも）', () => {
  assertDeny(decide(write(join(marked, 'plan.md'), marked), ctx), 'Write hq の一番上');
  assertDeny(decide(edit(join(marked, 'src', 'a.ts'), marked), ctx), 'Edit hq/src/a.ts');
  assertDeny(decide(notebook(join(marked, 'n.ipynb'), marked), ctx), 'NotebookEdit hq');
  assertDeny(decide(write(join(marked, 'notes', 'new', 'x.md'), marked), ctx), 'Write hq のまだ無いディレクトリ');
  assertDeny(decide(write('notes/x.md', marked), ctx), '相対パス（cwd が hq）');
  assertDeny(decide(write(join(markedPlain, 'x.md'), markedPlain), ctx), 'Write git の外の印のあるディレクトリ');
  assertDeny(decide(write(join(markedPlain, 'a', 'b', 'x.md'), markedPlain), ctx), 'Write git の外の印の下のまだ無いディレクトリ');
});

test('AC1：Issue の worktree（外の ../repo.worktrees/・中の .claude/worktrees/・印のあるワークスペースの下）への書き換えは通す', () => {
  for (const wt of [issueWt, innerWt, nestedWt]) {
    assertAllow(decide(write(join(wt, 'src', 'a.ts'), wt), ctx), `Write ${wt}`);
    assertAllow(decide(edit(join(wt, 'src', 'a.ts'), wt), ctx), `Edit ${wt}`);
    assertAllow(decide(notebook(join(wt, 'n.ipynb'), wt), ctx), `NotebookEdit ${wt}`);
    assertAllow(decide(write(join(wt, 'new', 'dir', 'x.ts'), wt), ctx), `Write ${wt} のまだ無いディレクトリ`);
    assertAllow(decide(write('src/a.ts', wt), ctx), `相対パス（cwd が ${wt}）`);
  }
  // cwd が main でも、書き換え先が worktree なら通す
  assertAllow(decide(write(join(issueWt, 'x.ts'), main), ctx), 'cwd が main で書き換え先が worktree');
  assertAllow(decide(write('.claude/worktrees/x/y.ts', main), ctx), '相対パスで main の中の .claude/worktrees/x');
});

test('AC1：一時ディレクトリ（allowRoots）・~/.claude の中は通す', () => {
  assertAllow(decide(write(join(allowDir, 'x.txt'), main), ctx), 'allowRoots の中');
  assertAllow(decide(write(join(allowDir, 'new', 'x.txt'), main), ctx), 'allowRoots のまだ無いディレクトリ');
  assertAllow(decide(write(allowDir, main), ctx), 'allowRoots そのもの');
  const def = realContext();
  assertAllow(decide(write(join(tmpdir(), 'workspace-guard-default.txt'), main), def), '既定の allowRoots：os.tmpdir()');
  assertAllow(decide(write(join(homedir(), '.claude', 'projects', 'x', 'memory', 'm.md'), main), def), '既定の allowRoots：~/.claude');
  assertAllow(decide(write(join(plain, 'x.txt'), plain), ctx), 'git の外で印の無い場所');
});

test('AC1：allowRoots はパスの区切りの単位で比べ（main/sr は main/src を含まない）、main の checkout の判定より先に効く', () => {
  const c = realContext({ allowRoots: [join(main, 'sr')] });
  assertDeny(decide(write(join(main, 'src', 'a.ts')), c), 'main/sr は main/src を含まない');
  const c2 = realContext({ allowRoots: [join(main, 'src')] });
  assertAllow(decide(write(join(main, 'src', 'a.ts')), c2), 'allowRoots が先に効く（main の中でも）');
});

test('AC1（Windows）：allowRoots と main の比べ方は大文字小文字・区切りを区別せず、Git Bash の /c/... を C:/... と読む', { skip: process.platform !== 'win32' }, () => {
  const upper = join(allowDir, 'x.txt').toUpperCase();
  assertAllow(decide(write(upper, main), ctx), `大文字: ${upper}`);
  assertAllow(decide(write(sh(join(allowDir, 'x.txt')), main), ctx), '区切りが /');
  const gitBash = (p: string) => sh(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
  assertAllow(decide(write(gitBash(join(allowDir, 'x.txt')), main), ctx), `Git Bash の形: ${gitBash(join(allowDir, 'x.txt'))}`);
  assertDeny(decide(write(join(main, 'src', 'a.ts').toUpperCase(), main), ctx), 'main の大文字');
  assertDeny(decide(write(gitBash(join(main, 'src', 'a.ts')), main), ctx), `main の Git Bash の形: ${gitBash(join(main, 'src', 'a.ts'))}`);
  assertAllow(decide(write(gitBash(join(issueWt, 'a.ts')), main), ctx), 'worktree の Git Bash の形');
});

test('AC1：file_path・notebook_path が無い・文字列でないなら止める', () => {
  assertDeny(decide({ tool_name: 'Write', tool_input: { content: 'x' }, cwd: main }, ctx), 'Write の file_path が無い');
  assertDeny(decide({ tool_name: 'Edit', tool_input: { file_path: 1 }, cwd: main }, ctx), 'Edit の file_path が数');
  assertDeny(decide({ tool_name: 'NotebookEdit', tool_input: { file_path: join(issueWt, 'n.ipynb') }, cwd: issueWt }, ctx), 'NotebookEdit は notebook_path を読む');
  assertDeny(decide({ tool_name: 'Write', cwd: main }, ctx), 'tool_input が無い');
  assertDeny(decide({ tool_name: 'Write', tool_input: { file_path: '' }, cwd: main }, ctx), 'file_path が空');
});

test('AC1：ほかのツール（Read・Grep・Glob）は通す', () => {
  for (const tool_name of ['Read', 'Grep', 'Glob', 'WebFetch']) {
    assertAllow(decide({ tool_name, tool_input: { file_path: join(main, 'src', 'a.ts') }, cwd: main }, ctx), tool_name);
  }
});

test('locate が error なら止める（allowRoots の中は locate を呼ぶ前に通す）', () => {
  let calls = 0;
  const broken: WorkspaceContext = { allowRoots: [allowDir], locate: () => { calls++; return { kind: 'error' }; }, hasMarker: () => false };
  assertDeny(decide(write(join(issueWt, 'a.ts'), issueWt), broken), 'Write で locate が error');
  assertDeny(decide(bash('git commit -m x', issueWt), broken), 'Bash の git commit で locate が error');
  const before = calls;
  assertAllow(decide(write(join(allowDir, 'a.ts'), issueWt), broken), 'allowRoots の中');
  assert.equal(calls, before, 'allowRoots の中では locate を呼ばない');
});

test('差し替えた ctx：toplevel が mainRoot と同じなら止め、違えば通し、印は作業ツリーの一番上で探すのをやめる', () => {
  const top = join(base, 'fake-main');
  const wt = join(base, 'fake-hq', 'wt');
  // 実装がまだ無いディレクトリを今ある祖先に寄せても結果が変わらないよう、ディレクトリは作っておく（中身は locate・hasMarker の差し替えで決める）
  mkdirSync(join(top, 'src'), { recursive: true });
  mkdirSync(join(wt, 'a'), { recursive: true });
  const fake: WorkspaceContext = {
    allowRoots: [],
    locate: (dir) => {
      const d = sh(dir).toLowerCase();
      if (d.startsWith(sh(top).toLowerCase())) return { kind: 'repo', toplevel: top, mainRoot: top };
      if (d.startsWith(sh(wt).toLowerCase())) return { kind: 'repo', toplevel: wt, mainRoot: top };
      return { kind: 'none' };
    },
    hasMarker: (dir) => sh(dir).toLowerCase() === sh(join(base, 'fake-hq')).toLowerCase(),
  };
  assertDeny(decide(write(join(top, 'src', 'a.ts'), top), fake), 'toplevel == mainRoot');
  assertAllow(decide(write(join(wt, 'a', 'b.ts'), wt), fake), '印の下の別の worktree（一番上で探すのをやめる）');
  assertDeny(decide(write(join(base, 'fake-hq', 'x.md'), base), fake), 'リポジトリの外なら根まで印を探す');
});

test('decideRaw：JSON でない stdin は止め、JSON なら decide と同じ', () => {
  for (const raw of ['', 'not json', '{']) {
    const d = decideRaw(raw, ctx);
    assert.equal(d.deny, true, `止めるべき: ${JSON.stringify(raw)}`);
  }
  assertDeny(decideRaw(JSON.stringify(write(join(main, 'a.ts'))), ctx), 'main への Write');
  assertAllow(decideRaw(JSON.stringify(write(join(issueWt, 'a.ts'), issueWt)), ctx), 'worktree への Write');
  assertAllow(decideRaw(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: join(main, 'a.ts') }, cwd: main }), ctx), 'Read');
});

// ---- AC2：Bash の git ----

const DENY_GIT = [
  'git commit -m x',
  'git commit -am x',
  'git add .',
  'git add src/a.ts',
  'git rm src/a.ts',
  'git mv src/a.ts src/b.ts',
  'git stash',
  'git stash push -m x',
  'git stash pop',
  'git reset --hard',
  'git reset HEAD~1',
  'git checkout -b x',
  'git checkout claude/issue-1-x',
  'git checkout -- src/a.ts',
  'git switch claude/issue-1-x',
  'git switch -c y',
  'git restore src/a.ts',
  'git merge claude/issue-1-x',
  'git rebase main',
  'git cherry-pick abc123',
  'git apply x.patch',
  'git clean -fd',
  'git revert HEAD',
  'git am x.patch',
  'git pull',
  'git pull origin main',
  'git pull --rebase',
];

const ALLOW_GIT = [
  'git pull --ff-only',
  'git pull --ff-only origin main',
  'git fetch',
  'git fetch origin main',
  'git status',
  'git log --oneline -5',
  'git diff',
  'git show HEAD',
  'git push -u origin claude/issue-1-x',
  'git stash list',
  'git stash show',
  'git worktree add ../repo.worktrees/claude-issue-9-y -b claude/issue-9-y',
  'git worktree remove ../repo.worktrees/claude-issue-1-x',
  'git worktree prune',
  'git worktree list',
  'git branch --show-current',
  'git rev-parse HEAD',
];

test('AC2：main の checkout での git commit・add・reset などを止める（下のディレクトリの cwd でも）', () => {
  for (const cmd of DENY_GIT) {
    assertDeny(decide(bash(cmd, main), ctx), `${cmd}（main）`);
    assertDeny(decide(bash(cmd, join(main, 'src')), ctx), `${cmd}（main/src）`);
  }
});

test('AC2：main の checkout での git pull --ff-only・fetch・worktree add/remove などは通す', () => {
  for (const cmd of ALLOW_GIT) assertAllow(decide(bash(cmd, main), ctx), `${cmd}（main）`);
});

test('AC2：印のあるワークスペースでの git の書き換えを止め、その下の worktree では通す', () => {
  for (const cmd of DENY_GIT) {
    assertDeny(decide(bash(cmd, marked), ctx), `${cmd}（hq）`);
    assertAllow(decide(bash(cmd, nestedWt), ctx), `${cmd}（hq の下の worktree）`);
  }
  for (const cmd of ALLOW_GIT) assertAllow(decide(bash(cmd, marked), ctx), `${cmd}（hq）`);
});

test('AC2：作業ツリーは git -C <dir>、前置きの cd <dir> &&、無ければ cwd で決める', () => {
  assertDeny(decide(bash(`git -C ${sh(main)} commit -m x`, issueWt), ctx), 'git -C main（cwd は worktree）');
  assertAllow(decide(bash(`git -C ${sh(issueWt)} commit -m x`, main), ctx), 'git -C worktree（cwd は main）');
  assertDeny(decide(bash(`cd ${sh(main)} && git add .`, issueWt), ctx), 'cd main &&（cwd は worktree）');
  assertAllow(decide(bash(`cd ${sh(issueWt)} && git add . && git commit -m x`, main), ctx), 'cd worktree &&（cwd は main）');
  assertDeny(decide(bash(`git -C ${sh(marked)} reset --hard`, issueWt), ctx), 'git -C hq');
  assertAllow(decide(bash(`git -C ${sh(main)} pull --ff-only`, issueWt), ctx), 'git -C main pull --ff-only');
  assertAllow(decide(bash(`git -C ${sh(main)} worktree add ../x -b y`, issueWt), ctx), 'git -C main worktree add');
  assertDeny(decide(bash('git -C src commit -m x', main), ctx), 'git -C の相対パス（main の下）');
});

test('AC2（Windows）：git -C の Git Bash の形 /c/... も C:/... と読む', { skip: process.platform !== 'win32' }, () => {
  const gitBash = (p: string) => sh(p).replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`);
  assertDeny(decide(bash(`git -C ${gitBash(main)} commit -m x`, issueWt), ctx), `git -C ${gitBash(main)}`);
  assertAllow(decide(bash(`git -C ${gitBash(issueWt)} commit -m x`, main), ctx), `git -C ${gitBash(issueWt)}`);
});

test('AC2：静的に決まらない -C・--git-dir・--work-tree・GIT_DIR=・GIT_WORK_TREE= の付いた止めるサブコマンドは止める（cwd が worktree でも）', () => {
  const cmds = [
    'git -C "$X" commit -m x',
    'git -C $X add .',
    'git -C "$(pwd)" reset --hard',
    `git --git-dir=${sh(join(main, '.git'))} commit -m x`,
    `git --git-dir ${sh(join(main, '.git'))} add .`,
    `git --work-tree=${sh(main)} checkout -- .`,
    `GIT_DIR=${sh(join(main, '.git'))} git commit -m x`,
    `GIT_WORK_TREE=${sh(main)} git add .`,
  ];
  for (const cmd of cmds) assertDeny(decide(bash(cmd, issueWt), ctx), cmd);
  // 止めないサブコマンドなら通す
  assertAllow(decide(bash('git -C "$X" status', issueWt), ctx), 'git -C "$X" status');
  assertAllow(decide(bash(`GIT_DIR=${sh(join(main, '.git'))} git log`, issueWt), ctx), 'GIT_DIR= git log');
});

test('AC2：$(...)・bash -c・sh -c・eval・連結の中の git も見る', () => {
  const cmds = [
    'echo $(git commit -m x)',
    'bash -c "git add ."',
    "sh -c 'git reset --hard'",
    'eval "git stash"',
    'true && git commit -m x',
    'git status; git add .',
    'git fetch || git pull',
  ];
  for (const cmd of cmds) {
    assertDeny(decide(bash(cmd, main), ctx), `${cmd}（main）`);
    assertAllow(decide(bash(cmd, issueWt), ctx), `${cmd}（worktree）`);
  }
});

test('AC2：git 以外の Bash（echo > file・sed -i・rm・node harness/scripts/agent.ts worktree）は止めない', () => {
  const cmds = [
    'echo x > src/a.ts',
    "sed -i 's/a/b/' src/a.ts",
    'rm src/a.ts',
    'node harness/scripts/agent.ts worktree claude/issue-9-y',
    'npm test',
    'ls -la',
    'cat .gitignore',
    'echo "git commit -m x"',
  ];
  for (const cmd of cmds) {
    assertAllow(decide(bash(cmd, main), ctx), `${cmd}（main）`);
    assertAllow(decide(bash(cmd, marked), ctx), `${cmd}（hq）`);
  }
});

test('AC2：Bash の command が無い・文字列でないなら止める', () => {
  assertDeny(decide({ tool_name: 'Bash', tool_input: {}, cwd: main }, ctx), 'command が無い');
  assertDeny(decide({ tool_name: 'Bash', tool_input: { command: 1 }, cwd: main }, ctx), 'command が数');
});

// ---- AC3：Orca・hq を使わない今の手順 ----

test('AC3：Issue の worktree の中の plan・implement・judge・fix・sync の書き換えと git は止まらない', () => {
  const steps: Input[] = [
    write(join(issueWt, 'harness', 'lib', 'x.ts'), issueWt),
    edit(join(issueWt, 'src', 'a.ts'), issueWt),
    notebook(join(issueWt, 'n.ipynb'), issueWt),
    bash('git add -A && git commit -m "feat: x"', issueWt),
    bash('git push -u origin claude/issue-1-x', issueWt),
    bash('git fetch origin && git merge origin/main', issueWt),
    bash('git rebase origin/main', issueWt),
    bash('git checkout -- src/a.ts', issueWt),
    bash('git stash && git stash pop', issueWt),
    bash('git reset --soft HEAD~1', issueWt),
    bash('git restore --staged src/a.ts', issueWt),
    bash('npm run check', issueWt),
    bash('node harness/scripts/agent.ts claim 1 --manual --stage implement', issueWt),
  ];
  for (const s of steps) assertAllow(decide(s, ctx), JSON.stringify(s));
});

test('AC3：main の checkout での agent.ts worktree・git pull --ff-only・fetch と、一時ディレクトリへの Write は止まらない', () => {
  const steps: Input[] = [
    bash('node harness/scripts/agent.ts worktree claude/issue-1-x', main),
    bash('git pull --ff-only', main),
    bash('git fetch origin', main),
    bash('git fetch origin && git pull --ff-only', main),
    bash('git worktree remove ../repo.worktrees/claude-issue-1-x', main),
    write(join(allowDir, 'plan.md'), main),
    write(join(allowDir, 'scratch', 'critic-input.json'), main),
  ];
  for (const s of steps) assertAllow(decide(s, ctx), JSON.stringify(s));
});

// ---- 子プロセス（run.mjs を通して main() を動かす） ----

interface DenyOutput { hookSpecificOutput?: { hookEventName?: unknown; permissionDecision?: unknown; permissionDecisionReason?: unknown } }

function spawnHook(input: string, hookArg: string = HOOK) {
  return spawnSync(process.execPath, [RUN, hookArg], { cwd: root, input, encoding: 'utf8' });
}

function assertDenyOutput(r: ReturnType<typeof spawnHook>, label: string): void {
  assert.equal(r.status, 0, `${label}: exit code（stderr: ${r.stderr}）`);
  const out = JSON.parse(r.stdout) as DenyOutput;
  assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse', label);
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', label);
  const reason = out.hookSpecificOutput?.permissionDecisionReason;
  assert.ok(typeof reason === 'string' && reason.length > 0, `${label}: 理由が空`);
}

test('子プロセス：run.mjs 経由の workspace-guard は、JSON でない stdin と file_path の無い Write を deny する', () => {
  for (const hookArg of [HOOK, '.claude/hooks/workspace-guard.ts']) {
    assertDenyOutput(spawnHook('not json', hookArg), `JSON でない（${hookArg}）`);
    const noPath = JSON.stringify({ tool_name: 'Write', tool_input: { content: 'x' }, hook_event_name: 'PreToolUse', cwd: tmpdir() });
    assertDenyOutput(spawnHook(noPath, hookArg), `file_path の無い Write（${hookArg}）`);
  }
});

test('子プロセス：run.mjs 経由の workspace-guard は、os.tmpdir() の中への Write では何も出さない', () => {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(tmpdir(), 'workspace-guard-child.txt'), content: 'x' }, hook_event_name: 'PreToolUse', cwd: tmpdir() });
  const r = spawnHook(input);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '', `通すときは何も出さない: ${r.stdout}`);
});

test('import しただけでは main() が動かない（stdin を待たずに import が終わる）', () => {
  const code = `await import(${JSON.stringify(pathToFileURL(HOOK).href)}); console.log('loaded');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'loaded');
});
