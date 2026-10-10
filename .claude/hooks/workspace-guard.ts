/**
 * 書き換えの場所の見張りの PreToolUse hook（.claude/settings.json で Edit・Write・NotebookEdit・Bash に登録）。Issue #286。
 *
 * main の checkout と fleet のワークスペース（印のファイル `.agent-harness-workspace` を一番上に置いた作業ツリー）の中の書き換えを止め、
 * 書き換えを Issue の worktree の中だけにする（規則「作業は常に worktree で行う」を仕組みで守らせる。人の決定は #281 のコメント 5892608637）。
 * 止めるのは Edit・Write・NotebookEdit の書き先と、作業ツリー・索引を変える git（commit・add・reset など、
 * `--ff-only` も `pull.ff=only` の設定も無い pull、rebase を伴う pull（`--ff-only` があっても））だけ。
 * `git pull --ff-only`・`pull.ff=only` の設定で fast-forward だけになる素の pull（同じコマンドの中で git の設定の読み先・設定を
 * 変えていないとき。前置きの代入・`env X=`・`-c`・`--config-env` に加え、pull より前の文の `export HOME=…` などの代入・`source`・
 * `git config` の書き込みがあれば、場所で判定する。Issue #331）・`fetch`・`status`・`worktree add/remove/prune` などは通す。
 * OS の一時ディレクトリと `~/.claude` の中は常に通す。
 *
 * 場所の判定の順：通す置き場所 → 書き先の作業ツリーの一番上（`git rev-parse --show-toplevel --git-dir --git-common-dir`）→
 * 書き先から作業ツリーの一番上までの祖先の印 → 作業ツリーが main の checkout か（git-dir と git-common-dir が同じ作業ツリー。
 * `--separate-git-dir` で git のディレクトリが離れていても見分ける。linked worktree・submodule は「git-common-dir の親」と比べる）。
 * 作業ツリーの一番上で比べるので、main の checkout の中の `.claude/worktrees/` の worktree や `../<リポジトリ名>.worktrees/` は通る。
 * 判定できないとき（入力が読めない・パスが無い・git が失敗する・git の作業場所が静的に決まらない）は止める。
 * ただし、同じコマンドの中で必ず実行される形で文字のまま代入した変数（`W=/path; cd "$W" && git merge …`）を、引用符の中で使ったときは、その値で読む（Issue #539）。
 * 展開を含む値・条件付き・パイプ・サブシェル・ブロックの中の代入、引用符の無い使い方などは今までどおり止める。
 * 引用符の境目で名前が切れる使い方（`"$W"o`）と、関数の定義・trap・readonly・declare などの文の後も、変数を読まずに止める。
 *
 * 拾いきれない経路（抜け道。docs/security.md）：Bash のリダイレクト（`>`）・`sed -i`・`rm`・`cp` などの git 以外の書き換え、
 * スクリプトや別のプロセス（`node harness/scripts/agent.ts` など）の中で動く git、xargs・find -exec などで動かす git、印を消すこと、
 * ヒアストリング（`bash <<< 'git pull'`）の中の git、`export GIT_DIR=…`・`GIT_WORK_TREE` で後の文の作業場所を変える形、
 * スクリプト・別のプロセスの中で設定や環境を変えてから pull する形、外で定義した alias・関数で git を動かす形。
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

/** コマンドを順に読むときの状態 */
interface Where {
  /** 作業場所。undefined は静的に決まらない */
  dir: string | undefined;
  /** 同じコマンドの中で、git の設定の読み先・設定を変えたかもしれない（hook が読んだ pull の設定と実際が食い違いうる） */
  configChanged?: boolean;
  /** 同じコマンドの中で、必ず実行され同じシェルに残る形で文字のまま代入した変数（名前 → 値）。Map は作り直して使い、書き換えない */
  vars?: ReadonlyMap<string, string>;
  /** IFS を変えた。以後、変数は覚えない */
  varsOff?: boolean;
}

/**
 * 変数の値を、引用符の中の `$名前`・`${名前}` で読む。読めない（覚えていない・引用符が無い・ほかの展開が混ざる・値が分割や展開されうる）ときは undefined。
 * 名前の後は、空か `/` で始まるときだけ読む（`"$W"o` は名前が W で切れるので、字句の上の `$Wo` を Wo と読まない）
 */
function resolveVar(arg: Word, vars: ReadonlyMap<string, string> | undefined): string | undefined {
  if (vars === undefined || !arg.quoted) return undefined;
  const m = /^\$([A-Za-z_]\w*)/.exec(arg.text) ?? /^\$\{([A-Za-z_]\w*)\}/.exec(arg.text);
  if (m === null) return undefined;
  // 波かっこなしの名前は、字句が読んだ名前の終わりと合わないと読まない
  if (!m[0].startsWith('${') && arg.nameEnd !== m[0].length) return undefined;
  const rest = arg.text.slice(m[0].length);
  if (rest !== '' && !rest.startsWith('/')) return undefined;
  if (/[$`\\]/.test(rest)) return undefined;
  const value = vars.get(m[1]!);
  if (value === undefined || /[\s*?[]/.test(value)) return undefined;
  return value + rest;
}

/** git の設定の読み先に効く環境変数（HOME・XDG_CONFIG_HOME・GIT_CONFIG で始まるもの） */
const affectsConfig = (name: string): boolean => name === 'HOME' || name === 'XDG_CONFIG_HOME' || name.startsWith('GIT_CONFIG');

/** 語が設定の読み先の変数の名前そのもの（展開の無い `HOME`）か、その代入（`HOME=…`・`HOME+=…`。値は展開されてもよい） */
function wordAffectsConfig(w: Word): boolean {
  if (!w.dynamic && affectsConfig(w.text)) return true;
  const m = /^([A-Za-z_]\w*)\+?=/.exec(w.text);
  return m !== null && affectsConfig(m[1]!);
}

/** 変数名の位置の語が展開されると、どの変数に代入するか分からないコマンド */
const ASSIGNING = new Set(['export', 'declare', 'typeset', 'local', 'readonly', 'unset', 'read', 'mapfile', 'readarray', 'getopts', 'for']);
/** `-n`（nameref）で名前を別の名前で書き換えられるコマンド */
const NAMEREF = new Set(['declare', 'typeset', 'local']);

/** 文（頭の名前と引数）が、この後の git の設定の読み先・設定を変えうるか（安全側に倒す） */
function statementChangesConfig(name: string, args: Word[]): boolean {
  if (name === 'source' || name === '.') return true;
  // 変数名が展開される語（`export "$V"`・`export $X=1`）。`名前=` で始まる語は値だけが展開される（`export PATH=/x:$PATH`）。`for` は変数名の位置（最初の語）だけ
  const nameIsDynamic = (a: Word): boolean => a.dynamic && !/^[A-Za-z_]\w*\+?=/.test(a.text);
  if (ASSIGNING.has(name) && (name === 'for' ? args[0] !== undefined && nameIsDynamic(args[0]) : args.some(nameIsDynamic))) return true;
  if (NAMEREF.has(name) && args.some((a) => !a.dynamic && /^-[A-Za-z]*n[A-Za-z]*$/.test(a.text))) return true;
  if (name === 'printf') {
    const k = args.findIndex((a) => a.text === '-v');
    if (k >= 0 && (args[k + 1] === undefined || args[k + 1]!.dynamic)) return true;
  }
  if (name === 'git') return gitConfigWrites(args);
  return false;
}

/** git のサブコマンドの前に置く、次の語を値に取る大域オプション */
const GIT_OPTIONS_WITH_VALUE = ['-C', '-c', '--config-env', '--namespace', '--super-prefix', '--attr-source', '--exec-path', '--git-dir', '--work-tree'];
/** `git config` の読むだけの形 */
const GIT_CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l']);

/** `git config` の書き込みか（読むだけの形を除く。サブコマンドが展開されるなら書き込みとみなす） */
function gitConfigWrites(args: Word[]): boolean {
  let j = 0;
  while (j < args.length && args[j]!.text.startsWith('-') && !args[j]!.dynamic) j += GIT_OPTIONS_WITH_VALUE.includes(args[j]!.text) ? 2 : 1;
  const sub = args[j];
  if (sub === undefined) return false;
  if (sub.dynamic) return true;
  if (sub.text !== 'config') return false;
  const rest = args.slice(j + 1);
  if (rest.some((a) => !a.dynamic && GIT_CONFIG_READS.has(a.text))) return false;
  const first = rest.find((a) => !a.text.startsWith('-'));
  return !(first !== undefined && !first.dynamic && (first.text === 'get' || first.text === 'list'));
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);
const WRAPPERS = new Set(['command', 'nohup', 'time', 'exec', 'sudo', 'doas', 'nice', 'stdbuf', 'setsid', 'ionice']);
const baseName = (s: string): string => s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1).replace(/\.exe$/i, '');

/** 作業ツリー・索引を変える git のサブコマンド */
const WRITES = new Set(['commit', 'add', 'rm', 'mv', 'stash', 'reset', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'cherry-pick', 'apply', 'clean', 'revert', 'am', 'pull']);

function moveTo(where: Where, arg: Word | undefined, ctx: WorkspaceContext): Where {
  const o = ops(ctx);
  if (arg === undefined) return { ...where, dir: homedir() };
  const resolved = arg.dynamic ? resolveVar(arg, where.vars) : undefined;
  if ((arg.dynamic && resolved === undefined) || arg.text === '-') return { ...where, dir: undefined };
  const t = fromMsys(o, expandHome(o, resolved ?? arg.text));
  if (o.p.isAbsolute(t)) return { ...where, dir: o.p.resolve(t) };
  return { ...where, dir: where.dir !== undefined ? o.p.resolve(where.dir, t) : undefined };
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
  /** コマンド行・環境・同じコマンドの前の文で git の設定を変えている（hook が読んだ pull の設定と実際が食い違いうる） */
  let configOverride = where.configChanged === true;
  for (const a of assigns) {
    const name = a.slice(0, a.indexOf('=')).replace(/\+$/, '');
    if (name === 'GIT_DIR' || name === 'GIT_WORK_TREE') unknownWhy = `前置きの ${name}`;
    if (affectsConfig(name)) configOverride = true;
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
        else if (t === '-C' || t === '--chdir' || t.startsWith('-C') || t.startsWith('--chdir=')) here = { ...here, dir: undefined };
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
  const prefixAffects = assigns.some((a) => affectsConfig(a.slice(0, a.indexOf('=')).replace(/\+$/, '')));
  if (!head) {
    // 代入だけの文（`HOME=/x`）は同じシェルの変数を変え、後の文に効く
    if (prefixAffects) where.configChanged = true;
    return ALLOW;
  }
  // 頭から後の語（前置きの代入を除く）が設定の読み先の変数に触れるなら、後の文にも引き継ぐ（安全側）
  if (seg.words.slice(start).some(wordAffectsConfig)) where.configChanged = true;
  let args = seg.words.slice(start + 1);
  if (head.dynamic) {
    // コマンド名が展開しないと分からない：git の書き換えの手がかりがあれば止める
    if (args.some((a) => WRITES.has(a.text))) return unknownDeny(`コマンド名（${head.text}）が展開しないと分からない`);
    return ALLOW;
  }
  let name = baseName(head.text);
  if (name === 'builtin' && args[0] !== undefined && !args[0].dynamic) {
    name = args[0].text;
    args = args.slice(1);
  }
  // 中（bash -c・ヒアドキュメント・eval）へは、外の印と、この文の前置きの代入・語の規則の印を持ち込む
  const inner = (): Where => ({ ...here, configChanged: here.configChanged === true || where.configChanged === true || prefixAffects });
  if (name !== 'git' && statementChangesConfig(name, args)) where.configChanged = true;
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
    // 子のシェルの中で立った印は外に戻さない（子の環境は親に戻らない）
    // 変数も子に渡さない（export していない変数は子に届かない）
    if (cflag) return script ? analyze(script.text, { ...inner(), vars: undefined }, ctx, depth + 1) : ALLOW;
    for (const body of seg.heredocs) {
      const d = analyze(body, { ...inner(), vars: undefined }, ctx, depth + 1);
      if (d.deny) return d;
    }
    return ALLOW;
  }
  if (name === 'eval') {
    // eval は同じシェルで動くので、中で立った印を外の後の文に引き継ぐ
    // 前置きの代入の名前は、eval の中では前置きの値になるので、渡す変数からも外に戻す変数からも外す
    const prefixed = assigns.map((a) => a.slice(0, a.indexOf('=')).replace(/\+$/, ''));
    const w = inner();
    w.vars = dropVars(where.vars, prefixed);
    const d = analyze(args.map((a) => a.text).join(' '), w, ctx, depth + 1);
    if (w.configChanged) where.configChanged = true;
    where.vars = dropVars(w.vars, prefixed);
    if (w.varsOff) where.varsOff = true;
    return d;
  }
  if (name === 'git') {
    const d = checkGit(args, { ...here, configChanged: here.configChanged === true || where.configChanged === true }, assigns, ctx);
    // git config の書き込みは、判定した後に印を立てる（git config 自身の判定は変えない）
    if (gitConfigWrites(args)) where.configChanged = true;
    return d;
  }
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
  /** 区切りの `(` と `)` の深さ、`if`・`while`・`{` などで開いたブロックの深さ。負になったら（`case` のパターンの `a)` など）以後は覚えない */
  let parenDepth = 0;
  let blockDepth = 0;
  let broken = false;
  for (let idx = 0; idx < segs.length; idx++) {
    const seg = segs[idx]!;
    for (const c of seg.before) {
      if (c === '(') parenDepth++;
      else if (c === ')' && --parenDepth < 0) broken = true;
    }
    // 関数の定義（`f() { … }`）の後は、呼ぶたびに値が変わりうるので変数を覚えない
    if (seg.before.includes('()')) {
      where.varsOff = true;
      where.vars = undefined;
    }
    const lead = leadingWords(seg.words);
    blockDepth += lead.delta;
    if (blockDepth < 0) broken = true;
    const next = segs[idx + 1]?.before ?? '';
    // 必ず実行され（&&・|| の後でない）、同じシェルに残る（パイプ・背景・括弧・ブロックの中でない）
    const certain =
      !broken &&
      where.varsOff !== true &&
      /^[;\n]*$/.test(seg.before) &&
      parenDepth === 0 &&
      blockDepth === 0 &&
      !/^\|(?!\|)/.test(next) &&
      !/^&(?!&)/.test(next) &&
      !next.startsWith('(');
    for (const s of seg.subs) {
      const d = analyze(s, { ...where }, ctx, depth + 1);
      if (d.deny) return d;
    }
    const { start, assigns } = commandStart(seg.words, where);
    if (assigns.some((a) => a.startsWith('IFS=') || a.startsWith('IFS+=')) || lead.assignWords.some((w) => /^IFS\+?=/.test(w.text))) {
      where.varsOff = true;
      where.vars = undefined;
    }
    if (lead.assignOnly) {
      for (const w of lead.assignWords) {
        const m = /^([A-Za-z_]\w*)(\+?)=([\s\S]*)$/.exec(w.text)!;
        const value = m[3]!;
        const ok = certain && !w.dynamic && m[2] === '' && value !== '' && !value.includes('~') && where.varsOff !== true;
        setVar(where, m[1]!, ok ? value : undefined);
      }
    }
    const head = seg.words[start];
    let name = head === undefined ? '' : baseName(head.text);
    let rest = seg.words.slice(start + 1);
    if (name === 'builtin' && rest[0] !== undefined) {
      name = baseName(rest[0].text);
      rest = rest.slice(1);
    }
    if (head !== undefined && (head.dynamic || ASSIGNING.has(name) || name === 'let' || name === 'source' || name === '.' || (name === 'printf' && rest.some((a) => a.text === '-v')))) {
      where.vars = undefined;
    }
    // 値が変わる・代入が効かない形を作る文（関数・trap・readonly・declare -n など）の後は、変数を覚えない
    if (head !== undefined && UNTRACKABLE.has(name)) {
      where.varsOff = true;
      where.vars = undefined;
    }
    const d = checkSegment(seg, where, ctx, depth);
    if (d.deny) return d;
    // eval の中の代入は、eval 自身が必ず実行され同じシェルに残るときだけ外に残す
    if (name === 'eval' && (!certain || rest.some((a) => a.dynamic))) where.vars = undefined;
  }
  return ALLOW;
}

/** 後の代入の値を信用できなくする文の頭（関数の定義・DEBUG などの trap・読み取り専用・nameref） */
const UNTRACKABLE = new Set(['function', 'trap', 'readonly', 'declare', 'typeset', 'local']);
const BLOCK_OPEN =new Set(['if', 'while', 'until', 'for', 'case', 'select', '{']);
const BLOCK_CLOSE = new Set(['fi', 'done', 'esac', '}']);
const LEADING_KEYWORDS = new Set([...KEYWORDS, 'for', 'case', 'select', 'esac']);

/** 文の頭の、キーワード（ブロックの開き・閉じ）と代入の語。assignOnly は、キーワードと代入だけの文 */
function leadingWords(words: Word[]): { delta: number; assignWords: Word[]; assignOnly: boolean } {
  let delta = 0;
  const assignWords: Word[] = [];
  let stopped = false;
  for (const w of words) {
    if (!w.quoted && !w.dynamic && LEADING_KEYWORDS.has(w.text)) {
      if (BLOCK_OPEN.has(w.text)) delta++;
      if (BLOCK_CLOSE.has(w.text)) delta--;
      if (w.text === 'for' || w.text === 'case' || w.text === 'select') {
        stopped = true;
        break;
      }
      continue;
    }
    if (/^[A-Za-z_]\w*\+?=/.test(w.text)) {
      assignWords.push(w);
      continue;
    }
    stopped = true;
    break;
  }
  return { delta, assignWords, assignOnly: !stopped && assignWords.length > 0 };
}

/** 変数を足す・消す（Map は作り直す。value が undefined なら消す） */
function setVar(where: Where, name: string, value: string | undefined): void {
  const m = new Map(where.vars ?? []);
  if (value === undefined) m.delete(name);
  else m.set(name, value);
  where.vars = m;
}

function dropVars(vars: ReadonlyMap<string, string> | undefined, names: string[]): ReadonlyMap<string, string> | undefined {
  if (vars === undefined) return undefined;
  const m = new Map(vars);
  for (const n of names) m.delete(n);
  return m;
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
