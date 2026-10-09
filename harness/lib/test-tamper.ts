/**
 * テストの改ざん検査（agent/tests）。PR の unified diff（base...head）だけを見る純粋関数。
 * テストファイルは harness.config.json の testPatterns（範囲照合と同じパターンの書式）で見分ける。
 * 検出するもの：
 * - テストファイルの削除と、テストファイルでないパスへのリネーム
 * - テスト定義（test( / it( / describe(）の行の削除。同じファイルに同じ名前の定義が追加されていれば移動とみなす
 * - テストの名前の変更：削除された定義の行が、同じまとまりで組になった追加の定義の行と名前の文字列だけ違うもの（削除にせず、変更後の行を持たせる）
 * - skip / only / todo の追加（.skip(、{ skip: … }、xit( など）。文字列リテラル（'…'・"…"・`…`）の中の一致は数えない。
 *   ただし見分けが確かでない行（文字列・テンプレート・ブロックコメントが行をまたぐ。テンプレートに ${ がある、コードの部分に
 *   正規表現か割り算かもしれない / があるときは、同じ hunk の残りの行も）は伏せずに生の行で数える。コメントの中の一致は数える
 * - アサーション（assert / expect(）を含む行の削除・書き換え（整形だけの変更も含む）
 * 同じファイルで同じ内容の行が消えて足されたもの（移動）は数えない。
 * - テストの中身の書き換え：名前が変わった組（テスト定義の行どうしで組む）の本体（括弧が閉じるまで）が、空行・// だけの行・アサーションの行を除いて前後で違うもの。
 *   本体が hunk の外まで続いて全部を見られず、後ろの hunk に本体の書き換えになりうる行があるときは、前後の本体（body）を持たせない。
 *   後ろの hunk は境目より前の行だけを見る（境目：字下げが定義以下の次のテスト定義の行。字下げ 0 の定義なら、見出しの関数の文脈が別の名前のテスト定義の hunk 全体。Issue #530）
 * アサーションの書き換えは、同じ場所の削除と追加が対になれば変更後の行も持たせる（表示と、Jev に問う材料（harness/lib/test-tamper-jev.ts）に使う。この検査の判定には使わない）。
 */
import { TEST_EXEMPT_LABEL } from './config.ts';
import { globToRegExp } from './scope.ts';

export type TamperKind = 'deleted-file' | 'renamed-away' | 'removed-test' | 'renamed-test' | 'rewritten-test' | 'skip-added' | 'assertion-changed';

export interface TamperFinding {
  kind: TamperKind;
  file: string;
  /** 削除された行は base 側、追加された行は head 側の行番号。ファイル単位の検出では無い */
  line?: number;
  side?: 'base' | 'head';
  text?: string;
  /** assertion-changed・renamed-test で、同じ場所の追加の行と対になったときの変更後の行（head 側） */
  after?: { line: number; text: string };
  /** rewritten-test で、本体の全部を見られたときの前後の本体（定義の行＋本体の行）。見られないときは無い（Jev に問わない） */
  body?: { before: string; after: string };
}

export const TAMPER_KIND_LABELS: Record<TamperKind, string> = {
  'deleted-file': 'テストファイルの削除',
  'renamed-away': 'テストファイルでないパスへのリネーム',
  'removed-test': 'テスト定義の削除',
  'renamed-test': 'テストの名前の変更',
  'rewritten-test': 'テストの中身の書き換え',
  'skip-added': 'skip / only / todo の追加',
  'assertion-changed': 'アサーションの削除・書き換え',
};

/** 検出の種類ごとの一言の説明（Check Run の概要に出す） */
export const TAMPER_KIND_NOTES: Record<TamperKind, string> = {
  'deleted-file': 'テストのファイルがまるごと消えています。確かめる対象が無くなると、何を変えても通ってしまいます。',
  'renamed-away': 'テストのファイルが、テストとして扱われない場所・名前に移されています。テストとして動かなくなるおそれがあります。',
  'removed-test': 'テストの項目（`test(` / `it(` / `describe(`）が消えています。それまで確かめていたことが確かめられなくなります。',
  'renamed-test': 'テストの項目（`test(` / `it(` / `describe(`）の名前（説明の文字列）だけが変わっています。中身の行は別に検査しています。',
  'rewritten-test': 'テストの項目の名前が変わり、本体（アサーションでない行）も書き換わっています。確かめていたことが変わっていないかを見ます。',
  'skip-added': 'テストを飛ばす・一部だけ動かす印（`skip` / `only` / `todo`）が足されています。そのテスト（`only` ならほかのテスト）が動かなくなります。',
  'assertion-changed': '採点基準の行（`assert` / `expect(`）が消えたか、書き換わっています。変更後の行が分かるものは並べています。',
};

interface Line {
  no: number;
  text: string;
  /** hunk の中の「連続する削除と、その直後に続く連続する追加」のまとまりの番号 */
  block: number;
  /** ファイルの中の hunk の番号（FileDiff.hunks の添字） */
  hunk: number;
  /** 追加の行だけ：skip / only / todo の検出に当てる行（文字列の中身を伏せた行か、生の行）。相殺・テスト定義・アサーションの検出には使わない */
  skipText?: string;
}

interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  removed: Line[];
  added: Line[];
  /** hunk ごとの古い側（文脈と削除）・新しい側（文脈と追加）の行。テストの本体を切り出すのに使う */
  /** section は hunk の見出し（`@@ … @@`）の後ろの関数の文脈（trim 済み。無ければ空文字） */
  hunks: { old: { no: number; text: string }[]; new: { no: number; text: string }[]; section: string }[];
}

const DEFINITION = /\b((?:test|it|describe)(?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/;
const SKIP = /\.(?:skip|only|todo)\s*\(|\b[xf](?:it|describe|test)\s*\(|[{,]\s*(?:skip|only|todo)\s*:(?!\s*false\b)/;
const ASSERTION = /\bassert\b|\bexpect\s*\(/;
/** import の行はアサーションとみなさない（`import assert from ...` の削除で誤検出しない） */
const IMPORT = /^\s*import\b/;

/** harness.config.json に testPatterns が無いときのパターン */
export const DEFAULT_TEST_PATTERNS = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**'];

export function isTestFile(patterns: string[], path: string): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

export function detectTestTampering(diff: string, patterns: string[]): TamperFinding[] {
  const findings: TamperFinding[] = [];
  for (const f of parseDiff(diff)) {
    const oldIsTest = f.oldPath !== null && isTestFile(patterns, f.oldPath);
    const newIsTest = f.newPath !== null && isTestFile(patterns, f.newPath);
    if (f.deleted || f.newPath === null) {
      if (oldIsTest) findings.push({ kind: 'deleted-file', file: f.oldPath! });
      continue;
    }
    if (oldIsTest && !newIsTest && f.oldPath !== f.newPath) {
      findings.push({ kind: 'renamed-away', file: `${f.oldPath} → ${f.newPath}` });
      continue;
    }
    if (!newIsTest) continue;
    const file = f.newPath;
    // 同じ内容の行が消えて足されたものは移動とみなす（多重集合で相殺する）
    const addedPool = countTexts(f.added);
    const removedPool = countTexts(f.removed);
    const removed = f.removed.filter((l) => !take(addedPool, l.text.trim()));
    const added = f.added.filter((l) => !take(removedPool, l.text.trim()));
    const pairs = pairLines(removed, added);
    const namesOf = (lines: Line[]) => new Set(lines.map((l) => definitionName(l.text)).filter((n): n is string => n !== null));
    const addedNames = namesOf(f.added);
    const defPairs = pairDefinitions(removed, added, namesOf(f.removed), addedNames);
    for (const l of removed) {
      const name = definitionName(l.text);
      if (name !== null && !addedNames.has(name)) {
        const after = defPairs.get(l);
        if (after !== undefined && sameExceptName(l.text, after.text)) findings.push(classifyRenamed(f, file, l, after, removed, added));
        else findings.push({ kind: 'removed-test', file, line: l.no, side: 'base', text: l.text.trim() });
      } else if (ASSERTION.test(l.text) && !IMPORT.test(l.text)) {
        const after = pairs.get(l);
        findings.push({ kind: 'assertion-changed', file, line: l.no, side: 'base', text: l.text.trim(), ...(after ? { after: { line: after.no, text: after.text.trim() } } : {}) });
      }
    }
    for (const l of added) {
      if (SKIP.test(l.skipText ?? l.text)) findings.push({ kind: 'skip-added', file, line: l.no, side: 'head', text: l.text.trim() });
    }
  }
  return findings;
}

/** 同じまとまりの中で、相殺後に残った削除の k 番目と追加の k 番目を組む（数が合わず余った行は組まない） */
function pairLines(removed: Line[], added: Line[]): Map<Line, Line> {
  const addedByBlock = new Map<number, Line[]>();
  for (const l of added) addedByBlock.set(l.block, [...(addedByBlock.get(l.block) ?? []), l]);
  const seen = new Map<number, number>();
  const pairs = new Map<Line, Line>();
  for (const l of removed) {
    const k = seen.get(l.block) ?? 0;
    seen.set(l.block, k + 1);
    const a = addedByBlock.get(l.block)?.[k];
    if (a) pairs.set(l, a);
  }
  return pairs;
}

/**
 * テスト定義の行どうしを組む：同じまとまりの中で、相殺後に残った削除の定義の行（追加の側に同じ名前が無いもの）の k 番目と、
 * 追加の定義の行（削除の側に同じ名前が無いもの）の k 番目。間に足したコメントなどで組がずれない
 */
function pairDefinitions(removed: Line[], added: Line[], removedNames: Set<string>, addedNames: Set<string>): Map<Line, Line> {
  const addedByBlock = new Map<number, Line[]>();
  for (const l of added) {
    const name = definitionName(l.text);
    if (name !== null && !removedNames.has(name)) addedByBlock.set(l.block, [...(addedByBlock.get(l.block) ?? []), l]);
  }
  const seen = new Map<number, number>();
  const pairs = new Map<Line, Line>();
  for (const l of removed) {
    const name = definitionName(l.text);
    if (name === null || addedNames.has(name)) continue;
    const k = seen.get(l.block) ?? 0;
    seen.set(l.block, k + 1);
    const a = addedByBlock.get(l.block)?.[k];
    if (a) pairs.set(l, a);
  }
  return pairs;
}

/** 本体の比べで読み飛ばす行（空行・// だけの行・アサーションの行。アサーションは別に検出している） */
const isIgnorableBodyLine = (text: string): boolean => {
  const t = text.trim();
  return t === '' || t.startsWith('//') || (ASSERTION.test(t) && !IMPORT.test(t));
};

/**
 * 定義の行から、その hunk の同じ側の行を順に読み、括弧の深さが 0 に戻った行までを本体とする（定義の行を含む）。
 * hunk の終わりまでに閉じなければ closed は false。文字列の中身・// 以降・/* … *\/ の中は数えない
 */
function definitionBody(f: FileDiff, line: Line, side: 'old' | 'new'): { lines: string[]; closed: boolean } {
  const rows = f.hunks[line.hunk]?.[side] ?? [];
  const start = rows.findIndex((r) => r.no === line.no);
  const lines: string[] = [];
  if (start < 0) return { lines, closed: false };
  let state: LexState = 'code';
  let inBlock = false;
  let depth = 0;
  for (const row of rows.slice(start)) {
    lines.push(row.text);
    const r = lexLine(row.text, state);
    state = r.next;
    const m = r.masked;
    for (let i = 0; i < m.length; i++) {
      if (inBlock) {
        if (m[i] === '*' && m[i + 1] === '/') {
          inBlock = false;
          i++;
        }
      } else if (m[i] === '/' && m[i + 1] === '/') break;
      else if (m[i] === '/' && m[i + 1] === '*') {
        inBlock = true;
        i++;
      } else if ('([{'.includes(m[i]!)) depth++;
      else if (')]}'.includes(m[i]!)) depth--;
    }
    if (depth <= 0) return { lines, closed: true };
  }
  return { lines, closed: false };
}

/** 定義の行（先頭）を除いた本体を、空行・// だけの行・アサーションの行を除いて比べる */
function sameBody(a: string[], b: string[]): boolean {
  const norm = (lines: string[]) => lines.slice(1).filter((t) => !isIgnorableBodyLine(t)).map((t) => t.trim());
  const x = norm(a);
  const y = norm(b);
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/** 名前が変わった組（呼び出し・引数・行の残りは同じ）を、本体を比べて renamed-test か rewritten-test にする */
function classifyRenamed(f: FileDiff, file: string, l: Line, after: Line, removed: Line[], added: Line[]): TamperFinding {
  const base = { file, line: l.no, side: 'base' as const, text: l.text.trim(), after: { line: after.no, text: after.text.trim() } };
  const before = definitionBody(f, l, 'old');
  const now = definitionBody(f, after, 'new');
  const same = sameBody(before.lines, now.lines);
  const complete = (before.closed && now.closed) || l.hunk === f.hunks.length - 1;
  if (complete) {
    if (same) return { kind: 'renamed-test', ...base };
    return { kind: 'rewritten-test', ...base, body: { before: before.lines.join('\n').trim(), after: now.lines.join('\n').trim() } };
  }
  // 本体が後ろの hunk まで続く。後ろの hunk に本体の書き換えになりうる行があれば、全部を見られず同じと確かめられない
  const later = laterBodyCandidates(f, l, after, removed, added);
  const uncertain = later.some((x) => !isIgnorableBodyLine(x.text) && !DEFINITION.test(x.text));
  if (!uncertain && same) return { kind: 'renamed-test', ...base };
  return { kind: 'rewritten-test', ...base };
}

/** 先頭の空白（スペース・タブ）の文字数 */
function leadingWidth(text: string): number {
  return text.length - text.trimStart().length;
}

/** 行の先頭（字下げの直後）からテスト定義が始まるときその名前。でなければ null */
function startsWithDefinition(text: string): string | null {
  const m = text.match(DEFINITION);
  return m && m.index === leadingWidth(text) ? m[3]! : null;
}

/**
 * 名前を変えた定義の本体が後ろの hunk まで続くとき、後ろの hunk の行のうち本体に入りうる行（境目より前）だけを返す。
 * 境目（側ごと）：(a) 字下げ 0 の定義で、後ろの hunk の見出しが前後どちらの名前とも違うテスト定義、(b) 字下げが定義以下の次のテスト定義の行。見つからなければ全部
 */
function laterBodyCandidates(f: FileDiff, l: Line, after: Line, removed: Line[], added: Line[]): Line[] {
  const boundary = (def: Line, side: 'old' | 'new'): { hunk: number; no: number } | null => {
    const width = leadingWidth(def.text);
    for (let h = l.hunk + 1; h < f.hunks.length; h++) {
      const hunk = f.hunks[h]!;
      const name = startsWithDefinition(hunk.section);
      if (width === 0 && name !== null && name !== definitionName(l.text) && name !== definitionName(after.text)) return { hunk: h, no: -Infinity };
      const row = hunk[side].find((r) => startsWithDefinition(r.text) !== null && leadingWidth(r.text) <= width);
      if (row) return { hunk: h, no: row.no };
    }
    return null;
  };
  const keep = (lines: Line[], b: { hunk: number; no: number } | null) =>
    lines.filter((x) => x.hunk > l.hunk && (b === null || x.hunk < b.hunk || (x.hunk === b.hunk && x.no < b.no)));
  return [...keep(removed, boundary(l, 'old')), ...keep(added, boundary(after, 'new'))];
}

function definitionName(text: string): string | null {
  return text.match(DEFINITION)?.[3] ?? null;
}

/** テスト定義の行の名前の文字列（引用符を含む）を印に置き換えた行（前後の空白は除く）。定義でなければ null */
function definitionSkeleton(text: string): string | null {
  const m = text.match(DEFINITION);
  if (!m || m.index === undefined) return null;
  return `${text.slice(0, m.index)}${m[1]}(\u0000${text.slice(m.index + m[0].length)}`.trim();
}

/** 2つの行がどちらもテスト定義で、名前の文字列だけが違うか（呼び出し・引数・行の残りが同じ） */
function sameExceptName(before: string, after: string): boolean {
  const a = definitionSkeleton(before);
  return a !== null && a === definitionSkeleton(after);
}

function countTexts(lines: Line[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l.text.trim(), (m.get(l.text.trim()) ?? 0) + 1);
  return m;
}

function take(pool: Map<string, number>, key: string): boolean {
  const n = pool.get(key) ?? 0;
  if (n === 0) return false;
  pool.set(key, n - 1);
  return true;
}

/** git が引用符で囲んだパス（C 形式のエスケープ。非 ASCII は 8 進のバイト列）を元に戻す */
function unquote(path: string): string {
  if (!(path.length >= 2 && path.startsWith('"') && path.endsWith('"'))) return path;
  const bytes: number[] = [];
  const body = path.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1] ?? '';
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else if (next in simple) {
      bytes.push(simple[next]!);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `diff --git` の見出しから、変更前後のパスを読む（引用符付きの形も受け付ける。読めなければ null） */
function headerPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  // 引用符の無い見出しで前後が同じパス（空白を含んでもよい）なら、git と同じく真ん中で分ける
  const half = (rest.length - 5) / 2;
  if (Number.isInteger(half) && half > 0 && rest.startsWith('a/') && rest.slice(2, 2 + half) === rest.slice(half + 5) && rest.slice(2 + half, half + 5) === ' b/') {
    return [rest.slice(2, 2 + half), rest.slice(half + 5)];
  }
  const m = line.match(/^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (!m) return null;
  return [unquote(m[1]!).replace(/^a\//, ''), unquote(m[2]!).replace(/^b\//, '')];
}

type LexState = 'code' | 'single' | 'double' | 'template' | 'block';

interface LexResult {
  /** 文字列・テンプレートの中身を空白にした行（引用符とコメントは残す） */
  masked: string;
  /** 次の行の始めの状態（'…'・"…" は行末の \ で続くときだけ持ち越す） */
  next: LexState;
  /** 行の終わりが文字列・テンプレート・ブロックコメントの中か */
  open: boolean;
  /** テンプレートの ${ か、コードの部分にコメントの始まりでない / があった（状態を読み違えるおそれ） */
  unsure: boolean;
}

const QUOTES: Record<string, LexState> = { "'": 'single', '"': 'double', '`': 'template' };
const CLOSE: Partial<Record<LexState, string>> = { single: "'", double: '"', template: '`' };

/** 1行を左から読み、文字列リテラルの中身を伏せる（skip / only / todo の検出のためだけの小さな字句の読み取り） */
function lexLine(text: string, start: LexState): LexResult {
  let s = start;
  let out = '';
  let unsure = false;
  let continued = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1] ?? '';
    if (s === 'code') {
      if (ch === '/' && next === '/') {
        out += text.slice(i);
        break;
      }
      if (ch === '/' && next === '*') {
        out += '/*';
        i++;
        s = 'block';
        continue;
      }
      if (ch === '/') unsure = true;
      s = QUOTES[ch] ?? 'code';
      out += ch;
    } else if (s === 'block') {
      if (ch === '*' && next === '/') {
        out += '*/';
        i++;
        s = 'code';
      } else out += ch;
    } else if (ch === '\\') {
      if (next === '') continued = true;
      out += next === '' ? ' ' : '  ';
      i++;
    } else if (ch === CLOSE[s]) {
      out += ch;
      s = 'code';
    } else {
      if (s === 'template' && ch === '$' && next === '{') unsure = true;
      out += ' ';
    }
  }
  const next = (s === 'single' || s === 'double') && !continued ? 'code' : s;
  return { masked: out, next, open: s !== 'code', unsure };
}

function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let block = 0;
  let prev = ' ';
  // skip の検出のための字句の状態。hunk の新しい側の行（文脈と追加）を順に読んで持ち越し、
  // 読み違えるおそれ（unsure）が出たら、その hunk の残りは生の行で数える
  let lex: LexState = 'code';
  let unsure = false;
  /** 新しい側の1行を読んで状態を進め、skip の検出に当てる行を返す（伏せてよいときだけ伏せた行） */
  const lexNewSide = (text: string): string => {
    const r = lexLine(text, lex);
    const safe = lex === 'code' && !r.open && !r.unsure && !unsure;
    if (r.unsure) unsure = true;
    lex = r.next;
    return safe ? r.masked : text;
  };
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      // hunk の中は行数で読む（`--- ` で始まる削除行を見出しと取り違えないため）
      if (line.startsWith('\\')) continue;
      const mark = line[0];
      const text = line.slice(1);
      if (mark === '-') {
        if (prev !== '-') block++;
        cur.hunks.at(-1)?.old.push({ no: oldNo, text });
        cur.removed.push({ no: oldNo++, text, block, hunk: cur.hunks.length - 1 });
        oldLeft--;
      } else if (mark === '+') {
        if (prev !== '-' && prev !== '+') block++;
        cur.hunks.at(-1)?.new.push({ no: newNo, text });
        cur.added.push({ no: newNo++, text, block, hunk: cur.hunks.length - 1, skipText: lexNewSide(text) });
        newLeft--;
      } else {
        lexNewSide(text);
        cur.hunks.at(-1)?.old.push({ no: oldNo, text });
        cur.hunks.at(-1)?.new.push({ no: newNo, text });
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
      }
      prev = mark === '-' || mark === '+' ? mark : ' ';
      continue;
    }
    if (line.startsWith('diff --git ')) {
      // 見出しが読めなくても必ず新しいファイルを始める（直前のファイルの記録を上書きしないため）。パスは ---/+++/rename でも決まる
      const paths = headerPaths(line);
      cur = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, deleted: false, removed: [], added: [], hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunk) {
      cur.hunks.push({ old: [], new: [], section: (hunk[5] ?? '').trim() });
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      prev = ' ';
      lex = 'code';
      unsure = false;
    } else if (line.startsWith('deleted file mode')) {
      cur.deleted = true;
    } else if (line.startsWith('rename from ')) {
      cur.oldPath = unquote(line.slice('rename from '.length));
    } else if (line.startsWith('rename to ')) {
      cur.newPath = unquote(line.slice('rename to '.length));
    } else if (line.startsWith('--- ')) {
      const p = line.slice(4);
      cur.oldPath = p === '/dev/null' ? null : unquote(p).replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      cur.newPath = p === '/dev/null' ? null : unquote(p).replace(/^b\//, '');
    }
  }
  return files;
}

/** failure の概要の先頭に置く、技術者でなくても分かる説明 */
function tamperExplanation(exemptLabel: string): string[] {
  return [
    '### 何を見張っているか',
    '',
    'この検査は、テストを甘くして通すことを見張っています。たとえるなら、試験の答案（コード）を直さずに、採点基準（テスト）を書き換えて合格にしてしまう行為です。',
    '',
    '### なぜ止まったか',
    '',
    'テストの行（採点基準の行など）が変わると、中身に関わらず止めます。甘くなったかどうかまでは判断できないので、人に見せる作りです。止まっても、テストが甘くなったとは限りません（関数に引数を足しただけでも止まります）。',
    '',
    '### 人が確かめること',
    '',
    '- 期待する結果（比べている値）・メッセージ・確認の数が変わっていないか',
    '- テストが消えたり、飛ばされたりしていないか',
    '',
    '### 通し方',
    '',
    `確かめて問題が無ければ、Issue か PR に理由を書いて、人が PR に \`${exemptLabel}\` を付けます（AI は付けません）。ラベルは付けた時点の差分にだけ効くので、付けたあとに push したら、差分を確かめてラベルを外して付け直します。問題があれば、ラベルを付けずに PR にコメントで直してもらいます。`,
    '',
    '### 検出したもの',
    '',
  ];
}

const code = (text: string) => `\`${text.slice(0, 120).replace(/`/g, "'")}\``;

/** 種類ごとの見出しと一言の説明、ファイルと行（変更前後）の一覧 */
function tamperList(findings: TamperFinding[], limit: number): string[] {
  const shown = findings.slice(0, limit);
  const lines: string[] = [];
  for (const kind of Object.keys(TAMPER_KIND_LABELS) as TamperKind[]) {
    const ofKind = shown.filter((f) => f.kind === kind);
    if (ofKind.length === 0) continue;
    lines.push(`**${TAMPER_KIND_LABELS[kind]}**：${TAMPER_KIND_NOTES[kind]}`, '');
    for (const f of ofKind) {
      const at = f.line === undefined ? '' : `:${f.line}${f.side === 'base' ? '（変更前）' : ''}`;
      if (f.after) {
        lines.push(`- \`${f.file}${at}\` → \`:${f.after.line}（変更後）\``, `  - 変更前：${code(f.text ?? '')}`, `  - 変更後：${code(f.after.text)}`);
      } else {
        lines.push(`- \`${f.file}${at}\`${f.text ? ` — ${code(f.text)}` : ''}`);
      }
    }
    lines.push('');
  }
  if (findings.length > limit) lines.push(`- ほか ${findings.length - limit} 件`);
  return lines;
}

/** Check Run の要約（平易な説明と、種類ごとのファイルと行の一覧） */
export function renderTamperSummary(findings: TamperFinding[], limit = 100, exemptLabel = TEST_EXEMPT_LABEL): string {
  return [...tamperExplanation(exemptLabel), ...tamperList(findings, limit)].join('\n').trimEnd();
}

/**
 * 人が Merge する PR（Human Merge）向けの説明と一覧。agent/tests の neutral の要約と、Human Merge の依頼のコメントに載せる。
 * 止めずに Merge の判断に含めるので、例外ラベルを付けさせる「通し方」は書かない。
 */
export function renderTamperForHumanMerge(findings: TamperFinding[], limit = 100): string {
  return [
    '### 何を見張っているか',
    '',
    'この検査は、テストを甘くして通すことを見張っています。たとえるなら、試験の答案（コード）を直さずに、採点基準（テスト）を書き換えて合格にしてしまう行為です。',
    '',
    '### なぜ止めていないか',
    '',
    'この PR は人が Merge するので、検査の結果で止めずに、Merge の判断に含めます。テストの行（採点基準の行など）が変わったことだけを示しています。甘くなったとは限りません（関数に引数を足しただけでも載ります）。',
    '',
    '### 人が確かめること',
    '',
    '- 期待する結果（比べている値）・メッセージ・確認の数が変わっていないか',
    '- テストが消えたり、飛ばされたりしていないか',
    '',
    `問題があれば、Merge せずに PR にコメントで直してもらいます。\`${TEST_EXEMPT_LABEL}\` は要りません。`,
    '',
    '### 検出したもの',
    '',
    ...tamperList(findings, limit),
  ].join('\n').trimEnd();
}
