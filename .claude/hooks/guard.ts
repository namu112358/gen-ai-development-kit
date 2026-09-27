/**
 * 付き添いのセッションの PreToolUse hook（.claude/settings.json で Bash と mcp__.* に登録）。
 *
 * permissions.deny の文字列の一致では防げない操作を、操作の意味を見て止める：
 * main への push（別名の refspec を含む）、force push、Merge、保護ラベルの付け外し（CLAUDE.md の「やってはいけないこと」）。
 * Bash のコマンドは字句に分けて展開し（`&&`・`;`・`|`・`bash -c`・`eval`・`$(...)` など）、MCP は GitHub のツールの入力を見る。
 *
 * 入出力（https://code.claude.com/docs/en/hooks.md）：stdin の JSON（tool_name・tool_input・cwd）を読み、
 * 止めるときは hookSpecificOutput.permissionDecision = "deny" と理由を stdout に出して exit 0。
 * 通すときは何も出さずに exit 0（通常の許可の流れ。permissions.deny もそのまま効く）。
 * stdin・設定・今のブランチが読めないときは、push・merge・保護ラベルの名前を含むものだけ止める。
 *
 * 拾いきれない経路（スクリプトファイルの中身、別名、xargs など）はあるので、最後の砦は GitHub の Ruleset。
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
  [k: string]: unknown;
}

export interface GuardContext {
  defaultBranch: string;
  /** 大文字・小文字を区別せずに比べる。`:exempt` で終わるラベルは常に保護ラベル */
  protectedLabels: string[];
  /** セッションの cwd の今のブランチ（null は分からない） */
  currentBranch: string | null;
  /** `cd <dir>`・`git -C <dir>` の後のブランチ（無い・null は分からない） */
  branchAt?: (dir: string) => string | null;
}

export type Decision = { deny: false } | { deny: true; reason: string };

/** 設定が読めないときに使う保護ラベル */
const FALLBACK_LABELS = ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'];
const MAX_DEPTH = 8;
const ALLOW: Decision = { deny: false };

const ROLE = 'これは人か App の役割です（CLAUDE.md の「やってはいけないこと」）。別の方法で試さず、人に返してください。';
const role = (what: string): string => `hook が止めました：${what}。${ROLE}`;
const unknown = (what: string): string =>
  `hook が止めました：${what}が展開しないと分かりません。値をそのまま書けば判定できます（main への push・Merge・保護ラベルの操作は CLAUDE.md の「やってはいけないこと」なので、その場合は人に返してください）。`;
const fallbackReason = (why: string): string =>
  `hook が止めました：${why}ため、push・merge・保護ラベルの名前を含む操作は止めています（CLAUDE.md の「やってはいけないこと」を守るため）。人に返してください。`;

// ---------------------------------------------------------------- 字句

class ParseError extends Error {}

interface Word {
  text: string;
  /** 変数・コマンド置換など、展開しないと値が分からない部分を含む */
  dynamic: boolean;
  quoted: boolean;
}

interface Segment {
  words: Word[];
  /** `$(...)`・バッククォートなどの中身（再帰して調べる） */
  subs: string[];
  /** ヒアドキュメントの本文 */
  heredocs: string[];
}

interface PendingHeredoc {
  delim: string;
  strip: boolean;
}

/** ヒアドキュメントの区切りの語を読む（引用符を外す）。戻り値は [区切り, 引用されていたか, 次の位置] */
function readDelimiter(src: string, k: number): [string, boolean, number] {
  while (src[k] === ' ' || src[k] === '\t') k++;
  let delim = '';
  let quoted = false;
  while (k < src.length && !/[\s;|&()<>]/.test(src[k]!)) {
    const c = src[k]!;
    if (c === "'" || c === '"') {
      const e = src.indexOf(c, k + 1);
      if (e < 0) throw new ParseError('閉じていない引用符');
      delim += src.slice(k + 1, e);
      quoted = true;
      k = e + 1;
    } else if (c === '\\') {
      delim += src[k + 1] ?? '';
      quoted = true;
      k += 2;
    } else {
      delim += c;
      k++;
    }
  }
  return [delim, quoted, k];
}

/** ヒアドキュメントの本文を読み飛ばす。戻り値は [本文, 次の位置] */
function readHeredocBody(src: string, k: number, h: PendingHeredoc): [string, number] {
  const lines: string[] = [];
  while (k < src.length) {
    const end = src.indexOf('\n', k);
    const line = src.slice(k, end < 0 ? src.length : end);
    k = end < 0 ? src.length : end + 1;
    if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
    lines.push(line);
  }
  return [lines.join('\n'), k];
}

function skipBacktick(src: string, k: number): number {
  while (k < src.length) {
    if (src[k] === '\\') k += 2;
    else if (src[k] === '`') return k;
    else k++;
  }
  throw new ParseError('閉じていないバッククォート');
}

function skipDouble(src: string, k: number): number {
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') k += 2;
    else if (c === '"') return k + 1;
    else if (c === '$' && src[k + 1] === '(') k = matchParen(src, k + 2) + 1;
    else if (c === '`') k = skipBacktick(src, k + 1) + 1;
    else k++;
  }
  throw new ParseError('閉じていない引用符');
}

/** `$(` の後ろから、対応する `)` の位置を返す（引用符・ヒアドキュメントを考える） */
function matchParen(src: string, k: number): number {
  let depth = 1;
  let pending: PendingHeredoc[] = [];
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') {
      k += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", k + 1);
      if (e < 0) throw new ParseError('閉じていない引用符');
      k = e + 1;
    } else if (c === '"') {
      k = skipDouble(src, k + 1);
    } else if (c === '`') {
      k = skipBacktick(src, k + 1) + 1;
    } else if (c === '#' && (k === 0 || /\s/.test(src[k - 1]!))) {
      while (k < src.length && src[k] !== '\n') k++;
    } else if (src.startsWith('<<<', k)) {
      k += 3;
    } else if (src.startsWith('<<', k)) {
      k += 2;
      const strip = src[k] === '-';
      if (strip) k++;
      const [delim, , next] = readDelimiter(src, k);
      pending.push({ delim, strip });
      k = next;
    } else if (c === '\n' && pending.length > 0) {
      k++;
      for (const h of pending) k = readHeredocBody(src, k, h)[1];
      pending = [];
    } else {
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) return k;
      k++;
    }
  }
  throw new ParseError('閉じていない $(');
}

function matchBrace(src: string, k: number): number {
  let depth = 1;
  while (k < src.length) {
    const c = src[k]!;
    if (c === '\\') k += 2;
    else if (c === "'") {
      const e = src.indexOf("'", k + 1);
      if (e < 0) throw new ParseError('閉じていない引用符');
      k = e + 1;
    } else if (c === '"') k = skipDouble(src, k + 1);
    else {
      if (c === '{') depth++;
      if (c === '}' && --depth === 0) return k;
      k++;
    }
  }
  throw new ParseError('閉じていない ${');
}

/** 展開されるヒアドキュメントの本文から、コマンド置換の中身を拾う */
function findSubs(body: string): string[] {
  const subs: string[] = [];
  let k = 0;
  while (k < body.length) {
    if (body[k] === '\\') k += 2;
    else if (body.startsWith('$(', k)) {
      const e = matchParen(body, k + 2);
      subs.push(body.slice(k + 2, e));
      k = e + 1;
    } else if (body[k] === '`') {
      const e = skipBacktick(body, k + 1);
      subs.push(body.slice(k + 1, e).replace(/\\`/g, '`'));
      k = e + 1;
    } else k++;
  }
  return subs;
}

/** シェルのコマンド列を、区切り（&&・||・;・|・&・改行・括弧）ごとの語の並びに分ける */
export function parseScript(src: string): Segment[] {
  const segs: Segment[] = [];
  const n = src.length;
  let cur: Segment = { words: [], subs: [], heredocs: [] };
  let word: Word | null = null;
  let skipNextWord = false;
  let pendingDelim: { strip: boolean } | null = null;
  let heredocs: { h: PendingHeredoc; expand: boolean; seg: Segment }[] = [];

  const w = (): Word => (word ??= { text: '', dynamic: false, quoted: false });
  const endWord = (): void => {
    if (!word) return;
    if (pendingDelim) {
      heredocs.push({ h: { delim: word.text, strip: pendingDelim.strip }, expand: !word.quoted, seg: cur });
      pendingDelim = null;
    } else if (skipNextWord) skipNextWord = false;
    else cur.words.push(word);
    word = null;
  };
  const endSeg = (): void => {
    endWord();
    skipNextWord = false;
    pendingDelim = null;
    if (cur.words.length > 0 || cur.subs.length > 0) segs.push(cur);
    cur = { words: [], subs: [], heredocs: [] };
  };

  /** `$` から始まる展開を読む。展開でなければ k をそのまま返す */
  const readDollar = (k: number, x: Word): number => {
    const next = src[k + 1];
    if (next === '(') {
      const e = matchParen(src, k + 2);
      cur.subs.push(src.slice(k + 2, e));
      x.text += src.slice(k, e + 1);
      x.dynamic = true;
      return e + 1;
    }
    if (next === '{') {
      const e = matchBrace(src, k + 2);
      cur.subs.push(src.slice(k + 2, e));
      x.text += src.slice(k, e + 1);
      x.dynamic = true;
      return e + 1;
    }
    const m = src.slice(k + 1).match(/^(?:[A-Za-z_]\w*|[0-9@*#?$!-])/);
    if (m) {
      x.text += `$${m[0]}`;
      x.dynamic = true;
      return k + 1 + m[0].length;
    }
    return k;
  };

  const readBacktick = (k: number, x: Word): number => {
    const e = skipBacktick(src, k + 1);
    cur.subs.push(src.slice(k + 1, e).replace(/\\`/g, '`'));
    x.text += src.slice(k, e + 1);
    x.dynamic = true;
    return e + 1;
  };

  const readDouble = (k: number, x: Word): number => {
    x.quoted = true;
    while (k < n) {
      const c = src[k]!;
      if (c === '"') return k + 1;
      if (c === '\\') {
        const d = src[k + 1] ?? '';
        if (d === '\n') k += 2;
        else if ('$`"\\'.includes(d)) {
          x.text += d;
          k += 2;
        } else {
          x.text += '\\';
          k++;
        }
      } else if (c === '$') {
        const e = readDollar(k, x);
        if (e === k) {
          x.text += '$';
          k++;
        } else k = e;
      } else if (c === '`') k = readBacktick(k, x);
      else {
        x.text += c;
        k++;
      }
    }
    throw new ParseError('閉じていない引用符');
  };

  const readHeredocs = (k: number): number => {
    for (const { h, expand, seg } of heredocs) {
      const [body, next] = readHeredocBody(src, k, h);
      seg.heredocs.push(body);
      if (expand) seg.subs.push(...findSubs(body));
      k = next;
    }
    heredocs = [];
    return k;
  };

  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      const x = w();
      x.text += src[i + 1] ?? '';
      x.quoted = true;
      i += 2;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === '\n') {
      endSeg();
      i = readHeredocs(i + 1);
    } else if (c === '#' && !word) {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === ';' || c === '|' || c === '(' || c === ')') {
      endSeg();
      i++;
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        endWord();
        i += src[i + 2] === '>' ? 3 : 2;
        skipNextWord = true;
      } else {
        endSeg();
        i++;
      }
    } else if (c === '<' || c === '>') {
      // 2>&1 などの先頭の番号は語にしない
      const fd = word as Word | null;
      if (fd && !fd.quoted && !fd.dynamic && /^\d+$/.test(fd.text)) word = null;
      else endWord();
      if (src.startsWith('<<<', i)) {
        i += 3;
        skipNextWord = true;
      } else if (src.startsWith('<<', i)) {
        i += 2;
        const strip = src[i] === '-';
        if (strip) i++;
        pendingDelim = { strip };
      } else {
        i++;
        if ('>&|'.includes(src[i] ?? '_')) i++;
        skipNextWord = true;
      }
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      if (e < 0) throw new ParseError('閉じていない引用符');
      const x = w();
      x.text += src.slice(i + 1, e);
      x.quoted = true;
      i = e + 1;
    } else if (c === '$' && src[i + 1] === "'") {
      // $'...'：エスケープがあれば中身は分からないものとして扱う
      let k = i + 2;
      const x = w();
      x.quoted = true;
      while (k < n && src[k] !== "'") {
        if (src[k] === '\\') {
          x.dynamic = true;
          x.text += src.slice(k, k + 2);
          k += 2;
        } else x.text += src[k++];
      }
      if (k >= n) throw new ParseError('閉じていない引用符');
      i = k + 1;
    } else if (c === '"') {
      i = readDouble(i + 1, w());
    } else if (c === '`') {
      i = readBacktick(i, w());
    } else if (c === '$') {
      const x = w();
      const e = readDollar(i, x);
      if (e === i) {
        x.text += '$';
        i++;
      } else i = e;
    } else {
      w().text += c;
      i++;
    }
  }
  endSeg();
  return segs;
}

// ---------------------------------------------------------------- 判定

interface Where {
  dir: string | undefined;
  branch: string | null;
}

const same = (a: string | null | undefined, b: string): boolean => a != null && a.toLowerCase() === b.toLowerCase();

function isProtectedLabel(label: string, labels: string[]): boolean {
  const l = label.trim().toLowerCase();
  if (l === '') return false;
  return l.endsWith(':exempt') || labels.some((p) => p.toLowerCase() === l);
}

/** 設定や字句の解析に頼れないときの判定：push・merge・保護ラベルの名前を含むか */
function keywordHit(text: string, labels: string[]): boolean {
  const t = text.toLowerCase();
  return /push|merge|:exempt/.test(t) || labels.some((l) => t.includes(l.toLowerCase()));
}

function moveTo(where: Where, arg: Word | undefined, ctx: GuardContext): Where {
  if (!arg || arg.dynamic || arg.text === '-' || arg.text.startsWith('~')) return { dir: undefined, branch: null };
  const dir = isAbsolute(arg.text) ? resolve(arg.text) : where.dir !== undefined ? resolve(where.dir, arg.text) : undefined;
  return { dir, branch: dir !== undefined && ctx.branchAt ? ctx.branchAt(dir) : null };
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until']);
const basename = (s: string): string => s.slice(s.lastIndexOf('/') + 1);

/** 前置きの環境変数と env・command・nohup・time・exec を外した位置を返す。env -S の文字列は subScripts に足す */
function commandStart(words: Word[], subScripts: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (!w.dynamic && /^[A-Za-z_]\w*\+?=/.test(w.text)) {
      i++;
      continue;
    }
    if (!w.quoted && KEYWORDS.has(w.text)) {
      i++;
      continue;
    }
    const name = basename(w.text);
    if (name === 'env') {
      i++;
      while (i < words.length && (words[i]!.text.startsWith('-') || /^[A-Za-z_]\w*=/.test(words[i]!.text))) {
        const t = words[i]!.text;
        if (t === '-S' || t === '--split-string') {
          subScripts.push(words[i + 1]?.text ?? '');
          i += 2;
        } else if (t.startsWith('-S') || t.startsWith('--split-string=')) {
          subScripts.push(t.replace(/^(-S|--split-string=)/, ''));
          i++;
        } else if (['-u', '--unset', '-C', '--chdir'].includes(t)) i += 2;
        else i++;
      }
      continue;
    }
    if (name === 'command' || name === 'nohup' || name === 'time' || name === 'exec') {
      i++;
      while (i < words.length && words[i]!.text.startsWith('-')) {
        const t = words[i]!.text;
        i += (name === 'exec' && t === '-a') || (name === 'time' && ['-f', '-o', '--format', '--output'].includes(t)) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  return i;
}

function checkPush(args: Word[], branch: string | null, ctx: GuardContext): string | null {
  const main = ctx.defaultBranch;
  const positional: Word[] = [];
  let endOpts = false;
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    const t = w.text;
    if (!endOpts && !w.dynamic && t === '--') {
      endOpts = true;
    } else if (!endOpts && t.startsWith('--')) {
      const name = t.split('=')[0]!;
      if (['--force', '--force-with-lease', '--force-if-includes'].includes(name)) return role(`force push（git push ${t}）`);
      if (['--mirror', '--all', '--branches'].includes(name)) return role(`すべてのブランチの push（git push ${t}）は ${main} も書き換える`);
      if (['--repo', '--receive-pack', '--exec', '--push-option'].includes(name) && !t.includes('=')) k++;
    } else if (!endOpts && t.startsWith('-') && t.length > 1) {
      const cluster = t.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        if (cluster[j] === 'f') return role(`force push（git push ${t}）`);
        if (cluster[j] === 'o') {
          if (j === cluster.length - 1) k++;
          break;
        }
      }
    } else {
      positional.push(w);
    }
  }
  const refspecs = positional.slice(1);
  for (const r of refspecs) {
    if (r.dynamic) return unknown(`git push の送り先（${r.text}）`);
    const t = r.text;
    if (t.startsWith('+')) return role(`force push（git push の refspec ${t}）`);
    const colon = t.indexOf(':');
    let dst: string | null = colon >= 0 ? t.slice(colon + 1) : t;
    if (colon < 0 && (t === 'HEAD' || t === '@')) {
      if (branch === null) return unknown(`git push ${t} の送り先（今のブランチ）`);
      dst = branch;
    }
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst.includes('*')) return role(`パターンの refspec（${t}）の push は ${main} も書き換えうる`);
    if (same(dst, main)) return role(`${main} への push（git push … ${t}）`);
  }
  if (refspecs.length === 0) {
    if (branch === null) return unknown('refspec の無い git push の送り先（今のブランチ）');
    if (same(branch, main)) return role(`${main} にいるときの refspec の無い git push`);
  }
  return null;
}

function checkGit(args: Word[], where: Where, ctx: GuardContext): string | null {
  let here: Where = where;
  let j = 0;
  while (j < args.length && args[j]!.text.startsWith('-')) {
    const t = args[j]!.text;
    if (t === '-C') {
      here = moveTo(here, args[j + 1], ctx);
      j += 2;
    } else if (t === '-c') {
      const kv = args[j + 1];
      if (kv && (kv.dynamic || /^alias\./i.test(kv.text))) return unknown(`git -c ${kv.text} の中身`);
      j += 2;
    } else if (['--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'].includes(t)) {
      if (t === '--git-dir' || t === '--work-tree') here = { dir: undefined, branch: null };
      j += 2;
    } else {
      if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) here = { dir: undefined, branch: null };
      j++;
    }
  }
  const sub = args[j];
  if (!sub) return null;
  if (sub.dynamic) return unknown(`git のサブコマンド（${sub.text}）`);
  if (sub.text !== 'push') return null;
  return checkPush(args.slice(j + 1), here.branch, ctx);
}

/** `--flag v`・`--flag=v`・`-l v`・`-lv` の値を集める */
function flagValues(args: Word[], longs: string[], shorts: string[]): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    const t = w.text;
    const long = longs.find((f) => t === f || t.startsWith(`${f}=`));
    if (long) {
      if (t === long) {
        const v = args[k + 1];
        if (v) out.push(v);
        k++;
      } else out.push({ ...w, text: t.slice(long.length + 1) });
      continue;
    }
    const short = t.startsWith('--') ? undefined : shorts.find((f) => t.startsWith(f));
    if (short) {
      if (t === short) {
        const v = args[k + 1];
        if (v) out.push(v);
        k++;
      } else out.push({ ...w, text: t.slice(short.length).replace(/^=/, '') });
    }
  }
  return out;
}

function checkLabelWords(values: Word[], labels: string[], what: string): string | null {
  for (const v of values) {
    if (v.dynamic) return unknown(`${what}のラベル（${v.text}）`);
    const hit = v.text.split(',').find((l) => isProtectedLabel(l, labels));
    if (hit !== undefined) return role(`保護ラベル ${hit.trim()} の付け外し（${what}）`);
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function checkGhApi(args: Word[], ctx: GuardContext): string | null {
  const main = ctx.defaultBranch;
  let method: string | undefined;
  let hasBody = false;
  let fromFile = false;
  let endpoint: Word | undefined;
  const fields = new Map<string, Word>();
  const addField = (w: Word, kv: string): void => {
    const eq = kv.indexOf('=');
    if (eq > 0) fields.set(kv.slice(0, eq).toLowerCase(), { ...w, text: kv.slice(eq + 1) });
    hasBody = true;
  };
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    const t = w.text;
    if (t === '-X' || t === '--method') {
      method = args[++k]?.text;
    } else if (t.startsWith('--method=')) {
      method = t.slice('--method='.length);
    } else if (t.startsWith('-X')) {
      method = t.slice(2);
    } else if (['-f', '-F', '--field', '--raw-field'].includes(t)) {
      const v = args[++k];
      if (v) addField(v, v.text);
    } else if (/^--(raw-)?field=/.test(t)) {
      addField(w, t.slice(t.indexOf('=') + 1));
    } else if (/^-[fF]./.test(t)) {
      addField(w, t.slice(2));
    } else if (t === '--input' || t.startsWith('--input=')) {
      hasBody = true;
      fromFile = true;
      if (t === '--input') k++;
    } else if (['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview'].includes(t)) {
      k++;
    } else if (!t.startsWith('-')) {
      endpoint ??= w;
    }
  }
  const m = (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  const texts = args.map((a) => safeDecode(a.text));
  const all = texts.join('\n');

  for (const t of texts) {
    const lower = t.toLowerCase();
    const hit = ctx.protectedLabels.find((l) => lower.includes(l.toLowerCase())) ?? lower.match(/[\w.-]+:exempt\b/)?.[0];
    if (hit) return role(`保護ラベル ${hit} を含む gh api`);
  }
  if (/(^|\/)pulls\/[^/\s]+\/merge(?![\w-])/i.test(all)) return role('PR の Merge（gh api …/pulls/<番号>/merge）');
  const mutation = all.match(/\b(mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/i);
  if (mutation) return role(`GraphQL の ${mutation[1]}`);
  const mainToken = new RegExp(`(^|[^\\w./-])(refs/heads/)?${main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./-])`, 'i');
  const refMutation = all.match(/\b(createCommitOnBranch|updateRefs?|deleteRef)\b/i);
  if (refMutation && (mainToken.test(all) || fromFile || args.some((a) => a.dynamic))) return role(`GraphQL の ${refMutation[1]} で ${main} を書き換える`);
  if (m === 'GET') return null;

  if (endpoint?.dynamic) return unknown(`gh api -X ${m} の送り先（${endpoint.text}）`);
  const headsMain = new RegExp(`heads/${main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./-])`, 'i');
  if (texts.some((t) => headsMain.test(t))) return role(`gh api -X ${m} で ${main} の ref を書き換える`);
  const ep = endpoint ? safeDecode(endpoint.text) : '';
  if (/\/(merges|merge-upstream)(?![\w-])/i.test(ep)) return role(`gh api -X ${m} ${ep}（ブランチへの Merge）`);
  if (/\/contents(\/|$|\?)/i.test(ep) && (m === 'PUT' || m === 'DELETE')) {
    const branch = fields.get('branch');
    if (fromFile || !branch || branch.dynamic || same(branch.text, main)) return role(`contents API（gh api -X ${m} ${ep}）で ${main} に書き込む`);
  }
  return null;
}

function checkGh(args: Word[], ctx: GuardContext): string | null {
  const group = args[0];
  const sub = args[1];
  if (!group) return null;
  if (group.dynamic || sub?.dynamic) return unknown(`gh のサブコマンド（${group.text} ${sub?.text ?? ''}）`);
  const g = group.text;
  const s = sub?.text;
  if (g === 'pr' && s === 'merge') return role('PR の Merge（gh pr merge）');
  if (g === 'pr' && s === 'ready' && !args.some((a) => a.text === '--undo')) return role('Draft の解除（gh pr ready）');
  if ((g === 'issue' || g === 'pr') && (s === 'edit' || s === 'create')) {
    const values = flagValues(args.slice(2), ['--add-label', '--remove-label', '--label'], ['-l']);
    return checkLabelWords(values, ctx.protectedLabels, `gh ${g} ${s}`);
  }
  if (g === 'label' && (s === 'create' || s === 'edit' || s === 'delete')) {
    const values = args.slice(2).map((a) => (a.text.includes('=') ? { ...a, text: a.text.slice(a.text.indexOf('=') + 1) } : a));
    return checkLabelWords(values.filter((a) => a.dynamic || !a.text.startsWith('-')), ctx.protectedLabels, `gh label ${s}`);
  }
  if (g === 'api') return checkGhApi(args.slice(1), ctx);
  return null;
}

function checkSegment(seg: Segment, where: Where, ctx: GuardContext, depth: number, script: string): string | null {
  const nested: string[] = [];
  const start = commandStart(seg.words, nested);
  for (const s of nested) {
    const r = analyze(s, { ...where }, ctx, depth + 1);
    if (r) return r;
  }
  const head = seg.words[start];
  if (!head) return null;
  const args = seg.words.slice(start + 1);
  if (head.dynamic) {
    // コマンド名が展開しないと分からない：中身の手がかりがあれば止める
    if (args.some((a) => ['push', 'merge'].includes(a.text) || a.text.split(',').some((l) => isProtectedLabel(l, ctx.protectedLabels)))) {
      return unknown(`コマンド名（${head.text}）`);
    }
    return null;
  }
  const name = basename(head.text);
  if (name === 'cd' || name === 'pushd') {
    Object.assign(where, moveTo(where, args.find((a) => !/^-[LPe@]+$/.test(a.text)), ctx));
    return null;
  }
  if (SHELLS.has(name)) {
    let cflag = false;
    let script2: Word | undefined;
    for (let k = 0; k < args.length; k++) {
      const t = args[k]!.text;
      if (t === '--') continue;
      if (/^[-+]o$|^-O$|^\+O$/.test(t)) {
        k++;
        continue;
      }
      if (/^[-+][a-zA-Z]+$/.test(t)) {
        if (t.startsWith('-') && t.includes('c')) cflag = true;
        continue;
      }
      if (t.startsWith('--')) continue;
      script2 = args[k];
      break;
    }
    if (cflag) return script2 ? analyze(script2.text, { ...where }, ctx, depth + 1) : null;
    if (script2) return null; // スクリプトファイルは読まない
    if (seg.heredocs.length > 0) {
      for (const body of seg.heredocs) {
        const r = analyze(body, { ...where }, ctx, depth + 1);
        if (r) return r;
      }
      return null;
    }
    // 標準入力からコマンドを読むシェル：前のコマンドの出力は分からないので、言葉の手がかりで判定する
    return keywordHit(script, ctx.protectedLabels) ? fallbackReason('標準入力から読むシェルの中身が分からない') : null;
  }
  if (name === 'eval') return analyze(args.map((a) => a.text).join(' '), { ...where }, ctx, depth + 1);
  if (name === 'git') return checkGit(args, where, ctx);
  if (name === 'gh') return checkGh(args, ctx);
  return null;
}

function analyze(script: string, where: Where, ctx: GuardContext, depth: number): string | null {
  if (depth > MAX_DEPTH) return keywordHit(script, ctx.protectedLabels) ? fallbackReason('入れ子が深すぎて中身を調べきれない') : null;
  let segs: Segment[];
  try {
    segs = parseScript(script);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return keywordHit(script, ctx.protectedLabels) ? fallbackReason(`コマンドを字句に分けられない（${e.message}）`) : null;
  }
  for (const seg of segs) {
    for (const s of seg.subs) {
      const r = analyze(s, { ...where }, ctx, depth + 1);
      if (r) return r;
    }
    const r = checkSegment(seg, where, ctx, depth, script);
    if (r) return r;
  }
  return null;
}

/** tool_input の中の、キー名に label を含む値（配列・入れ子も）の文字列を集める */
function labelStrings(v: unknown, underLabel: boolean, out: string[]): string[] {
  if (typeof v === 'string') {
    if (underLabel) out.push(...v.split(','));
  } else if (Array.isArray(v)) {
    for (const x of v) labelStrings(x, underLabel, out);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) labelStrings(x, underLabel || k.toLowerCase().includes('label'), out);
  }
  return out;
}

function checkMcp(toolName: string, toolInput: unknown, ctx: GuardContext): string | null {
  const name = toolName.toLowerCase();
  if (!name.includes('github')) return null;
  if (name.includes('merge')) return role(`Merge にかかわる MCP ツール（${toolName}）`);
  const hit = labelStrings(toolInput, false, []).find((l) => isProtectedLabel(l, ctx.protectedLabels));
  if (hit !== undefined) return role(`保護ラベル ${hit.trim()} の付け外し（${toolName}）`);
  if (/push_files|create_or_update_file|delete_file/.test(name)) {
    const branch = toolInput !== null && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>).branch : undefined;
    if (typeof branch !== 'string' || branch.trim() === '' || same(branch.replace(/^refs\/heads\//, ''), ctx.defaultBranch)) {
      return role(`${ctx.defaultBranch} への書き込み（${toolName}）`);
    }
  }
  return null;
}

/** hook の入力（stdin の JSON）を判定する。副作用は無い（今のブランチは ctx で受け取る） */
export function decide(input: HookInput, ctx: GuardContext): Decision {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  let reason: string | null = null;
  if (toolName === 'Bash') {
    const command = input.tool_input !== null && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>).command : undefined;
    if (typeof command !== 'string') return ALLOW;
    const where: Where = { dir: typeof input.cwd === 'string' ? input.cwd : undefined, branch: ctx.currentBranch };
    reason = analyze(command, where, ctx, 0);
  } else if (toolName.startsWith('mcp__')) {
    reason = checkMcp(toolName, input.tool_input, ctx);
  }
  return reason ? { deny: true, reason } : ALLOW;
}

/** 失敗したときの判定：push・merge・保護ラベルの名前を含むものだけ止める */
function fallback(text: string, labels: string[], why: string): Decision {
  return keywordHit(text, labels) ? { deny: true, reason: fallbackReason(why) } : ALLOW;
}

/**
 * stdin の文字列を判定する。JSON が読めない、設定（ctx が null）や今のブランチ（currentBranch が null）が読めないときは、
 * push・merge・保護ラベルの名前を含むものだけ止める。
 */
export function decideRaw(raw: string, ctx: GuardContext | null): Decision {
  const labels = ctx?.protectedLabels ?? FALLBACK_LABELS;
  let input: HookInput;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    input = v as HookInput;
  } catch {
    return fallback(raw, labels, 'hook の入力（JSON）が読めない');
  }
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (toolName !== 'Bash' && !toolName.startsWith('mcp__')) return ALLOW;
  const text = JSON.stringify([toolName, input.tool_input ?? null]);
  if (!ctx) return fallback(text, labels, 'ハーネスの設定が読めない');
  if (ctx.currentBranch === null) return fallback(text, labels, '今のブランチが読めない');
  try {
    return decide(input, ctx);
  } catch {
    return fallback(text, labels, '判定の途中で失敗した');
  }
}

/** hook の標準出力。通すときは空（通常の許可の流れに任せる） */
export function hookOutput(d: Decision): string {
  if (!d.deny) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } });
}

function gitBranch(dir: string): string | null {
  const r = spawnSync('git', ['-C', dir, 'branch', '--show-current'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
}

if (import.meta.main) {
  let raw = '';
  let out = '';
  try {
    for await (const chunk of process.stdin) raw += String(chunk);
    let ctx: GuardContext | null = null;
    try {
      const { loadConfig, LABELS } = await import('../../harness/lib/config.ts');
      const config = loadConfig();
      if (typeof config.defaultBranch !== 'string' || config.defaultBranch === '' || typeof config.autoMergeStopLabel !== 'string') throw new Error('config');
      let cwd = process.cwd();
      try {
        const v = JSON.parse(raw) as HookInput;
        if (typeof v.cwd === 'string') cwd = v.cwd;
      } catch {
        // decideRaw が扱う
      }
      ctx = {
        defaultBranch: config.defaultBranch,
        protectedLabels: [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel],
        currentBranch: gitBranch(cwd),
        branchAt: gitBranch,
      };
    } catch {
      ctx = null;
    }
    out = hookOutput(decideRaw(raw, ctx));
  } catch {
    out = hookOutput(fallback(raw, FALLBACK_LABELS, 'hook の途中で失敗した'));
  }
  if (out) process.stdout.write(`${out}\n`);
}
