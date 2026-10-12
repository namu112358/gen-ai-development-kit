// review-api の GitHub REST の呼び出し（review-api/src/github.ts の createGitHubClient）が、偽の fetch に対して
// 各メソッドの呼び先（URL・メソッド）と Accept・共通ヘッダー、listComments のページ送り（100件未満で止まる・10ページで止まる）、
// getFileContent の 404 が null、2xx 以外が token を含まない GitHubError になること、github.ts が import を持たないことを、
// 外部 API を呼ばずに確かめる（Issue #880）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGitHubClient, GitHubError } from '../../review-api/src/github.ts';

const TOKEN = 'ghs_secretTOKEN1234567890';
const BASE = 'https://api.github.com/repos/o/r';

interface Call { url: string; method: string; headers: Headers; body: string | undefined }

// 呼ばれた URL・method・headers・body を記録し、respond が返す Response を返す偽の fetch
const fakeFetch = (respond: (call: Call, index: number) => Response) => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input instanceof Request ? input.url : input),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const clientWith = (respond: (call: Call, index: number) => Response) => {
  const fake = fakeFetch(respond);
  return { ...fake, client: createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetch: fake.fetch }) };
};

const only = (calls: Call[]): Call => {
  assert.equal(calls.length, 1, calls.map((c) => c.url).join(','));
  return calls[0]!;
};

// 各メソッドの呼び先・メソッド・Accept
const routes: { name: string; run: (c: ReturnType<typeof createGitHubClient>) => Promise<unknown>; url: string; method: string; accept: string; respond: () => Response }[] = [
  { name: 'getPr', run: (c) => c.getPr(1), url: `${BASE}/pulls/1`, method: 'GET', accept: 'application/vnd.github+json', respond: () => json({ number: 1 }) },
  { name: 'getIssue', run: (c) => c.getIssue(2), url: `${BASE}/issues/2`, method: 'GET', accept: 'application/vnd.github+json', respond: () => json({ number: 2 }) },
  { name: 'getTree', run: (c) => c.getTree('main'), url: `${BASE}/git/trees/main?recursive=1`, method: 'GET', accept: 'application/vnd.github+json', respond: () => json({ tree: [] }) },
  { name: 'compareDiff', run: (c) => c.compareDiff('a', 'b'), url: `${BASE}/compare/a...b`, method: 'GET', accept: 'application/vnd.github.diff', respond: () => new Response('diff --git a/x b/x\n') },
  { name: 'getFileContent', run: (c) => c.getFileContent('dir/a b.ts', 'main'), url: `${BASE}/contents/dir/a%20b.ts?ref=main`, method: 'GET', accept: 'application/vnd.github.raw', respond: () => new Response('const a = 1;\n') },
  { name: 'createComment', run: (c) => c.createComment(3, 'hello'), url: `${BASE}/issues/3/comments`, method: 'POST', accept: 'application/vnd.github+json', respond: () => json({ id: 9 }, 201) },
];

for (const { name, run, url, method, accept, respond } of routes) {
  test(`${name} は ${method} ${url} を Accept ${accept} で呼ぶ`, async () => {
    const { calls, client } = clientWith(respond);
    await run(client);
    const call = only(calls);
    assert.equal(call.url, url);
    assert.equal(call.method, method);
    assert.equal(call.headers.get('accept'), accept);
  });
}

test('共通ヘッダー（Authorization・X-GitHub-Api-Version・User-Agent）が付く', async () => {
  const { calls, client } = clientWith(() => json({ number: 1 }));
  await client.getPr(1);
  const call = only(calls);
  assert.equal(call.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(call.headers.get('x-github-api-version'), '2022-11-28');
  assert.equal(call.headers.get('user-agent'), 'review-api');
});

test('createComment は本文を JSON {"body": ...} で content-type application/json として送る', async () => {
  const { calls, client } = clientWith(() => json({ id: 9 }, 201));
  await client.createComment(3, 'hello "world"');
  const call = only(calls);
  assert.equal(call.headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(call.body ?? ''), { body: 'hello "world"' });
});

test('compareDiff は本文の文字列を、getFileContent は中身の文字列を返す', async () => {
  const diff = clientWith(() => new Response('diff --git a/x b/x\n'));
  assert.equal(await diff.client.compareDiff('a', 'b'), 'diff --git a/x b/x\n');
  const file = clientWith(() => new Response('const a = 1;\n'));
  assert.equal(await file.client.getFileContent('x.ts', 'main'), 'const a = 1;\n');
});

const page = (count: number, start: number) => Array.from({ length: count }, (_, i) => ({ id: start + i }));

test('listComments は 100件の次に 3件のページで止まり、2回呼んで 103件を返す', async () => {
  const { calls, client } = clientWith((_, i) => json(i === 0 ? page(100, 0) : page(3, 100)));
  const comments = await client.listComments(5);
  assert.equal(comments.length, 103);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${BASE}/issues/5/comments?per_page=100&page=1`);
  assert.equal(calls[1]!.url, `${BASE}/issues/5/comments?per_page=100&page=2`);
});

test('listComments はずっと 100件でも 10ページで止まり 1000件を返す', async () => {
  const { calls, client } = clientWith((_, i) => json(page(100, i * 100)));
  const comments = await client.listComments(5);
  assert.equal(calls.length, 10);
  assert.equal(comments.length, 1000);
  assert.equal(calls[9]!.url, `${BASE}/issues/5/comments?per_page=100&page=10`);
});

test('getFileContent の 404 は null を返す', async () => {
  const { client } = clientWith(() => json({ message: 'Not Found' }, 404));
  assert.equal(await client.getFileContent('missing.ts', 'main'), null);
});

// 2xx 以外：status・method・クエリを除いた path を持つ GitHubError で、token を含まない
const failures: { name: string; status: number; run: (c: ReturnType<typeof createGitHubClient>) => Promise<unknown>; method: string; path: string }[] = [
  { name: 'getPr の 404', status: 404, run: (c) => c.getPr(1), method: 'GET', path: '/repos/o/r/pulls/1' },
  { name: 'getIssue の 404', status: 404, run: (c) => c.getIssue(2), method: 'GET', path: '/repos/o/r/issues/2' },
  { name: 'getTree の 404', status: 404, run: (c) => c.getTree('main'), method: 'GET', path: '/repos/o/r/git/trees/main' },
  { name: 'compareDiff の 404', status: 404, run: (c) => c.compareDiff('a', 'b'), method: 'GET', path: '/repos/o/r/compare/a...b' },
  { name: 'listComments の 500', status: 500, run: (c) => c.listComments(5), method: 'GET', path: '/repos/o/r/issues/5/comments' },
  { name: 'createComment の 403', status: 403, run: (c) => c.createComment(3, 'x'), method: 'POST', path: '/repos/o/r/issues/3/comments' },
  { name: 'getFileContent の 500', status: 500, run: (c) => c.getFileContent('x.ts', 'main'), method: 'GET', path: '/repos/o/r/contents/x.ts' },
];

for (const { name, status, run, method, path } of failures) {
  test(`${name}は GitHubError（${status} ${method} ${path}）で token を含まない`, async () => {
    // 応答本文に token が入っていても漏らさない
    const { client } = clientWith(() => json({ message: `bad credentials ${TOKEN}` }, status));
    await assert.rejects(run(client), (error: unknown) => {
      assert.ok(error instanceof GitHubError, String(error));
      assert.equal(error.status, status);
      assert.equal(error.method, method);
      assert.equal(error.path, path);
      for (const text of [error.message, String(error), JSON.stringify(error), String(error.stack)]) {
        assert.ok(!text.includes(TOKEN), `token が含まれる: ${text}`);
      }
      return true;
    });
  });
}

test('github.ts は import を持たない（cloudflare:workers・@anthropic-ai/sdk・node: を読まない）', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/github.ts', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import[\s{*'"]/m.test(source), 'import 文がある');
  assert.ok(!/\bimport\s*\(/.test(source), 'import() がある');
  for (const name of ['cloudflare:workers', '@anthropic-ai/sdk', 'node:']) {
    assert.ok(!source.includes(name), `${name} を含む`);
  }
});
