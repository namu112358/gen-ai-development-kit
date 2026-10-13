// 見張りの hook（.claude/hooks/guard.ts）が main 以外の既定ブランチを守ることを確かめる（Issue #868）。
// defaultBranch が develop の文脈で develop への git push を止めること、設定が読めない（decideRaw の ctx が null）ときに
// どのブランチ宛ての ref の書き換え・contents API の書き込み・MCP のファイルの書き込みも止め、読むだけの操作は通すことを見る。
// ctx が null で ls を通し git push を止めることは hooks-guard.test.ts・hooks-guard-gaps.test.ts が見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

const develop: GuardContext = { defaultBranch: 'develop', protectedLabels: ['agent:plan-ok', 'agent:hold'], currentBranch: 'claude/issue-1-x' };

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });
const mcp = (name: string, branch: string): HookInput => ({ tool_name: `mcp__github__${name}`, tool_input: { owner: 'o', repo: 'r', path: 'a.txt', branch } });

test('defaultBranch が develop の文脈で develop への git push を止め、作業ブランチへの push は通す', () => {
  for (const cmd of ['git push origin develop', 'git push origin HEAD:develop', 'git push origin x:refs/heads/develop']) {
    assert.equal(decide(bash(cmd), develop).deny, true, `止めるべき: ${cmd}`);
  }
  for (const cmd of ['git push -u origin claude/issue-1-x', 'git push origin feature:develop-x']) {
    assert.deepEqual(decide(bash(cmd), develop), { deny: false }, `通すべき: ${cmd}`);
  }
});

test('decideRaw: 設定が読めない（ctx が null）ときは、どのブランチ宛ての ref の書き換え・contents API・MCP の書き込みも止め、読むだけは通す', () => {
  const deny: [string, HookInput][] = [
    ['ref の PATCH（develop）', bash('gh api -X PATCH repos/o/r/git/refs/heads/develop -f sha=abc')],
    ['ref の PATCH（main）', bash('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc')],
    ['ref の DELETE（develop）', bash('gh api -X DELETE repos/o/r/git/refs/heads/develop')],
    ['GraphQL の updateRef', bash(`gh api graphql -f query='mutation { updateRef(input: {refId: "R", oid: "abc"}) { clientMutationId } }'`)],
    ['contents API の PUT（branch=develop）', bash('gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=Zg== -f branch=develop')],
    ['contents API の DELETE（branch=develop）', bash('gh api -X DELETE repos/o/r/contents/a.txt -f message=m -f sha=abc -f branch=develop')],
    ['MCP create_or_update_file（develop）', mcp('create_or_update_file', 'develop')],
    ['MCP delete_file（develop）', mcp('delete_file', 'develop')],
    ['MCP push_files（develop）', mcp('push_files', 'develop')],
  ];
  for (const [name, input] of deny) assert.equal(decideRaw(JSON.stringify(input), null).deny, true, `止めるべき: ${name}`);
  const allow: [string, HookInput][] = [
    ['ref の GET（develop）', bash('gh api repos/o/r/git/refs/heads/develop')],
    ['contents API の GET（ref=develop）', bash('gh api repos/o/r/contents/a.txt?ref=develop')],
    ['MCP get_file_contents（develop）', mcp('get_file_contents', 'develop')],
  ];
  for (const [name, input] of allow) assert.deepEqual(decideRaw(JSON.stringify(input), null), { deny: false }, `通すべき: ${name}`);
});
