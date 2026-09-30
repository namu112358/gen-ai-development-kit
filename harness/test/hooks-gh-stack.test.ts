import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

// Issue #147：hook が gh stack の書き込み・Merge の操作を止め、読むだけの操作と PR 番号だけの link を通す

const ctx: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/issue-1-a',
};

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

function assertDeny(command: string): void {
  const d = decide(bash(command), ctx);
  assert.equal(d.deny, true, `止めるべき: ${command}`);
  if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${command}`);
}

function assertAllow(command: string): void {
  assert.deepEqual(decide(bash(command), ctx), { deny: false }, `通すべき: ${command}`);
}

test('gh stack の Merge・push・同期・rebase・submit・modify・alias などの書き込みを止める', () => {
  for (const cmd of [
    'gh stack merge',
    'gh stack merge 7 --yes --squash',
    'gh stack push',
    'gh stack sync --prune',
    'gh stack rebase --upstack',
    'gh stack submit --auto',
    'gh stack modify',
    'gh stack alias',
    'gh stack alias gst',
    'gh stack unstack',
    'gh stack init x',
    'gh stack add -Am m',
    'gh stack feedback',
  ]) {
    assertDeny(cmd);
  }
});

test('gh stack checkout は対話でリモートのスタックを unstack しうるので止める', () => {
  for (const cmd of ['gh stack checkout 42', 'gh stack checkout']) assertDeny(cmd);
});

test('gh stack link にブランチ名や作成・base 変更の指定があれば止める', () => {
  for (const cmd of [
    'gh stack link feature-a feature-b',
    'gh stack link 10 feature-ui',
    'gh stack link --open 10 20',
    'gh stack link --base develop 10 20',
    'gh stack link 10 20 --remote origin',
  ]) {
    assertDeny(cmd);
  }
});

test('gh のグローバルな指定・extension exec・直接の実行ファイルの形でも止める', () => {
  for (const cmd of [
    'gh -R o/r stack merge',
    'gh extension exec stack merge',
    'gh extensions exec stack sync',
    'gh ext exec stack push',
    'gh-stack merge',
    '/home/u/.local/share/gh/extensions/gh-stack/gh-stack push',
    'gh-stack.exe sync',
    'C:/Users/u/AppData/Local/gh/extensions/gh-stack/gh-stack.exe merge',
    '"C:\\Users\\u\\AppData\\Local\\gh\\extensions\\gh-stack\\gh-stack.exe" merge',
  ]) {
    assertDeny(cmd);
  }
});

test('連結・bash -c の中の gh stack も止める', () => {
  for (const cmd of ['true && gh stack merge', 'bash -c "gh stack push"']) assertDeny(cmd);
});

test('サブコマンドや link の引数が変数で決まらないときは止める', () => {
  for (const cmd of ['gh stack $SUB', 'gh stack link $B', 'gh stack link 10 $B']) assertDeny(cmd);
});

test('gh api で merge-async に PUT するのを止める', () => {
  for (const cmd of [
    'gh api -X PUT repos/o/r/pulls/1/merge-async --input -',
    'gh api --method PUT repos/o/r/pulls/1/merge-async',
  ]) {
    assertDeny(cmd);
  }
});

test('gh stack を止める理由は gh-stack の skill を案内する', () => {
  const d = decide(bash('gh stack merge'), ctx);
  assert.equal(d.deny, true);
  if (d.deny) assert.ok(d.reason.includes('gh-stack の skill'), `理由: ${d.reason}`);
});

test('PR 番号・PR の URL だけの gh stack link は通す', () => {
  for (const cmd of [
    'gh stack link 10 20',
    'gh stack link https://github.com/o/r/pull/10 https://github.com/o/r/pull/20',
    'gh stack link 7 48',
  ]) {
    assertAllow(cmd);
  }
});

test('gh stack の見るだけ・移動・ヘルプの操作は通す', () => {
  for (const cmd of [
    'gh stack view',
    'gh stack view --json',
    'gh stack view --short',
    'gh stack up',
    'gh stack down 2',
    'gh stack top',
    'gh stack bottom',
    'gh stack switch',
    'gh stack trunk',
    'gh stack --help',
    'gh stack -h',
    'gh stack help',
    'gh stack version',
    'gh stack',
    'gh extension exec stack view',
    'gh-stack view',
  ]) {
    assertAllow(cmd);
  }
});

test('merge-async の状態を読む GET と、下の層を base にした Draft PR の作成は通す', () => {
  for (const cmd of ['gh api repos/o/r/pulls/1/merge-async/630b9d5e', 'gh pr create --draft --base claude/issue-1-a']) {
    assertAllow(cmd);
  }
});

test('JSON として読めない入力は止める', () => {
  const d = decideRaw('{"tool_name":"Bash","tool_input":{"command":"gh stack merge"', ctx);
  assert.equal(d.deny, true);
});
