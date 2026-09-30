// Issue #331：ワークスペースの見張りの hook（.claude/hooks/workspace-guard.ts）が、同じコマンドの中で git pull より前に git の設定の読み先（HOME・XDG_CONFIG_HOME・GIT_CONFIG_*）や設定そのものを変える形を、pull.ff=only の main の checkout でも素の pull として止め、今通している形（素の pull・--ff-only・Issue の worktree）は通すか
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { decide, MARKER } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, git, guardSandbox } from './support/workspace-guard-sandbox.ts';

/** pull.ff=only・pull.rebase=false（素の pull を通す形） */
const only = guardSandbox({ pullFf: 'only', pullRebase: 'false' });
after(() => only.cleanup());

/** 印のあるワークスペース（本体とは別の git worktree の一番上に MARKER を置く） */
const marked = join(only.base, 'hq');
git(only.main, 'worktree', 'add', '-q', '-b', 'hq', marked);
writeFileSync(join(marked, MARKER), '');

/** main の checkout で止め、理由に main の checkout が出る */
function denyMain(cmd: string): void {
  const d = decide(bash(cmd, only.main), only.ctx);
  assertDeny(d, `${cmd}（pull.ff=only の main）`);
  if (d.deny) assert.ok(d.reason.includes('main の checkout'), `理由に「main の checkout」が無い: ${cmd}: ${d.reason}`);
}

/** ケースごとに子のテストにして、どれが落ちたかを1件ずつ見られるようにする */
async function eachCase(t: TestContext, cmds: string[], check: (cmd: string) => void): Promise<void> {
  for (const cmd of cmds) await t.test(JSON.stringify(cmd), () => check(cmd));
}

// ---- AC1：pull より前に設定の読み先を変える形を止める ----

test('AC1：export で HOME・GIT_CONFIG_GLOBAL を変えてからの git pull を止める', async (t) => {
  await eachCase(t, ['export HOME=/x; git pull', 'export GIT_CONFIG_GLOBAL=/x; git pull'], denyMain);
});

test('AC1：export で XDG_CONFIG_HOME・GIT_CONFIG_NOSYSTEM・GIT_CONFIG_COUNT 系を変えてからの git pull を止める', async (t) => {
  await eachCase(t, [
    'export XDG_CONFIG_HOME=/x && git pull',
    'export GIT_CONFIG_NOSYSTEM=1; git pull',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=pull.ff GIT_CONFIG_VALUE_0=false; git pull',
  ], denyMain);
});

test('AC1：代入・declare・typeset・unset・値なしの export・builtin export・動的な export の後の git pull を止める', async (t) => {
  await eachCase(t, [
    'HOME=/x; git pull',
    'declare -x HOME=/x; git pull',
    'typeset -x HOME=/x; git pull',
    'unset HOME; git pull',
    'export HOME; git pull',
    'builtin export HOME=/x; git pull',
    'export "$V"; git pull',
  ], denyMain);
});

test('AC1：source・. でファイルを読み込んだ後の git pull を止める（builtin を付けても）', async (t) => {
  await eachCase(t, ['source ./x; git pull', '. ./x; git pull', 'builtin source ./x; git pull', 'builtin . ./x; git pull'], denyMain);
});

test('AC1：eval・bash -c・改行でつないだ形を止める', async (t) => {
  await eachCase(t, ["eval 'export HOME=/x'; git pull", "export HOME=/x; bash -c 'git pull'", 'export HOME=/x\ngit pull'], denyMain);
});

test('AC1：for・read・printf -v で変数を書き換えてからの git pull を止める', async (t) => {
  await eachCase(t, [
    'for HOME in /x; do git pull; done',
    'read HOME <<< /x; git pull',
    'printf -v HOME /x; git pull',
    'for $V in /x; do git pull; done',
  ], denyMain);
});

test('AC1：git config で pull の設定を書き換えてからの git pull を止める', async (t) => {
  await eachCase(t, [
    'git config pull.ff false; git pull',
    'git config --global pull.ff false && git pull',
    'git config set pull.rebase true; git pull',
    'git -C . config pull.ff false; git pull',
  ], denyMain);
});

test('AC1：前置きの代入・env で読み先を変えた子のシェル・eval・ヒアドキュメントの中の git pull を止める', async (t) => {
  await eachCase(t, [
    "HOME=/x bash -c 'git pull'",
    "env GIT_CONFIG_GLOBAL=/x bash -c 'git pull'",
    "HOME=/x eval 'git pull'",
    'HOME=/x bash <<EOF\ngit pull\nEOF',
  ], denyMain);
});

test('AC1：declare -n の名前の参照で HOME を書き換えてからの git pull を止める', () => {
  denyMain('declare -n r=HOME; r=/x; git pull');
});

test('AC1：パイプ・コマンド置換・ヒアドキュメント・サブシェルと組み合わせた形も止める（安全側に倒す）', async (t) => {
  await eachCase(t, [
    'export HOME=/x | git pull',
    'export HOME=/x; echo $(git pull)',
    'export HOME=/x; bash <<EOF\ngit pull\nEOF',
    '(export HOME=/x); git pull',
  ], denyMain);
});

// ---- AC2：今通している形は変えない ----

test('AC2：pull.ff=only の main の checkout で、素の pull・関係の無い変数の export・設定の読み出しの後の pull は通す', async (t) => {
  const { main, ctx } = only;
  await eachCase(t, [
    'git pull',
    'git pull origin main',
    'export FOO=1; git pull',
    'export PATH=/x:$PATH; git pull',
    "bash -c 'export HOME=/x'; git pull",
    'git config --get pull.ff; git pull',
    'git config --list; git pull',
  ], (cmd) => assertAllow(decide(bash(cmd, main), ctx), `${cmd}（pull.ff=only の main）`));
});

test('AC2：読み先を変えても --ff-only の pull は今までどおり通す', () => {
  assertAllow(decide(bash('export HOME=/x; git pull --ff-only', only.main), only.ctx), 'export HOME=/x; git pull --ff-only（main）');
});

// ---- AC3：Issue の worktree・印のあるワークスペース ----

test('AC3：Issue の worktree では、読み先を変えた pull も素の pull も通す', () => {
  const { issueWt, ctx } = only;
  assertAllow(decide(bash('export HOME=/x; git pull', issueWt), ctx), 'export HOME=/x; git pull（worktree）');
  assertAllow(decide(bash('git pull', issueWt), ctx), 'git pull（worktree）');
});

test('AC3：印のあるワークスペースでは、読み先を変えた pull を止める', () => {
  assertDeny(decide(bash('export HOME=/x; git pull', marked), only.ctx), 'export HOME=/x; git pull（印のあるワークスペース）');
});
