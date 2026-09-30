// mutate.ts の --check-targets（実装の .ts・.js の変更が無い PR で mutation ジョブを省くかの判定）のテスト
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTargetsResult, hasTargetsSafely, REPORT_TITLE } from '../scripts/mutate.ts';

const mutateScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mutate.ts');

test('checkTargetsResult：候補が 0 なら has-targets=false と、対象が無い旨の Summary', () => {
  const r = checkTargetsResult(0);
  assert.equal(r.output, 'has-targets=false\n');
  assert.ok(r.summary !== null);
  assert.ok(r.summary.includes(REPORT_TITLE));
  assert.match(r.summary, /実装の \.ts・\.js の変更がありません/);
  assert.match(r.summary, /npm ci と mutation を省きました/);
});

test('checkTargetsResult：候補があれば has-targets=true で Summary は書かない', () => {
  assert.deepEqual(checkTargetsResult(3), { output: 'has-targets=true\n', summary: null });
  assert.deepEqual(checkTargetsResult(1), { output: 'has-targets=true\n', summary: null });
});

test('hasTargetsSafely：0 なら false、1 以上なら true、数えられなければ（例外）true で mutation を動かす側に倒す', () => {
  assert.equal(hasTargetsSafely(() => 0), false);
  assert.equal(hasTargetsSafely(() => 2), true);
  assert.equal(
    hasTargetsSafely(() => {
      throw new Error('git diff が読めない');
    }),
    true,
  );
});

/** 一時の git リポジトリ。最初のコミット（README.md）まで作る */
function tempRepo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-check-targets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
      git('add', file);
    }
    git('commit', '-qm', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'README.md': '# repo\n' }, 'init');
  return { dir, root, git, commit };
}

/** 一時リポジトリで --check-targets を動かし、GITHUB_OUTPUT と GITHUB_STEP_SUMMARY の中身を返す */
function runCheckTargets(repo: { dir: string; root: string }, extraArgs: string[] = []) {
  const output = join(repo.dir, 'github-output');
  const summary = join(repo.dir, 'step-summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const r = spawnSync(process.execPath, [mutateScript, '--check-targets', ...extraArgs], {
    cwd: repo.root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    timeout: 60_000,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
  };
}

test('--check-targets：.md だけを変えたコミットは has-targets=false で、Summary に対象が無い旨が出る', (t) => {
  const repo = tempRepo(t);
  repo.commit({ 'docs/guide.md': '# guide\n\n説明を足す。\n' }, 'docs');
  const r = runCheckTargets(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^has-targets=false$/m);
  assert.doesNotMatch(r.output, /has-targets=true/);
  assert.ok(r.summary.includes(REPORT_TITLE), r.summary);
  assert.match(r.summary, /実装の \.ts・\.js の変更がありません/);
  assert.match(r.stdout, /has-targets=false/);
  assert.doesNotMatch(r.stdout, /ベースラインのテストを動かします/, 'テストは動かさない');
});

test('--check-targets：src/a.ts に実装の行を足したコミットは has-targets=true で、Summary は書かない', (t) => {
  const repo = tempRepo(t);
  repo.commit({ 'src/a.ts': 'export const f = (a, b) => a === b;\n' }, 'impl');
  const r = runCheckTargets(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^has-targets=true$/m);
  assert.doesNotMatch(r.output, /has-targets=false/);
  assert.equal(r.summary, '');
  assert.doesNotMatch(r.stdout, /ベースラインのテストを動かします/, 'テストは動かさない');
});

test('--check-targets：テストファイル（harness/test/x.test.ts）だけを変えたコミットは has-targets=false', (t) => {
  const repo = tempRepo(t);
  repo.commit({ 'harness/test/x.test.ts': 'export const g = (a, b) => a === b;\n' }, 'test only');
  const r = runCheckTargets(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^has-targets=false$/m);
  assert.ok(r.summary.includes(REPORT_TITLE), r.summary);
});

test('--check-targets：import と型だけの行を足した .ts は has-targets=false', (t) => {
  const repo = tempRepo(t);
  repo.commit(
    {
      'src/types.ts': "import { x } from './x.ts';\nexport interface A { a: string }\nexport type B = string;\n// コメントだけ\n",
      'src/decl.d.ts': 'export const h = (a, b) => a === b;\n',
    },
    'types only',
  );
  const r = runCheckTargets(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^has-targets=false$/m);
});

test('--check-targets：--base で比べる範囲を変えられる（2つ前からなら実装の変更を数える）', (t) => {
  const repo = tempRepo(t);
  repo.commit({ 'src/a.ts': 'export const f = (a, b) => a === b;\n' }, 'impl');
  repo.commit({ 'docs/guide.md': '# guide\n' }, 'docs');
  const onlyLast = runCheckTargets(repo);
  assert.equal(onlyLast.status, 0, onlyLast.stderr);
  assert.match(onlyLast.output, /^has-targets=false$/m);
  const fromTwoBack = runCheckTargets(repo, ['--base', 'HEAD~2']);
  assert.equal(fromTwoBack.status, 0, fromTwoBack.stderr);
  assert.match(fromTwoBack.output, /^has-targets=true$/m);
});
