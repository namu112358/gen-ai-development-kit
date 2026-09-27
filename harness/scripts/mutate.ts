/**
 * テストが効いているかを確かめる（mutation）。PR で変えた実装の行を1箇所ずつ少しだけ壊してテストを動かし、
 * 壊してもテストが落ちなかった箇所（survived）を一覧にする。
 *
 *   node harness/scripts/mutate.ts [--base <ref>] [--max-mutants 30] [--max-minutes 15] [--test-timeout-seconds 90]
 *
 * 比べる範囲は `git diff -U0 <base> HEAD`（既定の base は HEAD^1。pull_request の checkout はマージコミットなので第1親が base）。
 * 壊したファイルは、1回ごとに finally で（止められたときはシグナルの処理で）元に戻す。
 *
 * 限界：
 * - 結果は PR 側のコードと YAML（.github/workflows/ci.yml の mutation ジョブ）が決めるので、PR を出した側が偽れる。
 *   情報のためだけに出す。自動 Merge の条件や App の `agent/*` チェックの代わりにはしない
 *   （条件にするなら、PR 側のコードに左右されない信頼できる実行が別に要る）。
 * - 実行時間（--max-minutes。ベースラインのテストも含む）と壊す箇所の数（--max-mutants）に上限を置き、超えた分は試さない。
 *   打ち切っても、落ちなかった箇所があっても、ベースラインのテストが落ちても終了コードは 0（テストの失敗は ci ジョブが出す）。
 * - 行単位の単純な置き換えなので、型だけの誤り・等価な変更（壊しても意味が変わらないもの）・複数行にまたがる式は見ない。
 *   文字列・テンプレートリテラル・コメントの中は壊さないが、正規表現リテラルは見分けない。
 *
 * CLI の部分は `import.meta.main` の中だけで動く（テストが import しても何も動かない）。
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.ts';
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

/** 結果を Markdown にする */
export function renderReport(plan: MutantPlan, run: RunResult): string {
  const tried = run.caught.length + run.survived.length;
  const lines = [REPORT_TITLE, '', REPORT_NOTE, ''];
  lines.push(`- 試した数：${tried}（壊し方の候補 ${plan.total}）`);
  lines.push(`- テストが落ちた（caught）：${run.caught.length}`);
  lines.push(`- テストが落ちなかった（survived）：${run.survived.length}`);
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

// ---- CLI（import.meta.main の中だけで動く） ----

const TEST_ARGS = ['--test', 'harness/test/**/*.test.ts'];

function parseArgs(argv: string[]): { base: string; maxMutants: number; maxMinutes: number; testTimeoutSeconds: number } {
  const opts = { base: 'HEAD^1', maxMutants: 30, maxMinutes: 15, testTimeoutSeconds: 90 };
  for (let i = 0; i < argv.length; i++) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`${key} の値がありません`);
    if (key === '--base') opts.base = value;
    else if (key === '--max-mutants') opts.maxMutants = Number(value);
    else if (key === '--max-minutes') opts.maxMinutes = Number(value);
    else if (key === '--test-timeout-seconds') opts.testTimeoutSeconds = Number(value);
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
function runTests(timeoutMs: number, inherit: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, TEST_ARGS, { stdio: inherit ? 'inherit' : 'ignore', detached: true });
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
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
    diff = execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', opts.base, 'HEAD'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    report(renderSkipped(`比べる範囲（${opts.base}..HEAD）の差分が読めませんでした。`));
    return;
  }
  const config = loadConfig();
  const targets = selectTargets(parseChangedLines(diff), config.testPatterns ?? DEFAULT_TEST_PATTERNS).filter((t) => {
    // 作業ツリーの行が差分の行と同じものだけ（HEAD 以外を見ていると位置がずれる）
    try {
      return readFileSync(t.file, 'utf8').split('\n')[t.line - 1] === t.text;
    } catch {
      return false;
    }
  });
  const plan = planMutants(targets, opts.maxMutants);
  if (plan.total === 0) {
    report(renderReport(plan, { caught: [], survived: [], notRun: 0, truncated: null }));
    return;
  }

  console.log(`ベースラインのテストを動かします（候補 ${plan.total}、試す上限 ${plan.mutants.length}）`);
  if (!(await runTests(deadline - Date.now(), true))) {
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
        const passed = await runTests(opts.testTimeoutSeconds * 1000, false);
        const outcome: Outcome = passed ? 'survived' : 'caught';
        console.log(`${outcome}\t${m.file}:${m.line}\t${m.operator}`);
        return outcome;
      } finally {
        restorePending();
      }
    },
    { deadline, now: Date.now },
  );
  report(renderReport(plan, run));
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
