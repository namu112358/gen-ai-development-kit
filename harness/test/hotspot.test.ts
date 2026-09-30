// Issue #326：ホットスポットの集計（hotspot）。`git log --numstat` の形の入力と行数から、変更回数・行数・並び順・上限（truncated）・除外（消えたファイル・sizeExclude の形）が決まることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countLines, HOTSPOT_LOG_ARGS, parseNumstat, rankHotspots, type FileChurn } from '../lib/hotspot.ts';

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
