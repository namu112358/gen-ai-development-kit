// 見張りの hook（guard.ts）が保護ラベル・例外ラベルの付け外しを意味で止め、gh api --input - の本文も見て、読むだけのコマンドは通すことを確かめる（Issue #218）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import { delegateMergeConfig, LABELS, loadConfig } from '../lib/config.ts';

/** guard.ts の main が設定から作るのと同じ形の ctx */
function ctxFromConfig(): GuardContext {
  const config = loadConfig();
  return {
    defaultBranch: config.defaultBranch,
    protectedLabels: [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel, delegateMergeConfig(config).label],
    currentBranch: 'claude/issue-218-x',
  };
}

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

/** 保護ラベルの4つと、例外ラベルの3つと、今後増える例外ラベルの例 */
const LABEL_NAMES = [
  'agent:plan-ok',
  'agent:hold',
  'agent:auto-merge-stopped',
  'agent:delegate-merge',
  'plan:exempt',
  'review:exempt',
  'test:exempt',
  'security:exempt',
];

function assertDenyAll(input: HookInput, label: string): void {
  const ctx = ctxFromConfig();
  const d = decide(input, ctx);
  assert.equal(d.deny, true, `止めるべき（decide）: ${label}`);
  if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${label}`);
  assert.equal(decideRaw(JSON.stringify(input), ctx).deny, true, `止めるべき（decideRaw）: ${label}`);
  assert.equal(decideRaw(JSON.stringify(input), null).deny, true, `止めるべき（decideRaw、設定が読めない）: ${label}`);
}

function assertAllowAll(input: HookInput, label: string): void {
  const ctx = ctxFromConfig();
  assert.deepEqual(decide(input, ctx), { deny: false }, `通すべき（decide）: ${label}`);
  assert.deepEqual(decideRaw(JSON.stringify(input), ctx), { deny: false }, `通すべき（decideRaw）: ${label}`);
}

function ghLabelCmds(label: string): string[] {
  return [
    `gh issue edit 1 --add-label ${label}`,
    `gh issue edit 1 --add-label=${label}`,
    `gh issue edit 1 --remove-label foo,${label}`,
    `gh issue edit 1 --add-label ${label.toUpperCase()}`,
    `gh issue create --title t -l ${label}`,
    `gh issue create --title t --label=${label}`,
    `gh pr edit 1 --add-label ${label}`,
    `gh pr edit 1 --remove-label ${label}`,
    `gh pr create --title t --label ${label}`,
    `gh label create ${label}`,
    `gh label edit ${label} --name x`,
    `gh label delete ${label}`,
    `gh api repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
    `gh api -X POST repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
    `gh api -X DELETE repos/o/r/issues/1/labels/${label}`,
    `gh api -X DELETE repos/o/r/issues/1/labels/${encodeURIComponent(label)}`,
  ];
}

function wrapped(label: string): string[] {
  return [
    `bash -c "gh issue edit 1 --add-label ${label}"`,
    `sh -c 'gh pr edit 1 --remove-label ${label}'`,
    `cd /wt && gh pr edit 1 --add-label ${label}`,
    `true; gh issue edit 1 --add-label ${label}`,
    `env gh issue edit 1 --add-label ${label}`,
    `GH_REPO=o/r gh issue edit 1 --add-label ${label}`,
    `eval "gh issue edit 1 --add-label ${label}"`,
    `echo $(gh issue edit 1 --add-label ${label})`,
    `gh -R o/r issue edit 1 --add-label ${label}`,
    `gh --repo o/r pr edit 1 --remove-label ${label}`,
    `gh --repo=o/r issue create --title t -l ${label}`,
    `gh -R o/r label delete ${label}`,
    `gh issue -R o/r edit 1 --add-label ${label}`,
    `gh pr --repo o/r edit 1 --remove-label ${label}`,
    `gh issue --repo=o/r create --title t -l ${label}`,
    `gh label -R o/r create ${label}`,
  ];
}

test('保護ラベル・例外ラベルを gh issue|pr edit|create・gh label・gh api で付け外しするのを止める', () => {
  for (const label of LABEL_NAMES) for (const cmd of ghLabelCmds(label)) assertDenyAll(bash(cmd), cmd);
});

test('サブコマンドの前に -R・--repo を置いた gh pr merge・gh pr ready も止める', () => {
  const denied = ['gh -R o/r pr merge 1', 'gh --repo o/r pr merge 1 --squash', 'gh --repo=o/r pr ready 1', 'gh pr -R o/r merge 1', 'gh pr --repo o/r ready 1'];
  for (const cmd of denied) assertDenyAll(bash(cmd), cmd);
  for (const cmd of ['gh -R o/r pr view 1', 'gh pr -R o/r view 1', 'gh pr -R o/r ready 1 --undo']) assertAllowAll(bash(cmd), cmd);
});

test('bash -c・&&・;・env・代入の前置き・eval・$(...) の中の付け外しも止める', () => {
  for (const label of LABEL_NAMES) for (const cmd of wrapped(label)) assertDenyAll(bash(cmd), cmd);
});

test('GitHub の MCP で保護ラベル・例外ラベルを付け外しするのを止める', () => {
  for (const label of LABEL_NAMES) {
    assertDenyAll({ tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 1, labels: ['bug', label] } }, `update_issue labels ${label}`);
    assertDenyAll({ tool_name: 'mcp__github__issue_write', tool_input: { method: 'update', issue_number: 1, labels: [label] } }, `issue_write labels ${label}`);
    assertDenyAll({ tool_name: 'mcp__github__update_issue', tool_input: { issue_number: 1, fields: { labelNames: `foo,${label}` } } }, `入れ子の label キー ${label}`);
  }
});

/** gh api が本文を標準入力から読む形。label が本文にだけ出る */
function stdinBodyCmds(label: string): string[] {
  const body = `{"labels":["${label}"]}`;
  return [
    `gh api repos/o/r/issues/1/labels --input - <<EOF\n${body}\nEOF`,
    `gh api repos/o/r/issues/1/labels --input - <<'EOF'\n${body}\nEOF`,
    `gh api -X PUT repos/o/r/issues/1/labels --input=- <<-EOF\n\t${body}\n\tEOF`,
    `gh api repos/o/r/issues/1/labels --input - <<< '${body}'`,
    `gh api repos/o/r/issues/1/labels --input=- <<<"${body.replace(/"/g, '\\"')}"`,
    `echo '${body}' | gh api repos/o/r/issues/1/labels --input -`,
    `printf '%s' '${body}' | gh api -X POST repos/o/r/issues/1/labels --input=-`,
    `cd /wt && echo '${body}' | gh api repos/o/r/issues/1/labels --input -`,
  ];
}

test('gh api --input - に、ヒアドキュメント・ヒアストリング・パイプで保護ラベル・例外ラベルを渡すのを止める', () => {
  for (const label of LABEL_NAMES) for (const cmd of stdinBodyCmds(label)) assertDenyAll(bash(cmd), cmd);
});

/** 本文が変数の展開で、ラベルの名前は同じコマンドの代入の側にだけ出る形（合体版のレビューの指摘） */
function stdinVariableCmds(label: string): string[] {
  return [
    `L='${label}'; gh api repos/o/r/issues/1/labels --input - <<< "{\\"labels\\":[\\"$L\\"]}"`,
    `L=${label} && gh api repos/o/r/issues/1/labels --input - <<< "$L"`,
    `export L=${label}; gh api repos/o/r/issues/1/labels --input - <<EOF\n{"labels":["$L"]}\nEOF`,
    `L=${label}; gh api repos/o/r/issues/1/labels --input - <<EOF\n{"labels":["\${L}"]}\nEOF`,
  ];
}

test('gh api --input - の本文が変数の展開で、ラベルの名前が同じコマンドの代入にあれば止める', () => {
  for (const label of LABEL_NAMES) for (const cmd of stdinVariableCmds(label)) assertDenyAll(bash(cmd), cmd);
});

test('gh api --input - の本文が変数の展開でも、コマンドのどこにもラベルの名前が無ければ通す', () => {
  const cmds = [
    `B=hello; gh api repos/o/r/issues/1/comments --input - <<< "{\\"body\\":\\"$B\\"}"`,
    'B=hello; gh api repos/o/r/issues/1/comments --input - <<EOF\n{"body":"$B"}\nEOF',
  ];
  for (const cmd of cmds) assertAllowAll(bash(cmd), cmd);
});

test('gh api --input - の本文にラベルの名前が無ければ通す（push・merge の語でも止めない）', () => {
  const cmds = [
    'gh api repos/o/r/issues/1/comments --input - <<EOF\n{"body":"hello"}\nEOF',
    `gh api repos/o/r/issues/1/comments --input - <<< '{"body":"hello"}'`,
    `echo '{"body":"hello"}' | gh api repos/o/r/issues/1/comments --input -`,
    `echo '{"body":"merge の後に push します"}' | gh api repos/o/r/issues/1/comments --input -`,
    'gh api repos/o/r/issues/1/comments --input - <<EOF\n{"body":"merge の後に push します"}\nEOF',
    `echo '{"labels":["priority:high"]}' | gh api repos/o/r/issues/1/labels --input -`,
    'gh api repos/o/r/issues/1/labels --input - <<EOF\n{"labels":["area:harness"]}\nEOF',
  ];
  for (const cmd of cmds) assertAllowAll(bash(cmd), cmd);
});

test('ラベルの名前を含む読むだけのコマンドは通す', () => {
  const cmds = [
    'grep -n "agent:hold" .claude/hooks/guard.ts',
    "grep -rn 'agent:plan-ok' harness",
    "rg ':exempt' docs",
    'rg -n review:exempt harness/lib',
    'git log --grep agent:plan-ok',
    'git log --oneline -S agent:delegate-merge',
    'gh issue view 218 --comments',
    'gh issue list --label agent:hold',
    'gh pr list --label test:exempt --state open',
    'cat harness.config.json | grep agent:auto-merge-stopped',
    'grep -c plan:exempt .claude/settings.json',
    'grep -n agent:hold <<< "agent:hold"',
  ];
  for (const cmd of cmds) assertAllowAll(bash(cmd), cmd);
});

test('本文でラベルに触れるだけのコメントは通す', () => {
  const cmds = [
    'gh issue comment 1 --body "agent:hold を外してください"',
    'gh pr comment 1 --body "review:exempt を付けてください"',
    'gh issue comment 1 --body-file - <<EOF\nagent:plan-ok を付けてください\nEOF',
    'echo "agent:delegate-merge を付けてください" | gh issue comment 1 --body-file -',
  ];
  for (const cmd of cmds) assertAllowAll(bash(cmd), cmd);
  assertAllowAll(
    { tool_name: 'mcp__github__add_issue_comment', tool_input: { issue_number: 1, body: 'agent:hold と test:exempt を外してください' } },
    'add_issue_comment の本文にラベルの名前',
  );
});

test('関係の無いラベルの付け外しは通す', () => {
  const cmds = [
    'gh issue edit 1 --add-label priority:high',
    'gh pr edit 1 --remove-label area:harness',
    'gh issue create --title t -l bug',
    "gh api repos/o/r/issues/1/labels -f 'labels[]=bug'",
  ];
  for (const cmd of cmds) assertAllowAll(bash(cmd), cmd);
});
