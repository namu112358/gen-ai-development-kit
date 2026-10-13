// 必須チェック（projectChecks の context）と同じ名前の CI ジョブが検証コマンドを流すことのテスト（このリポジトリの ci.yml と導入先に配る雛形の ci.yml。Issue #983）と、
// project-check が流すコマンドの並び（projectCheckCommands）のテスト
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type HarnessConfig, projectChecks, projectCommands } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const readLines = (path: string): string[] => readFileSync(join(root, path), 'utf8').split(/\r?\n/);
const readConfig = (path: string): HarnessConfig => JSON.parse(readFileSync(join(root, path), 'utf8')) as HarnessConfig;

const indentOf = (l: string): number => l.match(/^\s*/)![0].length;
const isBlankOrComment = (l: string): boolean => l.trim() === '' || l.trim().startsWith('#');

/** トップレベルのキーの下のブロック（コメント・空行を除く） */
function topBlock(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  assert.ok(start >= 0, `トップレベルに ${key}: がありません`);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (isBlankOrComment(l)) continue;
    if (indentOf(l) === 0) break;
    out.push(l);
  }
  return out;
}

/** jobs の下のジョブ（name）のブロック（コメント・空行を除く） */
function jobBlock(lines: string[], name: string): string[] {
  const jobs = topBlock(lines, 'jobs');
  const jobIndent = Math.min(...jobs.map(indentOf));
  const start = jobs.findIndex((l) => indentOf(l) === jobIndent && l.trim() === `${name}:`);
  assert.ok(start >= 0, `jobs に ${name}: がありません`);
  const out: string[] = [];
  for (const l of jobs.slice(start + 1)) {
    if (indentOf(l) <= jobIndent) break;
    out.push(l);
  }
  return out;
}

/** ジョブの steps の各 step の run の1行（`run: <コマンド>` と `- run: <コマンド>`。複数行の run: | は除く） */
function stepRuns(job: string[]): string[] {
  return job
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter((l) => l.startsWith('run:'))
    .map((l) => l.replace(/^run:\s*/, '').replace(/\s+#.*$/, '').trim())
    .filter((r) => r !== '|' && r !== '>');
}

/** 必須チェックの各 context と同じ名前のジョブがあり、その steps に command を流す run があることを確かめる */
function assertRequiredJobsRun(lines: string[], contexts: string[], command: string, label: string): void {
  assert.ok(contexts.length > 0, `${label}：projectChecks が空です`);
  for (const context of contexts) {
    const runs = stepRuns(jobBlock(lines, context));
    assert.ok(runs.includes(command), `${label}：ジョブ ${context} に run: ${command} の step がありません（${JSON.stringify(runs)}）`);
  }
}

const TEMPLATE_CI = 'harness/templates/ci.yml';
const TEMPLATE_CONFIG = 'harness/templates/harness.config.json';
const PROJECT_CHECK = 'node harness/scripts/agent.ts project-check';

test('このリポジトリの ci.yml：projectChecks の各 context と同じ名前のジョブが project.checkCommand を流す', () => {
  const config = readConfig('harness.config.json');
  const { checkCommand } = projectCommands(config);
  assert.ok(checkCommand, 'このリポジトリの project.checkCommand が null です');
  assertRequiredJobsRun(readLines('.github/workflows/ci.yml'), projectChecks(config).map((c) => c.context), checkCommand, 'ci.yml');
});

test('雛形の ci.yml：雛形の projectChecks の各 context と同じ名前のジョブが project-check を流す', () => {
  const contexts = projectChecks(readConfig(TEMPLATE_CONFIG)).map((c) => c.context);
  assertRequiredJobsRun(readLines(TEMPLATE_CI), contexts, PROJECT_CHECK, TEMPLATE_CI);
});

test('雛形の ci.yml から project-check の step を消すと、ジョブの検査は落ちる（検査が step を見ていること）', () => {
  const contexts = projectChecks(readConfig(TEMPLATE_CONFIG)).map((c) => c.context);
  const lines = readLines(TEMPLATE_CI);
  // step の `- name: ...` と `run: <project-check>` の組、または `- run: <project-check>` を取り除く
  const at = lines.findIndex((l) => l.trim().replace(/^-\s+/, '') === `run: ${PROJECT_CHECK}`);
  assert.ok(at >= 0, `${TEMPLATE_CI} に run: ${PROJECT_CHECK} がありません`);
  const removeFrom = lines[at]!.trim().startsWith('-') ? at : at - 1;
  assert.ok(lines[removeFrom]!.trim().startsWith('-'), 'project-check の step の始まり（- ）が見つかりません');
  const without = [...lines.slice(0, removeFrom), ...lines.slice(at + 1)];
  assert.throws(() => assertRequiredJobsRun(without, contexts, PROJECT_CHECK, TEMPLATE_CI), /project-check/);
});

test('projectCheckCommands：取り込み→検証の順で、checkCommand が null なら取り込みも流さない', async () => {
  const { projectCheckCommands } = await import('../scripts/agent/commands/check-changed.ts');
  const cases: { commands: { checkCommand: string | null; installCommand: string | null }; expected: string[] }[] = [
    { commands: { checkCommand: 'npm run check', installCommand: 'npm ci' }, expected: ['npm ci', 'npm run check'] },
    { commands: { checkCommand: 'npm run check', installCommand: null }, expected: ['npm run check'] },
    { commands: { checkCommand: null, installCommand: 'npm ci' }, expected: [] },
    { commands: { checkCommand: null, installCommand: null }, expected: [] },
  ];
  for (const { commands, expected } of cases) {
    assert.deepEqual(projectCheckCommands(commands), expected, JSON.stringify(commands));
  }
});
