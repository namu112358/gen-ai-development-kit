// Issue #730：書き換えの場所の見張りの hook（.claude/hooks/workspace-guard.ts）が、git の応答が打ち切りの時間（GIT_TIMEOUT_MS）より遅いとき、打ち切りと分かる理由で止めるか、gitTimeoutMs: 0 なら打ち切らずに場所で判定するか（遅い git は runGit で模し、実際には待たない）
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { decide, GIT_TIMEOUT_MS, realContext, type Decision, type RunGit } from '../../.claude/hooks/workspace-guard.ts';
import { assertAllow, assertDeny, bash, guardSandbox, write } from './support/workspace-guard-sandbox.ts';

/** 本体は pull.ff=only・pull.rebase=false（素の git pull を設定で通す形。pullSettings が読めないときだけ止まる） */
const sb = guardSandbox({ pullFf: 'only', pullRebase: 'false' });
after(() => sb.cleanup());

/** 模した git の応答の時間（既定の打ち切り 5000ms より遅い） */
const SLOW_MS = 6000;

/** spawnSync が timeout で打ち切ったときの形 */
function timedOutResult(): SpawnSyncReturns<string> {
  const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error };
}

interface SlowGit {
  runGit: RunGit;
  /** runGit が呼ばれたときの引数と打ち切りの時間 */
  calls: { args: string[]; timeoutMs: number | undefined }[];
}

/**
 * 遅い git を模す。slow(args) が真の呼び出しは応答に SLOW_MS かかるとみなし、受け取った打ち切りが定義されていてそれより短ければ
 * ETIMEDOUT の結果を返す。そうでなければ本物の git を呼ぶ（sleep はしない）
 */
function slowGit(slow: (args: string[]) => boolean = () => true): SlowGit {
  const calls: SlowGit['calls'] = [];
  const runGit: RunGit = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    if (slow(args) && timeoutMs !== undefined && timeoutMs < SLOW_MS) return timedOutResult();
    return spawnSync('git', args, { encoding: 'utf8' });
  };
  return { runGit, calls };
}

/** 打ち切りと分かる理由か（文言は丸ごと固定せず、語の一部だけを見る） */
function assertTimeoutReason(d: Decision, label: string): void {
  assertDeny(d, label);
  if (d.deny) {
    assert.ok(d.reason.includes(`${GIT_TIMEOUT_MS}ms`), `理由に打ち切りの時間が無い: ${label}: ${d.reason}`);
    assert.ok(d.reason.includes('混'), `理由に PC が混んでいることが無い: ${label}: ${d.reason}`);
  }
}

test('GIT_TIMEOUT_MS は 5000', () => {
  assert.equal(GIT_TIMEOUT_MS, 5000);
});

test('AC1：git が打ち切りより遅いとき、既定の realContext の locate は { kind: error, timedOut: true } を返し、main の checkout・Issue の worktree への Write はどちらも打ち切りと分かる理由で止める', () => {
  const { runGit } = slowGit();
  const ctx = realContext({ allowRoots: [sb.allowDir], runGit });
  assert.deepEqual(ctx.locate(sb.main), { kind: 'error', timedOut: true });
  assert.deepEqual(ctx.locate(sb.issueWt), { kind: 'error', timedOut: true });
  assertTimeoutReason(decide(write(join(sb.main, 'src', 'a.ts'), sb.main), ctx), 'Write（main の checkout・打ち切り）');
  assertTimeoutReason(decide(write(join(sb.issueWt, 'src', 'a.ts'), sb.issueWt), ctx), 'Write（Issue の worktree・打ち切り）');
});

test('AC1：gitTimeoutMs: 0 の realContext は、git が既定の打ち切りより遅くても locate が repo を返し、main の checkout は止め、Issue の worktree は通す', () => {
  const { runGit } = slowGit();
  const ctx = realContext({ allowRoots: [sb.allowDir], gitTimeoutMs: 0, runGit });
  assert.equal(ctx.locate(sb.main).kind, 'repo');
  assert.equal(ctx.locate(sb.issueWt).kind, 'repo');
  const dMain = decide(write(join(sb.main, 'src', 'a.ts'), sb.main), ctx);
  assertDeny(dMain, 'Write（main の checkout・打ち切らない）');
  if (dMain.deny) assert.ok(!dMain.reason.includes(`${GIT_TIMEOUT_MS}ms`), `打ち切りでないのに打ち切りの理由: ${dMain.reason}`);
  assertAllow(decide(write(join(sb.issueWt, 'src', 'a.ts'), sb.issueWt), ctx), 'Write（Issue の worktree・打ち切らない）');
});

test('AC1：runGit に渡す打ち切りは、既定では GIT_TIMEOUT_MS、gitTimeoutMs: 0 では undefined。引数は -C と作業場所から始まる', () => {
  for (const [label, opts, expected] of [
    ['既定', {}, GIT_TIMEOUT_MS],
    ['gitTimeoutMs: 0', { gitTimeoutMs: 0 }, undefined],
  ] as const) {
    const { runGit, calls } = slowGit(() => false);
    const ctx = realContext({ allowRoots: [sb.allowDir], ...opts, runGit });
    ctx.locate(sb.issueWt);
    ctx.pullSettings!(sb.main);
    assert.ok(calls.length >= 2, `runGit が呼ばれていない: ${label}`);
    for (const c of calls) {
      assert.equal(c.timeoutMs, expected, `打ち切りの時間（${label}）: ${c.args.join(' ')}`);
      assert.equal(c.args[0], '-C', `引数が -C から始まらない（${label}）: ${c.args.join(' ')}`);
    }
  }
});

test('AC1：打ち切りでない git の失敗は timedOut を付けず、理由も打ち切りの文にしない', () => {
  const runGit: RunGit = () => {
    const error = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: null, error };
  };
  const ctx = realContext({ allowRoots: [sb.allowDir], runGit });
  assert.deepEqual(ctx.locate(sb.main), { kind: 'error' });
  const d = decide(write(join(sb.issueWt, 'src', 'a.ts'), sb.issueWt), ctx);
  assertDeny(d, 'Write（git が ENOENT で失敗）');
  if (d.deny) assert.ok(!d.reason.includes(`${GIT_TIMEOUT_MS}ms`), `打ち切りでないのに打ち切りの理由: ${d.reason}`);
});

test('AC1：pullSettings の git が打ち切られたら null を返し、pull.ff=only の main の checkout で素の git pull を止める（打ち切らなければ通す）', () => {
  // locate（rev-parse）は速く、pull の設定を読む git（config・symbolic-ref）だけが遅い
  const slowConfig = (args: string[]) => !args.includes('rev-parse');
  const timed = realContext({ allowRoots: [sb.allowDir], runGit: slowGit(slowConfig).runGit });
  assert.equal(timed.locate(sb.main).kind, 'repo');
  assert.equal(timed.pullSettings!(sb.main), null);
  assertDeny(decide(bash('git pull', sb.main), timed), 'git pull（main・pull の設定の git が打ち切り）');

  const untimed = realContext({ allowRoots: [sb.allowDir], gitTimeoutMs: 0, runGit: slowGit(slowConfig).runGit });
  assert.deepEqual(untimed.pullSettings!(sb.main), { ff: 'only', rebase: 'false' });
  assertAllow(decide(bash('git pull', sb.main), untimed), 'git pull（main・打ち切らない）');
});

test('AC1：allowRoots の中への Write は runGit を呼ばずに通す', () => {
  const { runGit, calls } = slowGit();
  const ctx = realContext({ allowRoots: [sb.allowDir], runGit });
  assertAllow(decide(write(join(sb.allowDir, 'x.txt'), sb.main), ctx), 'Write（allowRoots の中）');
  assert.equal(calls.length, 0, 'allowRoots の中で runGit を呼んだ');
});
