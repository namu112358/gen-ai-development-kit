// Issue #622：main を取り込んだだけで PR 自身の差分が変わらない push では mutation の本体を省く（patch-id の鍵と記録）のテスト
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseRecord, renderCachedSkip, type MutationRecord } from '../scripts/mutate.ts';

const mutateScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'mutate.ts');
const root = join(import.meta.dirname, '..', '..');
const read = (name: string): string[] => readFileSync(join(root, '.github', 'workflows', name), 'utf8').split(/\r?\n/);
const indentOf = (l: string): number => l.match(/^\s*/)![0].length;

/** 一時の git リポジトリ。最初のコミット（README.md と、PR が変える src/a.ts の文脈）まで作る */
function tempRepo(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-patch-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repoRoot = join(dir, 'repo');
  mkdirSync(repoRoot);
  // checkout で作業ツリーが CRLF に書き換わると、mutate.ts の「作業ツリーの行が差分の行と同じ」が外れるので autocrlf を切る（Windows）
  const git = (...args: string[]): string => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repoRoot, file)), { recursive: true });
      writeFileSync(join(repoRoot, file), content);
      git('add', file);
    }
    git('commit', '-qm', message);
  };
  git('init', '-q', '-b', 'main');
  commit({ 'README.md': '# repo\n', 'src/a.ts': 'export const one = 1;\nexport const two = 2;\n' }, 'init');
  return { dir, root: repoRoot, git, commit };
}

/** 一時リポジトリで --check-targets を動かし、GITHUB_OUTPUT の中身を返す */
function runCheckTargets(repo: { dir: string; root: string }) {
  const output = join(repo.dir, 'github-output');
  const summary = join(repo.dir, 'step-summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const r = spawnSync(process.execPath, [mutateScript, '--check-targets'], {
    cwd: repo.root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
}

/** GITHUB_OUTPUT の patch-key の値（無ければ失敗） */
function patchKeyOf(output: string): string {
  const m = output.match(/^patch-key=(.*)$/m);
  assert.ok(m, `patch-key がありません: ${output}`);
  const key = m[1]!.trim();
  assert.match(key, /^mutation-v1-[0-9a-f]{40}$/, `patch-key の形が違います: ${key}`);
  return key;
}

/** main の今の先頭で PR のブランチを --no-ff でマージし（第1親が base）、そのマージコミットで --check-targets の patch-key を読む */
function mergeAndKey(repo: ReturnType<typeof tempRepo>, name: string): string {
  repo.git('checkout', '-q', '-b', name, 'main');
  repo.git('merge', '-q', '--no-ff', '-m', `merge ${name}`, 'pr');
  const r = runCheckTargets(repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.output, /^has-targets=true$/m);
  return patchKeyOf(r.output);
}

/** PR のブランチ（src/a.ts に実装の行を足す）を作り、main に戻る */
function preparePr(repo: ReturnType<typeof tempRepo>) {
  repo.git('checkout', '-q', '-b', 'pr', 'main');
  repo.commit({ 'src/a.ts': 'export const one = 1;\nexport const f = (a, b) => a === b;\nexport const two = 2;\n' }, 'impl');
  repo.git('checkout', '-q', 'main');
}

test('patch-key：main に別のファイルの変更を足して同じ PR をマージし直しても鍵は同じ（main の取り込みだけの push では本体を省く）', (t) => {
  const repo = tempRepo(t);
  preparePr(repo);
  const m1 = mergeAndKey(repo, 'm1');
  repo.git('checkout', '-q', 'main');
  repo.commit({ 'docs/x.md': '# x\n', 'src/b.ts': 'export const g = (a, b) => a + b;\n' }, 'main moves');
  const m2 = mergeAndKey(repo, 'm2');
  assert.equal(m2, m1);
});

test('patch-key：PR の head で src/a.ts の行を変えてマージし直すと鍵が変わる（PR 自身の差分が変わる push では本体が動く）', (t) => {
  const repo = tempRepo(t);
  preparePr(repo);
  const m1 = mergeAndKey(repo, 'm1');
  repo.git('checkout', '-q', 'pr');
  repo.commit({ 'src/a.ts': 'export const one = 1;\nexport const f = (a, b) => a !== b;\nexport const two = 2;\n' }, 'impl changes');
  repo.git('checkout', '-q', 'main');
  const m3 = mergeAndKey(repo, 'm3');
  assert.notEqual(m3, m1);
});

/** ci.yml の jobs.mutation の steps を、step ごとの行の配列にする */
function mutationSteps(): string[][] {
  const lines = read('ci.yml');
  const start = lines.findIndex((l) => /^\s+mutation:\s*(#.*)?$/.test(l));
  assert.ok(start >= 0, 'ci.yml に mutation のジョブがありません');
  const jobIndent = indentOf(lines[start]!);
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== '' && indentOf(l) <= jobIndent) break;
    body.push(l);
  }
  const stepsAt = body.findIndex((l) => /^\s+steps:\s*$/.test(l));
  assert.ok(stepsAt >= 0, 'mutation のジョブに steps がありません');
  const steps: string[][] = [];
  for (const l of body.slice(stepsAt + 1)) {
    if (l.trim() === '' || l.trim().startsWith('#')) continue;
    if (/^\s+- /.test(l)) steps.push([]);
    steps.at(-1)?.push(l.trim().replace(/^- /, ''));
  }
  return steps;
}

/** step の `<key>:` の値（無ければ空文字） */
const valueOf = (step: string[], key: string): string =>
  step.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? '';

test('ci.yml：鍵が当たれば npm ci と本体を動かさず、本体が記録したときだけ復元と同じ鍵で保存する', () => {
  const steps = mutationSteps();
  const find = (label: string, pred: (s: string[]) => boolean): string[] => {
    const s = steps.find(pred);
    assert.ok(s, `mutation のジョブに ${label} の step がありません`);
    return s;
  };
  const restore = find('actions/cache/restore', (s) => s.some((l) => /^uses: actions\/cache\/restore@/.test(l)));
  const npmCi = find('npm ci', (s) => valueOf(s, 'run') === 'npm ci');
  const mutate = find('mutate.ts --max-mutants', (s) => /mutate\.ts --max-mutants/.test(valueOf(s, 'run')));
  const save = find('actions/cache/save', (s) => s.some((l) => /^uses: actions\/cache\/save@/.test(l)));

  assert.equal(valueOf(restore, 'id'), 'cached');
  for (const [label, step] of [['npm ci', npmCi], ['mutate.ts --max-mutants', mutate]] as const) {
    assert.ok(valueOf(step, 'if').includes("steps.cached.outputs.cache-hit != 'true'"), `${label} の if: ${valueOf(step, 'if')}`);
  }
  assert.equal(valueOf(mutate, 'id'), 'mutate');
  assert.ok(valueOf(save, 'if').includes("steps.mutate.outputs.recorded == 'true'"), `保存の if: ${valueOf(save, 'if')}`);
  const key = '${{ steps.targets.outputs.patch-key }}';
  assert.equal(valueOf(restore, 'key'), key);
  assert.equal(valueOf(save, 'key'), key);
});

test('renderCachedSkip・parseRecord：Summary に理由と前の実行の URL、survived の行を記録のとおり返し、壊れた記録は null', () => {
  const record: MutationRecord = {
    runUrl: 'https://github.com/o/r/actions/runs/123/attempts/1',
    head: '0123456789abcdef0123456789abcdef01234567',
    survived: ['survived\tsrc/a.ts:2\t=== → !==', 'survived\tsrc/a.ts:3\ttrue → false'],
  };
  assert.deepEqual(parseRecord(JSON.stringify(record)), record);

  const hit = renderCachedSkip(record);
  assert.ok(hit.summary.includes(record.runUrl), hit.summary);
  assert.match(hit.summary, /main の取り込み/);
  assert.deepEqual(hit.log, record.survived);

  const unreadable = renderCachedSkip(null);
  assert.deepEqual(unreadable.log, []);
  assert.match(unreadable.summary, /読めません/);

  for (const broken of [
    '{ not json',
    JSON.stringify({ ...record, runUrl: '' }),
    JSON.stringify({ ...record, head: undefined }),
    JSON.stringify({ ...record, survived: 'survived\tsrc/a.ts:2\tx' }),
    JSON.stringify({ ...record, survived: ['src/a.ts:2 x'] }),
  ]) {
    assert.equal(parseRecord(broken), null, broken);
  }
});
