import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * 変更したファイルに関係するテストを選ぶ（相対 import をたどる）。mutation（壊したファイル）と check-changed（変更したファイル）が共有する。
 * 関係するテストが分からない変更は全体を流す側に倒す。
 */
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

export const ALL_TESTS = 'harness/test/**/*.test.ts';
/** これを超える数のテストファイルは並べず全体で流す（コマンドラインの長さの上限を避ける） */
export const MAX_LISTED_TESTS = 100;

/** node に渡す引数。関係するテストが無い・多すぎるときは全体 */
export function testArgsFor(related: string[]): string[] {
  if (related.length === 0 || related.length > MAX_LISTED_TESTS) return ['--test', ALL_TESTS];
  return ['--test', ...related];
}

/** 変更があれば全体を流すパス（多くのテストが依存する土台。コードは relatedTestFiles が推移的な import で拾うので入れない） */
export const FULL_RUN_PATHS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'harness.config.json',
  '.node-version',
  'harness/test/support/',
];

/** リポジトリの .ts・.js・.mjs（未追跡の新規ファイルも含む）を読む。tests は harness/test/**.test.ts */
export function readSources(): { sources: Map<string, string>; tests: string[] } {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.js', '*.mjs'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const sources = new Map<string, string>();
  for (const f of listed) {
    try {
      sources.set(f, readFileSync(f, 'utf8'));
    } catch {
      // 消えたファイルは読まない
    }
  }
  const tests = listed.filter((f) => TEST_FILE.test(f));
  return { sources, tests };
}

const TEST_FILE = /^harness\/test\/.*\.test\.ts$/;
const CODE_FILE = /\.(?:ts|js|mjs)$/;

export type ChangedTestPlan =
  | { mode: 'all'; reason: string; changed: string[] }
  | { mode: 'subset'; tests: string[]; changed: string[]; perFile: Map<string, string[]> };

/** 変更ファイルの一覧から流すテストを決める。関係するテストが分からなければ全体 */
export function changedTestPlan(changed: string[], sources: Map<string, string>, testFiles: string[]): ChangedTestPlan {
  if (changed.length === 0) return { mode: 'all', reason: '変更なし', changed };
  const base = changed.find((f) => FULL_RUN_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  if (base !== undefined) return { mode: 'all', reason: `土台のファイルの変更（${base}）`, changed };
  const code = changed.filter((f) => CODE_FILE.test(f));
  if (code.length === 0) return { mode: 'all', reason: 'コードの変更なし', changed };
  const tests = new Set<string>();
  const perFile = new Map<string, string[]>();
  for (const f of code) {
    if (TEST_FILE.test(f)) {
      tests.add(f);
      continue;
    }
    if (!sources.has(f)) return { mode: 'all', reason: `ファイルが読めない（${f}）`, changed };
    const related = relatedTestFiles(f, sources, testFiles);
    if (related.length === 0) return { mode: 'all', reason: `関係するテストが見つからない（${f}）`, changed };
    perFile.set(f, related);
    for (const t of related) tests.add(t);
  }
  const list = [...tests].sort();
  if (list.length > MAX_LISTED_TESTS) return { mode: 'all', reason: `関係するテストが ${MAX_LISTED_TESTS} 件を超える`, changed };
  return { mode: 'subset', tests: list, changed, perFile };
}

/** 標準出力の1行目 */
export function changedSummaryLine(plan: ChangedTestPlan): string {
  return plan.mode === 'subset' ? `流すテスト：${plan.tests.length} 件（変更 ${plan.changed.length} ファイル）` : `流すテスト：全体（${plan.reason}）`;
}
