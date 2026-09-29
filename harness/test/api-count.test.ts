// Issue #247：agent.ts のコマンドごとに GitHub API の呼び出しの回数を測る（harness/lib/api-count.ts）。
// パスの形（番号を伏せたもの）ごとの数え方、応答の上限のヘッダーの覚え方、要約の書式、環境変数での有効化を確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiCounter, CountingTransport, apiCountFromEnv, pathShape } from '../lib/api-count.ts';
import { HttpError, type RequestOptions, type Transport } from '../lib/github.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('pathShape：owner/repo と Issue・PR 番号を伏せ、クエリを落とす', () => {
  assert.equal(pathShape('GET', '/repos/o/r/issues/12/comments?per_page=100&page=2'), 'GET /repos/:owner/:repo/issues/:n/comments');
  assert.equal(pathShape('GET', '/repos/o/r/pulls/3'), 'GET /repos/:owner/:repo/pulls/:n');
  assert.equal(pathShape('GET', '/repos/some-owner/some.repo/issues'), 'GET /repos/:owner/:repo/issues');
});

test('pathShape：同じ形の別の番号・別の owner/repo は同じ形になる', () => {
  assert.equal(pathShape('GET', '/repos/a/b/issues/1/comments'), pathShape('GET', '/repos/x/y/issues/9999/comments?page=3'));
  assert.equal(pathShape('GET', '/repos/a/b/pulls/1'), pathShape('GET', '/repos/a/b/pulls/2'));
});

test('pathShape：完全な URL は host を落とす', () => {
  assert.equal(pathShape('GET', 'https://api.github.com/repos/o/r/pulls/3'), 'GET /repos/:owner/:repo/pulls/:n');
  assert.equal(pathShape('GET', 'https://ghe.example.com/repos/o/r/issues/4/comments?per_page=100'), 'GET /repos/:owner/:repo/issues/:n/comments');
});

test('pathShape：先頭の / が無ければ付ける', () => {
  assert.equal(pathShape('GET', 'repos/o/r/pulls/3'), 'GET /repos/:owner/:repo/pulls/:n');
  assert.equal(pathShape('GET', 'user'), 'GET /user');
});

test('pathShape：/repos の外のパスはそのまま', () => {
  assert.equal(pathShape('GET', '/user'), 'GET /user');
  assert.equal(pathShape('GET', '/rate_limit'), 'GET /rate_limit');
});

test('pathShape：40桁の16進数の区切りは :sha', () => {
  assert.equal(pathShape('GET', `/repos/o/r/commits/${SHA}/check-runs`), 'GET /repos/:owner/:repo/commits/:sha/check-runs');
  assert.equal(pathShape('GET', `/repos/o/r/commits/${SHA}/check-runs?per_page=100`), 'GET /repos/:owner/:repo/commits/:sha/check-runs');
});

test('pathShape：compare・labels・branches・contents・git/ref(s) の後ろは1つの :x', () => {
  assert.equal(pathShape('GET', '/repos/o/r/compare/main...abc'), 'GET /repos/:owner/:repo/compare/:x');
  assert.equal(pathShape('GET', `/repos/o/r/compare/${SHA}...${SHA}`), 'GET /repos/:owner/:repo/compare/:x');
  assert.equal(pathShape('DELETE', '/repos/o/r/issues/5/labels/agent%3Ahold'), 'DELETE /repos/:owner/:repo/issues/:n/labels/:x');
  assert.equal(pathShape('GET', '/repos/o/r/branches/claude/issue-1-x/protection'), 'GET /repos/:owner/:repo/branches/:x');
  assert.equal(pathShape('GET', '/repos/o/r/contents/harness/lib/plan.ts?ref=main'), 'GET /repos/:owner/:repo/contents/:x');
  assert.equal(pathShape('GET', '/repos/o/r/git/ref/heads/main'), 'GET /repos/:owner/:repo/git/ref/:x');
  assert.equal(pathShape('PATCH', '/repos/o/r/git/refs/heads/main'), 'PATCH /repos/:owner/:repo/git/refs/:x');
});

test('pathShape：labels の後ろが無ければそのまま', () => {
  assert.equal(pathShape('POST', '/repos/o/r/issues/5/labels'), 'POST /repos/:owner/:repo/issues/:n/labels');
  assert.equal(pathShape('GET', '/repos/o/r/labels'), 'GET /repos/:owner/:repo/labels');
});

test('pathShape：別のラベル名は同じ形になる', () => {
  assert.equal(
    pathShape('DELETE', '/repos/o/r/issues/5/labels/agent%3Ahold'),
    pathShape('DELETE', '/repos/o/r/issues/77/labels/priority%3Ahigh'),
  );
});

test('pathShape：小文字のメソッドは大文字にする', () => {
  assert.equal(pathShape('get', '/repos/o/r/pulls/3'), 'GET /repos/:owner/:repo/pulls/:n');
  assert.equal(pathShape('post', '/repos/o/r/issues/5/comments'), 'POST /repos/:owner/:repo/issues/:n/comments');
});

test('pathShape：GraphQL は query と mutation を分ける', () => {
  assert.equal(pathShape('POST', '/graphql', { query: 'query Foo { viewer { login } }' }), 'POST /graphql (query)');
  assert.equal(pathShape('POST', '/graphql', { query: '{ viewer { login } }' }), 'POST /graphql (query)');
  assert.equal(pathShape('POST', '/graphql', { query: 'mutation { addComment(input: {}) { clientMutationId } }' }), 'POST /graphql (mutation)');
  assert.equal(pathShape('POST', '/graphql', { query: 'mutation Enable($id: ID!) { x }', variables: { id: 'a' } }), 'POST /graphql (mutation)');
});

test('pathShape：GraphQL の前の空白と # コメントを飛ばす', () => {
  assert.equal(pathShape('POST', '/graphql', { query: '\n   \t mutation { x }' }), 'POST /graphql (mutation)');
  assert.equal(pathShape('POST', '/graphql', { query: '# 自動 Merge を設定する\nmutation { x }' }), 'POST /graphql (mutation)');
  assert.equal(pathShape('POST', '/graphql', { query: '  # 1行目\r\n  # 2行目 mutation ではない\n  mutation M { x }' }), 'POST /graphql (mutation)');
  assert.equal(pathShape('POST', '/graphql', { query: '# mutation と書いたコメント\nquery { x }' }), 'POST /graphql (query)');
});

test('pathShape：GraphQL で body に query の文字列が無ければ種類を付けない', () => {
  assert.equal(pathShape('POST', '/graphql'), 'POST /graphql');
  assert.equal(pathShape('POST', '/graphql', {}), 'POST /graphql');
  assert.equal(pathShape('POST', '/graphql', { query: 1 }), 'POST /graphql');
  assert.equal(pathShape('POST', '/graphql', 'mutation { x }'), 'POST /graphql');
});

test('pathShape：GraphQL の完全な URL・小文字のメソッドも同じ', () => {
  assert.equal(pathShape('post', 'https://api.github.com/graphql', { query: 'mutation { x }' }), 'POST /graphql (mutation)');
});

/** 呼ばれた引数を記録し、決めた結果を返す偽の Transport */
class FakeTransport implements Transport {
  calls: { method: string; path: string; opts?: RequestOptions }[] = [];
  private readonly respond: (method: string, path: string, opts?: RequestOptions) => Promise<unknown>;
  constructor(respond: (method: string, path: string, opts?: RequestOptions) => Promise<unknown>) {
    this.respond = respond;
  }
  request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
    this.calls.push({ method, path, opts });
    return this.respond(method, path, opts);
  }
}

test('CountingTransport：形ごとに数え、戻り値をそのまま返す', async () => {
  const value = { number: 3, title: 't' };
  const inner = new FakeTransport(async () => value);
  const counter = new ApiCounter();
  const t = new CountingTransport(inner, counter);
  const opts: RequestOptions = { accept: 'application/vnd.github.diff', raw: true };
  assert.equal(await t.request('GET', '/repos/o/r/pulls/3', opts), value);
  await t.request('GET', '/repos/o/r/pulls/4');
  await t.request('POST', '/repos/o/r/issues/4/comments', { body: { body: 'x' } });
  assert.equal(counter.total, 3);
  assert.deepEqual(inner.calls[0], { method: 'GET', path: '/repos/o/r/pulls/3', opts });
  assert.equal(inner.calls.length, 3);
  const s = counter.summary('x');
  assert.ok(s.includes('[api-count]   2  GET /repos/:owner/:repo/pulls/:n\n'), s);
  assert.ok(s.includes('[api-count]   1  POST /repos/:owner/:repo/issues/:n/comments\n'), s);
});

test('CountingTransport：allow404 の null もそのまま返し、1回に数える', async () => {
  const counter = new ApiCounter();
  const t = new CountingTransport(new FakeTransport(async () => null), counter);
  assert.equal(await t.request('GET', '/repos/o/r/pulls/9', { allow404: true }), null);
  assert.equal(counter.total, 1);
});

test('CountingTransport：例外はそのまま投げ、失敗も1回に数える', async () => {
  const err = new HttpError(403, 'rate limited');
  const counter = new ApiCounter();
  const t = new CountingTransport(new FakeTransport(async () => { throw err; }), counter);
  await assert.rejects(t.request('GET', '/repos/o/r/pulls/9'), (e) => e === err);
  assert.equal(counter.total, 1);
  assert.ok(counter.summary('x').includes('[api-count]   1  GET /repos/:owner/:repo/pulls/:n\n'));
});

test('CountingTransport：GraphQL の body で query と mutation を分けて数える', async () => {
  const counter = new ApiCounter();
  const t = new CountingTransport(new FakeTransport(async () => ({})), counter);
  await t.request('POST', '/graphql', { body: { query: 'query { a }' } });
  await t.request('POST', '/graphql', { body: { query: 'mutation { b }' } });
  await t.request('POST', '/graphql', { body: { query: 'mutation { c }' } });
  const s = counter.summary('x');
  assert.ok(s.includes('[api-count]   2  POST /graphql (mutation)\n'), s);
  assert.ok(s.includes('[api-count]   1  POST /graphql (query)\n'), s);
});

test('ApiCounter：record は pathShape ごとに数え、total を増やす', () => {
  const c = new ApiCounter();
  assert.equal(c.total, 0);
  assert.equal(c.responses, 0);
  c.record('get', '/repos/o/r/issues/1/comments?page=1');
  c.record('GET', '/repos/o/r/issues/2/comments?page=2');
  c.record('POST', '/graphql', { body: { query: 'mutation { x }' } });
  assert.equal(c.total, 3);
  assert.equal(c.responses, 0);
  const s = c.summary('cmd');
  assert.ok(s.includes('[api-count]   2  GET /repos/:owner/:repo/issues/:n/comments\n'), s);
  assert.ok(s.includes('[api-count]   1  POST /graphql (mutation)\n'), s);
});

test('ApiCounter：observe は this から外して呼べ、応答を数える', () => {
  const c = new ApiCounter();
  const f = c.observe;
  f({ status: 200, headers: {} });
  f({ status: 404, headers: { 'content-type': 'application/json' } });
  assert.equal(c.responses, 2);
  assert.equal(c.total, 0);
});

test('ApiCounter：資源ごとに最後に見た上限の値を上書きで覚える', () => {
  const c = new ApiCounter();
  const f = c.observe;
  f({ status: 200, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4999', 'x-ratelimit-used': '1', 'x-ratelimit-limit': '5000' } });
  f({ status: 200, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990', 'x-ratelimit-used': '10', 'x-ratelimit-limit': '5000' } });
  f({ status: 200, headers: { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '4800', 'x-ratelimit-used': '200', 'x-ratelimit-limit': '5000' } });
  const lines = c.summary('queue').split('\n');
  assert.deepEqual(lines.slice(0, 3), [
    '[api-count] queue: 計 0 回（HTTP の応答 3 回）',
    '[api-count]   core: remaining 4990 / used 10 / limit 5000',
    '[api-count]   graphql: remaining 4800 / used 200 / limit 5000',
  ]);
});

test('ApiCounter：remaining の無い応答では資源の値を変えない（応答の数は増える）', () => {
  const c = new ApiCounter();
  c.observe({ status: 200, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4000', 'x-ratelimit-used': '1000', 'x-ratelimit-limit': '5000' } });
  c.observe({ status: 200, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-used': '1', 'x-ratelimit-limit': '1' } });
  c.observe({ status: 304, headers: {} });
  assert.equal(c.responses, 3);
  const s = c.summary('x');
  assert.ok(s.includes('[api-count]   core: remaining 4000 / used 1000 / limit 5000\n'), s);
  assert.equal(s.split('\n').filter((l) => l.includes('remaining')).length, 1);
});

test('ApiCounter：資源の無い応答は unknown、無い項目は ?', () => {
  const c = new ApiCounter();
  c.observe({ status: 200, headers: { 'x-ratelimit-remaining': '12' } });
  assert.ok(c.summary('x').includes('[api-count]   unknown: remaining 12 / used ? / limit ?\n'));
});

test('ApiCounter：summary は見ていないときは1行目だけで、末尾に改行が1つ', () => {
  const c = new ApiCounter();
  assert.equal(c.summary('check'), '[api-count] check: 計 0 回（HTTP の応答 0 回）\n');
});

test('ApiCounter：summary の行の形と並び（資源は名前の昇順、形は回数の多い順・同数は形の昇順）', () => {
  const c = new ApiCounter();
  c.record('GET', '/repos/o/r/pulls/1');
  c.record('POST', '/repos/o/r/issues/1/comments');
  c.record('GET', '/repos/o/r/issues/1/comments');
  c.record('GET', '/repos/o/r/issues/2/comments');
  c.record('GET', '/repos/o/r/issues/3/comments');
  c.record('DELETE', '/repos/o/r/issues/1/labels/a');
  c.record('DELETE', '/repos/o/r/issues/2/labels/b');
  c.observe({ status: 200, headers: { 'x-ratelimit-resource': 'search', 'x-ratelimit-remaining': '29', 'x-ratelimit-used': '1', 'x-ratelimit-limit': '30' } });
  c.observe({ status: 200, headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4000', 'x-ratelimit-used': '1000', 'x-ratelimit-limit': '5000' } });
  assert.equal(
    c.summary('judge-input'),
    [
      '[api-count] judge-input: 計 7 回（HTTP の応答 2 回）',
      '[api-count]   core: remaining 4000 / used 1000 / limit 5000',
      '[api-count]   search: remaining 29 / used 1 / limit 30',
      '[api-count]   3  GET /repos/:owner/:repo/issues/:n/comments',
      '[api-count]   2  DELETE /repos/:owner/:repo/issues/:n/labels/:x',
      '[api-count]   1  GET /repos/:owner/:repo/pulls/:n',
      '[api-count]   1  POST /repos/:owner/:repo/issues/:n/comments',
    ].join('\n') + '\n',
  );
});

test('apiCountFromEnv：未設定・空・0 なら null', () => {
  assert.equal(apiCountFromEnv({}), null);
  assert.equal(apiCountFromEnv({ AGENT_HARNESS_API_COUNT: undefined }), null);
  assert.equal(apiCountFromEnv({ AGENT_HARNESS_API_COUNT: '' }), null);
  assert.equal(apiCountFromEnv({ AGENT_HARNESS_API_COUNT: '0' }), null);
});

test('apiCountFromEnv：それ以外なら新しい ApiCounter', () => {
  const a = apiCountFromEnv({ AGENT_HARNESS_API_COUNT: '1' });
  assert.ok(a instanceof ApiCounter);
  assert.equal(a.total, 0);
  const b = apiCountFromEnv({ AGENT_HARNESS_API_COUNT: 'yes' });
  assert.ok(b instanceof ApiCounter);
  assert.notEqual(a, b);
});
