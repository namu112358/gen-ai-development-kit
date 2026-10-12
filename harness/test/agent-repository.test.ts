// Issue #789：owner/repo の解析（harness/lib/repository.ts）を1つにまとめ、. を含む名前・/git/ の形・末尾の / を読み、5か所の repository() がこの関数を使う
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseRepositoryUrl, resolveRepository } from '../lib/repository.ts';

const ROOT = join(import.meta.dirname, '..', '..');

test('parseRepositoryUrl は github.com と /git/ の形から owner/repo を読む', () => {
  const cases: { url: string; expected: string }[] = [
    { url: 'https://github.com/owner/repo', expected: 'owner/repo' },
    { url: 'https://github.com/owner/repo.git', expected: 'owner/repo' },
    { url: 'git@github.com:owner/repo.git', expected: 'owner/repo' },
    { url: 'ssh://git@github.com/owner/repo.git', expected: 'owner/repo' },
    { url: 'https://github.com/owner/my.repo', expected: 'owner/my.repo' },
    { url: 'git@github.com:owner/my.repo.git', expected: 'owner/my.repo' },
    { url: 'https://github.com/owner/repo/', expected: 'owner/repo' },
    { url: 'https://github.com/owner/repo.git/', expected: 'owner/repo' },
    { url: 'http://local_proxy@127.0.0.1:12345/git/owner/repo', expected: 'owner/repo' },
    { url: 'http://local_proxy@127.0.0.1:12345/git/owner/my.repo.git', expected: 'owner/my.repo' },
    { url: '  https://github.com/owner/repo.git\n', expected: 'owner/repo' },
  ];
  for (const c of cases) assert.equal(parseRepositoryUrl(c.url), c.expected, c.url);
});

test('parseRepositoryUrl は読めない URL に null を返す（緩めていない）', () => {
  const cases = ['', '   ', 'https://gitlab.com/owner/repo', 'https://github.com/owner', 'https://github.com/owner/repo/extra'];
  for (const url of cases) assert.equal(parseRepositoryUrl(url), null, JSON.stringify(url));
});

test('resolveRepository は GITHUB_REPOSITORY を先に使い、origin を読まない', () => {
  let called = 0;
  const r = resolveRepository('env-owner/env-repo', () => {
    called++;
    return 'https://github.com/owner/repo.git';
  });
  assert.deepEqual(r, { ok: true, repository: 'env-owner/env-repo' });
  assert.equal(called, 0);
});

test('resolveRepository は GITHUB_REPOSITORY が空なら origin を読む', () => {
  for (const env of [undefined, '']) {
    let called = 0;
    const r = resolveRepository(env, () => {
      called++;
      return 'git@github.com:owner/my.repo.git';
    });
    assert.deepEqual(r, { ok: true, repository: 'owner/my.repo' }, String(env));
    assert.equal(called, 1);
  }
});

test('resolveRepository は origin を読めなければ ok: false で URL を含む文を返す', () => {
  for (const url of ['', 'https://gitlab.com/owner/repo', 'https://github.com/owner/repo/extra']) {
    const r = resolveRepository(undefined, () => url);
    assert.deepEqual(r, { ok: false, error: `origin から owner/repo を判別できません: ${url}` }, JSON.stringify(url));
  }
});

test('5か所の repository() は harness/lib/repository.ts を使い、古い正規表現を持たない', () => {
  const files = [
    'harness/scripts/agent/cli.ts',
    'harness/scripts/observe.ts',
    'harness/scripts/review-panel.ts',
    'harness/scripts/qa-retro-loop.ts',
    'harness/scripts/dashboard.ts',
  ];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /from '(?:\.\.?\/)+(?:[\w-]+\/)*lib\/repository\.ts'/, `${f} が lib/repository.ts を import する`);
    assert.ok(!src.includes('[^/.]+?'), `${f} に古い正規表現 [^/.]+? が残っていない`);
  }
});
