/**
 * 書き換えの場所の見張りの PreToolUse hook（.claude/settings.json で Edit・Write・NotebookEdit・Bash に登録）。Issue #286。
 *
 * main の checkout と fleet のワークスペース（印のファイル `.agent-harness-workspace` を一番上に置いた作業ツリー）の中の書き換えを止め、
 * 書き換えを Issue の worktree の中だけにする（規則「作業は常に worktree で行う」を仕組みで守らせる。人の決定は #281 のコメント 5892608637）。
 * 止めるのは Edit・Write・NotebookEdit の書き先と、作業ツリー・索引を変える git（commit・add・reset など、
 * `--ff-only` も `pull.ff=only` の設定も無い pull、rebase を伴う pull（`--ff-only` があっても））だけ。
 * `git pull --ff-only`・`pull.ff=only` の設定で fast-forward だけになる素の pull（コマンド行・環境で設定を変えていないとき）・
 * `fetch`・`status`・`worktree add/remove/prune` などは通す。OS の一時ディレクトリと `~/.claude` の中は常に通す。
 *
 * 場所の判定の順：通す置き場所 → 書き先の作業ツリーの一番上（`git rev-parse --show-toplevel --git-dir --git-common-dir`）→
 * 書き先から作業ツリーの一番上までの祖先の印 → 作業ツリーが main の checkout か（git-dir と git-common-dir が同じ作業ツリー。
 * `--separate-git-dir` で git のディレクトリが離れていても見分ける。linked worktree・submodule は「git-common-dir の親」と比べる）。
 * 作業ツリーの一番上で比べるので、main の checkout の中の `.claude/worktrees/` の worktree や `../<リポジトリ名>.worktrees/` は通る。
 * 判定できないとき（入力が読めない・パスが無い・git が失敗する・git の作業場所が静的に決まらない）は止める。
 *
 * 拾いきれない経路（抜け道。docs/security.md）：Bash のリダイレクト（`>`）・`sed -i`・`rm`・`cp` などの git 以外の書き換え、
 * スクリプトや別のプロセス（`node harness/scripts/agent.ts` など）の中で動く git、xargs・find -exec などで動かす git、印を消すこと。
 * Bash のコマンドは guard.ts の parseScript で字句に分ける（guard.ts が読み込めないと、この hook も動けないときの deny になる）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { parseScript } from './guard.ts';

export const MARKER = '.agent-harness-workspace';

export type Decision = { deny: false } | { deny: true; reason: string };

export type Located = { kind: 'repo'; toplevel: string; mainRoot: string } | { kind: 'none' } | { kind: 'error' };

export interface WorkspaceContext {
  /** 常に通す置き場所（OS の一時ディレクトリ・~/.claude） */
  allowRoots: string[];
  /** dir（無ければ今ある一番近い祖先）を含む作業ツリーの一番上と、main の checkout（git-dir と git-common-dir が同じなら作業ツリーの一番上、linked worktree・submodule は git-common-dir の親） */
  locate: (dir: string) => Located;
  /** dir の直下に印のファイルがあるか */
  hasMarker: (dir: string) => boolean;
  /** パスの扱い（区切り・大文字小文字・Git Bash の /c/...）を決めるプラットフォーム。既定はこの OS */
  platform?: NodeJS.Platform;
  /**
   * dir で素の `git pull` に効く設定（`pull.ff` と、今のブランチの `branch.<名前>.rebase`、無ければ `pull.rebase`。未設定は null）。
   * null は読めない。無いか null なら、素の pull は場所で判定する（main の checkout では止める）
   */
  pullSettings?: (dir: string) => PullSettings | null;
}

export interface PullSettings {
  ff: string | null;
  rebase: string | null;
}

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
  [k: string]: unknown;
}

const ALLOW: Decision = { deny: false };
const MAX_DEPTH = 8;

const ADVICE = '書き換えは Issue の worktree（node harness/scripts/agent.ts worktree <ブランチ>）の中で行ってください。hq・fleet の役のセッションはファイルを書き換えません（harness/CLAUDE.harness.md の「作業は常に worktree で行う」）。';
const deny = (what: string): Decision => ({ deny: true, reason: `hook（workspace-guard）が止めました：${what}。${ADVICE}` });
const unknownDeny = (what: string): Decision => ({
  deny: true,
  reason: `hook（workspace-guard）が止めました：${what}ため、書き換えてよい場所か判定できません。${ADVICE}`,
});

// ---------------------------------------------------------------- パス

/** パスの扱い。win32 は大文字・小文字と区切り（/ と \）を区別せず、Git Bash の /c/... を C:/... と読む */
interface PathOps {
  win: boolean;
  p: typeof posix;
  /** 実際のファイルシステムを見るか（判定するプラットフォームがこの OS と同じときだけ） */
  fs: boolean;
}

function ops(ctx: WorkspaceContext): PathOps {
  return opsFor(ctx.platform ?? process.platform);
}

function opsFor(platform: NodeJS.Platform): PathOps {
  const win = platform === 'win32';
  return { win, p: win ? win32 : posix, fs: win === (process.platform === 'win32') };
}

/** Git Bash の /c/... を C:/... に読み替える（Windows だけ） */
function fromMsys(o: PathOps, p: string): string {
  if (!o.win) return p;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? '/'}` : p;
}

function expandHome(o: PathOps, p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return o.p.join(homedir(), p.slice(2));
  return p;
}

function exists(o: PathOps, p: string): boolean {
  return o.fs && existsSync(p);
}

/** 絶対パスにし、今ある一番近い祖先を実体のパスにする */
function canonical(o: PathOps, p: string): string {
  let cur = o.p.resolve(p);
  const rest: string[] = [];
  for (;;) {
    if (exists(o, cur)) {
      let real = cur;
      try {
        real = realpathSync.native(cur);
      } catch {
        // そのまま使う
      }
      return rest.length > 0 ? o.p.join(real, ...rest.reverse()) : real;
    }
    const parent = o.p.dirname(cur);
    if (parent === cur) return o.p.resolve(p);
    rest.push(cur.slice(parent.length).replace(/^[\\/]/, ''));
    cur = parent;
  }
}

function key(o: PathOps, p: string): string {
  const r = o.p.resolve(p).replace(/[\\/]+$/, '');
  return o.win ? r.replace(/\//g, '\\').toLowerCase() : r;
}
const samePath = (o: PathOps, a: string, b: string): boolean => key(o, a) === key(o, b);
function within(o: PathOps, child: string, root: string): boolean {
  const c = key(o, child);
  const r = key(o, root);
  const sep = o.win ? '\\' : '/';
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 今ある一番近い祖先のディレクトリ（realContext の locate が git を動かす場所） */
function existingDir(p: string): string {
  let cur = p;
  for (;;) {
    try {
      if (statSync(cur).isDirectory()) return cur;
    } catch {
      // 無い
    }
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * パスの場所を判定する。target は書き先のファイル（isDir が false）か、git の作業場所（isDir が true）の絶対パス。
 * 止めるなら理由、通すなら null
 */
function classify(target: string, isDir: boolean, ctx: WorkspaceContext): Decision {
  const o = ops(ctx);
  const abs = canonical(o, target);
  for (const root of ctx.allowRoots) {
    if (within(o, abs, canonical(o, root))) return ALLOW;
  }
  // まだ無いディレクトリでもよい（locate が今ある祖先で git を読む。印は無いディレクトリには無い）
  const start = isDir ? abs : o.p.dirname(abs);
  const loc = ctx.locate(start);
  if (loc.kind === 'error') return unknownDeny(`git で ${start} の作業ツリーを読めなかった`);
  const top = loc.kind === 'repo' ? canonical(o, loc.toplevel) : null;
  let cur = start;
  for (;;) {
    if (ctx.hasMarker(cur)) return deny(`fleet のワークスペース（${cur} に ${MARKER} がある）の中の書き換え（${abs}）`);
    if (top !== null && samePath(o, cur, top)) break;
    const parent = o.p.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (loc.kind === 'repo' && top !== null && samePath(o, top, canonical(o, loc.mainRoot))) {
    return deny(`main の checkout（${top}）の中の書き換え（${abs}）`);
  }
  return ALLOW;
}

// ---------------------------------------------------------------- Bash の git

type Segment = ReturnType<typeof parseScript>[number];
type Word = Segment['words'][number];

/** 作業場所。undefined は静的に決まらない */
interface Where {
  dir: string | undefined;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);
const WRAPPERS = new Set(['command', 'nohup', 'time', 'exec', 'sudo', 'doas', 'nice', 'stdbuf', 'setsid', 'ionice']);
const baseName = (s: string): string => s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '');

/** 作業ツリー・索引を変える git のサブコマンド */
const WRITES = new Set(['commit', 'add', 'rm', 'mv', 'stash', 'reset', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'apply', 'clean', 'revert', 'am', 'pull']);

function moveTo(where: Where, arg: Word | undefined, ctx: WorkspaceContext): Where {
  const o = ops(ctx);
  if (arg === undefined) return { dir: homedir() };
  if (arg.dynamic || arg.text === '-') return { dir: undefined };
  const t = fromMsys(o, expandHome(o, arg.text));
  if (o.p.isAbsolute(t)) return { dir: o.p.resolve(t) };
  return { dir: where.dir !== undefined ? o.p.resolve(where.dir, t) : undefined };
}

/** 素の pull（`--ff-only` の無い pull）で通してよい引数（完全一致）。ほかの `-` で始まる引数が1つでもあれば通さない */
const PLAIN_PULL_OPTIONS = new Set([
  '-q', '--quiet', '-v', '--verbose', '--no-rebase', '--rebase=false', '--ff-only', '--progress', '--no-progress',
  '--autostash', '--no-autostash', '--prune', '--no-tags', '--tags',
]);

/** pull の引数が rebase を求めるか（`--rebase` の省略形 `--r`〜・`=false` 以外の値付き・短いオプションの束の `r`） */
function wantsRebase(a: Word): boolean {
  if (a.dynamic) return false;
  const t = a.text;
  if (/^-[A-Za-z]+$/.test(t)) return t.includes('r');
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(t);
  if (!m || !'rebase'.startsWith(m[1]!)) return false;
  return m[2] !== 'false';
}

/** 素の pull（rebase を求めず、`--ff-only` も無い）を、効く設定が fast-forward だけのときに通してよいか */
function plainPullIsFastForward(rest: Word[], here: Where, configOverride: boolean, ctx: WorkspaceContext): boolean {
  if (configOverride || here.dir === undefined || ctx.pullSettings === undefined) return false;
  for (const a of rest) {
    if (a.dynamic) return false;
    if (a.text.startsWith('-') && !PLAIN_PULL_OPTIONS.has(a.text)) return false;
  }
  const s = ctx.pullSettings(here.dir);
  if (s === null) return false;
  return s.ff === 'only' && (s.rebase === null || s.rebase.toLowerCase() === 'false');
}

/** git の引数から、止めるべきか。null は通す */
function checkGit(args: Word[], where: Where, assigns: string[], ctx: WorkspaceContext): Decision {
  let here: Where = where;
  let unknownWhy: string | null = null;
  /** コマンド行・環境で git の設定を変えている（hook が読んだ pull の設定と実際が食い違いうる） */
  let configOverride = false;
  for (const a of assigns) {
    const name = a.slice(0, a.indexOf('=')).replace(/\+$/, '');
    if (name === 'GIT_DIR' || name === 'GIT_WORK_TREE') unknownWhy = `前置きの ${name}`;
    if (name.startsWith('GIT_CONFIG') || name === 'HOME' || name === 'XDG_CONFIG_HOME') configOverride = true;
  }
  let j = 0;
  while (j < args.length && args[j]!.text.startsWith('-') && !args[j]!.dynamic) {
    const t = args[j]!.text;
    if (t === '-C') {
      here = moveTo(here, args[j + 1] ?? { text: '', dynamic: true, quoted: false }, ctx);
      j += 2;
    } else if (['-c', '--config-env', '--namespace', '--super-prefix', '--attr-source', '--exec-path'].includes(t)) {
      if (t === '-c' || t === '--config-env') configOverride = true;
      j += 2;
    } else if (t === '--git-dir' || t === '--work-tree') {
      unknownWhy = `git ${t}`;
      j += 2;
    } else {
      if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) unknownWhy = `git ${t.slice(0, t.indexOf('='))}`;
      if (t.startsWith('--config-env=')) configOverride = true;
      j++;
    }
  }
  const sub = args[j];
  if (!sub) return ALLOW;
  const rest = args.slice(j + 1);
  if (sub.dynamic) return unknownDeny(`git のサブコマンド（${sub.text}）が展開しないと分からない`);
  const s = sub.text;
  if (!WRITES.has(s)) return ALLOW;
  if (s === 'stash' && rest[0] !== undefined && !rest[0].dynamic && ['list', 'show'].includes(rest[0].text)) return ALLOW;
  if (s === 'pull' && !rest.some(wantsRebase)) {
    // rebase を伴う pull は --ff-only があっても通さず、場所で判定する
    if (rest.some((a) => a.text === '--ff-only')) return ALLOW;
    if (unknownWhy === null && plainPullIsFastForward(rest, here, configOverride, ctx)) return ALLOW;
  }
  if (unknownWhy !== null) return unknownDeny(`${unknownWhy} が付いた git ${s} は作業ツリーが分からない`);
  if (here.dir === undefined) return unknownDeny(`git ${s} を動かす場所が静的に決まらない`);
  const d = classify(here.dir, true, ctx);
  if (!d.deny) return ALLOW;
  return { deny: true, reason: d.reason.replace('の中の書き換え', `の中の git ${s}`) };
}

/** 前置き（代入・キーワード・env・sudo など）を飛ばしたコマンドの頭の位置と、前置きの代入 */
function commandStart(words: Word[], where: Where): { start: number; assigns: string[]; here: Where } {
  const assigns: string[] = [];
  let here = where;
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (!w.dynamic && /^[A-Za-z_]\w*\+?=/.test(w.text)) {
      assigns.push(w.text);
      i++;
      continue;
    }
    if (!w.quoted && KEYWORDS.has(w.text)) {
      i++;
      continue;
    }
    const name = baseName(w.text);
    if (name === 'env') {
      i++;
      while (i < words.length && (words[i]!.text.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i]!.text))) {
        const t = words[i]!.text;
        if (t === '--') {
          i++;
          break;
        }
        if (!t.startsWith('-')) assigns.push(t);
        else if (t === '-C' || t === '--chdir' || t.startsWith('-C') || t.startsWith('--chdir=')) here = { dir: undefined };
        else if (t === '-u' || t === '--unset' || t === '-S' || t === '--split-string') i++;
        i++;
      }
      continue;
    }
    if (WRAPPERS.has(name)) {
      i++;
      while (i < words.length && words[i]!.text.startsWith('-')) i++;
      continue;
    }
    if (name === 'timeout') {
      i++;
      while (i < words.length && words[i]!.text.startsWith('-')) i++;
      i++; // 時間
      continue;
    }
    break;
  }
  return { start: i, assigns, here };
}

function checkSegment(seg: Segment, where: Where, ctx: WorkspaceContext, depth: number): Decision {
  const { start, assigns, here } = commandStart(seg.words, where);
  const head = seg.words[start];
  if (!head) return ALLOW;
  const args = seg.words.slice(start + 1);
  if (head.dynamic) {
    // コマンド名が展開しないと分からない：git の書き換えの手がかりがあれば止める
    if (args.some((a) => WRITES.has(a.text))) return unknownDeny(`コマンド名（${head.text}）が展開しないと分からない`);
    return ALLOW;
  }
  const name = baseName(head.text);
  if (name === 'cd' || name === 'pushd') {
    where.dir = moveTo(where, args.find((a) => !/^-[LPe@]+$/.test(a.text)), ctx).dir;
    return ALLOW;
  }
  if (SHELLS.has(name)) {
    let cflag = false;
    let script: Word | undefined;
    for (let k = 0; k < args.length; k++) {
      const t = args[k]!.text;
      if (/^[-+]o$|^-O$|^\+O$/.test(t)) {
        k++;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(t)) {
        if (t.startsWith('-') && t.includes('c')) cflag = true;
        continue;
      }
      if (t.startsWith('--')) continue;
      script = args[k];
      break;
    }
    if (cflag) return script ? analyze(script.text, { ...here }, ctx, depth + 1) : ALLOW;
    for (const body of seg.heredocs) {
      const d = analyze(body, { ...here }, ctx, depth + 1);
      if (d.deny) return d;
    }
    return ALLOW;
  }
  if (name === 'eval') return analyze(args.map((a) => a.text).join(' '), { ...here }, ctx, depth + 1);
  if (name === 'git') return checkGit(args, here, assigns, ctx);
  return ALLOW;
}

const mentionsGit = (script: string): boolean => /(^|[^A-Za-z0-9_-])git([^A-Za-z0-9_-]|$)/.test(script);

function analyze(script: string, where: Where, ctx: WorkspaceContext, depth: number): Decision {
  if (depth > MAX_DEPTH) return mentionsGit(script) ? unknownDeny('入れ子が深すぎて中身を調べきれない') : ALLOW;
  let segs: Segment[];
  try {
    segs = parseScript(script);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return mentionsGit(script) ? unknownDeny(`コマンドを字句に分けられない（${message}）`) : ALLOW;
  }
  for (const seg of segs) {
    for (const s of seg.subs) {
      const d = analyze(s, { ...where }, ctx, depth + 1);
      if (d.deny) return d;
    }
    const d = checkSegment(seg, where, ctx, depth);
    if (d.deny) return d;
  }
  return ALLOW;
}

// ---------------------------------------------------------------- 入口

/** hook の入力を判定する。git・ファイルシステムは ctx を通して読む */
export function decide(input: HookInput, ctx: WorkspaceContext): Decision {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input.tool_input !== null && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {};
  const o = ops(ctx);
  const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? fromMsys(o, input.cwd) : undefined;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') {
    const p = toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path;
    if (typeof p !== 'string' || p === '') return unknownDeny(`${toolName} の書き先（${toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path'}）が無い`);
    const t = fromMsys(o, expandHome(o, p));
    if (!o.p.isAbsolute(t) && cwd === undefined) return unknownDeny(`${toolName} の書き先が相対パスで、cwd が無い`);
    return classify(o.p.isAbsolute(t) ? t : o.p.resolve(cwd!, t), false, ctx);
  }
  if (toolName === 'Bash') {
    const command = toolInput.command;
    if (typeof command !== 'string') return unknownDeny('Bash のコマンドが読めない');
    return analyze(command, { dir: cwd }, ctx, 0);
  }
  return ALLOW;
}

/** stdin の文字列を判定する。JSON として読めなければ止める */
export function decideRaw(raw: string, ctx: WorkspaceContext): Decision {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return unknownDeny('hook の入力（stdin の JSON）が読めない');
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return unknownDeny('hook の入力（stdin の JSON）が読めない');
  return decide(input as HookInput, ctx);
}

/** 実際の git・ファイルシステムを使う文脈。allowRoots の既定は OS の一時ディレクトリと ~/.claude */
export function realContext(opts: { allowRoots?: string[] } = {}): WorkspaceContext {
  return {
    allowRoots: opts.allowRoots ?? [tmpdir(), join(homedir(), '.claude')],
    locate: (dir: string): Located => {
      const r = spawnSync(
        'git',
        ['-C', existingDir(resolve(dir)), 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir', '--show-superproject-working-tree'],
        { encoding: 'utf8', timeout: 5000 },
      );
      if (r.status === 0 && typeof r.stdout === 'string') {
        // --show-superproject-working-tree は submodule でないと何も出さない（ふつうは3行、submodule では4行）
        const lines = r.stdout.trim().split(/\r?\n/);
        const [top, gitDir, common] = lines;
        if (lines.length > 4 || !top || !gitDir || !common) return { kind: 'error' };
        // submodule（4行）・linked worktree（git-dir ≠ git-common-dir）は git-common-dir の親。
        // そうでなければ linked worktree ではないので main の checkout（--separate-git-dir で git のディレクトリが離れていても）
        const o = opsFor(process.platform);
        const isMain = lines.length === 3 && samePath(o, canonical(o, gitDir), canonical(o, common));
        return { kind: 'repo', toplevel: top, mainRoot: isMain ? top : dirname(common) };
      }
      if (typeof r.stderr === 'string' && /not a git repository/i.test(r.stderr)) return { kind: 'none' };
      return { kind: 'error' };
    },
    hasMarker: (dir: string): boolean => existsSync(join(dir, MARKER)),
    pullSettings: (dir: string): PullSettings | null => {
      const cwd = existingDir(resolve(dir));
      const run = (...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
      /** 未設定（終了コード 1）は null。ほかの失敗は読めない */
      const get = (k: string): string | null => {
        const r = run('config', '--get', k);
        if (r.status === 0 && typeof r.stdout === 'string') return r.stdout.trim();
        if (r.status === 1) return null;
        throw new Error(`git config --get ${k}`);
      };
      try {
        const ff = get('pull.ff');
        const b = run('symbolic-ref', '-q', '--short', 'HEAD');
        let branch: string | null = null;
        if (b.status === 0 && typeof b.stdout === 'string') branch = b.stdout.trim() || null;
        else if (b.status !== 1) return null;
        const rebase = (branch !== null ? get(`branch.${branch}.rebase`) : null) ?? get('pull.rebase');
        return { ff, rebase };
      } catch {
        return null;
      }
    },
  };
}

export function hookOutput(d: Decision): string {
  if (!d.deny) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
}

/** hook の本体。直接起動したとき（import.meta.main）と、入口（run.mjs）から呼ばれたときに動く */
export async function main(): Promise<void> {
  let raw = '';
  let out = '';
  try {
    for await (const chunk of process.stdin) raw += String(chunk);
    out = hookOutput(decideRaw(raw, realContext()));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    out = hookOutput(unknownDeny(`hook の途中で失敗した（${message}）`));
  }
  if (out) process.stdout.write(`${out}\n`);
}

if (import.meta.main) await main();
