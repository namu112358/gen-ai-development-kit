/**
 * 減らせるテストの材料（harness/scripts/test-prune.ts）の決まる集計。LLM を呼ばない純粋関数だけを置く。
 * テストファイルごとの V8 のカバレッジから本体の実行された行を作り、ほかのテストファイルとの重なり（uniqueLines・bestOverlap）、
 * ファイルの文字列を固定するだけのテスト（pinned）、テストの定義の数を出し、削除・統合の候補を組む。
 * テストの健康（遅いテスト・不安定なテスト・生き残ったミュータント）は数え直さず、保守の観測（harness/scripts/observe.ts）の JSON を読む
 * （型は harness/lib/test-health.ts）。どれを減らすかの判断は test-prune の skill が行う。
 */
import type { FlakyTestsSection, MutantsSection, SlowTests, SurvivedMutant } from './test-health.ts';

export interface V8Range {
  startOffset: number;
  endOffset: number;
  count: number;
}
export interface V8Function {
  functionName?: string;
  ranges: V8Range[];
  isBlockCoverage?: boolean;
}
export interface V8Script {
  scriptId?: string;
  url: string;
  functions: V8Function[];
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 本体の行として数える .ts か（harness/test/** と node_modules を除く） */
export function isSourceTarget(path: string): boolean {
  if (!path.endsWith('.ts') || path.startsWith('../') || path.startsWith('/')) return false;
  if (path.startsWith('harness/test/')) return false;
  return !path.split('/').includes('node_modules');
}

/** file:// の URL をルートからの / 区切りの相対パスにする。本体の .ts でなければ null */
export function coverageUrlToPath(url: string, root: string): string | null {
  if (!url.startsWith('file://')) return null;
  let p: string;
  try {
    p = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  const base = root.replace(/\\/g, '/').replace(/\/?$/, '/');
  if (!p.toLowerCase().startsWith(base.toLowerCase())) return null;
  const rel = p.slice(base.length);
  return isSourceTarget(rel) ? rel : null;
}

/**
 * 実行回数1以上の文字を含む、空行でない行の番号（1 始まり、昇順）。範囲は外側から塗り、入れ子の範囲が上書きする。
 * skipModuleScope：モジュール全体の範囲（0 からソースの終わりまで）を塗らない。読み込んだだけで実行扱いになる型・コメント・宣言の行を
 * 数えず、関数の本体の行で重なりを比べる（CLI はこれを使う）
 */
export function coveredLines(source: string, functions: V8Function[], opts: { skipModuleScope?: boolean } = {}): number[] {
  const counts = new Int8Array(source.length);
  const isModuleScope = (r: V8Range): boolean => r.startOffset === 0 && r.endOffset >= source.length;
  const ranges = functions
    .flatMap((f) => f.ranges)
    .filter((r) => !(opts.skipModuleScope && isModuleScope(r))).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) counts.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(source.length, r.endOffset));
  const out: number[] = [];
  let start = 0;
  let line = 1;
  while (start <= source.length) {
    let end = source.indexOf('\n', start);
    if (end === -1) end = source.length;
    if (source.slice(start, end).trim() !== '') {
      for (let i = start; i < end; i++) {
        if (counts[i] === 1 && source[i]!.trim() !== '') {
          out.push(line);
          break;
        }
      }
    }
    start = end + 1;
    line++;
  }
  return out;
}

export interface Overlap {
  coveredLines: number;
  uniqueLines: number;
  bestOverlap: { with: string; ratio: number } | null;
}

/** テストファイル → 実行された行（`path:line`）から、ほかのどのファイルも実行しない行の数と、行が最も多く含まれる相手 */
export function overlapByFile(covered: Map<string, Set<string>>): Map<string, Overlap> {
  const owners = new Map<string, number>();
  for (const lines of covered.values()) for (const l of lines) owners.set(l, (owners.get(l) ?? 0) + 1);
  const names = [...covered.keys()].sort(byName);
  const out = new Map<string, Overlap>();
  for (const name of names) {
    const lines = covered.get(name)!;
    let unique = 0;
    for (const l of lines) if (owners.get(l) === 1) unique++;
    let best: { with: string; ratio: number } | null = null;
    if (lines.size > 0) {
      for (const other of names) {
        if (other === name) continue;
        const o = covered.get(other)!;
        let shared = 0;
        for (const l of lines) if (o.has(l)) shared++;
        const ratio = shared / lines.size;
        if (best === null || ratio > best.ratio) best = { with: other, ratio };
      }
    }
    out.set(name, { coveredLines: lines.size, uniqueLines: unique, bestOverlap: best });
  }
  return out;
}

const PINNED_TARGET = /readFileSync\([^)\n]*?['"`]([^'"`\n]*\.(?:md|ya?ml|html|json|txt))['"`]/g;
const PINNED_ASSERTION = /\.includes\(|assert\.(?:match|doesNotMatch)\(/;

/** readFileSync で読むコード以外のファイルと、文言を確かめる行の数（読むファイルが無ければ 0） */
export function detectPinned(source: string): { targets: string[]; assertions: number } {
  const targets: string[] = [];
  for (const m of source.matchAll(PINNED_TARGET)) if (!targets.includes(m[1]!)) targets.push(m[1]!);
  if (targets.length === 0) return { targets, assertions: 0 };
  const assertions = source.split(/\r?\n/).filter((l) => PINNED_ASSERTION.test(l)).length;
  return { targets, assertions };
}

/** `test(`・`it(` の定義の数（静的に数える目安） */
export function countTests(source: string): number {
  return [...source.matchAll(/\b(?:test|it)\(/g)].length;
}

/** 子プロセスを起動するテストか（子に env を明示して渡すとカバレッジが欠けうる） */
export function spawnsChild(source: string): boolean {
  return /\b(?:spawn|spawnSync|execFile|execFileSync)\b/.test(source);
}

// --- テストの健康（observe.ts の JSON） ---

export interface FileHealth {
  slowSeconds: number | null;
  flaky: { name: string; count: number }[];
  survivedMutants: number;
}
export interface HealthInput {
  slowFiles: Map<string, number>;
  flaky: { name: string; count: number }[];
  mutants: SurvivedMutant[];
  notes: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** observe.ts の JSON（ObserveReport）からテストの健康の節を読む。読めない節は notes に書いて空にする */
export function readHealth(json: unknown): { ok: true; value: HealthInput } | { ok: false; reason: string } {
  if (!isObject(json)) return { ok: false, reason: '--health の JSON がオブジェクトではありません' };
  if (json.version !== 1) return { ok: false, reason: '--health の JSON の version が 1 ではありません' };
  const notes: string[] = [];
  const section = <T>(key: string): T | null => {
    const s = json[key];
    if (!isObject(s)) {
      notes.push(`${key} は読めません：節がありません`);
      return null;
    }
    if (s.available !== true) {
      notes.push(`${key} は読めません：${String(s.reason ?? '理由なし')}`);
      return null;
    }
    return s as unknown as T;
  };
  const slowFiles = new Map<string, number>();
  const slow = section<SlowTests>('slowTests');
  if (slow && Array.isArray(slow.files)) for (const f of slow.files) if (typeof f?.file === 'string' && typeof f.seconds === 'number') slowFiles.set(f.file, f.seconds);
  const flakySec = section<FlakyTestsSection>('flakyTests');
  const flaky = flakySec && Array.isArray(flakySec.items) ? flakySec.items.filter((i) => typeof i?.name === 'string').map((i) => ({ name: i.name, count: Number(i.count) || 0 })) : [];
  const mutantsSec = section<MutantsSection>('mutants');
  const mutants =
    mutantsSec && Array.isArray(mutantsSec.items)
      ? mutantsSec.items.filter((m) => typeof m?.file === 'string' && typeof m.line === 'number').map((m) => ({ file: m.file, line: m.line, operator: String(m.operator) }))
      : [];
  return { ok: true, value: { slowFiles, flaky, mutants, notes } };
}

/** 1ファイルの健康。不安定なテストは名前がファイルの本文に含まれるもの、生き残ったミュータントは lines に当たるもの */
export function healthForFile(health: HealthInput, file: string, source: string, lines: Set<string>): FileHealth {
  return {
    slowSeconds: health.slowFiles.get(file) ?? null,
    flaky: health.flaky.filter((f) => f.name !== '' && source.includes(f.name)),
    survivedMutants: health.mutants.filter((m) => lines.has(`${m.file}:${m.line}`)).length,
  };
}

// --- 候補 ---

export interface FileReport {
  path: string;
  tests: number;
  durationMs: number;
  exitCode: number | null;
  coveredLines: number;
  uniqueLines: number;
  bestOverlap: { with: string; ratio: number } | null;
  pinned: { targets: string[]; assertions: number };
  spawnsChild: boolean;
  health: FileHealth | null;
}

export type CandidateKind = 'contained' | 'pinned' | 'no-coverage';
export interface Candidate {
  kind: CandidateKind;
  file: string;
  reasons: string[];
  overlapWith: string | null;
  ratio: number | null;
  coveredLines: number;
  durationMs: number;
  spawnsChild: boolean;
  survivedMutantsInOverlap: number | null;
}

const KIND_ORDER: CandidateKind[] = ['contained', 'pinned', 'no-coverage'];
const pct = (r: number): string => `${Math.round(r * 1000) / 10}%`;

/** 削除・統合・書き直しの候補（種類の順、同じ種類は重なりの割合・所要時間の大きい順） */
export function buildCandidates(
  files: FileReport[],
  opts: { minContainment: number; limit: number },
  overlapMutants?: Map<string, number>,
): { candidates: Candidate[]; notes: string[] } {
  const all: Candidate[] = [];
  for (const f of files) {
    let kind: CandidateKind | null = null;
    const reasons: string[] = [];
    if (f.coveredLines > 0 && f.uniqueLines === 0 && f.bestOverlap !== null && f.bestOverlap.ratio >= opts.minContainment) {
      kind = 'contained';
      reasons.push(`実行する本体の ${f.coveredLines} 行のうち ${pct(f.bestOverlap.ratio)} を ${f.bestOverlap.with} も実行し、このファイルだけが実行する行が無い`);
    } else if (f.coveredLines === 0 && f.pinned.assertions >= 1) {
      kind = 'pinned';
      reasons.push(`本体の行を実行せず、${f.pinned.targets.join('・')} の文言を ${f.pinned.assertions} 行で確かめている`);
    } else if (f.coveredLines === 0) {
      kind = 'no-coverage';
      reasons.push('本体の行を実行していない（確かめる対象が見えない）');
    }
    if (kind === null) continue;
    if (f.spawnsChild) reasons.push('子プロセスを起動する（env を明示して渡すと子のカバレッジが欠ける。本文を読んで確かめる）');
    if (f.exitCode !== 0) reasons.push(`テストが終了コード ${f.exitCode ?? 'null'} で終わった`);
    reasons.push(`テストの定義 ${f.tests} 件、所要 ${f.durationMs} ms`);
    let survived: number | null = null;
    if (kind === 'contained' && overlapMutants) {
      survived = overlapMutants.get(f.bestOverlap!.with) ?? 0;
      reasons.push(`重なる先が実行する行の生き残ったミュータント ${survived} 件`);
    }
    if (f.health?.flaky.length) reasons.push(`不安定なテスト：${f.health.flaky.map((x) => `${x.name}（${x.count} 回）`).join('、')}`);
    all.push({
      kind,
      file: f.path,
      reasons,
      overlapWith: kind === 'contained' ? f.bestOverlap!.with : null,
      ratio: kind === 'contained' ? f.bestOverlap!.ratio : null,
      coveredLines: f.coveredLines,
      durationMs: f.durationMs,
      spawnsChild: f.spawnsChild,
      survivedMutantsInOverlap: survived,
    });
  }
  all.sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.ratio ?? 0) - (a.ratio ?? 0) || b.durationMs - a.durationMs || byName(a.file, b.file),
  );
  const notes: string[] = [];
  const candidates = all.slice(0, opts.limit);
  if (all.length > candidates.length) notes.push(`候補を ${opts.limit} 件で切りました（${all.length - candidates.length} 件を省略）`);
  return { candidates, notes };
}

// --- 引数 ---

export interface TestPruneOptions {
  out: string | null;
  health: string | null;
  minContainment: number;
  limit: number;
  concurrency: number;
  only: string | null;
}

export function parseTestPruneArgs(args: string[]): { ok: true; value: TestPruneOptions } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value: TestPruneOptions = { out: null, health: null, minContainment: 0.95, limit: 30, concurrency: 4, only: null };
  const seen = new Set<string>();
  const positive = (name: string, v: string | undefined): number => {
    if (v === undefined || !/^[1-9]\d*$/.test(v)) {
      errors.push(`${name} は正の整数で書いてください`);
      return 0;
    }
    return Number(v);
  };
  const text = (name: string, v: string | undefined): string | null => {
    if (v === undefined || v === '' || v.startsWith('--')) {
      errors.push(`${name} には値を渡してください`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (seen.has(a)) errors.push(`${a} が2回あります`);
    seen.add(a);
    if (a === '--out') value.out = text(a, args[++i]);
    else if (a === '--health') value.health = text(a, args[++i]);
    else if (a === '--only') value.only = text(a, args[++i]);
    else if (a === '--limit') value.limit = positive(a, args[++i]);
    else if (a === '--concurrency') value.concurrency = positive(a, args[++i]);
    else if (a === '--min-containment') {
      const v = args[++i];
      const n = v !== undefined && /^(?:0|1)(?:\.\d+)?$|^\.\d+$/.test(v) ? Number(v) : NaN;
      if (!(n > 0 && n <= 1)) errors.push(`${a} は 0 より大きく 1 以下の数で書いてください`);
      else value.minContainment = n;
    } else errors.push(`知らない引数です: ${a}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
