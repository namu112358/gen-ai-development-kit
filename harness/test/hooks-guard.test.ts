import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

const root = join(import.meta.dirname, '..', '..');

const ctx: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/106-x',
};
const onMain: GuardContext = { ...ctx, currentBranch: 'main' };

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

function assertDeny(input: HookInput, c: GuardContext, label: string): void {
  const d = decide(input, c);
  assert.equal(d.deny, true, `止めるべき: ${label}`);
  if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${label}`);
}

function assertAllow(input: HookInput, c: GuardContext, label: string): void {
  assert.deepEqual(decide(input, c), { deny: false }, `通すべき: ${label}`);
}

test('main への push とその別名を止める', () => {
  const cmds = [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin @:main',
    'git push origin x:refs/heads/main',
    'git push origin +feature:main',
    'git push origin feature:main',
    'git -C . push origin main',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('今のブランチが main のときの refspec なしの push と HEAD の push を止める', () => {
  for (const cmd of ['git push', 'git push origin HEAD']) assertDeny(bash(cmd), onMain, `${cmd}（main にいる）`);
});

test('force push・--mirror・--all を止める', () => {
  const cmds = [
    'git push --force',
    'git push -f',
    'git push -fu origin x',
    'git push --force-with-lease',
    'git push --force-with-lease=x',
    'git push --force-if-includes',
    'git push origin +claude/x',
    'git push --mirror',
    'git push --all',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('既定ブランチの削除を止める', () => {
  for (const cmd of ['git push origin --delete main', 'git push origin :main']) assertDeny(bash(cmd), ctx, cmd);
});

test('シェルの包み・前置き・連結・コマンド置換の中の操作も止める', () => {
  const cmds = [
    'bash -c "git push origin HEAD:main"',
    'sh -c "git push origin HEAD:main"',
    'eval "git push origin main"',
    'FOO=1 git push -f',
    'env git push origin main',
    'true && gh pr merge 1',
    'echo $(gh pr merge 1)',
    'echo `gh pr merge 1`',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('gh api による merge と既定ブランチへの書き込みを止める', () => {
  const cmds = [
    'gh api repos/o/r/pulls/1/merge -X PUT',
    "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
    "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"x\"}){clientMutationId}}'",
    "gh api graphql -f query='mutation{mergeBranch(input:{repositoryId:\"x\",base:\"main\",head:\"y\"}){clientMutationId}}'",
    'gh api -X PATCH repos/o/r/git/refs/heads/main',
    'gh api -X POST repos/o/r/merges -f base=main -f head=x',
    'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=Zg==',
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('保護ラベルの付け外しを止める（書き方の違い・大文字小文字・*:exempt も）', () => {
  const cmds = [
    'gh issue edit 1 --add-label agent:hold',
    'gh pr edit 1 --remove-label foo,review:exempt',
    'gh issue edit 1 --add-label agent:auto-merge-stopped',
    'gh issue edit 1 --add-label=agent:hold',
    'gh issue create -l agent:plan-ok',
    'gh pr create --label=Agent:Hold',
    'gh label delete agent:hold',
    "gh api repos/o/r/issues/1/labels -f 'labels[]=agent:hold'",
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('展開しないと分からない refspec・ラベルと、字句に分けられないコマンドは安全側に止める', () => {
  const cmds = [
    'git push origin "$BR"',
    'git push origin ${BR}',
    'git push origin $(git branch --show-current)',
    'gh issue edit 1 --add-label "$L"',
    "git push origin 'main",
  ];
  for (const cmd of cmds) assertDeny(bash(cmd), ctx, cmd);
});

test('MCP の merge・保護ラベル・既定ブランチへの書き込みを止める', () => {
  const cases: Array<[string, HookInput]> = [
    ['update_issue labels', { tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 1, labels: ['bug', 'agent:plan-ok'] } }],
    ['入れ子の label キー', { tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 1, fields: { labelNames: ['agent:hold'] } } }],
    ['merge_pull_request', { tool_name: 'mcp__github__merge_pull_request', tool_input: { pull_number: 1 } }],
    ['push_files branch main', { tool_name: 'mcp__github__push_files', tool_input: { owner: 'o', repo: 'r', branch: 'main', files: [] } }],
    ['push_files branch なし', { tool_name: 'mcp__github__push_files', tool_input: { owner: 'o', repo: 'r', files: [] } }],
    ['create_or_update_file branch main', { tool_name: 'mcp__github__create_or_update_file', tool_input: { owner: 'o', repo: 'r', path: 'a.txt', content: 'x', message: 'm', branch: 'main' } }],
  ];
  for (const [label, input] of cases) assertDeny(input, ctx, label);
});

test('止める理由に CLAUDE.md への言及がある', () => {
  const d = decide(bash('gh pr merge 1'), ctx);
  assert.equal(d.deny, true);
  if (d.deny) assert.match(d.reason, /CLAUDE\.md/);
});

test('普通の Bash の操作は通す', () => {
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
  for (const cmd of cmds) assertAllow(bash(cmd), ctx, cmd);
});

test('cd の先のブランチで refspec なしの push を判定する', () => {
  const cmd = 'cd /wt && git push';
  assertAllow(bash(cmd), { ...ctx, branchAt: () => 'claude/x' }, `${cmd}（/wt は claude/x）`);
  assertDeny(bash(cmd), { ...ctx, branchAt: () => 'main' }, `${cmd}（/wt は main）`);
  assertDeny(bash(cmd), { ...ctx, branchAt: () => null }, `${cmd}（/wt のブランチが不明）`);
  assertDeny(bash(cmd), ctx, `${cmd}（branchAt なし）`);
});

test('普通の MCP の操作と Bash 以外のツールは通す', () => {
  const cases: Array<[string, HookInput]> = [
    ['add_issue_comment の本文に保護ラベル名', { tool_name: 'mcp__github__add_issue_comment', tool_input: { issue_number: 1, body: 'agent:hold を外してください' } }],
    ['push_files branch claude/x', { tool_name: 'mcp__github__push_files', tool_input: { owner: 'o', repo: 'r', branch: 'claude/x', files: [] } }],
    ['github 以外の MCP', { tool_name: 'mcp__slack__post_message', tool_input: { text: 'gh pr merge 1', labels: ['agent:hold'] } }],
    ['Read', { tool_name: 'Read', tool_input: { file_path: '/x/merge/main.ts' } }],
  ];
  for (const [label, input] of cases) assertAllow(input, ctx, label);
});

test('decideRaw: JSON が読めないときは push・merge・保護ラベルの名前があれば止め、なければ通す', () => {
  assert.equal(decideRaw('{not json git push origin claude/x', ctx).deny, true, '壊れた JSON に git push');
  assert.deepEqual(decideRaw('hello', ctx), { deny: false }, '壊れた JSON に hello');
});

test('decideRaw: 設定が読めないとき（ctx が null）も同じく安全側に倒す', () => {
  assert.deepEqual(decideRaw(JSON.stringify(bash('ls')), null), { deny: false }, 'ctx null で ls');
  assert.equal(decideRaw(JSON.stringify(bash('git push -u origin claude/x')), null).deny, true, 'ctx null で git push');
  const unknownBranch: GuardContext = { ...ctx, currentBranch: null };
  assert.deepEqual(decideRaw(JSON.stringify(bash('ls')), unknownBranch), { deny: false }, 'ブランチ不明で ls');
  assert.equal(decideRaw(JSON.stringify(bash('git push -u origin claude/x')), unknownBranch).deny, true, 'ブランチ不明で git push');
});

test('decideRaw: 読める JSON は decide と同じ結果になる', () => {
  for (const cmd of ['gh pr view 1', 'git push -u origin claude/106-x', 'gh pr merge 1', 'git push origin HEAD:main']) {
    const input = bash(cmd);
    assert.equal(decideRaw(JSON.stringify(input), ctx).deny, decide(input, ctx).deny, cmd);
  }
});

function runHook(input: HookInput): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['.claude/hooks/guard.ts'], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('子プロセス: 止める入力では PreToolUse の deny と理由を出して exit 0', () => {
  for (const cmd of ['gh pr merge 1', 'git push origin HEAD:main']) {
    const r = runHook({ ...bash(cmd), hook_event_name: 'PreToolUse', cwd: root });
    assert.equal(r.status, 0, `${cmd}: exit code（stderr: ${r.stderr}）`);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { hookEventName?: unknown; permissionDecision?: unknown; permissionDecisionReason?: unknown } };
    assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse', cmd);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', cmd);
    const reason = out.hookSpecificOutput?.permissionDecisionReason;
    assert.ok(typeof reason === 'string' && reason.length > 0, `${cmd}: 理由が空`);
  }
});

test('子プロセス: 通す入力では何も出さずに exit 0', () => {
  const r = runHook({ ...bash('gh pr view 1'), hook_event_name: 'PreToolUse', cwd: root });
  assert.equal(r.status, 0, `exit code（stderr: ${r.stderr}）`);
  assert.equal(r.stdout.trim(), '');
});

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }
interface Settings { hooks?: { PreToolUse?: HookEntry[] }; permissions?: { allow?: string[]; deny?: string[] } }

test('settings.json に PreToolUse の hook が登録され、既存の deny・allow が残っている', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings;
  const entry = settings.hooks?.PreToolUse?.find((e) => e.matcher === 'Bash|mcp__.*');
  assert.ok(entry, 'matcher が Bash|mcp__.* の PreToolUse がありません');
  assert.ok(
    entry.hooks?.some((h) => h.type === 'command' && typeof h.command === 'string' && h.command.includes('.claude/hooks/guard.ts')),
    'guard.ts を呼ぶ command hook がありません',
  );
  const deny = settings.permissions?.deny ?? [];
  for (const rule of ['Bash(gh pr merge *)', 'Bash(git push --force*)', 'Bash(gh issue edit *agent:hold*)', 'mcp__github__merge_pull_request']) {
    assert.ok(deny.includes(rule), `permissions.deny に ${rule} がありません`);
  }
  assert.ok((settings.permissions?.allow ?? []).includes('Bash(npm run check)'), 'permissions.allow に Bash(npm run check) がありません');
});

test('judge の SKILL.md に固定の reviewer.json・risk.json が残っておらず、PR 番号付きの名前がある', () => {
  const text = readFileSync(join(root, '.claude', 'skills', 'judge', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(text, /(^|[^-\w])reviewer\.json/m, '固定の reviewer.json が残っています');
  assert.doesNotMatch(text, /(^|[^-\w])risk\.json/m, '固定の risk.json が残っています');
  assert.ok(text.includes('reviewer-<PR番号>-'), 'reviewer-<PR番号>- がありません');
  assert.ok(text.includes('risk-<PR番号>-'), 'risk-<PR番号>- がありません');
});
