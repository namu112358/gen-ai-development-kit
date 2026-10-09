import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HarnessConfig } from './config.ts';

/**
 * 作業用の git worktree（リポジトリの外の作業場所）の作成（`node_modules` が無ければ `npm ci` まで）と削除、置き場所の決め方、Orca の表示名。
 * 作業は常に git worktree で行う。置き場所は環境変数 `AGENT_HARNESS_WORKTREE_ROOT` → 設定の `worktreeRoot` → 既定
 * （`../<リポジトリ名>.worktrees`）の順で `worktreeRoot` が決め、リポジトリの中になる値と本体を含む祖先は拒む
 * （作業中の変更やほかの作業ツリーがコミットに紛れ込まないように）。Issue のブランチの worktree には、Orca があれば
 * 表示名「#番号 短い名前」と Issue を付ける（`labelOrcaWorktree`。表示のためだけで、無い・失敗しても止めない）。
 * plan-critic の読み先は `criticRepo` が決める（先に fetch し（失敗したら手元の origin/<既定ブランチ> で続けて警告を出す）、origin/<既定ブランチ> を含むパスを選ぶ。無ければ SHA の detach の worktree。
 * セッションを渡すと Issue とセッションごとの名前の worktree（並行するセッション・入れ子の ship の片付けで消えない））。
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
  /** 空のディレクトリを消す（既定は rmdirSync。空でなければ消えない。テストで「消せない」を作るために差し替える） */
  removeEmptyDir?: (path: string) => void;
}

/** worktree・worktree-remove の使い方 */
export const WORKTREE_USAGE = {
  worktree: 'worktree <ブランチ|SHA> [--detach] [--routine]',
  'worktree-remove': 'worktree-remove <ブランチ|SHA>',
} as const;

/**
 * worktree・worktree-remove の引数を読む。ref は先頭の引数で、フラグはその後ろに書く。
 * ref が無い、または `-` で始まる（`--detach` を ref として受け取らないように）ときは使い方を含めて投げる
 */
export function parseWorktreeArgs(cmd: 'worktree' | 'worktree-remove', args: string[]): { ref: string; detach: boolean; routine: boolean } {
  const ref = args[0];
  if (ref === undefined || ref.trim() === '' || ref.startsWith('-')) {
    const why = ref === undefined || ref.trim() === '' ? 'ブランチか SHA を渡してください' : `先頭の引数 ${ref} はフラグです。ブランチか SHA を先に書き、フラグはその後ろに書いてください`;
    throw new Error(`${why}。使い方: node harness/scripts/agent.ts ${WORKTREE_USAGE[cmd]}`);
  }
  const rest = args.slice(1);
  return { ref, detach: rest.includes('--detach'), routine: rest.includes('--routine') };
}

/** パスが中身の無いディレクトリか */
function isEmptyDir(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
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
 * 登録されていない空のディレクトリは消して作り直し、消せなければほかのプロセスが使っていると分かる文で止める
 * （空でないディレクトリは中身を消さずに止める）。
 * detach でない ref がリモートに無く、コミットの SHA（40 桁の16進、または 7〜39 桁でコミットに解決できる）なら、
 * SHA の名前のブランチを作らずに --detach を促して止める。
 * fetch の失敗は警告だけ出して手元の ref で続ける。
 */
export function addWorktree(ref: string, detach: boolean, opts: WorktreeOptions, name?: string): string {
  const { root, defaultBranch, warn = console.error, removeEmptyDir = rmdirSync } = opts;
  const path = worktreePath(root, name ?? ref, opts.worktreeRoot);
  if (existsSync(path) && isEmptyDir(path) && !findWorktree(root, path)) {
    // 消し残した空のディレクトリ（Windows でほかのプロセスが掴んでいた残りなど）は消して作り直す
    run(root, ['worktree', 'prune']);
    try {
      removeEmptyDir(path);
    } catch (e) {
      throw new Error(
        `${path} に空のディレクトリが残っていて、ほかのプロセスが使っているため消せません。そのプロセス（エディタ・端末・Orca など）を閉じてから消してください: ${(e as Error).message}`,
      );
    }
  }
  if (existsSync(path)) {
    const wt = findWorktree(root, path);
    if (!wt) throw new Error(`${path} は既にありますが、worktree として登録されていません`);
    if (detach) {
      const r = run(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      const sha = r.status === 0 ? r.stdout.trim() : null;
      if (sha === null || wt.head !== sha) {
        // SHA と同じ名前のブランチの worktree もあるので、ブランチなら名前とコミットを分けて示す
        const at = wt.branch ? `ブランチ ${wt.branch}（コミット ${wt.head}）` : wt.head;
        throw new Error(`${path} の worktree は ${at} を指していて、${ref} ではありません`);
      }
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
    // --detach を付け忘れた SHA から、SHA の名前のブランチを既定ブランチの先に作らない（後の --detach がそのブランチで止まる）
    if (/^[0-9a-f]{40}$/i.test(ref) || (/^[0-9a-f]{7,39}$/i.test(ref) && run(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).status === 0)) {
      throw new Error(`${ref} はコミットの SHA です。SHA を取り出すときは --detach を付けてください。使い方: node harness/scripts/agent.ts ${WORKTREE_USAGE.worktree}`);
    }
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

/**
 * worktree を削除する。git の削除と prune の後にパスが空のディレクトリで残っていれば消してみて、それでも残れば警告を出す。
 * git の削除が失敗しても、パスが空のディレクトリだけでそれを消せたら成功とみなす（登録の無い残りの片付け）。
 * それ以外の git の失敗は理由付きで投げる（prune の失敗は無視する）
 */
export function removeWorktree(ref: string, opts: Pick<WorktreeOptions, 'root' | 'worktreeRoot' | 'warn' | 'removeEmptyDir'>): void {
  const { root, warn = console.error, removeEmptyDir = rmdirSync } = opts;
  const path = worktreePath(root, ref, opts.worktreeRoot);
  const r = run(root, ['worktree', 'remove', '--force', path]);
  run(root, ['worktree', 'prune']);
  let cleared = false;
  if (existsSync(path) && isEmptyDir(path) && !findWorktree(root, path)) {
    try {
      removeEmptyDir(path);
      cleared = !existsSync(path);
    } catch {
      // 残ったことは下の警告で知らせる
    }
  }
  if (existsSync(path)) warn(`警告: ${path} が残りました（ほかのプロセスが使っている可能性があります。閉じてから手で消してください）`);
  if (r.status !== 0 && !cleared) throw new Error(`worktree を削除できませんでした: ${r.stderr.trim()}`);
}

/** plan-critic の読み先 */
export interface CriticRepo {
  path: string;
  /** origin/<branch> の SHA */
  base: string;
  branch: string;
  source: 'issue-worktree' | 'cwd' | 'snapshot';
  /** snapshot の worktree を `worktree-remove` で消すときの名前（source が snapshot のときだけ） */
  removeRef?: string;
  /** fetch に失敗して手元の ref で続けたときだけ付く（git fetch の stderr） */
  fetchError?: string;
}

/**
 * plan-critic が読むリポジトリのパスを決める。先に origin の既定ブランチを fetch し、HEAD がその最新（base）を含む最初のものを使う：
 * Issue のブランチ（`claude/issue-<番号>-`）の worktree → cwd の toplevel → 無ければ base の detach の worktree（addWorktree。npm ci はしない）。
 * セッションを渡すと、その worktree は Issue とセッションごとの名前になる（並行するセッション・入れ子の ship の片付けで消えない）。
 * fetch の失敗は警告（`opts.warn`）を1回出して手元の origin/<既定ブランチ> で続ける（`fetchError` に stderr）。
 * 手元の base も読めない・worktree を作れないときは、読めるパスが無いとして投げる（批評を始める前に止める）
 */
export function criticRepo(issue: number, cwd: string, opts: WorktreeOptions, session?: string): CriticRepo {
  const { root, defaultBranch: branch } = opts;
  const { warn = console.error } = opts;
  const noPath = (why: string) => new Error(`origin/${branch} の最新を読めるパスがありません: ${why}`);
  const fetched = run(root, ['fetch', '-q', 'origin', branch]);
  const fetchFailed = fetched.status !== 0;
  const fetchStderr = (fetched.stderr ?? '').trim();
  const parsed = run(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`]);
  const base = parsed.status === 0 ? parsed.stdout.trim() : '';
  if (!base) {
    throw noPath(fetchFailed ? `git fetch origin ${branch} に失敗し、手元の origin/${branch} もありません: ${fetchStderr}` : `origin/${branch} を読めません`);
  }
  if (fetchFailed) warn(`警告: git fetch origin ${branch} に失敗しました。手元の origin/${branch}（${base}）で批評を続けます（最新でないおそれ）: ${fetchStderr}`);
  const fetchError = fetchFailed ? { fetchError: fetchStderr } : {};
  const hasBase = (head: string) => head !== '' && run(root, ['merge-base', '--is-ancestor', base, head]).status === 0;

  const prefix = `claude/issue-${issue}-`;
  const trees = git(root, 'worktree', 'list', '--porcelain')
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n');
      return {
        path: lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length) ?? '',
        head: lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? '',
        branch: lines.find((l) => l.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null,
      };
    });
  const found = trees.find((t) => t.path !== '' && t.branch?.startsWith(prefix) && hasBase(t.head));
  if (found) return { path: found.path, base, branch, source: 'issue-worktree', ...fetchError };

  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (top.status === 0 && hasBase(run(top.stdout.trim(), ['rev-parse', 'HEAD']).stdout.trim())) {
    return { path: top.stdout.trim(), base, branch, source: 'cwd', ...fetchError };
  }

  try {
    if (session) {
      const name = `critic-${issue}-${createHash('sha256').update(session).digest('hex').slice(0, 12)}-${base}`;
      return { path: addWorktree(base, true, opts, name), base, branch, source: 'snapshot', removeRef: name, ...fetchError };
    }
    return { path: addWorktree(base, true, opts), base, branch, source: 'snapshot', removeRef: base, ...fetchError };
  } catch (e) {
    throw noPath((e as Error).message);
  }
}
