// Issue #176：ダッシュボードの GitHub への問い合わせ（条件付きリクエストでの見張りと、書き込みを拒む Transport）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestOptions, Transport } from '../lib/github.ts';
import { GitHub } from '../lib/github.ts';
import { DashboardData, ReadOnlyTransport, UpdateWatcher, type FetchLike } from '../scripts/dashboard/github.ts';
import { config, FakeGitHub, HEAD, pr } from './support/gate-fixtures.ts';
import { stackedPr } from './support/stack-fixtures.ts';

interface Item { number: number; updated_at: string; pull_request?: object }
interface Reply { status: number; etag?: string; body?: Item[] }
interface Call { url: string; headers: Record<string, string> }

const header = (h: Record<string, string>, name: string): string | undefined =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

function fakeFetch(replies: Reply[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    assert.equal(init.method, 'GET');
    const r = replies.shift();
    assert.ok(r, '想定より多く問い合わせた');
    return {
      status: r.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? r.etag ?? null : null) },
      json: async () => r.body ?? [],
    };
  };
  return { fetch, calls };
}
const items = (list: [number, string, boolean?][]): Item[] => list.map(([number, updated_at, pr]) => ({ number, updated_at, ...(pr ? { pull_request: {} } : {}) }));

test('UpdateWatcher：1回目は If-None-Match なしで full。2回目は前回の ETag を付け、304 なら unchanged', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 200, etag: 'W/"e1"', body: items([[1, 't1'], [2, 't1', true]]) },
    { status: 304, etag: 'W/"e1"' },
  ]);
  const w = new UpdateWatcher({ fetch, token: 'tok-123', repository: 'o/r' });
  assert.deepEqual(await w.poll(), { kind: 'full' });
  w.commit();
  assert.equal(header(calls[0]!.headers, 'if-none-match'), undefined);
  assert.deepEqual(await w.poll(), { kind: 'unchanged' });
  assert.equal(header(calls[1]!.headers, 'if-none-match'), 'W/"e1"');

  const url = new URL(calls[0]!.url);
  assert.equal(url.origin, 'https://api.github.com');
  assert.equal(url.pathname, '/repos/o/r/issues');
  for (const [k, v] of Object.entries({ state: 'all', sort: 'updated', direction: 'desc', per_page: '50' })) assert.equal(url.searchParams.get(k), v, k);
  for (const c of calls) assert.match(header(c.headers, 'authorization') ?? '', /tok-123/);
});

test('UpdateWatcher：200 なら updated_at が変わった番号と新しく出た番号だけ changed（Issue と PR の両方）。変化が無ければ unchanged', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 200, etag: '"e1"', body: items([[1, 't1'], [2, 't1', true], [3, 't1']]) },
    { status: 200, etag: '"e2"', body: items([[2, 't2', true], [4, 't2'], [1, 't1'], [3, 't1']]) },
    { status: 200, etag: '"e3"', body: items([[2, 't2', true], [4, 't2'], [1, 't1'], [3, 't1']]) },
    { status: 304 },
  ]);
  const w = new UpdateWatcher({ fetch, token: 't', repository: 'o/r', apiUrl: 'https://ghe.example/api/v3' });
  assert.deepEqual(await w.poll(), { kind: 'full' });
  w.commit();
  const changed = await w.poll();
  w.commit();
  assert.equal(changed.kind, 'changed');
  assert.ok(changed.kind === 'changed');
  assert.deepEqual([...changed.numbers].sort((a, b) => a - b), [2, 4]);
  assert.equal(header(calls[1]!.headers, 'if-none-match'), '"e1"');
  assert.deepEqual(await w.poll(), { kind: 'unchanged' }, '200 でも変わった番号が無い');
  w.commit();
  assert.equal(header(calls[2]!.headers, 'if-none-match'), '"e2"');
  assert.deepEqual(await w.poll(), { kind: 'unchanged' });
  assert.equal(header(calls[3]!.headers, 'if-none-match'), '"e3"', '最新の ETag を使う');
  assert.ok(calls[0]!.url.startsWith('https://ghe.example/api/v3/repos/o/r/issues?'));
});

test('UpdateWatcher：50件すべてが変わっていたら full（取りこぼしがあり得るため全体を読み直す）', async () => {
  const page = (t: string) => items(Array.from({ length: 50 }, (_, i) => [i + 1, t] as [number, string]));
  const { fetch } = fakeFetch([
    { status: 200, etag: '"a"', body: page('t1') },
    { status: 200, etag: '"b"', body: page('t2') },
  ]);
  const w = new UpdateWatcher({ fetch, token: 't', repository: 'o/r' });
  assert.deepEqual(await w.poll(), { kind: 'full' });
  w.commit();
  assert.deepEqual(await w.poll(), { kind: 'full' });
});

test('UpdateWatcher：取り込みに失敗して commit しなければ、次の poll は同じ変化をもう一度返す', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 200, etag: '"e1"', body: items([[1, 't1'], [2, 't1']]) },
    { status: 200, etag: '"e1"', body: items([[1, 't1'], [2, 't1']]) },
    { status: 200, etag: '"e2"', body: items([[2, 't2'], [1, 't1']]) },
    { status: 200, etag: '"e2"', body: items([[2, 't2'], [1, 't1']]) },
    { status: 304 },
  ]);
  const w = new UpdateWatcher({ fetch, token: 't', repository: 'o/r' });
  assert.deepEqual(await w.poll(), { kind: 'full' }, '起動時の読み込み（ここで失敗したとする）');
  assert.deepEqual(await w.poll(), { kind: 'full' }, 'commit していないので、もう一度全体を読む');
  assert.equal(header(calls[1]!.headers, 'if-none-match'), undefined, 'ETag も進めていない');
  w.commit();
  assert.deepEqual(await w.poll(), { kind: 'changed', numbers: [2] }, '取り直しに失敗したとする');
  assert.deepEqual(await w.poll(), { kind: 'changed', numbers: [2] }, '同じ変化をもう一度返す');
  assert.equal(header(calls[3]!.headers, 'if-none-match'), '"e1"');
  w.commit();
  assert.deepEqual(await w.poll(), { kind: 'unchanged' });
  assert.equal(header(calls[4]!.headers, 'if-none-match'), '"e2"');
});

class RecordingTransport implements Transport {
  calls: { method: string; path: string; opts?: RequestOptions }[] = [];
  async request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
    this.calls.push({ method, path, opts });
    return { ok: true };
  }
}

test('ReadOnlyTransport：GET と query の GraphQL は内側に通す', async () => {
  const inner = new RecordingTransport();
  const t = new ReadOnlyTransport(inner);
  assert.deepEqual(await t.request('GET', '/repos/o/r/issues'), { ok: true });
  assert.deepEqual(await t.request('POST', '/graphql', { body: { query: 'query { repository(owner: "o", name: "r") { id } }' } }), { ok: true });
  assert.deepEqual(await t.request('POST', '/graphql', { body: { query: '{ viewer { login } }' } }), { ok: true });
  assert.deepEqual(inner.calls.map((c) => [c.method, c.path]), [['GET', '/repos/o/r/issues'], ['POST', '/graphql'], ['POST', '/graphql']]);
});

test('ReadOnlyTransport：書き込み（POST/PATCH/PUT/DELETE と mutation の GraphQL）は内側を呼ばずに例外', async () => {
  const inner = new RecordingTransport();
  const t = new ReadOnlyTransport(inner);
  await assert.rejects(async () => t.request('POST', '/repos/o/r/issues/1/comments', { body: { body: 'x' } }));
  await assert.rejects(async () => t.request('PATCH', '/repos/o/r/issues/1', { body: { state: 'closed' } }));
  await assert.rejects(async () => t.request('PUT', '/repos/o/r/pulls/1/merge'));
  await assert.rejects(async () => t.request('DELETE', '/repos/o/r/issues/1/labels/x'));
  await assert.rejects(async () => t.request('POST', '/graphql', { body: { query: 'mutation { addComment(input: {}) { clientMutationId } }' } }));
  await assert.rejects(async () => t.request('POST', '/graphql', { body: { query: '  mutation M { x }' } }));
  assert.deepEqual(inner.calls, []);
});

// DashboardData：紐付けは harness/lib/state.ts の linkedIssues（Stacked PR の層は本文の Refs #N）
function dataFake(): FakeGitHub {
  const issue = (number: number, labels: string[]) => ({ number, title: `t${number}`, state: 'open', body: null, html_url: `u${number}`, labels: labels.map((name) => ({ name })) });
  const issues = [issue(3, ['agent:plan-ok']), issue(4, [])];
  const prs = [
    stackedPr({ number: 7, body: 'Refs #3', head: { ref: 'claude/issue-3-top', sha: HEAD, repo: { full_name: 'o/r' } } }),
    pr({ number: 8, body: 'no link', head: { ref: 'claude/issue-9-x', sha: HEAD, repo: { full_name: 'o/r' } } }),
  ];
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/pulls\?state=open/, () => prs)
    .on('GET', /^\/repos\/o\/r\/pulls\/(\d+)$/, (m) => prs.find((p) => p.number === Number(m[1])))
    .on('GET', /^\/repos\/o\/r\/pulls\/\d+\/reviews/, () => [])
    .on('GET', /^\/repos\/o\/r\/issues\?state=open/, () => issues)
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)$/, (m) => issues.find((i) => i.number === Number(m[1])))
    .on('GET', /^\/repos\/o\/r\/issues\/\d+\/(timeline|comments)/, () => [])
    .on('GET', /^\/repos\/o\/r\/commits\/\w+$/, () => ({ commit: { committer: { date: '2026-09-26T00:00:00Z' } } }))
    .on('GET', /^\/repos\/o\/r\/commits\/\w+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /^\/repos\/o\/r\/compare\//, (_m, _b, opts) => (opts.raw ? 'diff --git a/x b/x\n' : { ahead_by: 0 }))
    .on('POST', /^\/graphql$/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('blockedBy')) return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
      if (q.includes('closedByPullRequestsReferences')) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } };
      if (q.includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } };
      throw new Error(`unexpected graphql: ${q}`);
    });
}

test('DashboardData：Refs #N だけで紐付く Stacked PR の層も Issue の PR になる。対象外の Issue は出さず、紐付けの無い Agent PR は単独で出す。書き込みはしない', async () => {
  const fake = dataFake();
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(fake), 'o/r'), config);
  await data.loadAll();
  assert.deepEqual(data.issues().map((i) => i.fleet.facts.number), [3], '#4 は agent: のラベルも着手宣言も PR も無い');
  assert.deepEqual(data.issues()[0]!.fleet.prs.map((p) => p.number), [7]);
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[7, 3], [8, null]]);
  assert.deepEqual(fake.writes(), []);
});

test('DashboardData.refresh：変わった PR は、紐付く Issue の組として取り直す', async () => {
  const fake = dataFake();
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(fake), 'o/r'), config);
  await data.loadAll();
  const before = fake.calls.length;
  await data.refresh([7]);
  const paths = fake.calls.slice(before).map((c) => c.path);
  assert.ok(paths.includes('/repos/o/r/issues/3'), 'PR #7 の Issue #3 を取り直す');
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[7, 3], [8, null]]);
});
