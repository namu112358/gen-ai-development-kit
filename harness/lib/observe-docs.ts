import { allLabelDefs, bypassMergeConfig, delegateConfig, MANAGED_PREFIXES, type HarnessConfig } from './config.ts';
import { globToRegExp } from './scope.ts';

/**
 * 保守の観測（harness/scripts/observe.ts）の docs の照合。docs・skill・CLAUDE.md などに書かれた
 * `agent.ts` のサブコマンド、リポジトリ内のパス、ラベル名、harness.config.json のキー、リンクの先と見出しが実在するかを決まる規則で見る。
 * 実在の一覧（DocsInventory）を組む buildDocsInventory と、1ファイルを照らす純粋関数 checkDoc に分ける。LLM は呼ばない。
 * コードブロックの中、`<…>` を含む書きかけの例、導入先のパス（リポジトリの最上位に無い名前で始まるもの）は見ない。
 * 設定キーは「`harness.config.json` の `キー`」の形で書かれたものだけを見る（同じ行の値・関数名・記録の欄を設定キーと取り違えない）。
 */

export type DocFindingKind = 'subcommand' | 'path' | 'label' | 'config-key' | 'link' | 'anchor';

export interface DocFinding {
  kind: DocFindingKind;
  name: string;
  file: string;
  /** 1 始まり */
  line: number;
}

export interface DocsInventory {
  /** git ls-files（/ 区切り、ルートからの相対） */
  files: ReadonlySet<string>;
  /** files の最初の階層の名前 */
  topLevel: ReadonlySet<string>;
  subcommands: ReadonlySet<string>;
  labels: ReadonlySet<string>;
  labelPrefixes: readonly string[];
  /** harness.config.json・雛形のキーの道筋（途中も含む） */
  configKeys: ReadonlySet<string>;
  /** HarnessConfig の型に書かれたキーの名前 */
  configKeyNames: ReadonlySet<string>;
  /** その Markdown の見出しから作ったアンカー。読めなければ null */
  anchorsOf(file: string): ReadonlySet<string> | null;
}

/** 照合の対象のファイルか（外部の写しの docs/upstream/ は書き換えないので見ない） */
export function isDocTarget(file: string): boolean {
  if (file.startsWith('docs/upstream/')) return false;
  if (file.startsWith('docs/') && file.endsWith('.md')) return true;
  if (file.startsWith('.claude/skills/') && file.endsWith('.md')) return true;
  if (/^\.claude\/agents\/[^/]+\.md$/.test(file)) return true;
  if (file === '.claude/routine.md' || file === 'CLAUDE.md' || file === 'harness/CLAUDE.harness.md' || file === 'README.md') return true;
  return /^harness\/(?:.+\/)?README\.md$/.test(file);
}

/** agent.ts の分岐（`case 'x'` と `cmd === 'x'`）からサブコマンドの名前を読む */
export function agentSubcommands(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bcase '([a-z][a-z0-9-]*)'/g)) names.add(m[1]!);
  for (const m of source.matchAll(/\bcmd === '([a-z][a-z0-9-]*)'/g)) names.add(m[1]!);
  return [...names].sort();
}

/** JSON のキーの道筋（ネストを . でつなぐ。途中も含む。配列の中と $ で始まるキーは見ない） */
export function configKeyPaths(json: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, prefix: string): void => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (k.startsWith('$')) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      out.push(path);
      walk(child, path);
    }
  };
  walk(json, '');
  return out;
}

/** harness/lib/config.ts の `export interface HarnessConfig { ... }` に書かれたキーの名前（ネストも含む） */
export function configTypeKeyNames(configTs: string): string[] {
  const start = configTs.indexOf('export interface HarnessConfig {');
  if (start < 0) return [];
  let depth = 0;
  let end = configTs.length;
  for (let i = configTs.indexOf('{', start); i < configTs.length; i++) {
    if (configTs[i] === '{') depth++;
    else if (configTs[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = configTs.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const names = new Set<string>();
  for (const m of body.matchAll(/(?:^|[\s{;])([A-Za-z_$][\w$]*)\??:/g)) names.add(m[1]!);
  return [...names].sort();
}

const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** コードブロックの開き・閉じを追う（閉じは同じ記号で開きと同じ長さ以上、後ろに何も無い行）。行がコードブロックの外の本文なら true */
function fenceTracker(): (line: string) => boolean {
  let open: string | null = null;
  return (line) => {
    const f = line.match(FENCE_RE);
    if (open === null) {
      if (f) {
        open = f[1]!;
        return false;
      }
      return true;
    }
    if (f && f[1]![0] === open[0] && f[1]!.length >= open.length && f[2]!.trim() === '') open = null;
    return false;
  };
}

/** GitHub と同じ規則で見出しのアンカーを作る（同じ名前は -1, -2 …）。<a id> / name も含む */
export function markdownAnchors(markdown: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  const prose = fenceTracker();
  for (const line of markdown.split(/\r?\n/)) {
    if (!prose(line)) continue;
    for (const m of line.matchAll(/<a\s[^>]*(?:id|name)="([^"]+)"/g)) out.add(m[1]!);
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!h) continue;
    const text = h[1]!.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

const SKIP_CHARS = /[<>…{]/;
const TRIM_TAIL = /[),，。、．;:]+$/;
const FILE_EXT = /\.(json|ts|md|yml|yaml|html|mjs|js)$/;
const CONFIG_KEY_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function exists(inv: DocsInventory, path: string): boolean {
  if (path.includes('*')) {
    const re = globToRegExp(path.replace(/\/$/, ''));
    for (const f of inv.files) if (re.test(f) || f.split('/').some((_, i, a) => re.test(a.slice(0, i + 1).join('/')))) return true;
    return false;
  }
  const p = path.replace(/\/$/, '');
  if (inv.files.has(p)) return true;
  const dir = `${p}/`;
  for (const f of inv.files) if (f.startsWith(dir)) return true;
  return false;
}

function normalize(parts: string[]): string | null {
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}

function checkPath(word: string, inv: DocsInventory): string | null {
  if (SKIP_CHARS.test(word)) return null;
  const w = word.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '').replace(TRIM_TAIL, '');
  if (w === '' || w.startsWith('/')) return null;
  const first = w.split('/')[0]!;
  if (!inv.topLevel.has(first)) return null;
  if (!w.includes('/') && !w.includes('*')) return null; // 最上位の名前そのもの（実在する）
  return exists(inv, w) ? null : w;
}

function checkLabel(word: string, inv: DocsInventory): string | null {
  if (SKIP_CHARS.test(word)) return null;
  const w = word.replace(TRIM_TAIL, '');
  const prefix = inv.labelPrefixes.find((p) => w.startsWith(p));
  if (!prefix || w.length === prefix.length) return null;
  if (!/^[\w:*.-]+$/.test(w)) return null;
  if (w.includes('*')) return null;
  return inv.labels.has(w) ? null : w;
}

function checkConfigKey(word: string, inv: DocsInventory): string | null {
  if (!CONFIG_KEY_RE.test(word) || FILE_EXT.test(word)) return null;
  for (const k of inv.configKeys) if (k === word || k.endsWith(`.${word}`)) return null;
  if (word.split('.').every((s) => inv.configKeyNames.has(s))) return null;
  return word;
}

function checkSubcommand(name: string, star: boolean, inv: DocsInventory): boolean {
  if (star) {
    for (const s of inv.subcommands) if (s.startsWith(name)) return true;
    return false;
  }
  return inv.subcommands.has(name);
}

function dirOf(file: string): string[] {
  const parts = file.split('/');
  parts.pop();
  return parts;
}

/** 1ファイルを照らし、実在しないものを行の順に出す */
export function checkDoc(file: string, text: string, inv: DocsInventory): DocFinding[] {
  const out: DocFinding[] = [];
  const push = (kind: DocFindingKind, name: string, line: number): void => void out.push({ kind, name, file, line });
  const prose = fenceTracker();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (!prose(line)) continue;

    const found: { kind: DocFindingKind; name: string }[] = [];
    // agent.ts のサブコマンド
    for (const m of line.matchAll(/agent\.ts[`\s]+([a-z][a-z0-9-]*)(\*)?/g)) {
      if (!checkSubcommand(m[1]!, m[2] === '*', inv)) found.push({ kind: 'subcommand', name: m[1]! + (m[2] ?? '') });
    }
    // インラインコードの中の語：パス・ラベル・設定キー。
    // 設定キーは「`harness.config.json` の `キー`」の形（続けて ・、と でつないだものも）だけを見る（同じ行の値・関数名・記録の欄を拾わない）
    let prevEnd = -1;
    let prevConfig = false;
    for (const m of line.matchAll(/(`+)([^`]+?)\1/g)) {
      const span = m[2]!.trim();
      const start = m.index!;
      const configSpan: boolean = /harness\.config\.json`*\s*の\s*$/.test(line.slice(0, start)) || (prevConfig && /^\s*[・、,とや]\s*$/.test(line.slice(prevEnd, start)));
      prevEnd = start + m[0].length;
      prevConfig = configSpan;
      for (const word of span.split(/\s+/)) {
        if (word === '') continue;
        const p = checkPath(word, inv);
        if (p !== null) found.push({ kind: 'path', name: p });
        const l = checkLabel(word, inv);
        if (l !== null) found.push({ kind: 'label', name: l });
        if (configSpan) {
          const k = checkConfigKey(word, inv);
          if (k !== null) found.push({ kind: 'config-key', name: k });
        }
      }
    }
    // リンク（インラインコードの中は見ない）
    const plain = line.replace(/(`+)[^`]+?\1/g, '');
    for (const m of plain.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]!;
      if (/^(https?:|mailto:)/i.test(target) || SKIP_CHARS.test(target)) continue;
      const hashAt = target.indexOf('#');
      const pathPart = hashAt >= 0 ? target.slice(0, hashAt) : target;
      const anchor = hashAt >= 0 ? decodeURIComponent(target.slice(hashAt + 1)) : null;
      let dest: string | null = file;
      if (pathPart !== '') {
        dest = normalize([...dirOf(file), ...decodeURIComponent(pathPart).split('/')]);
        if (dest === null || !exists(inv, dest)) {
          found.push({ kind: 'link', name: target });
          continue;
        }
      }
      if (anchor !== null && anchor !== '' && dest.endsWith('.md')) {
        const anchors = inv.anchorsOf(dest);
        if (anchors !== null && !anchors.has(anchor.toLowerCase()) && !anchors.has(anchor)) found.push({ kind: 'anchor', name: target });
      }
    }
    const seen = new Set<string>();
    for (const x of found) {
      const key = `${x.kind}\t${x.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      push(x.kind, x.name, n);
    }
  }
  return out;
}

/** 実在の一覧を組む。readText はルートからの相対パスで読み、読めなければ null */
export function buildDocsInventory(input: { files: string[]; readText(path: string): string | null; config: HarnessConfig }): DocsInventory {
  const files = new Set(input.files.map((f) => f.replace(/\\/g, '/')));
  const topLevel = new Set([...files].map((f) => f.split('/')[0]!));

  // サブコマンド：agent.ts と、分けた後の置き場所（harness/scripts/agent/）の .ts
  const agentSources = [...files].filter((f) => f === 'harness/scripts/agent.ts' || /^harness\/scripts\/agent\/.+\.ts$/.test(f));
  const subcommands = new Set(agentSources.flatMap((f) => agentSubcommands(input.readText(f) ?? '')));

  const labels = new Set<string>([
    ...allLabelDefs(input.config).map((l) => l.name),
    ...Object.values(delegateConfig(input.config)),
    bypassMergeConfig(input.config).label,
    input.config.autoMergeStopLabel,
  ]);

  const configKeys = new Set<string>();
  for (const f of ['harness.config.json', 'harness/templates/harness.config.json']) {
    const text = input.readText(f);
    if (text === null) continue;
    try {
      for (const k of configKeyPaths(JSON.parse(text))) configKeys.add(k);
    } catch {
      // 読めない JSON は数えない
    }
  }
  const configKeyNames = new Set(configTypeKeyNames(input.readText('harness/lib/config.ts') ?? ''));

  const anchorCache = new Map<string, Set<string> | null>();
  const anchorsOf = (file: string): Set<string> | null => {
    if (!anchorCache.has(file)) {
      const text = files.has(file) ? input.readText(file) : null;
      anchorCache.set(file, text === null ? null : markdownAnchors(text));
    }
    return anchorCache.get(file)!;
  };

  return { files, topLevel, subcommands, labels, labelPrefixes: MANAGED_PREFIXES, configKeys, configKeyNames, anchorsOf };
}
