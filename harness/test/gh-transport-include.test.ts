// Issue #247：API の回数を測るときだけ `gh api --include` で応答の頭（状態とヘッダー）を読む（harness/lib/github.ts）。
// 頭と本文の分け方（parseGhInclude）と、gh に渡す引数（ghApiArgs）が測らないときに今と同じであることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ghApiArgs, parseGhInclude } from '../lib/github.ts';

test('parseGhInclude：LF の応答を頭と本文に分ける', () => {
  const r = parseGhInclude('HTTP/2.0 200 OK\nContent-Type: application/json\nX-Ratelimit-Remaining: 4999\n\n{"a":1}\n');
  assert.deepEqual(r.info, { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' } });
  assert.equal(r.body, '{"a":1}\n');
});

test('parseGhInclude：CRLF の応答も分ける', () => {
  const r = parseGhInclude('HTTP/2.0 201 Created\r\nX-RateLimit-Resource: core\r\nX-RateLimit-Used: 3\r\n\r\n{"id":5}');
  assert.deepEqual(r.info, { status: 201, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-used': '3' } });
  assert.equal(r.body, '{"id":5}');
});

test('parseGhInclude：ヘッダー名は大小に関わらず小文字、値は前後の空白を除き : を含んでよい', () => {
  const r = parseGhInclude('HTTP/1.1 200 OK\nx-ratelimit-limit:   5000  \nLINK: <https://api.github.com/x?page=2>; rel="next"\nDate: Tue, 29 Sep 2026 10:00:00 GMT\n\n[]');
  assert.equal(r.info?.status, 200);
  assert.equal(r.info?.headers['x-ratelimit-limit'], '5000');
  assert.equal(r.info?.headers.link, '<https://api.github.com/x?page=2>; rel="next"');
  assert.equal(r.info?.headers.date, 'Tue, 29 Sep 2026 10:00:00 GMT');
  assert.equal(r.body, '[]');
});

test('parseGhInclude：本文が空（204 など）', () => {
  const r = parseGhInclude('HTTP/2.0 204 No Content\nX-Ratelimit-Remaining: 10\n\n');
  assert.deepEqual(r.info, { status: 204, headers: { 'x-ratelimit-remaining': '10' } });
  assert.equal(r.body, '');
});

test('parseGhInclude：空行が無ければ全部が頭で本文は空', () => {
  const r = parseGhInclude('HTTP/2.0 204 No Content\nX-Ratelimit-Remaining: 10');
  assert.deepEqual(r.info, { status: 204, headers: { 'x-ratelimit-remaining': '10' } });
  assert.equal(r.body, '');
});

test('parseGhInclude：本文の中の空行（diff など）で切れない', () => {
  const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n\n\nend\n';
  const r = parseGhInclude(`HTTP/2.0 200 OK\nContent-Type: text/plain\n\n${diff}`);
  assert.equal(r.info?.status, 200);
  assert.equal(r.body, diff);
  const crlf = parseGhInclude(`HTTP/2.0 200 OK\r\nContent-Type: text/plain\r\n\r\nline1\r\n\r\nline2`);
  assert.equal(crlf.body, 'line1\r\n\r\nline2');
});

test('parseGhInclude：404 のエラーの応答も分ける', () => {
  const r = parseGhInclude('HTTP/2.0 404 Not Found\nX-Ratelimit-Remaining: 4000\nX-Ratelimit-Resource: core\n\n{"message":"Not Found"}');
  assert.equal(r.info?.status, 404);
  assert.equal(r.info?.headers['x-ratelimit-remaining'], '4000');
  assert.equal(r.info?.headers['x-ratelimit-resource'], 'core');
  assert.equal(r.body, '{"message":"Not Found"}');
});

test('parseGhInclude：403 の上限切れの応答も分ける', () => {
  const r = parseGhInclude(
    'HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Limit: 5000\r\nX-Ratelimit-Remaining: 0\r\nX-Ratelimit-Used: 5000\r\nX-Ratelimit-Resource: core\r\n\r\n{"message":"API rate limit exceeded"}',
  );
  assert.deepEqual(r.info, {
    status: 403,
    headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '5000', 'x-ratelimit-resource': 'core' },
  });
  assert.equal(r.body, '{"message":"API rate limit exceeded"}');
});

test('parseGhInclude：HTTP/ で始まらなければ info は null、本文はそのまま', () => {
  for (const s of ['{"a":1}\n', '', '[]', 'diff --git a/x b/x\n\nHTTP/2.0 200 OK\n']) {
    assert.deepEqual(parseGhInclude(s), { info: null, body: s });
  }
});

test('ghApiArgs：include が偽なら今の引数と完全に一致（body なし）', () => {
  assert.deepEqual(ghApiArgs('GET', '/repos/o/r/pulls/3', {}, false), [
    'api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github+json',
  ]);
});

test('ghApiArgs：include が偽なら今の引数と完全に一致（body あり）', () => {
  assert.deepEqual(ghApiArgs('POST', '/repos/o/r/issues/3/comments', { body: { body: 'x' } }, false), [
    'api', '--method', 'POST', 'repos/o/r/issues/3/comments', '-H', 'Accept: application/vnd.github+json', '--input', '-',
  ]);
});

test('ghApiArgs：include が偽なら今の引数と完全に一致（accept 指定・先頭の / 無し）', () => {
  assert.deepEqual(ghApiArgs('GET', '/repos/o/r/pulls/3', { accept: 'application/vnd.github.diff', raw: true }, false), [
    'api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github.diff',
  ]);
  assert.deepEqual(ghApiArgs('GET', 'user', {}, false), ['api', '--method', 'GET', 'user', '-H', 'Accept: application/vnd.github+json']);
});

/** include 無しの配列の要素が順に全部含まれ、差が --include の1つだけか */
function assertOnlyIncludeAdded(without: string[], withInclude: string[]): void {
  assert.equal(withInclude.length, without.length + 1, JSON.stringify(withInclude));
  const i = withInclude.indexOf('--include');
  assert.ok(i >= 0, JSON.stringify(withInclude));
  assert.equal(withInclude.filter((a) => a === '--include').length, 1);
  assert.deepEqual([...withInclude.slice(0, i), ...withInclude.slice(i + 1)], without);
}

test('ghApiArgs：include が真なら --include の1つだけが増える', () => {
  const cases: [string, string, Parameters<typeof ghApiArgs>[2]][] = [
    ['GET', '/repos/o/r/pulls/3', {}],
    ['POST', '/repos/o/r/issues/3/comments', { body: { body: 'x' } }],
    ['GET', '/repos/o/r/pulls/3', { accept: 'application/vnd.github.diff', raw: true }],
    ['POST', '/graphql', { body: { query: 'mutation { x }' } }],
    ['GET', '/repos/o/r/pulls/9', { allow404: true }],
  ];
  for (const [m, p, o] of cases) assertOnlyIncludeAdded(ghApiArgs(m, p, o, false), ghApiArgs(m, p, o, true));
});

test('ghApiArgs：body があるとき --input - の組は崩れない', () => {
  const a = ghApiArgs('POST', '/graphql', { body: { query: 'q' } }, true);
  const i = a.indexOf('--input');
  assert.ok(i >= 0);
  assert.equal(a[i + 1], '-');
  const h = a.indexOf('-H');
  assert.equal(a[h + 1], 'Accept: application/vnd.github+json');
});
