/**
 * テストが効いているかを確かめる（mutation）。PR で変えた実装の行を1箇所ずつ少しだけ壊してテストを動かし、
 * 壊してもテストが落ちなかった箇所（survived）を一覧にする。
 *
 *   node harness/scripts/mutate.ts [--base <ref>] [--max-mutants 30] [--max-minutes 15] [--test-timeout-seconds 90]
 *   node harness/scripts/mutate.ts --check-targets [--base <ref>]
 *   node harness/scripts/mutate.ts --report-cached <record.json>
 *   node harness/scripts/mutate.ts [...] --record <record.json>
 *
 * 比べる範囲は `git diff -U0 <base> HEAD`（既定の base は HEAD^1。pull_request の checkout はマージコミットなので第1親が base）。
 * 壊したファイルは、1回ごとに finally で（止められたときはシグナルの処理で）元に戻す。
 * `--check-targets` は壊す候補があるかだけを数え、`GITHUB_OUTPUT` に `has-targets=true|false` を書く（テストは動かさない）。
 * ci の mutation ジョブが npm ci の前に動かすので、このファイルと import 先は実行時に npm の依存を読まない（Node の組み込みだけ）。
 *
 * 前の結果の再利用（main の取り込みだけの push で本体を省く）：`--check-targets` は has-targets=true のとき、PR 自身の差分
 * （`git diff <base> HEAD` の patch-id）から `patch-key=mutation-v1-<patch-id>` も GITHUB_OUTPUT に書く。ci はこれを actions/cache の鍵にする。
 * `--record <path>` は本体が結果の報告まで行ったときだけ、前の実行の URL・PR の head・survived の行を JSON で書き、書けたら `recorded=true` を書く。
 * `--report-cached <path>` は鍵が当たったときに、その記録から省いた旨の Summary を出し、survived の行（`survived<TAB><場所><TAB><壊し方>`）を
 * 標準出力に出し直す（ジョブのログを読む report.ts・test-health.ts が、省いた実行からも前と同じ行を読めるように。ログの形は変えない）。
 *
 * 限界：
 * - 結果は PR 側のコードと YAML（.github/workflows/ci.yml の mutation ジョブ）が決めるので、PR を出した側が偽れる。
 *   情報のためだけに出す。自動 Merge の条件や App の `agent/*` チェックの代わりにはしない
 *   （条件にするなら、PR 側のコードに左右されない信頼できる実行が別に要る）。
 * - 実行時間（--max-minutes。ベースラインのテストも含む）と壊す箇所の数（--max-mutants）に上限を置き、超えた分は試さない。
 *   打ち切っても、落ちなかった箇所があっても、ベースラインのテストが落ちても終了コードは 0（テストの失敗は ci ジョブが出す）。
 * - 行単位の単純な置き換えなので、型だけの誤り・等価な変更（壊しても意味が変わらないもの）・複数行にまたがる式は見ない。
 *   文字列・テンプレートリテラル・コメントの中は壊さないが、正規表現リテラルは見分けない。
 * - 1か所ごとに流すのは、壊したファイルに関係するテストだけ（relatedTestFiles）。静的な相対 import をたどるのと、
 *   テストの本文でのパス・引用符で囲んだファイル名への言及だけを見る。ディレクトリを読み込んで動的に import するもの
 *   （agent.ts が harness/scripts/agent/commands/ を読む形）は、本文で触れていなければ拾えず、survived が増えることがある。
 *   パスを join('harness', 'scripts', 'x.ts') のように分けて書くテストは、'x.ts' が本文にあれば拾える。
 *   よくある名前（'config.ts' など）では関係するテストが多めに出て、時間があまり縮まないことがある（多めに流す側に倒れる）。
 *   関係するテストが見つからないファイルは、テスト全体で試す。
 *
 * CLI の部分は `import.meta.main` の中だけで動く（テストが import しても何も動かない）。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { DEFAULT_TEST_PATTERNS, isTestFile } from '../lib/test-tamper.ts';

export interface ChangedLine {
  file: string;
  /** 新しい側の行番号（1 から） */
  line: number;
  text: string;
}

export interface MutantEdit {
  /** 壊し方（例 `=== → !==`） */
  operator: string;
  /** 壊した後の行 */
  text: string;
}

export interface Mutant {
  file: string;
  line: number;
  original: string;
  mutated: string;
  operator: string;
}

export interface MutantPlan {
  mutants: Mutant[];
  /** 上限で切る前の mutant の数 */
  total: number;
  truncated: 'count' | null;
}

export type Outcome = 'caught' | 'survived';

export interface RunResult {
  caught: Mutant[];
  survived: Mutant[];
  /** 期限を過ぎて試さなかった数 */
  notRun: number;
  truncated: 'time' | null;
}

/** `git diff -U0` の出力から、ファイルごとに足した・変えた行（新しい側）を取り出す。消しただけの行・リネームだけ・バイナリは無い */
export function parseChangedLines(diff: string): ChangedLine[] {
  const out: ChangedLine[] = [];
  let file: string | null = null;
  let next = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/\t.*$/, '');
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      inHunk = true;
      next = Number(hunk[1]);
      continue;
    }
    if (!inHunk || file === null) continue;
    if (raw.startsWith('+')) {
      out.push({ file, line: next, text: raw.slice(1) });
      next++;
    } else if (raw.startsWith(' ')) {
      next++;
    }
  }
  return out;
}

const COMMENT_ONLY = /^\s*(?:\/\/|\/\*|\*|$)/;
const IMPORT_OR_REEXPORT = /^\s*(?:import\b|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\b|export\s+\{[^}]*\}\s*;?\s*$)/;
const TYPE_ONLY = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\b|type\s+\w+(?:<[^=]*>)?\s*=)/;

/** 実装の行だけを残す（テストファイル・.ts/.js 以外・.d.ts・空行・コメントだけの行・import・再 export・型だけの行を外す） */
export function selectTargets(changed: ChangedLine[], testPatterns: string[]): ChangedLine[] {
  return changed.filter(
    (c) =>
      /\.(?:ts|js)$/.test(c.file) &&
      !c.file.endsWith('.d.ts') &&
      !isTestFile(testPatterns, c.file) &&
      !COMMENT_ONLY.test(c.text) &&
      !IMPORT_OR_REEXPORT.test(c.text) &&
      !TYPE_ONLY.test(c.text),
  );
}

/** 文字列・テンプレートリテラル・コメントの中を \0 で塗りつぶした行（位置は元の行と同じ） */
function maskNonCode(text: string): string {
  // 位置を元の行と揃えるため、UTF-16 の単位で扱う
  const s = text.split('');
  const out = s.slice();
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
      const end = Math.min(j, s.length - 1);
      for (let k = i; k <= end; k++) out[k] = '\0';
      i = end + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      for (let k = i; k < s.length; k++) out[k] = '\0';
      break;
    }
    if (c === '/' && s[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? s.length - 1 : close + 1;
      for (let k = i; k <= end; k++) out[k] = '\0';
      i = end + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

interface Rule {
  re: RegExp;
  replace: (match: string) => string;
  name: (match: string) => string;
}

const swap = (pairs: Record<string, string>) => (m: string) => pairs[m] ?? m;

const COMPARE: Record<string, string> = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
const RELATIONAL: Record<string, string> = { ' < ': ' >= ', ' >= ': ' < ', ' > ': ' <= ', ' <= ': ' > ' };
const LOGICAL: Record<string, string> = { '&&': '||', '||': '&&', true: 'false', false: 'true' };
const ARITH: Record<string, string> = { ' + ': ' - ', ' - ': ' + ', ' * ': ' / ', ' / ': ' * ' };

const RULES: Rule[] = [
  // `===` と `!==` を先に取り、`==` / `!=` はその一部でないものだけ
  { re: /[=!]==|(?<![=!<>])[=!]=(?!=)/g, replace: swap(COMPARE), name: (m) => `${m} → ${COMPARE[m]}` },
  // `<` `>` は前後に空白があるときだけ（ジェネリクスや矢印関数を壊さない）
  { re: / (?:<|>|<=|>=) /g, replace: swap(RELATIONAL), name: (m) => `${m.trim()} → ${RELATIONAL[m]!.trim()}` },
  { re: /&&|\|\||\btrue\b|\bfalse\b/g, replace: swap(LOGICAL), name: (m) => `${m} → ${LOGICAL[m]}` },
  { re: / [+\-*/] /g, replace: swap(ARITH), name: (m) => `${m.trim()} → ${ARITH[m]!.trim()}` },
];

const RETURN_VALUE = /\breturn\s+[^;{}]+;/g;

/** 1行から壊し方の一覧を作る。1箇所ずつ壊した行を1つずつ返す（文字列・テンプレートリテラル・行末コメントの中は壊さない） */
export function mutantsForLine(text: string): MutantEdit[] {
  const masked = maskNonCode(text);
  const edits: MutantEdit[] = [];
  const found: { index: number; length: number; replacement: string; operator: string }[] = [];
  for (const rule of RULES) {
    for (const m of masked.matchAll(rule.re)) {
      found.push({ index: m.index, length: m[0].length, replacement: rule.replace(m[0]), operator: rule.name(m[0]) });
    }
  }
  for (const m of masked.matchAll(RETURN_VALUE)) {
    found.push({ index: m.index, length: m[0].length, replacement: 'return;', operator: 'return X → return' });
  }
  found.sort((a, b) => a.index - b.index);
  for (const f of found) {
    edits.push({ operator: f.operator, text: text.slice(0, f.index) + f.replacement + text.slice(f.index + f.length) });
  }
  return edits;
}

/** 各行から1つずつ、次に2つ目…の順で選び（同じ行に偏らない）、上限で切る */
export function planMutants(targets: ChangedLine[], maxMutants: number): MutantPlan {
  const perLine = targets.map((t) =>
    mutantsForLine(t.text).map((e): Mutant => ({ file: t.file, line: t.line, original: t.text, mutated: e.text, operator: e.operator })),
  );
  const total = perLine.reduce((n, l) => n + l.length, 0);
  const ordered: Mutant[] = [];
  for (let round = 0; ordered.length < total; round++) {
    for (const l of perLine) if (round < l.length) ordered.push(l[round]!);
  }
  const max = Math.max(0, Math.floor(maxMutants));
  return { mutants: ordered.slice(0, max), total, truncated: total > max ? 'count' : null };
}

/** 順に動かして caught / survived に分ける。期限（deadline、now() と同じ単位）を過ぎたら次を始めない */
export async function runMutants(
  mutants: Mutant[],
  runOne: (m: Mutant) => Outcome | Promise<Outcome>,
  opts: { deadline: number; now: () => number },
): Promise<RunResult> {
  const result: RunResult = { caught: [], survived: [], notRun: 0, truncated: null };
  for (let i = 0; i < mutants.length; i++) {
    if (opts.now() >= opts.deadline) {
      result.truncated = 'time';
      result.notRun = mutants.length - i;
      break;
    }
    const m = mutants[i]!;
    ((await runOne(m)) === 'caught' ? result.caught : result.survived).push(m);
  }
  return result;
}

const code = (s: string): string => '`' + s.trim().replace(/`/g, "'") + '`';

export const REPORT_TITLE = '## mutation（テストが効いているか）';
const REPORT_NOTE = '> 情報のためだけの結果です（PR 側のコードが決めるので偽れます）。自動 Merge の条件や `agent/*` のチェックには使いません。';

/** 結果を Markdown にする。narrowing は、関係するテストだけで試したファイルと、全体で試したファイルの数 */
export function renderReport(plan: MutantPlan, run: RunResult, narrowing?: { narrowed: number; fullSuite: number }): string {
  const tried = run.caught.length + run.survived.length;
  const lines = [REPORT_TITLE, '', REPORT_NOTE, ''];
  lines.push(`- 試した数：${tried}（壊し方の候補 ${plan.total}）`);
  lines.push(`- テストが落ちた（caught）：${run.caught.length}`);
  lines.push(`- テストが落ちなかった（survived）：${run.survived.length}`);
  if (narrowing) {
    lines.push(`- 関係するテストだけで試したファイル：${narrowing.narrowed}`);
    lines.push(`- 関係するテストが見つからず全体で試したファイル：${narrowing.fullSuite}`);
  }
  const remaining = plan.total - tried;
  if (plan.truncated === 'count') lines.push(`- 打ち切り：壊す箇所の数の上限（${plan.mutants.length}）に達しました。`);
  if (run.truncated === 'time') lines.push(`- 打ち切り：時間の上限に達しました（上限の中で ${run.notRun} 件を試していません）。`);
  if (plan.truncated || run.truncated) lines.push(`- 試さなかった残り：${remaining}`);
  lines.push('');
  if (run.survived.length === 0) {
    lines.push(tried === 0 ? '試した変更はありません。' : '壊してもテストが落ちなかった変更はありません。');
  } else {
    lines.push('### 壊してもテストが落ちなかった変更', '', '| 場所 | 壊し方 | 元の行 | 壊した後の行 |', '| --- | --- | --- | --- |');
    for (const m of run.survived) {
      const cell = (s: string) => code(s).replace(/\|/g, '\\|');
      lines.push(`| ${m.file}:${m.line} | ${cell(m.operator)} | ${cell(m.original)} | ${cell(m.mutated)} |`);
    }
  }
  return lines.join('\n') + '\n';
}

/** 試す前に止めたときの Markdown（ベースラインのテストが落ちた、比べる範囲が読めない、など） */
export function renderSkipped(reason: string): string {
  return [REPORT_TITLE, '', REPORT_NOTE, '', `試していません：${reason}`, ''].join('\n');
}

/** 前の結果を引くキャッシュの鍵。PR 自身の差分の patch-id（行番号を無視する）で決める */
export function mutationCacheKey(diff: string): string {
  return `mutation-v1-${patchId(diff)}`;
}

/** --check-targets の結果：GITHUB_OUTPUT に書く行と、候補が無いときの Summary。key があれば候補があるときに patch-key も書く */
export function checkTargetsResult(total: number, key?: string | null): { output: string; summary: string | null } {
  if (total > 0) return { output: key ? `has-targets=true\npatch-key=${key}\n` : 'has-targets=true\n', summary: null };
  return { output: 'has-targets=false\n', summary: renderSkipped('実装の .ts・.js の変更がありません（npm ci と mutation を省きました）。') };
}

/** ログに出す survived の行。harness/lib/test-health.ts の parseSurvivedMutants が読む形 */
export function survivedLine(m: Mutant): string {
  return `survived\t${m.file}:${m.line}\t${m.operator}`;
}

/** 前に本体を最後まで走らせた記録（actions/cache に置く） */
export interface MutationRecord {
  runUrl: string;
  head: string;
  /** `survived<TAB><file>:<line><TAB><operator>` の行 */
  survived: string[];
}

const SURVIVED_LINE = /^survived\t.+:\d+\t.+$/;

/** 記録を読む。形が違えば null */
export function parseRecord(text: string): MutationRecord | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null) return null;
    const { runUrl, head, survived } = v as Record<string, unknown>;
    if (typeof runUrl !== 'string' || runUrl === '' || typeof head !== 'string' || head === '') return null;
    if (!Array.isArray(survived) || !survived.every((l) => typeof l === 'string' && SURVIVED_LINE.test(l))) return null;
    return { runUrl, head, survived: survived as string[] };
  } catch {
    return null;
  }
}

/** 鍵が当たって本体を省いたときの Summary と、ログに出し直す survived の行 */
export function renderCachedSkip(record: MutationRecord | null): { summary: string; log: string[] } {
  const reason = 'PR 自身の差分（patch-id）が、前に mutation を走らせた head と同じです（main の取り込みだけの push）。npm ci と mutation を省きました。';
  const previous = record
    ? `前の実行：${record.runUrl}（head ${record.head}、survived ${record.survived.length} 件）`
    : '前の実行の記録が読めませんでした。';
  return {
    summary: [REPORT_TITLE, '', REPORT_NOTE, '', `試していません：${reason}`, '', previous, ''].join('\n'),
    log: record?.survived ?? [],
  };
}

/** 候補があるか。数えられなかった（例外）ときは、黙って mutation を省かないように true */
export function hasTargetsSafely(count: () => number): boolean {
  try {
    return count() > 0;
  } catch {
    return true;
  }
}

/** 相対 import（`from '…'`・`import '…'`・`import('…')`）の指定。`.` で始まるものだけ */
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** file の本文にある相対 import を、リポジトリからの相対パス（`/` 区切り）にして返す */
function importsOf(file: string, body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(RELATIVE_IMPORT)) out.push(posix.normalize(posix.join(posix.dirname(file), m[1]!)));
  return out;
}

/**
 * target（壊したファイル）に関係するテストファイルをパスの昇順で返す。
 * テストファイルから相対 import を推移的にたどって target に届くか、テストの本文に target のパスか
 * 引用符で囲んだファイル名があれば関係する（子プロセスで動かすテストを拾うため）。
 */
export function relatedTestFiles(target: string, sources: Map<string, string>, testFiles: string[]): string[] {
  const name = posix.basename(target);
  const mentions = (body: string) => body.includes(target) || body.includes(`'${name}'`) || body.includes(`"${name}"`);
  const out: string[] = [];
  for (const test of testFiles) {
    const body = sources.get(test) ?? '';
    if (mentions(body)) {
      out.push(test);
      continue;
    }
    const seen = new Set<string>([test]);
    const stack = importsOf(test, body);
    let found = false;
    while (stack.length > 0 && !found) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (file === target) found = true;
      else stack.push(...importsOf(file, sources.get(file) ?? ''));
    }
    if (found) out.push(test);
  }
  return out.sort();
}

const ALL_TESTS = 'harness/test/**/*.test.ts';
/** これを超える数のテストファイルは並べず全体で流す（コマンドラインの長さの上限を避ける） */
const MAX_LISTED_TESTS = 100;

/** node に渡す引数。関係するテストが無い・多すぎるときは全体 */
export function testArgsFor(related: string[]): string[] {
  if (related.length === 0 || related.length > MAX_LISTED_TESTS) return ['--test', ALL_TESTS];
  return ['--test', ...related];
}

/** ベースラインで流すテスト。どれかのファイルが全体で試すなら []（全体）、そうでなければ和集合 */
export function baselineTests(perFile: Map<string, string[]>): string[] {
  const all = new Set<string>();
  for (const related of perFile.values()) {
    if (related.length === 0) return [];
    for (const t of related) all.add(t);
  }
  return [...all].sort();
}

// ---- CLI（import.meta.main の中だけで動く） ----

interface Options {
  base: string;
  maxMutants: number;
  maxMinutes: number;
  testTimeoutSeconds: number;
  checkTargets: boolean;
  reportCached: string | null;
  record: string | null;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { base: 'HEAD^1', maxMutants: 30, maxMinutes: 15, testTimeoutSeconds: 90, checkTargets: false, reportCached: null, record: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check-targets') {
      // 値を取らないフラグ
      opts.checkTargets = true;
      continue;
    }
    const [key, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${key} の値がありません`);
    if (key === '--base') opts.base = value;
    else if (key === '--max-mutants') opts.maxMutants = Number(value);
    else if (key === '--max-minutes') opts.maxMinutes = Number(value);
    else if (key === '--test-timeout-seconds') opts.testTimeoutSeconds = Number(value);
    else if (key === '--report-cached') opts.reportCached = value;
    else if (key === '--record') opts.record = value;
    else throw new Error(`知らない引数：${key}`);
    i++;
  }
  for (const [k, v] of Object.entries(opts)) if (typeof v === 'number' && !(v >= 0)) throw new Error(`${k} が数ではありません`);
  return opts;
}

/** 動いているテストのプロセス（シグナルで止められたときに片付ける） */
let running: ChildProcess | null = null;
/** 書き換え中のファイル（シグナルで止められたときに戻す） */
let pending: { path: string; content: string } | null = null;

function killRunning(): void {
  if (running?.pid !== undefined && running.exitCode === null) {
    try {
      process.kill(-running.pid, 'SIGKILL');
    } catch {
      // 既に終わっている
    }
  }
}

/** テストを動かし、通ったら true。timeoutMs を過ぎたら止めて false */
function runTests(args: string[], timeoutMs: number, inherit: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: inherit ? 'inherit' : 'ignore', detached: true });
    running = child;
    const timer = setTimeout(killRunning, Math.max(1, timeoutMs));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (status) => {
      clearTimeout(timer);
      running = null;
      resolve(status === 0);
    });
  });
}

function restorePending(): void {
  if (pending) {
    writeFileSync(pending.path, pending.content);
    pending = null;
  }
}

function report(markdown: string): void {
  process.stdout.write(markdown);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, markdown);
}

/** PR 自身の差分（文脈つき）。鍵に使う。git の設定の影響を受けない引数（harness/lib/patch-id.ts の prDiffLocal と同じ。ただし 3 点でなく `<base> HEAD`） */
function readFullDiff(base: string): string {
  return execFileSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, 'HEAD'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function readDiff(base: string): string {
  return execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', base, 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** 差分から壊す候補の行を選ぶ（作業ツリーの行が差分の行と同じものだけ） */
function changedTargets(diff: string): ChangedLine[] {
  const config = loadConfig();
  return selectTargets(parseChangedLines(diff), config.testPatterns ?? DEFAULT_TEST_PATTERNS).filter((t) => {
    // 作業ツリーの行が差分の行と同じものだけ（HEAD 以外を見ていると位置がずれる）
    try {
      return readFileSync(t.file, 'utf8').split('\n')[t.line - 1] === t.text;
    } catch {
      return false;
    }
  });
}

/** 壊すファイルごとに関係するテストを1回だけ求める（リポジトリの .ts・.js・.mjs を読む） */
function relatedTestsByFile(mutants: Mutant[]): Map<string, string[]> {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.js', '*.mjs'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const sources = new Map<string, string>();
  for (const f of listed) {
    try {
      sources.set(f, readFileSync(f, 'utf8'));
    } catch {
      // 消えたファイルは読まない
    }
  }
  const tests = listed.filter((f) => /^harness\/test\/.*\.test\.ts$/.test(f));
  const perFile = new Map<string, string[]>();
  for (const m of mutants) if (!perFile.has(m.file)) perFile.set(m.file, relatedTestFiles(m.file, sources, tests));
  return perFile;
}

/** --check-targets：候補があるかを GITHUB_OUTPUT に書く。数えられなければ true（本体の実行に任せる） */
function checkTargets(base: string): void {
  const has = hasTargetsSafely(() => {
    process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
    return planMutants(changedTargets(readDiff(base)), 1).total;
  });
  // 鍵を求められなければ出さない（キャッシュを見ず、今までどおり走る）
  let key: string | null = null;
  if (has) {
    try {
      key = mutationCacheKey(readFullDiff(base));
    } catch {
      key = null;
    }
  }
  const result = checkTargetsResult(has ? 1 : 0, key);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, result.output);
  process.stdout.write(result.output);
  if (result.summary) report(result.summary);
}

/** --report-cached：記録から省いた旨の Summary を出し、survived の行をログに出し直す（テストは動かさない） */
function reportCached(path: string): void {
  let record: MutationRecord | null = null;
  try {
    record = parseRecord(readFileSync(path, 'utf8'));
  } catch {
    record = null;
  }
  const skip = renderCachedSkip(record);
  for (const line of skip.log) console.log(line);
  report(skip.summary);
}

/** --record：本体が結果を報告した後に記録を書く。書けたら GITHUB_OUTPUT に recorded=true。書けなくても失敗にしない */
function writeRecord(path: string, survived: Mutant[]): void {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  if (!server || !repository || !runId || !attempt) return;
  try {
    let head: string;
    try {
      head = execFileSync('git', ['rev-parse', 'HEAD^2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    }
    const record: MutationRecord = {
      runUrl: `${server}/${repository}/actions/runs/${runId}/attempts/${attempt}`,
      head,
      survived: survived.map(survivedLine),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
    const output = process.env.GITHUB_OUTPUT;
    if (output) appendFileSync(output, 'recorded=true\n');
  } catch {
    // 記録は省くための材料なので、書けなければ次の実行で走る
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.checkTargets) {
    checkTargets(opts.base);
    return;
  }
  if (opts.reportCached !== null) {
    reportCached(opts.reportCached);
    return;
  }
  const started = Date.now();
  const deadline = started + opts.maxMinutes * 60_000;
  process.chdir(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killRunning();
      restorePending();
      process.exit(130);
    });
  }

  let diff: string;
  try {
    diff = readDiff(opts.base);
  } catch {
    report(renderSkipped(`比べる範囲（${opts.base}..HEAD）の差分が読めませんでした。`));
    return;
  }
  const targets = changedTargets(diff);
  const plan = planMutants(targets, opts.maxMutants);
  if (plan.total === 0) {
    report(renderReport(plan, { caught: [], survived: [], notRun: 0, truncated: null }));
    if (opts.record !== null) writeRecord(opts.record, []);
    return;
  }

  const perFile = relatedTestsByFile(plan.mutants);
  const fullSuite = [...perFile.values()].filter((r) => testArgsFor(r)[1] === ALL_TESTS).length;
  const narrowing = { narrowed: perFile.size - fullSuite, fullSuite };

  console.log(`ベースラインのテストを動かします（候補 ${plan.total}、試す上限 ${plan.mutants.length}）`);
  if (!(await runTests(testArgsFor(baselineTests(perFile)), deadline - Date.now(), true))) {
    report(renderSkipped('変更前のテスト（ベースライン）が通りませんでした（時間の上限を超えた場合を含む）。テストの失敗は ci ジョブを見てください。'));
    return;
  }

  const run = await runMutants(
    plan.mutants,
    async (m) => {
      const content = readFileSync(m.file, 'utf8');
      const lines = content.split('\n');
      lines[m.line - 1] = m.mutated;
      pending = { path: m.file, content };
      try {
        writeFileSync(m.file, lines.join('\n'));
        const passed = await runTests(testArgsFor(perFile.get(m.file) ?? []), opts.testTimeoutSeconds * 1000, false);
        const outcome: Outcome = passed ? 'survived' : 'caught';
        console.log(outcome === 'survived' ? survivedLine(m) : `caught\t${m.file}:${m.line}\t${m.operator}`);
        return outcome;
      } finally {
        restorePending();
      }
    },
    { deadline, now: Date.now },
  );
  report(renderReport(plan, run, narrowing));
  if (opts.record !== null) writeRecord(opts.record, run.survived);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    restorePending();
    // 情報のためのジョブなので、上限の打ち切りや想定外の失敗でも 0 で終え、理由を出す
    report(renderSkipped(`想定外のエラー：${e instanceof Error ? e.message : String(e)}`));
  }
  process.exit(0);
}
