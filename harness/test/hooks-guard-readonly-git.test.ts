// Issue #637：判定の担当のサブエージェント（hook の入力の agent_type）の git を、見張りの hook が読むだけの操作に絞るか
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';

const root = join(import.meta.dirname, '..', '..');
const RUN = join(root, '.claude', 'hooks', 'run.mjs');
const GUARD = join(root, '.claude', 'hooks', 'guard.ts');

const ctx: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/issue-637-x',
};

const bash = (command: string, agentType?: string): HookInput => ({
  tool_name: 'Bash',
  tool_input: { command },
  ...(agentType === undefined ? {} : { agent_type: agentType }),
});

const JUDGES = ['reviewer', 'risk-agent', 'review-intake', 'review-lens', 'review-ac-scope', 'review-safety', 'review-overbuild', 'review-scorer'];

test('判定の担当のどの名前でも git checkout --detach を止める', () => {
  for (const name of JUDGES) {
    assert.equal(decide(bash('git checkout --detach', name), ctx).deny, true, `止めるべき: ${name}`);
  }
});

test('判定の担当（reviewer）はブランチ・HEAD・作業ツリーを動かす git を、包み・場所の指定があっても止める', () => {
  const cmds = [
    'git switch -',
    'git reset --hard HEAD~1',
    'git -C /tmp/x checkout --detach',
    "bash -c 'git checkout --detach'",
    'git fetch origin && git checkout --detach',
    'git stash',
    'git worktree add ../x',
    'git branch -f x y',
    'git restore f',
    'git merge origin/main',
  ];
  for (const cmd of cmds) assert.equal(decide(bash(cmd, 'reviewer'), ctx).deny, true, `止めるべき: ${cmd}`);
});

test('判定の担当（reviewer）は diff を読むための git を今までどおり通す', () => {
  const cmds = [
    'git fetch origin && git diff origin/main...abc1234',
    'git diff a...b',
    'git show abc1234:harness/lib/config.ts',
    'git show origin/main:harness.config.json',
    'git log --oneline -5',
    'git blame harness/lib/config.ts',
    "git ls-files '*CLAUDE.md'",
    'git status --porcelain --untracked-files=all',
    'git rev-parse HEAD',
    'git branch --show-current',
    'git diff origin/main...HEAD | head -50',
  ];
  for (const cmd of cmds) assert.deepEqual(decide(bash(cmd, 'reviewer'), ctx), { deny: false }, `通すべき: ${cmd}`);
});

test('agent_type が無い・判定の担当でない（general-purpose・test-designer）ときは git checkout --detach を今までどおり通す', () => {
  for (const name of [undefined, 'general-purpose', 'test-designer']) {
    assert.deepEqual(decide(bash('git checkout --detach', name), ctx), { deny: false }, `通すべき: ${String(name)}`);
  }
});

test('decideRaw：設定が読めない（ctx が null）安全側の判定でも、reviewer の git checkout --detach を止める', () => {
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git checkout --detach' }, agent_type: 'reviewer' });
  assert.equal(decideRaw(raw, null).deny, true);
});

test('hook の入口ごと動かすと、reviewer の git checkout --detach は deny になり、worktree の HEAD とブランチが変わらない', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-readonly-git-'));
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    git('init', '-q');
    git('checkout', '-q', '-b', 'claude/issue-1-x');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
    const headBefore = git('rev-parse', 'HEAD');
    const branchBefore = git('branch', '--show-current');

    // session_id は渡さない（問題の記録を書かせない）
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git checkout --detach' },
      hook_event_name: 'PreToolUse',
      cwd: dir,
      agent_type: 'reviewer',
    });
    const r = spawnSync(process.execPath, [RUN, GUARD], { cwd: root, input, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } };
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');

    assert.equal(git('rev-parse', 'HEAD'), headBefore);
    assert.equal(git('branch', '--show-current'), branchBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
