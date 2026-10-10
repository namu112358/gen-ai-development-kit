/**
 * 計画の files に、今の規則で一緒に変えるファイルが抜けていないかを見る（`agent.ts check` が plan で使う）。
 * Issue #466。
 * 新しく足すファイル（`*` を含まず、リポジトリに今無いパス）から、次の規則で抜けを求める。
 *   1. harness/scripts/agent/commands/<名前>.ts を足す → harness/test/agent-commands.test.ts
 *   2. harness/scripts/agent.ts があり commands/ の下の項目が無い → commands/<名前>.ts と agent-commands.test.ts
 *   3. harness/test 直下に表のパターンに当たらない *.test.ts を足す → harness/test/README.md
 *   4. README の表を生成するディレクトリの直下に足す → そのディレクトリの README（readme.ts と同じ範囲）
 * 一緒に変えるファイルは、files のどれかと同じ文字列か、files の glob に当たれば足りているとみなす。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { globToRegExp } from '../lib/scope.ts';
import { NO_GENERATE_DIRS, namesInTable, readmeFileFor, TARGET_DIRS, TEST_PATTERN_DIR, uncoveredTests } from './readme.ts';

export interface CompanionRepo {
  exists(relPath: string): boolean;
  testPatterns(): string[];
}

export interface MissingCompanion {
  file: string;
  reason: string;
}

const COMMANDS_DIR = 'harness/scripts/agent/commands/';
const COMMANDS_TEST = 'harness/test/agent-commands.test.ts';
const COMMAND_EXAMPLE = `${COMMANDS_DIR}<名前>.ts`;

export function missingCompanions(files: string[], repo: CompanionRepo): MissingCompanion[] {
  const out: MissingCompanion[] = [];
  const have = (path: string): boolean => files.some((f) => f === path || (f.includes('*') && globToRegExp(f).test(path)));
  const add = (file: string, reason: string): void => {
    if (!have(file) && !out.some((m) => m.file === file)) out.push({ file, reason });
  };
  const added = files.filter((f) => !f.includes('*') && !repo.exists(f));

  // 規則1
  for (const f of added) {
    if (/^harness\/scripts\/agent\/commands\/[^/]+\.ts$/.test(f)) add(COMMANDS_TEST, `${f} を足すと agent-commands.test.ts の ADDED_AFTER_SPLIT に足す必要がある`);
  }
  // 規則2
  if (files.includes('harness/scripts/agent.ts') && !files.some((f) => f.startsWith(COMMANDS_DIR))) {
    add(COMMAND_EXAMPLE, 'agent.ts は振り分けだけでコマンドを持たない。<名前> は足すコマンドのまとまりの名前にする');
    add(COMMANDS_TEST, 'コマンドを足すと agent-commands.test.ts の ADDED_AFTER_SPLIT に足す必要がある');
  }
  // 規則3
  for (const f of added) {
    const m = /^harness\/test\/([^/]+\.test\.ts)$/.exec(f);
    if (m && uncoveredTests(repo.testPatterns(), [m[1]!]).length > 0) {
      add(`${TEST_PATTERN_DIR}/README.md`, `${f} のファイル名が harness/test/README.md の表のどのパターンにも当たらない`);
    }
  }
  // 規則4
  for (const f of added) {
    const parts = f.split('/');
    const name = parts.pop()!;
    if (name === 'README.md') continue;
    let dir = parts.join('/');
    while (dir !== '' && !repo.exists(dir)) dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
    if (!TARGET_DIRS.includes(dir) || NO_GENERATE_DIRS.includes(dir)) continue;
    const readme = relative('.', readmeFileFor('.', dir)).split(sep).join('/');
    add(readme, `${dir}/ に ${name} を足すと README の表に行が要る（node harness/scripts/readme.ts write）`);
  }
  return out;
}

export function repoAt(root: string): CompanionRepo {
  return {
    exists: (p) => existsSync(join(root, ...p.split('/'))),
    testPatterns: () => {
      const readme = join(root, ...TEST_PATTERN_DIR.split('/'), 'README.md');
      return existsSync(readme) ? namesInTable(readFileSync(readme, 'utf8')) : [];
    },
  };
}

export function findRepoRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || cwd;
  } catch {
    return cwd;
  }
}
