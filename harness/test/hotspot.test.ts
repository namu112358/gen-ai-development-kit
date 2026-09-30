// Issue #326：ホットスポットの集計（hotspot）。`git log --numstat` の形の入力と行数から、変更回数・行数・並び順・上限（truncated）・除外（消えたファイル・sizeExclude の形）が決まることを確かめる。
// Issue #350：git が引用符と8進のエスケープで出す ASCII でないパス（core.quotepath）を、元の名前に戻して数える。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { countLines, HOTSPOT_LOG_ARGS, parseNumstat, rankHotspots, unquoteGitPath, type FileChurn } from '../lib/hotspot.ts';

const LOG = [
  'commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '',
  '3\t1\tharness/lib/a.ts',
  '10\t0\tdocs/x.md',
  '',
  'commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '',
  '1\t1\tharness/lib/a.ts',
  '-\t-\timg/logo.png',
  'commit cccccccccccccccccccccccccccccccccccccccc',
  '2\t2\tharness/lib/a.ts',
  '5\t5\tpackage-lock.json',
  '',
].join('\n');

test('HOTSPOT_LOG_ARGS：期間の始まりから、リネームを追わずに numstat とコミットの区切りを出す', () => {
  assert.deepEqual(HOTSPOT_LOG_ARGS('2026-09-01T00:00:00Z'), ['log', '--since=2026-09-01T00:00:00Z', '--no-renames', '--numstat', '--format=commit %H']);
});

test('parseNumstat：ファイルごとに変更回数と足した行・消した行を数え、ファイル名の順に並べる', () => {
  assert.deepEqual(parseNumstat(LOG), [
    { file: 'docs/x.md', commits: 1, added: 10, deleted: 0 },
    { file: 'harness/lib/a.ts', commits: 3, added: 6, deleted: 4 },
    { file: 'img/logo.png', commits: 1, added: 0, deleted: 0 },
    { file: 'package-lock.json', commits: 1, added: 5, deleted: 5 },
  ]);
});

test('parseNumstat：同じコミットに同じファイルが2回出ても変更回数は1回', () => {
  const log = ['commit aaaa', '1\t0\tdocs/x.md', '1\t0\tdocs/x.md', 'commit bbbb', '1\t0\tdocs/x.md'].join('\n');
  const churn = parseNumstat(log);
  assert.equal(churn.length, 1);
  assert.equal(churn[0]!.commits, 2);
});

test('parseNumstat：空の入力は空', () => {
  assert.deepEqual(parseNumstat(''), []);
});

test('unquoteGitPath：引用された8進のエスケープを UTF-8 の文字に戻し、1文字のエスケープも戻し、囲まれていないパスはそのまま', () => {
  assert.equal(unquoteGitPath('"\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"'), '日本語.md');
  assert.equal(unquoteGitPath('"docs/\\346\\227\\245\\346\\234\\254\\350\\252\\236/a.md"'), 'docs/日本語/a.md');
  assert.equal(unquoteGitPath('"a\\tb.md"'), 'a\tb.md');
  assert.equal(unquoteGitPath('"say \\"hi\\".md"'), 'say "hi".md');
  assert.equal(unquoteGitPath('"back\\\\slash.md"'), 'back\\slash.md');
  assert.equal(unquoteGitPath('"\\a\\b\\n\\v\\f\\r"'), '\x07\b\n\v\f\r');
  assert.equal(unquoteGitPath('harness/lib/a.ts'), 'harness/lib/a.ts');
  assert.equal(unquoteGitPath('a\\346.md'), 'a\\346.md');
  assert.equal(unquoteGitPath('"abc'), '"abc');
  assert.equal(unquoteGitPath('日本語.md'), '日本語.md');
});

test('unquoteGitPath：終わりが不完全なエスケープは例外を投げず文字どおり残し、UTF-8 として読めないバイトは U+FFFD にする', () => {
  assert.doesNotThrow(() => unquoteGitPath('"abc\\"'));
  assert.equal(unquoteGitPath('"abc\\"'), 'abc\\');
  assert.doesNotThrow(() => unquoteGitPath('"abc\\34"'));
  assert.equal(unquoteGitPath('"abc\\34"'), 'abc\\34');
  assert.equal(unquoteGitPath('"abc\\3"'), 'abc\\3');
  assert.equal(unquoteGitPath('"\\377.md"'), '�.md');
});

test('parseNumstat：引用されたパスを元の名前に戻し、同じファイルの引用されない形と合わせて1ファイルとして数える', () => {
  const log = [
    'commit aaaa',
    '2\t1\t"\\346\\227\\245\\346\\234\\254\\350\\252\\236.md"',
    '1\t0\ta.md',
    'commit bbbb',
    '3\t0\t日本語.md',
  ].join('\n');
  assert.deepEqual(parseNumstat(log), [
    { file: 'a.md', commits: 1, added: 1, deleted: 0 },
    { file: '日本語.md', commits: 2, added: 5, deleted: 1 },
  ]);
});

test('parseNumstat：一時的な git リポジトリで core.quotepath=true の git log を読み、日本語のファイル名をそのままの名前で数える', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hotspot-quotepath-'));
  try {
    const emptyConfig = join(dir, 'empty-gitconfig');
    writeFileSync(emptyConfig, '');
    const repo = join(dir, 'repo');
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    env.GIT_CONFIG_GLOBAL = emptyConfig;
    env.GIT_CONFIG_NOSYSTEM = '1';
    const git = (cwd: string, ...args: string[]): string => {
      const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    git(dir, 'init', '-q', 'repo');
    git(repo, 'config', 'user.name', 'hotspot-test');
    git(repo, 'config', 'user.email', 'hotspot-test@example.invalid');
    writeFileSync(join(repo, '日本語.md'), 'one\ntwo\n');
    writeFileSync(join(repo, 'a.md'), 'x\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first');
    writeFileSync(join(repo, '日本語.md'), 'one\n');
    writeFileSync(join(repo, 'a.md'), 'x\ny\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'second');

    const log = git(repo, '-c', 'core.quotepath=true', ...HOTSPOT_LOG_ARGS('2000-01-01T00:00:00Z'));
    const churn = parseNumstat(log);
    assert.deepEqual(churn, [
      { file: 'a.md', commits: 2, added: 2, deleted: 0 },
      { file: '日本語.md', commits: 2, added: 2, deleted: 1 },
    ]);
    assert.ok(churn.every((c) => !c.file.startsWith('"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('countLines：末尾の改行は数えず、空は 0', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
});

const churn = (file: string, commits: number): FileChurn => ({ file, commits, added: commits, deleted: 0 });

test('rankHotspots：変更回数×行数の大きい順に、変更回数と行数つきで並べる', () => {
  const r = rankHotspots(
    [churn('harness/lib/a.ts', 3), churn('harness/lib/b.ts', 10), churn('docs/x.md', 1)],
    new Map([['harness/lib/a.ts', 100], ['harness/lib/b.ts', 20], ['docs/x.md', 50]]),
    { top: 10, exclude: [] },
  );
  assert.deepEqual(r.items.map((h) => [h.file, h.commits, h.lines, h.score]), [
    ['harness/lib/a.ts', 3, 100, 300],
    ['harness/lib/b.ts', 10, 20, 200],
    ['docs/x.md', 1, 50, 50],
  ]);
  assert.equal(r.items[0]!.added, 3);
  assert.equal(r.total, 3);
  assert.equal(r.truncated, 0);
});

test('rankHotspots：score が同じなら変更回数の多い順、それも同じならファイル名の順', () => {
  const r = rankHotspots(
    [churn('z.ts', 2), churn('y.ts', 1), churn('a.ts', 2)],
    new Map([['z.ts', 10], ['y.ts', 20], ['a.ts', 10]]),
    { top: 10, exclude: [] },
  );
  assert.deepEqual(r.items.map((h) => h.file), ['a.ts', 'z.ts', 'y.ts']);
});

test('rankHotspots：上位 top 件で切り、切った数を truncated に出す', () => {
  const r = rankHotspots(
    [churn('a.ts', 5), churn('b.ts', 4), churn('c.ts', 3), churn('d.ts', 2)],
    new Map([['a.ts', 1], ['b.ts', 1], ['c.ts', 1], ['d.ts', 1]]),
    { top: 2, exclude: [] },
  );
  assert.deepEqual(r.items.map((h) => h.file), ['a.ts', 'b.ts']);
  assert.equal(r.total, 4);
  assert.equal(r.truncated, 2);
});

test('rankHotspots：消えたファイル（行数が無い）と sizeExclude の形の除外に当たるものを除く', () => {
  const r = rankHotspots(
    [churn('harness/lib/a.ts', 3), churn('harness/lib/gone.ts', 50), churn('package-lock.json', 40), churn('web/yarn.lock', 30), churn('harness/test/__snapshots__/x.snap', 20)],
    new Map([['harness/lib/a.ts', 10], ['package-lock.json', 9999], ['web/yarn.lock', 100], ['harness/test/__snapshots__/x.snap', 100]]),
    { top: 10, exclude: ['package-lock.json', '**/*.lock', '**/*.snap'] },
  );
  assert.deepEqual(r.items.map((h) => h.file), ['harness/lib/a.ts']);
  assert.equal(r.total, 1);
  assert.equal(r.truncated, 0);
});
