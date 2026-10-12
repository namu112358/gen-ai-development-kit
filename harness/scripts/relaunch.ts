/**
 * Orca が無いときのハーネスの交代で、tmux の中から新しい付き添いのセッションを auto mode で起動する入口（Issue #807）。
 *
 *   node harness/scripts/relaunch.ts check
 *   node harness/scripts/relaunch.ts start --line "<1行>" [--timeout <秒>]
 *
 * - check：起動できるかを1行の JSON { ok, means, mainCheckout, reason } で出す（終了コード 0）。
 *   ok が偽になるのは、tmux の外・tmux か claude が PATH に無い・本体が既定ブランチでない・本体に未 commit の変更がある・セッションの ID が取れない・この交代で既に起動した印がある。
 * - start：check を確かめ直し、起動した印（git の共通ディレクトリの下の agent-harness/relaunch/<セッションのキー>.json）を先に書いてから、
 *   本体で claude --permission-mode auto を1行なしで起動する。画面に auto mode が出て bypass permissions が出ていないことを確かめてから、send-keys で1行を渡す。
 *   確かめられたら終了コード 0、確かめられない・起動できないときは1行を渡さず終了コード 1（結果は1行の JSON { started, verified, pane, reason, line }）。
 * - 引数の誤りは使い方を標準エラーに出して終了コード 2。git pull はここでしない（skill の手順で流す）。起動したウィンドウは閉じない。環境変数の値は出さない。
 * - CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { gitCommonDir, harnessStateDir, writeLocalFileOnce } from '../lib/local-state.ts';
import { sessionFileKey } from '../lib/session.ts';
import { onPath } from './orca-cli.ts';

export interface RelaunchDeps {
  env: Record<string, string | undefined>;
  run: (cmd: string, args: string[], cwd?: string) => { status: number | null; stdout: string };
  onPath: (command: string) => boolean;
  commonDir: string | null;
  defaultBranch: string;
  sleep: (ms: number) => void;
  now: () => number;
}

export interface RelaunchCheck {
  ok: boolean;
  means: 'tmux' | null;
  mainCheckout: string | null;
  reason: string | null;
}

export interface RelaunchResult {
  started: boolean;
  verified: boolean;
  pane: string | null;
  reason: string | null;
  line: string;
}

/** 起動した印のパス。セッションの ID が無い・ファイル名に使えない形なら null */
export function relaunchMarkerPath(commonDir: string, session: string | null): string | null {
  const key = sessionFileKey(session);
  if (key === null) return null;
  return `${harnessStateDir(commonDir)}/relaunch/${key}.json`;
}

/** 画面のモード表示。bypass permissions があれば auto mode の語があっても bypass */
export function screenMode(screen: string): 'auto' | 'bypass' | 'unknown' {
  if (screen.includes('bypass permissions')) return 'bypass';
  if (screen.includes('auto mode')) return 'auto';
  return 'unknown';
}

const stop = (reason: string): RelaunchCheck => ({ ok: false, means: null, mainCheckout: null, reason });

export function relaunchCheck(deps: RelaunchDeps): RelaunchCheck {
  if (!deps.env.TMUX) return stop('tmux の中で動いていないので、新しいセッションを起動できません。');
  if (!deps.onPath('tmux')) return stop('tmux が PATH に見つからないので、新しいセッションを起動できません。');
  if (!deps.onPath('claude')) return stop('claude が PATH に見つからないので、新しいセッションを起動できません。');
  if (!deps.commonDir) return stop('git の共通ディレクトリが取れないので、本体を決められません。');
  const main = dirname(deps.commonDir);
  const branch = deps.run('git', ['-C', main, 'symbolic-ref', '--short', 'HEAD'], main);
  const current = branch.status === 0 ? branch.stdout.trim() : '';
  if (current !== deps.defaultBranch) return stop(`本体が既定ブランチ（${deps.defaultBranch}）でないので、新しいセッションを起動できません。`);
  const status = deps.run('git', ['-C', main, 'status', '--porcelain'], main);
  if (status.status !== 0) return stop('本体の状態を読めないので、新しいセッションを起動できません。');
  if (status.stdout.trim() !== '') return stop('本体に未 commit の変更があるので、新しいセッションを起動できません。');
  const marker = relaunchMarkerPath(deps.commonDir, deps.env.AGENT_HARNESS_SESSION ?? null);
  if (marker === null) return stop('このセッションの ID が取れないので、新しいセッションを起動できません。');
  try {
    accessSync(marker, constants.F_OK);
    return stop('この交代では既に新しいセッションを起動しているので、もう一度は起動しません。');
  } catch {
    // 印が無ければ起動できる
  }
  return { ok: true, means: 'tmux', mainCheckout: main, reason: null };
}

export function relaunchStart(deps: RelaunchDeps, line: string, timeoutSeconds: number): RelaunchResult {
  const fail = (reason: string, started = false, pane: string | null = null): RelaunchResult => ({ started, verified: false, pane, reason, line });
  const check = relaunchCheck(deps);
  if (!check.ok || check.mainCheckout === null || deps.commonDir === null) {
    return fail(check.reason ?? '新しいセッションを起動できません。');
  }
  const marker = relaunchMarkerPath(deps.commonDir, deps.env.AGENT_HARNESS_SESSION ?? null);
  if (marker === null) return fail('このセッションの ID が取れないので、新しいセッションを起動できません。');
  const written = writeLocalFileOnce(marker, `${JSON.stringify({ startedAt: new Date(deps.now()).toISOString(), line }, null, 2)}\n`);
  if (!written) return fail('この交代では既に新しいセッションを起動しているので、もう一度は起動しません。');

  const created = deps.run(
    'tmux',
    ['new-window', '-P', '-F', '#{pane_id}', '-c', check.mainCheckout, '-n', 'fleet', 'claude', '--permission-mode', 'auto'],
    check.mainCheckout,
  );
  const pane = created.stdout.trim();
  if (created.status !== 0 || pane === '') return fail('tmux の新しいウィンドウを作れませんでした。');

  const deadline = deps.now() + timeoutSeconds * 1000;
  for (;;) {
    const captured = deps.run('tmux', ['capture-pane', '-p', '-t', pane]);
    const mode = captured.status === 0 ? screenMode(captured.stdout) : 'unknown';
    if (mode === 'bypass') return fail('新しいセッションが bypass permissions で動いているので、1行を渡していません。', true, pane);
    if (mode === 'auto') break;
    if (deps.now() >= deadline) return fail('新しいセッションの auto mode を時間内に確かめられなかったので、1行を渡していません。', true, pane);
    deps.sleep(1000);
    if (deps.now() >= deadline) return fail('新しいセッションの auto mode を時間内に確かめられなかったので、1行を渡していません。', true, pane);
  }
  const typed = deps.run('tmux', ['send-keys', '-t', pane, '-l', line]);
  const entered = typed.status === 0 ? deps.run('tmux', ['send-keys', '-t', pane, 'Enter']) : typed;
  if (entered.status !== 0) return fail('新しいセッションに1行を渡せませんでした。', true, pane);
  return { started: true, verified: true, pane, reason: null, line };
}

function defaultDeps(): RelaunchDeps {
  const isExecutable = (path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  return {
    env: process.env,
    run: (cmd, args, cwd) => {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
      return { status: r.status, stdout: String(r.stdout ?? '') };
    },
    onPath: (command) => onPath(command, process.platform, process.env, isExecutable),
    commonDir: gitCommonDir(),
    defaultBranch: loadConfig().defaultBranch,
    sleep: (ms) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
    now: () => Date.now(),
  };
}

const USAGE = '使い方: node harness/scripts/relaunch.ts check | start --line "<1行>" [--timeout <秒>]';

if (import.meta.main) {
  const [sub, ...rest] = process.argv.slice(2);
  const usage = (): never => {
    console.error(USAGE);
    process.exit(2);
  };
  if (sub === 'check') {
    if (rest.length > 0) usage();
    console.log(JSON.stringify(relaunchCheck(defaultDeps())));
  } else if (sub === 'start') {
    let line = '';
    let timeout = 60;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      const v = rest[i + 1];
      if (a === '--line' && v !== undefined) {
        line = v;
        i++;
      } else if (a === '--timeout' && v !== undefined && /^[1-9]\d*$/.test(v)) {
        timeout = Number(v);
        i++;
      } else usage();
    }
    if (line.trim() === '') usage();
    const r = relaunchStart(defaultDeps(), line, timeout);
    console.log(JSON.stringify(r));
    process.exit(r.verified ? 0 : 1);
  } else usage();
}
