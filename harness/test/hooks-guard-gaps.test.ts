import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

const ctx: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/x',
};
const onMain: GuardContext = { ...ctx, currentBranch: 'main' };
const atMain: GuardContext = { ...ctx, branchAt: () => 'main' };
const atClaude: GuardContext = { ...ctx, branchAt: () => 'claude/x' };
/** 既存の hooks-guard.test.ts と同じ ctx（通す例の再確認に使う） */
const ctx106: GuardContext = { ...ctx, currentBranch: 'claude/106-x' };
const unknownBranch: GuardContext = { ...ctx, currentBranch: null };

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

function assertDeny(input: HookInput, c: GuardContext, label: string): void {
  const d = decide(input, c);
  assert.equal(d.deny, true, `止めるべき: ${label}`);
  if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${label}`);
}

function assertAllow(input: HookInput, c: GuardContext, label: string): void {
  assert.deepEqual(decide(input, c), { deny: false }, `通すべき: ${label}`);
}

function assertRawDeny(input: HookInput, c: GuardContext | null, label: string): void {
  const d = decideRaw(JSON.stringify(input), c);
  assert.equal(d.deny, true, `止めるべき: ${label}`);
  if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${label}`);
}

function assertRawAllow(input: HookInput, c: GuardContext | null, label: string): void {
  assert.deepEqual(decideRaw(JSON.stringify(input), c), { deny: false }, `通すべき: ${label}`);
}

test('--repo があれば位置引数をすべて refspec とみなして main への push を止める', () => {
  for (const cmd of ['git push --repo=origin HEAD:main', 'git push --repo origin HEAD:main', 'git push --repo=origin main']) {
    assertDeny(bash(cmd), ctx, cmd);
  }
});

test('main にいるときの --repo 付きの refspec なし・remote 名だけの push を止める', () => {
  for (const cmd of ['git push --repo=origin', 'git push --repo=origin origin']) {
    assertDeny(bash(cmd), onMain, `${cmd}（main にいる）`);
  }
});

test('-c・--config-env・環境変数・git config で送り先を変える push と設定の書き込みを止める', () => {
  const cmds = [
    'git -c remote.origin.push=HEAD:main push',
    'git -c push.default=upstream push',
    'git -c Remote.Origin.Push=HEAD:main push origin',
    'git --config-env=remote.origin.push=X push',
    'git -c "$K" push',
    "GIT_CONFIG_PARAMETERS=\"'remote.origin.push'='HEAD:main'\" git push",
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push',
    'git config remote.origin.push HEAD:main',
    'git config --global push.default upstream',
    'git config set push.default current',
    'git -c remote.origin.mirror=true push origin',
    'git config remote.origin.mirror true',
    'git remote add --mirror=push m https://example.invalid/r.git',
    'GIT_DIR=/wt/.git git push',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('sudo・doas・nice・timeout などの前置きの中の push・merge・保護ラベルを止める', () => {
  const cmds = [
    'sudo git push origin HEAD:main',
    'sudo -u root git push -f',
    'sudo -- gh pr merge 1',
    'sudo -E env git push origin main',
    'sudo gh issue edit 1 --add-label agent:hold',
    'nice -n 5 git push origin HEAD:main',
    'timeout 30 git push origin main',
    'stdbuf -o0 git push -f',
    'setsid gh pr merge 1',
    'ionice -c 3 git push origin main',
    'doas -u root git push origin main',
    'timeout -s KILL 30 git push origin HEAD:main',
    'nice --adjustment=5 git push -f',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('sudo -D・env -C の先のブランチが main なら refspec なしの push を止め、claude/ なら通す', () => {
  assertDeny(bash('sudo -D /wt git push'), atMain, 'sudo -D /wt git push（/wt は main）');
  assertDeny(bash('env -C /wt git push'), atMain, 'env -C /wt git push（/wt は main）');
  assertAllow(bash('sudo -D /wt git push'), atClaude, 'sudo -D /wt git push（/wt は claude/x）');
});

test('MCP の Draft 解除（update_pull_request の draft: false、ready_for_review）を止める', () => {
  const cases: Array<[string, HookInput]> = [
    ['update_pull_request draft: false', { tool_name: 'mcp__github__update_pull_request', tool_input: { pull_number: 1, draft: false } }],
    ["update_pull_request draft: 'false'", { tool_name: 'mcp__github__update_pull_request', tool_input: { pull_number: 1, draft: 'false' } }],
    ['mark_pull_request_ready_for_review', { tool_name: 'mcp__github__mark_pull_request_ready_for_review', tool_input: { pull_number: 1 } }],
  ];
  for (const [label, input] of cases) assertDeny(input, ctx, label);
});

test('送り先を変えない --repo・-c・git config・sudo・nice と、Draft を解除しない update_pull_request は通す', () => {
  const cmds = [
    'git push --repo=origin claude/x',
    'git -c user.name=x commit -m m',
    'git -c push.default=upstream status',
    'git config --get push.default',
    'git config user.name x',
    'git remote add --mirror=fetch m https://example.invalid/r.git',
    'sudo ls',
    'nice -n 5 npm run check',
  ];
  for (const cmd of cmds) assertAllow(bash(cmd), ctx, cmd);
  const cases: Array<[string, HookInput]> = [
    ['update_pull_request draft: true', { tool_name: 'mcp__github__update_pull_request', tool_input: { pull_number: 1, draft: true } }],
    ['update_pull_request title だけ', { tool_name: 'mcp__github__update_pull_request', tool_input: { pull_number: 1, title: 't' } }],
  ];
  for (const [label, input] of cases) assertAllow(input, ctx, label);
});

test('既存の通す例（普通の Bash の操作）が通るまま', () => {
  const cmds = [
    'git push -u origin claude/106-x',
    'git push origin HEAD',
    'git push',
    'git merge origin/main',
    'gh pr view 1',
    'gh issue edit 1 --add-label area:harness',
    'npm run check',
    'gh issue comment 1 --body-file x',
    'gh api repos/o/r/pulls/1/reviews',
    "git commit -m \"$(cat <<'EOF'\nfix merge of main\nEOF\n)\"",
    'echo "gh pr merge 1"',
  ];
  for (const cmd of cmds) assertAllow(bash(cmd), ctx106, cmd);
});

test('既存の通す例（普通の MCP の操作と Bash 以外のツール）が通るまま', () => {
  const cases: Array<[string, HookInput]> = [
    ['add_issue_comment の本文に保護ラベル名', { tool_name: 'mcp__github__add_issue_comment', tool_input: { issue_number: 1, body: 'agent:hold を外してください' } }],
    ['push_files branch claude/x', { tool_name: 'mcp__github__push_files', tool_input: { owner: 'o', repo: 'r', branch: 'claude/x', files: [] } }],
    ['github 以外の MCP', { tool_name: 'mcp__slack__post_message', tool_input: { text: 'gh pr merge 1', labels: ['agent:hold'] } }],
    ['Read', { tool_name: 'Read', tool_input: { file_path: '/x/merge/main.ts' } }],
  ];
  for (const [label, input] of cases) assertAllow(input, ctx106, label);
});

const rawAllowCmds = ['git merge origin/main', 'grep merge x', 'echo push', 'gh pr view 1 --json mergeable'];
const rawDenyCmds = [
  'git push -u origin claude/x',
  'git -C /wt push origin claude/x',
  'cd /wt && git push',
  'sudo git push',
  'bash -c "git push"',
  'gh pr merge 1',
  'gh api -X PUT repos/o/r/pulls/1/merge',
  'gh api -X PATCH repos/o/r/git/refs/heads/main',
  'gh issue edit 1 --add-label agent:hold',
];

test('decideRaw: 今のブランチが読めないときは push・merge・保護ラベルを止め、それ以外は通す', () => {
  for (const cmd of rawAllowCmds) assertRawAllow(bash(cmd), unknownBranch, `ブランチ不明で ${cmd}`);
  for (const cmd of rawDenyCmds) assertRawDeny(bash(cmd), unknownBranch, `ブランチ不明で ${cmd}`);
  assertRawDeny(
    { tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 1, labels: ['agent:hold'] } },
    unknownBranch,
    'ブランチ不明で update_issue labels agent:hold',
  );
  assertRawAllow(
    { tool_name: 'mcp__github__add_issue_comment', tool_input: { issue_number: 1, body: 'x' } },
    unknownBranch,
    'ブランチ不明で add_issue_comment',
  );
});

test('decideRaw: 設定が読めない（ctx が null）ときも push・merge・保護ラベル・Draft 解除を止め、それ以外は通す', () => {
  for (const cmd of rawAllowCmds) assertRawAllow(bash(cmd), null, `ctx null で ${cmd}`);
  for (const cmd of rawDenyCmds) assertRawDeny(bash(cmd), null, `ctx null で ${cmd}`);
  assertRawDeny(
    { tool_name: 'mcp__github__update_pull_request', tool_input: { pull_number: 1, draft: false } },
    null,
    'ctx null で update_pull_request draft: false',
  );
});
