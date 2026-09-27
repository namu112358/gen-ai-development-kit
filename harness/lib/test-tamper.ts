/**
 * テストの改ざん検査（agent/tests）。PR の unified diff（base...head）だけを見る純粋関数。
 * テストファイルは harness.config.json の testPatterns（範囲照合と同じパターンの書式）で見分ける。
 * 検出するもの：
 * - テストファイルの削除と、テストファイルでないパスへのリネーム
 * - テスト定義（test( / it( / describe(）の行の削除。同じファイルに同じ名前の定義が追加されていれば移動とみなす
 * - skip / only / todo の追加（.skip(、{ skip: … }、xit( など）
 * - アサーション（assert / expect(）を含む行の削除・書き換え（整形だけの変更も含む）
 * 同じファイルで同じ内容の行が消えて足されたもの（移動）は数えない。
 */
import { globToRegExp } from './scope.ts';

export type TamperKind = 'deleted-file' | 'renamed-away' | 'removed-test' | 'skip-added' | 'assertion-changed';

export interface TamperFinding {
  kind: TamperKind;
  file: string;
  /** 削除された行は base 側、追加された行は head 側の行番号。ファイル単位の検出では無い */
  line?: number;
  side?: 'base' | 'head';
  text?: string;
}

export const TAMPER_KIND_LABELS: Record<TamperKind, string> = {
  'deleted-file': 'テストファイルの削除',
  'renamed-away': 'テストファイルでないパスへのリネーム',
  'removed-test': 'テスト定義の削除',
  'skip-added': 'skip / only / todo の追加',
  'assertion-changed': 'アサーションの削除・書き換え',
};

interface Line {
  no: number;
  text: string;
}

interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  deleted: boolean;
  removed: Line[];
  added: Line[];
}

const DEFINITION = /\b(?:test|it|describe)(?:\.\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
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
    const addedNames = new Set(f.added.map((l) => definitionName(l.text)).filter((n): n is string => n !== null));
    for (const l of removed) {
      const name = definitionName(l.text);
      if (name !== null && !addedNames.has(name)) findings.push({ kind: 'removed-test', file, line: l.no, side: 'base', text: l.text.trim() });
      else if (ASSERTION.test(l.text) && !IMPORT.test(l.text)) findings.push({ kind: 'assertion-changed', file, line: l.no, side: 'base', text: l.text.trim() });
    }
    for (const l of added) {
      if (SKIP.test(l.text)) findings.push({ kind: 'skip-added', file, line: l.no, side: 'head', text: l.text.trim() });
    }
  }
  return findings;
}

function definitionName(text: string): string | null {
  return text.match(DEFINITION)?.[2] ?? null;
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

function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      // hunk の中は行数で読む（`--- ` で始まる削除行を見出しと取り違えないため）
      if (line.startsWith('\\')) continue;
      const mark = line[0];
      const text = line.slice(1);
      if (mark === '-') {
        cur.removed.push({ no: oldNo++, text });
        oldLeft--;
      } else if (mark === '+') {
        cur.added.push({ no: newNo++, text });
        newLeft--;
      } else {
        oldNo++;
        newNo++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      // 見出しが読めなくても必ず新しいファイルを始める（直前のファイルの記録を上書きしないため）。パスは ---/+++/rename でも決まる
      const paths = headerPaths(line);
      cur = { oldPath: paths?.[0] ?? null, newPath: paths?.[1] ?? null, deleted: false, removed: [], added: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
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

/** Check Run の要約（ファイルと行の一覧） */
export function renderTamperSummary(findings: TamperFinding[], limit = 100): string {
  const lines = findings.slice(0, limit).map((f) => {
    const at = f.line === undefined ? '' : `:${f.line}${f.side === 'base' ? '（変更前）' : ''}`;
    const text = f.text ? ` — \`${f.text.slice(0, 120).replace(/`/g, "'")}\`` : '';
    return `- ${TAMPER_KIND_LABELS[f.kind]}：\`${f.file}${at}\`${text}`;
  });
  if (findings.length > limit) lines.push(`- ほか ${findings.length - limit} 件`);
  return lines.join('\n');
}
