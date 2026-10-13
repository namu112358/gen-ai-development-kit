/**
 * セッションの前提の確かめ（Issue #833）。足りないものを1行ずつ標準出力に出す。全部そろえば何も出さない。
 *
 *   node harness/scripts/session-doctor.ts
 *
 * - 見るもの：git の名義（user.name・user.email）・Orca の CLI（探すだけで実行しない）・手元の既定ブランチ（harness.config.json の defaultBranch）が origin より古くないか（設定が読めなければ見ない）・gh の認証。
 * - 行に環境変数の値・パス・SHA・トークン・gh の出力を入れない。環境変数は process.env から node の中で読む（printenv・env を使わない）。
 * - 設定を変えない。fetch・pull をしない。引数は取らず、終了コードは 0（引数があれば使い方を標準エラーに出して 2）。
 * - AGENT_HARNESS_SESSION_DOCTOR=0 で止める。NODE_TEST_CONTEXT があり AGENT_HARNESS_SESSION_DOCTOR=1 が無いときも止める。
 * - ls-remote と gh は非同期に並行に動かし、それぞれ子の時間切れ（3 秒）と、確かめ全体の上限（4 秒）を置く。
 *   同期で呼ぶ短い git（config・rev-parse・cat-file・merge-base）は全体の上限の対象外で、spawnSync の時間切れ（2 秒）だけを置く。
 * - 入口は import.meta.main の中だけで動く（テストが import しても動かない）。
 * - SessionStart の hook（.claude/hooks/session-env.ts。Issue #834）から、cwd と env を渡して呼ぶ（defaultSessionDoctorDeps の opts）。
 *   人が呼ばなくても startup のたびに動くので、画面を出さず取りに行かない：同期の git の env に GIT_TERMINAL_PROMPT=0・GIT_NO_LAZY_FETCH=1、
 *   ls-remote の env に GIT_TERMINAL_PROMPT=0・GCM_INTERACTIVE=never・SSH_ASKPASS_REQUIRE=never を足し、ls-remote は Windows のほかでは
 *   detached（制御端末を持たない）、Windows では windowsHide で動かす。credential helper は外さない。
 * - 同期の git は全体の上限の外なので最悪でも 5回×2秒＋4秒＝約14秒で、SessionStart の hook の既定の時間切れ（60秒）より短い。
 *   時間切れの値を変えたら、この見積もりと docs/setup.md の節11も直す。
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orcaCliInfo } from './orca-cli.ts';

type Env = Record<string, string | undefined>;

export interface SessionDoctorDeps {
  platform: NodeJS.Platform;
  env: Env;
  /** 同期の短い git。status は終了コード（起動できなければ null） */
  gitSync(args: string[]): { status: number | null; stdout: string };
  /** 既定ブランチ（harness.config.json の defaultBranch）。設定が読めない・空なら null（古さの1行を出さない） */
  defaultBranch: string | null;
  /** origin の refs/heads/<既定ブランチ> の SHA。失敗・時間切れ・空なら null */
  lsRemoteBranch(branch: string): Promise<string | null>;
  /** gh auth status の終了コード。起動できない・時間切れなら null */
  ghAuthStatus(): Promise<number | null>;
  isExecutable?: (path: string) => boolean;
  /** 確かめ全体の上限（ミリ秒） */
  totalTimeoutMs: number;
}

const CHILD_TIMEOUT_MS = 3_000;
const GIT_SYNC_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 4_000;

/** 止めるか。env の読み取りが例外を投げたら止めない */
export function sessionDoctorDisabled(env: Env): boolean {
  try {
    const flag = env.AGENT_HARNESS_SESSION_DOCTOR;
    if (flag === '0') return true;
    return !!env.NODE_TEST_CONTEXT && flag !== '1';
  } catch {
    return false;
  }
}

function runAsync(command: string, args: string[], opts: { cwd?: string; env?: Env; stdout: boolean; detached?: boolean }): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (status: number | null) => {
      if (done) return;
      done = true;
      resolve({ status, stdout: out });
    };
    try {
      const child = spawn(command, args, {
        shell: false,
        timeout: CHILD_TIMEOUT_MS,
        cwd: opts.cwd,
        detached: opts.detached && process.platform !== 'win32',
        windowsHide: process.platform === 'win32',
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'ignore'],
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (c: string) => {
        out += c;
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => finish(code));
    } catch {
      finish(null);
    }
  });
}

/** cwd の harness.config.json の defaultBranch。ファイルが無い・JSON が壊れている・空・文字列でないなら null */
export function readDefaultBranch(cwd: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(join(cwd, 'harness.config.json'), 'utf8')) as { defaultBranch?: unknown } | null)?.defaultBranch;
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  } catch {
    return null;
  }
}

export function defaultSessionDoctorDeps(opts: { cwd?: string; env?: Env } = {}): SessionDoctorDeps {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd;
  const syncEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  const lsRemoteEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' };
  return {
    platform: process.platform,
    env,
    gitSync: (args) => {
      const r = spawnSync('git', args, { shell: false, cwd, env: syncEnv as NodeJS.ProcessEnv, encoding: 'utf8', timeout: GIT_SYNC_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
      return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
    },
    defaultBranch: readDefaultBranch(cwd ?? process.cwd()),
    lsRemoteBranch: async (branch) => {
      const r = await runAsync('git', ['ls-remote', 'origin', `refs/heads/${branch}`], { cwd, env: lsRemoteEnv, stdout: true, detached: true });
      if (r.status !== 0) return null;
      const sha = r.stdout.trim().split(/\s+/)[0] ?? '';
      return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
    },
    ghAuthStatus: async () => (await runAsync('gh', ['auth', 'status'], { cwd, env, stdout: false })).status,
    totalTimeoutMs: TOTAL_TIMEOUT_MS,
  };
}

function gitIdentityMissing(d: SessionDoctorDeps): boolean {
  for (const key of ['user.name', 'user.email']) {
    const r = d.gitSync(['config', '--get', key]);
    if (r.status !== 0 || r.stdout.trim() === '') return true;
  }
  return false;
}

function orcaLine(d: SessionDoctorDeps): string | null {
  try {
    return orcaCliInfo(d.platform, d.env, d.isExecutable).found ? null : 'Orca の CLI が見つかりません';
  } catch {
    return 'Orca の CLI を決められません（環境変数を読めません）';
  }
}

async function defaultBranchLine(d: SessionDoctorDeps): Promise<string | null> {
  const branch = d.defaultBranch;
  if (!branch) return null;
  const local = d.gitSync(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const localSha = local.stdout.trim();
  if (local.status !== 0 || localSha === '') return null;
  const origin = await d.lsRemoteBranch(branch);
  if (!origin || origin === localSha) return null;
  const stale = `手元の既定ブランチ（${branch}）が origin より古いです（git fetch origin で取り込めます）`;
  if (d.gitSync(['cat-file', '-e', `${origin}^{commit}`]).status !== 0) return stale;
  const anc = d.gitSync(['merge-base', '--is-ancestor', origin, localSha]).status;
  if (anc === 0) return null;
  return anc === 1 ? stale : null;
}

async function ghLine(d: SessionDoctorDeps): Promise<string | null> {
  const code = await d.ghAuthStatus();
  return typeof code === 'number' && code !== 0 ? 'gh の認証がありません（gh auth login）' : null;
}

export async function sessionDoctor(opts: { orcaNoticeShown?: boolean } = {}, deps: Partial<SessionDoctorDeps> = {}): Promise<string[]> {
  const d: SessionDoctorDeps = { ...defaultSessionDoctorDeps(), ...deps };
  if (sessionDoctorDisabled(d.env)) return [];

  const lines: string[] = [];
  if (gitIdentityMissing(d)) lines.push('git の名義（user.name・user.email）が設定されていません');
  if (!opts.orcaNoticeShown) {
    const line = orcaLine(d);
    if (line) lines.push(line);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), d.totalTimeoutMs);
  });
  const guarded = (p: Promise<string | null>): Promise<string | null> => Promise.race([p.catch(() => null), limit]);
  try {
    const [branchLine, gh] = await Promise.all([guarded(defaultBranchLine(d)), guarded(ghLine(d))]);
    if (branchLine) lines.push(branchLine);
    if (gh) lines.push(gh);
  } finally {
    clearTimeout(timer);
  }
  return lines;
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    console.error('使い方: node harness/scripts/session-doctor.ts（引数は取らない）');
    process.exit(2);
  }
  try {
    for (const line of await sessionDoctor()) console.log(line);
  } catch {
    // 確かめの失敗でセッションを止めない
  }
  process.exit(0);
}
