import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HarnessConfig } from './config.ts';

/**
 * 作業用の git worktree（リポジトリの外の作業場所）の作成（`node_modules` が無ければ `npm ci` まで）と削除、置き場所の決め方、Orca の表示名。
 * 作業は常に git worktree で行う。置き場所は環境変数 `AGENT_HARNESS_WORKTREE_ROOT` → 設定の `worktreeRoot` → 既定
 * （`../<リポジトリ名>.worktrees`）の順で `worktreeRoot` が決め、リポジトリの中になる値と本体を含む祖先は拒む
 * （作業中の変更やほかの作業ツリーがコミットに紛れ込まないように）。Issue のブランチの worktree には、Orca があれば
 * 表示名「#番号 短い名前」と Issue を付ける（`labelOrcaWorktree`。表示のためだけで、無い・失敗しても止めない）。
 */

/** 本体のリポジトリのルート（worktree の中から呼ばれても本体を返す） */
export function mainRepoRoot(cwd: string = process.cwd()): string {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git リポジトリではありません: ${cwd}`);
  return dirname(r.stdout.trim());
}

/** パソコンごとに worktree の置き場所を上書きする環境変数 */
export const WORKTREE_ROOT_ENV = 'AGENT_HARNESS_WORKTREE_ROOT';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/** child が parent 自身かその下か */
function isSameOrInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * worktree の置き場所（絶対パス）。環境変数 → 設定 → 既定の順（空・空白だけは無いとみなす）。
 * `{repo}` はリポジトリ名、`~`・`~/`・`~\` はホーム（`~` の後ろは `/` も `\` も区切りとみなす。POSIX でも同じ）、絶対パスはそのまま、それ以外は repoRoot から。
 * 展開した結果が repoRoot 自身かその下、または repoRoot を含む祖先なら、値の出どころを示して投げる。
 * 比べるときだけ realpath でそろえ、返す値は resolve の結果のまま。env の既定は空（呼び出し元が process.env を渡す）
 */
export function worktreeRoot(
  repoRoot: string,
  config: Pick<HarnessConfig, 'worktreeRoot'> = {},
  env: Record<string, string | undefined> = {},
  home: string = homedir(),
): string {
  const root = resolve(repoRoot);
  const name = basename(root);
  const fromEnv = env[WORKTREE_ROOT_ENV]?.trim();
  const fromConfig = config.worktreeRoot?.trim();
  const [value, source] = fromEnv ? [fromEnv, `環境変数 ${WORKTREE_ROOT_ENV}`] : fromConfig ? [fromConfig, 'harness.config.json の worktreeRoot'] : [null, ''];
  if (value === null) return resolve(root, '..', `${name}.worktrees`);
  const replaced = value.replaceAll('{repo}', name);
  const expanded =
    replaced === '~' ? resolve(home) : /^~[/\\]/.test(replaced) ? resolve(home, ...replaced.slice(2).split(/[/\\]/)) : isAbsolute(replaced) ? resolve(replaced) : resolve(root, replaced);
  const [r, e] = [real(root), real(expanded)];
  if (isSameOrInside(r, e)) throw new Error(`${source}（${value}）の worktree の置き場所 ${expanded} がリポジトリの中です。リポジトリの外を指定してください`);
  if (isSameOrInside(e, r)) throw new Error(`${source}（${value}）の worktree の置き場所 ${expanded} がリポジトリを含みます。リポジトリの外の別のディレクトリを指定してください`);
  return expanded;
}

export function worktreePath(repoRoot: string, ref: string, root: string = worktreeRoot(repoRoot)): string {
  // 先頭の . は _ にする（`..` などで置き場所の外に出ないように）
  const name = ref.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\./, '_');
  return resolve(root, name);
}

export interface WorktreeOptions {
  /** 本体のリポジトリのルート */
  root: string;
  /** 新しいブランチの起点（`harness.config.json` の `defaultBranch`） */
  defaultBranch: string;
  /** worktree の置き場所の絶対パス（worktreeRoot で決めたもの。無ければ既定） */
  worktreeRoot?: string;
  /** 警告の出力先（既定は標準エラー） */
  warn?: (message: string) => void;
}

/** 呼び出し元（worktree コマンド・合体版のレビューの⑧）が渡す設定。どこから呼んでも同じ置き場所になる */
export function worktreeOptions(
  config: Pick<HarnessConfig, 'defaultBranch' | 'worktreeRoot'>,
  env: Record<string, string | undefined> = process.env,
  root: string = mainRepoRoot(),
): Required<Pick<WorktreeOptions, 'root' | 'defaultBranch' | 'worktreeRoot'>> {
  return { root, defaultBranch: config.defaultBranch, worktreeRoot: worktreeRoot(root, config, env) };
}

/** Orca の表示名と Issue（`claude/issue-<番号>-<短い名前>` のブランチだけ。短い名前はブランチの後ろをそのまま使う） */
export function orcaWorktreeLabel(ref: string): { issue: number; displayName: string } | null {
  const m = ref.match(/^claude\/issue-(\d+)-(.+)$/);
  return m ? { issue: Number(m[1]), displayName: `#${m[1]} ${m[2]}` } : null;
}

/**
 * Orca の CLI（orca-cli の skill の「Resolve the CLI」と同じ順）：ORCA_CLI_COMMAND → ORCA_DEV_REPO_ROOT があれば orca-dev →
 * linux は orca-ide（素の orca は読み上げソフトになりうるので使わない）→ ほか（win32・darwin）は orca
 */
export function orcaCliCommand(platform: NodeJS.Platform, env: Record<string, string | undefined>): string {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  return platform === 'linux' ? 'orca-ide' : 'orca';
}

/** `orca worktree set` の引数（親子は付けない） */
export function orcaWorktreeSetArgs(path: string, label: { issue: number; displayName: string }): string[] {
  return ['worktree', 'set', '--worktree', `path:${path}`, '--display-name', label.displayName, '--issue', String(label.issue), '--json'];
}

/** CLI の起動の結果（spawnSync の結果のうち使うところ） */
export type OrcaRunResult = { status: number | null; error?: Error & { code?: string }; stderr?: string | null };

export interface OrcaLabelDeps {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  run?: (command: string, args: string[]) => OrcaRunResult;
  warn?: (message: string) => void;
}

/** 既定の起動。shell を通さない（表示名の文字を解釈させない）。出力は標準出力に流さない。15 秒で打ち切る */
function defaultOrcaRun(command: string, args: string[]): OrcaRunResult {
  return spawnSync(command, args, { shell: false, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Issue のブランチの worktree に、Orca の表示名と Issue を付ける。1回だけ動かし、投げない。
 * ラベルが無ければ skipped、CLI が無い（ENOENT）なら何も言わずに absent、0 以外・タイムアウト・その他の起動エラー
 * （Windows で .cmd を shell なしで起動した EINVAL など）は警告1行で failed。Orca が動いていなくても起動（open）はしない
 */
export function labelOrcaWorktree(path: string, ref: string, deps: OrcaLabelDeps = {}): 'labeled' | 'skipped' | 'absent' | 'failed' {
  const label = orcaWorktreeLabel(ref);
  if (!label) return 'skipped';
  const { platform = process.platform, env = process.env, run = defaultOrcaRun, warn = console.error } = deps;
  try {
    const r = run(orcaCliCommand(platform, env), orcaWorktreeSetArgs(path, label));
    if (r.error?.code === 'ENOENT') return 'absent';
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : `終了コード ${r.status ?? '(シグナルで終了)'}: ${(r.stderr ?? '').trim().split('\n')[0] ?? ''}`;
      warn(`警告: Orca の表示名を付けられませんでした（続けます）: ${why}`);
      return 'failed';
    }
    return 'labeled';
  } catch (e) {
    warn(`警告: Orca の表示名を付けられませんでした（続けます）: ${(e as Error).message}`);
    return 'failed';
  }
}

function run(root: string, args: string[]) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function git(root: string, ...args: string[]): string {
  const r = run(root, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} が失敗しました: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

/** `git worktree list --porcelain` からパスの worktree を探す */
function findWorktree(root: string, path: string): { head: string; branch: string | null } | null {
  const target = real(path);
  for (const block of git(root, 'worktree', 'list', '--porcelain').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!at || real(at) !== target) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '';
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null;
    return { head, branch };
  }
  return null;
}

/**
 * 作業用の worktree を作り、パスを返す。ブランチがリモートにあればそれを、無ければ origin/<既定ブランチ> から新しく作る。
 * detach は判定のテスト実行用（head SHA をそのまま取り出す）。
 * 既にパスがあれば、同じブランチ（detach なら同じコミット）の worktree のときだけそのパスを返し、違えば止める。
 * fetch の失敗は警告だけ出して手元の ref で続ける。
 */
export function addWorktree(ref: string, detach: boolean, opts: WorktreeOptions): string {
  const { root, defaultBranch, warn = console.error } = opts;
  const path = worktreePath(root, ref, opts.worktreeRoot);
  if (existsSync(path)) {
    const wt = findWorktree(root, path);
    if (!wt) throw new Error(`${path} は既にありますが、worktree として登録されていません`);
    if (detach) {
      const r = run(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      const sha = r.status === 0 ? r.stdout.trim() : null;
      if (sha === null || wt.head !== sha) throw new Error(`${path} の worktree は ${wt.branch ?? wt.head} を指していて、${ref} ではありません`);
    } else if (wt.branch !== ref) {
      throw new Error(`${path} の worktree は ${wt.branch ?? `${wt.head}（detach）`} を指していて、${ref} ではありません`);
    }
    return path;
  }

  // 必要な ref だけ取る。ブランチがリモートに無いことは失敗ではないので、先に確かめて既定ブランチだけにする
  let refs: string[] | null = [defaultBranch, ref];
  if (!detach) {
    const r = run(root, ['ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`]);
    if (r.status === 2) refs = [defaultBranch];
    else if (r.status !== 0) {
      warn(`警告: origin の ${ref} を確かめられませんでした。手元の ref で続けます: ${r.stderr.trim()}`);
      refs = null;
    }
  }
  if (refs) {
    const r = run(root, ['fetch', '-q', 'origin', ...refs]);
    if (r.status !== 0) warn(`警告: git fetch origin ${refs.join(' ')} が失敗しました。手元の ref で続けます: ${r.stderr.trim()}`);
  }

  if (detach) {
    const r = run(root, ['worktree', 'add', '-q', '--detach', path, ref]);
    if (r.status !== 0) throw new Error(`${ref} の worktree を作れませんでした（手元にそのコミットが無い可能性があります）: ${r.stderr.trim()}`);
  } else if (run(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${ref}`]).status === 0) {
    git(root, 'worktree', 'add', '-q', '-B', ref, path, `origin/${ref}`);
  } else {
    git(root, 'worktree', 'add', '-q', '-b', ref, path, `origin/${defaultBranch}`);
  }
  return path;
}

/** `npm ci` の結果（`spawnSync` の結果のうち使うところ） */
export type NpmCiResult = { status: number | null; error?: Error };

/** npmCommand が起動できる npm の引数（固定の組だけ。外から来る文字列は受け取らない） */
const NPM_ARGS = { ci: ['ci'], check: ['run', 'check'] } as const;

/**
 * npm の起動の仕方（worktree の作成の `npm ci` と、合体版のレビューの⑧の `npm ci`・`npm run check` が使う）。
 * Windows の npm は `npm.cmd` で、Node は shell を通さないと `.cmd` を起動できないので shell を通す。
 * shell: true に引数の配列を渡すと Node 24 が DEP0190 の警告を出すので、Windows ではコマンドを1つの文字列にする
 */
export function npmCommand(platform: NodeJS.Platform, script: 'ci' | 'check'): { command: string; args: string[]; shell: boolean } {
  const args = [...NPM_ARGS[script]];
  return platform === 'win32' ? { command: ['npm', ...args].join(' '), args: [], shell: true } : { command: 'npm', args, shell: false };
}

/** `npm ci` の起動の仕方（npmCommand の ci） */
export function npmCiCommand(platform: NodeJS.Platform): { command: string; args: string[]; shell: boolean } {
  return npmCommand(platform, 'ci');
}

/** 既定の `npm ci`。npm の出力は標準エラーへ流し、標準出力（worktree のパス）を汚さない */
function defaultNpmCi(cwd: string): NpmCiResult {
  const { command, args, shell } = npmCiCommand(process.platform);
  return spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2], shell });
}

/**
 * worktree の依存を用意する。`node_modules` があれば何もしない（'present'）。
 * `package-lock.json` が無ければ `npm ci` は必ず失敗するので何もしない（'skipped'）。
 * それ以外は `npm ci` を1回動かし（'installed'）、起動できないか 0 以外で終われば理由付きで投げる。
 */
export function ensureNodeModules(path: string, runNpmCi: (cwd: string) => NpmCiResult = defaultNpmCi): 'present' | 'installed' | 'skipped' {
  if (existsSync(join(path, 'node_modules'))) return 'present';
  if (!existsSync(join(path, 'package-lock.json'))) return 'skipped';
  const r = runNpmCi(path);
  if (r.error) throw new Error(`npm ci を起動できませんでした（${path}）: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`npm ci が失敗しました（${path}）: 終了コード ${r.status ?? '(シグナルで終了)'}`);
  return 'installed';
}

/** worktree を削除する。削除に失敗したら理由付きで投げる（prune の失敗は無視する） */
export function removeWorktree(ref: string, opts: Pick<WorktreeOptions, 'root' | 'worktreeRoot'>): void {
  const { root } = opts;
  const r = run(root, ['worktree', 'remove', '--force', worktreePath(root, ref, opts.worktreeRoot)]);
  run(root, ['worktree', 'prune']);
  if (r.status !== 0) throw new Error(`worktree を削除できませんでした: ${r.stderr.trim()}`);
}
