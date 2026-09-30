// Issue #196（人の決定）：agent.ts worktree で作った Issue の worktree に、Orca があれば表示名「#番号 短い名前」と Issue を付ける。
// 表示名の取り方・CLI の選び方・引数（親子は付けない）・起動の結果ごとの扱い（無い・失敗でも止めない、Orca を起動しない）と、
// worktree コマンドが --routine・--detach では付けないことを確かめる。Orca は本物を呼ばない（run を差し替えるか、在らないコマンドにする）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { labelOrcaWorktree, orcaCliCommand, orcaWorktreeLabel, orcaWorktreeSetArgs } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const PATH = join(KIT, '..', 'repo.worktrees', 'claude-issue-196-worktree-root');

test('orcaWorktreeLabel：claude/issue-<番号>-<短い名前> の後ろを表示名にする', () => {
  assert.deepEqual(orcaWorktreeLabel('claude/issue-196-worktree-root'), { issue: 196, displayName: '#196 worktree-root' });
  assert.deepEqual(orcaWorktreeLabel('claude/issue-5-a-b-c'), { issue: 5, displayName: '#5 a-b-c' });
});

test('orcaWorktreeLabel：形に合わないブランチ（SHA・main・claude/x・番号でない）には付けない', () => {
  for (const ref of ['a'.repeat(40), '0123abc', 'main', 'claude/x', 'claude/issue-x-y', 'claude/issue-5', 'claude/issue-5-', 'feature/issue-5-x', 'xclaude/issue-5-x']) {
    assert.equal(orcaWorktreeLabel(ref), null, ref);
  }
});

test('orcaCliCommand：ORCA_CLI_COMMAND → ORCA_DEV_REPO_ROOT なら orca-dev → linux は orca-ide → ほかは orca', () => {
  assert.equal(orcaCliCommand('linux', { ORCA_CLI_COMMAND: '/opt/my-orca' }), '/opt/my-orca');
  assert.equal(orcaCliCommand('win32', { ORCA_CLI_COMMAND: 'C:\\tools\\orca.exe', ORCA_DEV_REPO_ROOT: '/x' }), 'C:\\tools\\orca.exe');
  assert.equal(orcaCliCommand('linux', { ORCA_DEV_REPO_ROOT: '/src/orca' }), 'orca-dev');
  assert.equal(orcaCliCommand('darwin', { ORCA_DEV_REPO_ROOT: '/src/orca' }), 'orca-dev');
  assert.equal(orcaCliCommand('linux', {}), 'orca-ide');
  assert.notEqual(orcaCliCommand('linux', {}), 'orca', 'linux で素の orca は読み上げソフトになりうる');
  assert.equal(orcaCliCommand('win32', {}), 'orca');
  assert.equal(orcaCliCommand('darwin', {}), 'orca');
});

test('orcaWorktreeSetArgs：path: で選び、表示名と Issue を付け、親子は付けない', () => {
  const args = orcaWorktreeSetArgs(PATH, { issue: 196, displayName: '#196 worktree-root' });
  assert.deepEqual(args, ['worktree', 'set', '--worktree', `path:${PATH}`, '--display-name', '#196 worktree-root', '--issue', '196', '--json']);
  assert.ok(!args.includes('--parent-worktree'));
  assert.ok(!args.includes('--no-parent'));
});

type Call = { command: string; args: string[] };
const errno = (code: string) => Object.assign(new Error(`spawnSync orca ${code}`), { code, errno: -1, syscall: 'spawnSync orca' });

function harness(result: Record<string, unknown>) {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    env: { ORCA_CLI_COMMAND: 'fake-orca' },
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: null, stdout: '', stderr: '', ...result } as never;
    },
    warn: (m: string) => void warnings.push(m),
  };
  return { calls, warnings, deps };
}

test('labelOrcaWorktree：0 で終われば labeled。CLI を1回、表示名と Issue の引数で呼ぶ', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const h = harness({ status: 0, stdout: '{"ok":true}' });
  assert.equal(labelOrcaWorktree(PATH, 'claude/issue-196-worktree-root', h.deps), 'labeled');
  assert.deepEqual(h.calls, [{ command: 'fake-orca', args: orcaWorktreeSetArgs(PATH, { issue: 196, displayName: '#196 worktree-root' }) }]);
  assert.deepEqual(h.warnings, []);
  assert.equal(log.mock.callCount(), 0, 'CLI の出力を標準出力に流さない');
});

test('labelOrcaWorktree：CLI が無い（ENOENT）なら何も言わずに absent', () => {
  const h = harness({ error: errno('ENOENT') });
  assert.equal(labelOrcaWorktree(PATH, 'claude/issue-7-x', h.deps), 'absent');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.warnings, []);
});

test('labelOrcaWorktree：0 以外・タイムアウト・EINVAL などは警告を1行出して failed（throw しない）', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['0 以外', { status: 1, stderr: 'Orca is not running' }],
    ['タイムアウト', { status: null, signal: 'SIGTERM', error: errno('ETIMEDOUT') }],
    ['EINVAL（.cmd を shell なしで起動）', { error: errno('EINVAL') }],
    ['シグナル', { status: null, signal: 'SIGKILL' }],
  ];
  for (const [name, result] of cases) {
    const h = harness(result);
    assert.equal(labelOrcaWorktree(PATH, 'claude/issue-7-x', h.deps), 'failed', name);
    assert.equal(h.warnings.length, 1, name);
    assert.match(h.warnings[0]!, /^警告: Orca の表示名を付けられませんでした（続けます）/, name);
    assert.ok(!h.warnings[0]!.includes('\n'), `${name}：1行`);
    assert.equal(h.calls.length, 1, `${name}：やり直さない`);
  }
});

test('labelOrcaWorktree：run が投げても throw しない', () => {
  const warnings: string[] = [];
  const got = labelOrcaWorktree(PATH, 'claude/issue-7-x', {
    platform: 'linux',
    env: {},
    run: () => {
      throw new Error('boom');
    },
    warn: (m: string) => void warnings.push(m),
  });
  assert.ok(got === 'failed' || got === 'absent', got);
});

test('labelOrcaWorktree：表示名の無いブランチは skipped で、CLI を呼ばない', () => {
  for (const ref of ['claude/x', 'a'.repeat(40), 'main']) {
    const h = harness({ status: 0 });
    assert.equal(labelOrcaWorktree(PATH, ref, h.deps), 'skipped', ref);
    assert.deepEqual(h.calls, [], ref);
    assert.deepEqual(h.warnings, [], ref);
  }
});

test('labelOrcaWorktree：Orca が動いていないと言われても起動し直さない（open を呼ばない）', () => {
  const h = harness({ status: 1, stderr: 'Orca is not running. Run `orca open`.' });
  labelOrcaWorktree(PATH, 'claude/issue-7-x', h.deps);
  assert.equal(h.calls.length, 1);
  for (const c of h.calls) assert.ok(!c.args.includes('open'), c.args.join(' '));
});

test('labelOrcaWorktree：deps が無ければ orcaCliCommand の CLI を使う（ORCA_CLI_COMMAND が在らないなら absent）', () => {
  const before = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_CLI_COMMAND = join(KIT, 'no-such-orca-cli');
  try {
    const warnings: string[] = [];
    assert.equal(labelOrcaWorktree(PATH, 'claude/issue-7-x', { env: process.env, warn: (m: string) => void warnings.push(m) }), 'absent');
    assert.deepEqual(warnings, []);
  } finally {
    if (before === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = before;
  }
});

test('worktree コマンドは ensureNodeModules の後・パスを出す前に labelOrcaWorktree を呼ぶ', () => {
  const src = readFileSync(join(KIT, 'harness', 'scripts', 'agent', 'commands', 'worktree.ts'), 'utf8');
  const ensure = src.indexOf('ensureNodeModules(path');
  const label = src.indexOf('labelOrcaWorktree(');
  const print = src.indexOf('console.log(path)');
  assert.ok(ensure >= 0 && label >= 0 && print >= 0, 'ensureNodeModules・labelOrcaWorktree・console.log(path) がある');
  assert.ok(ensure < label && label < print, '順は ensureNodeModules → labelOrcaWorktree → パスの出力');
  assert.equal(src.match(/labelOrcaWorktree\(/g)?.length, 1);
});

test('review-panel.ts の detach の worktree には表示名を付けない', () => {
  const src = readFileSync(join(KIT, 'harness', 'scripts', 'review-panel.ts'), 'utf8');
  assert.doesNotMatch(src, /labelOrcaWorktree/);
});

/** ORCA_CLI_COMMAND を node にする。呼ばれれば `node worktree set …` が失敗して Orca の警告が出るので、呼ばれたかがわかる */
function agentWithDetectableOrca(cwd: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AGENT_HARNESS_WORKTREE_ROOT;
  delete env.ORCA_DEV_REPO_ROOT;
  env.ORCA_CLI_COMMAND = process.execPath;
  return spawnSync(process.execPath, [join(KIT, 'harness', 'scripts', 'agent.ts'), ...args], { cwd, encoding: 'utf8', env });
}

test('worktree コマンド：--routine では Issue のブランチでも Orca を呼ばず、標準出力の最終行はパスのまま', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const r = agentWithDetectableOrca(s.root, ['worktree', 'claude/issue-7-demo', '--routine']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Orca/);
  assert.match(r.stdout.trimEnd().split('\n').at(-1)!, /claude-issue-7-demo$/);
});

test('worktree コマンド：--detach では Issue のブランチ名でも Orca を呼ばない', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.git(s.root, 'branch', 'claude/issue-7-demo');
  const r = agentWithDetectableOrca(s.root, ['worktree', 'claude/issue-7-demo', '--detach']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /Orca/);
  assert.match(r.stdout.trimEnd().split('\n').at(-1)!, /claude-issue-7-demo$/);
});
