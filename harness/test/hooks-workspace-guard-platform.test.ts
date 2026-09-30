// Issue #296（#286 の続き）：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）のパスの扱い（区切り・大文字小文字・Git Bash の形）を、文脈の platform として受け取り、どの OS でも win32 と posix の両方を確かめる（ファイルシステムに頼らない仮の場所と、platform を省いた実際の git の砂場）
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide, type WorkspaceContext } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, gitBash, guardSandbox, sh, write } from './support/workspace-guard-sandbox.ts';

// ---- 仮の場所：ファイルシステムに頼らず、platform と locate を差し替える ----

interface FakeLayout { main: string; wt: string; allow: string }

/** 仮の場所の locate。platform が win32 なら大文字小文字と区切りを区別せずに比べる */
function fakeCtx(platform: 'win32' | 'linux', l: FakeLayout): WorkspaceContext {
  const norm = (p: string): string => (platform === 'win32' ? p.replaceAll('/', '\\').toLowerCase() : p).replace(/[\\/]+$/, '');
  const under = (p: string, r: string): boolean => {
    const a = norm(p);
    const b = norm(r);
    return a === b || a.startsWith(b + (platform === 'win32' ? '\\' : '/'));
  };
  return {
    platform,
    allowRoots: [l.allow],
    locate: (dir: string) => {
      if (under(dir, l.wt)) return { kind: 'repo', toplevel: l.wt, mainRoot: l.main };
      if (under(dir, l.main)) return { kind: 'repo', toplevel: l.main, mainRoot: l.main };
      return { kind: 'none' };
    },
    hasMarker: () => false,
  };
}

// allowRoots を main の中に置き、allowRoots に当たらなければ main の checkout として止まる形にする
const WIN_LAYOUT: FakeLayout = { main: 'C:\\wg-fake\\repo', wt: 'C:\\wg-fake\\repo.worktrees\\claude-issue-1-x', allow: 'C:\\wg-fake\\repo\\tmp' };
const POSIX_LAYOUT: FakeLayout = { main: '/wg-fake/repo', wt: '/wg-fake/repo.worktrees/claude-issue-1-x', allow: '/wg-fake/repo/tmp' };

test('AC1（win32）：allowRoots と main の比べ方は大文字小文字・区切りを区別せず、Git Bash の /c/... を C:/... と読む', () => {
  const c = fakeCtx('win32', WIN_LAYOUT);
  const m = WIN_LAYOUT.main;
  assertAllow(decide(write('C:\\WG-FAKE\\REPO\\TMP\\X.TXT', m), c), '大文字の allowRoots');
  assertAllow(decide(write('C:/wg-fake/repo/tmp/x.txt', m), c), '区切りが / の allowRoots');
  assertAllow(decide(write('/c/wg-fake/repo/tmp/x.txt', m), c), 'Git Bash の形の allowRoots');
  assertDeny(decide(write('C:\\WG-FAKE\\REPO\\SRC\\A.TS', m), c), 'main の大文字');
  assertDeny(decide(write('C:/wg-fake/repo/src/a.ts', m), c), 'main の区切りが /');
  assertDeny(decide(write('/c/wg-fake/repo/src/a.ts', m), c), 'main の Git Bash の形');
  assertAllow(decide(write('/c/wg-fake/repo.worktrees/claude-issue-1-x/a.ts', m), c), 'worktree の Git Bash の形');
  assertDeny(decide(write('src\\a.ts', '/c/wg-fake/repo'), c), 'cwd が Git Bash の形の main で相対パス');
});

test('AC1（posix）：大文字小文字を区別し、/c/... は C:/... と読まない', () => {
  const c = fakeCtx('linux', POSIX_LAYOUT);
  const m = POSIX_LAYOUT.main;
  assertAllow(decide(write('/wg-fake/repo/tmp/x.txt', m), c), 'allowRoots');
  assertDeny(decide(write('/wg-fake/repo/TMP/x.txt', m), c), '大文字の TMP は allowRoots ではない（main の中なので止まる）');
  assertDeny(decide(write('/wg-fake/repo/src/a.ts', m), c), 'main');
  assertAllow(decide(write('/wg-fake/repo.worktrees/claude-issue-1-x/a.ts', m), c), 'worktree');
  assertAllow(decide(write('/c/wg-fake/repo/src/a.ts', m), c), '/c/... は読み替えず、main の外（リポジトリの外）として通す');
});

test('AC2（win32）：git -C・cd の Git Bash の形 /c/... も C:/... と読む', () => {
  const c = fakeCtx('win32', WIN_LAYOUT);
  const wt = WIN_LAYOUT.wt;
  assertDeny(decide(bash('git -C /c/wg-fake/repo commit -m x', wt), c), 'git -C /c/wg-fake/repo');
  assertDeny(decide(bash('cd /c/WG-FAKE/repo && git add .', wt), c), 'cd /c/WG-FAKE/repo &&');
  assertAllow(decide(bash('git -C /c/wg-fake/repo.worktrees/claude-issue-1-x commit -m x', WIN_LAYOUT.main), c), 'git -C の worktree');
  assertAllow(decide(bash('git -C /c/wg-fake/repo pull --ff-only', wt), c), 'git -C main pull --ff-only');
});

test('AC2（posix）：git -C・cd のパスはそのまま読む', () => {
  const c = fakeCtx('linux', POSIX_LAYOUT);
  const wt = POSIX_LAYOUT.wt;
  assertDeny(decide(bash('git -C /wg-fake/repo commit -m x', wt), c), 'git -C main');
  assertDeny(decide(bash('cd /wg-fake/repo && git add .', wt), c), 'cd main &&');
  assertAllow(decide(bash('git -C /wg-fake/repo.worktrees/claude-issue-1-x commit -m x', POSIX_LAYOUT.main), c), 'git -C の worktree');
  assertAllow(decide(bash('git -C /c/wg-fake/repo commit -m x', wt), c), '/c/... は読み替えない');
});

// ---- 実際の git の砂場：platform を省いた realContext（この OS のパスの扱い） ----

const sb = guardSandbox({ pullFf: 'false', pullRebase: 'false' });
after(() => sb.cleanup());

test('realContext（platform を省く）：この OS のパスの形でも、main の checkout を止め、worktree と allowRoots は通す', () => {
  const { main, issueWt, allowDir, ctx } = sb;
  if (process.platform === 'win32') {
    // Windows：大文字小文字と区切りを区別せず、Git Bash の /c/... を C:/... と読む
    assertAllow(decide(write(join(allowDir, 'x.txt').toUpperCase(), main), ctx), 'allowRoots の大文字');
    assertAllow(decide(write(sh(join(allowDir, 'x.txt')), main), ctx), 'allowRoots の区切りが /');
    assertAllow(decide(write(gitBash(join(allowDir, 'x.txt')), main), ctx), `allowRoots の Git Bash の形: ${gitBash(join(allowDir, 'x.txt'))}`);
    assertDeny(decide(write(join(main, 'src', 'a.ts').toUpperCase(), main), ctx), 'main の大文字');
    assertDeny(decide(write(gitBash(join(main, 'src', 'a.ts')), main), ctx), `main の Git Bash の形: ${gitBash(join(main, 'src', 'a.ts'))}`);
    assertAllow(decide(write(gitBash(join(issueWt, 'a.ts')), main), ctx), 'worktree の Git Bash の形');
    assertDeny(decide(bash(`git -C ${gitBash(main)} commit -m x`, issueWt), ctx), `git -C ${gitBash(main)}`);
    assertAllow(decide(bash(`git -C ${gitBash(issueWt)} commit -m x`, main), ctx), `git -C ${gitBash(issueWt)}`);
  } else {
    // Windows 以外：区切りの重なり・. と .. をそろえて比べ、/c/... は読み替えない
    assertAllow(decide(write(`${allowDir}//x.txt`, main), ctx), 'allowRoots の区切りの重なり');
    assertDeny(decide(write(`${main}//src//a.ts`, main), ctx), 'main の区切りの重なり');
    assertDeny(decide(write(`${main}/./src/../src/a.ts`, main), ctx), 'main の . と ..');
    assertAllow(decide(write(`${issueWt}//a.ts`, main), ctx), 'worktree の区切りの重なり');
    assertDeny(decide(bash(`git -C ${main}// commit -m x`, issueWt), ctx), 'git -C main の末尾の区切りの重なり');
    assertAllow(decide(bash(`git -C ${issueWt}/ commit -m x`, main), ctx), 'git -C worktree の末尾の区切り');
    assertAllow(decide(write(`/c${main}/src/a.ts`, main), ctx), '/c/... は読み替えず、main の外として通す');
  }
});
