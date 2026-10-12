// Issue #598: ルート・ドライブ全体から始める find を見張りの hook が止め、探す場所を絞るか Glob を使うよう案内し、場所を絞った find は通すことを確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

const base: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/issue-598-root-find-guard',
};

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

test('ルート・ドライブ全体から始める find は止め、場所を絞るか Glob を案内する（AC1）', () => {
  const cmds = [
    'find / -name x',
    "find / -name claude-code.d.ts -not -path '*/proc/*'",
    'find /c -name x',
    'find C:/ -name x',
    'find -L / -name x',
    'find mods / -name x',
    'timeout 30 find / -name x',
    "bash -c 'find / -name x'",
    '/usr/bin/find / -name x',
  ];
  for (const cmd of cmds) {
    const d = decide(bash(cmd), base);
    assert.equal(d.deny, true, `止めるべき: ${cmd}`);
    if (d.deny) {
      assert.ok(d.reason.includes('Glob'), `理由に Glob が無い: ${cmd}`);
      assert.ok(d.reason.includes('絞る'), `理由に 絞る が無い: ${cmd}`);
    }
  }
});

test('場所を絞った find・場所の無い find・展開する場所は止めない（AC2）', () => {
  const cmds = [
    'find mods -name x',
    'find . -name x',
    'find -name x',
    'find /home/u/repo -name x',
    'find /cache -name x',
    'find "$HOME" -name x',
    "find mods -path '/' -name x",
  ];
  for (const cmd of cmds) assert.deepEqual(decide(bash(cmd), base), { deny: false }, `通すべき: ${cmd}`);
});
