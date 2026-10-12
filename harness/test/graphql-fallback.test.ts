// #716：FallbackGitHub が REST の core の上限でだけコメントとラベルを GraphQL の mutation でやり直し、ほかの失敗と素の GitHub（ゲート）では GraphQL を呼ばないことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub, HttpError, RateLimitError, type Transport } from '../lib/github.ts';

// cli.ts は import したときに harness.config.json を読むので、agent-commands.test.ts の loadCli にならって動的 import する
const loadCli = () => import('../scripts/agent/cli.ts');

const RESET = '2026-10-12T05:00:00.000Z';
const coreLimit = (resource: string | null = 'core') => new RateLimitError(403, 'API rate limit exceeded', { kind: 'primary', resource, resetAt: RESET });
const KNOWN_LABELS: Record<string, string> = { 'agent:a': 'LA_a', 'agent:b': 'LA_b' };

type Call = { method: string; path: string; query: string; variables: Record<string, any> };

/** REST では渡された例外を投げ、/graphql では query の語で決めた { data } を返す偽の Transport */
function fakeTransport(restError: Error): { transport: Transport; calls: Call[]; gql: () => Call[] } {
  const calls: Call[] = [];
  const transport: Transport = {
    async request(method, path, opts = {}) {
      const body = (opts.body ?? {}) as { query?: string; variables?: Record<string, any> };
      calls.push({ method, path, query: body.query ?? '', variables: body.variables ?? {} });
      if (path !== '/graphql') throw restError;
      const q = body.query ?? '';
      const v = body.variables ?? {};
      if (q.includes('addComment')) return { data: { addComment: { commentEdge: { node: { databaseId: 901, url: 'https://github.com/o/r/issues/7#issuecomment-901' } } } } };
      if (q.includes('addLabelsToLabelable')) return { data: { addLabelsToLabelable: { labelable: { labels: { nodes: [{ name: 'agent:a' }, { name: 'agent:b' }] } } } } };
      if (q.includes('removeLabelsFromLabelable')) return { data: { removeLabelsFromLabelable: { clientMutationId: null } } };
      if (q.includes('issueOrPullRequest')) {
        const repository: Record<string, unknown> = { issueOrPullRequest: { __typename: 'Issue', id: 'I_7' } };
        for (const [k, name] of Object.entries(v)) if (/^l\d+$/.test(k)) repository[k] = KNOWN_LABELS[name] ? { id: KNOWN_LABELS[name], name } : null;
        return { data: { repository } };
      }
      throw new Error(`想定しない GraphQL: ${q}`);
    },
  };
  return { transport, calls, gql: () => calls.filter((c) => c.path === '/graphql') };
}

test('REST が core の上限なら、comment は addComment でやり直して REST と同じ形を返し、標準エラーに1行出す', async () => {
  const { FallbackGitHub } = await loadCli();
  const { transport, gql } = fakeTransport(coreLimit());
  const lines: string[] = [];
  const gh = new FallbackGitHub(transport, 'o/r', (line: string) => lines.push(line));
  const res = await gh.comment(7, 'hello');
  assert.deepEqual(res, { id: 901, html_url: 'https://github.com/o/r/issues/7#issuecomment-901' });
  const add = gql().find((c) => c.query.includes('addComment'));
  assert.ok(add, 'addComment が呼ばれていない');
  assert.equal(add.variables.subjectId, 'I_7');
  assert.equal(add.variables.body, 'hello');
  assert.equal(lines.length, 1);
  for (const part of ['#7', 'コメントの投稿', RESET]) assert.ok(lines[0]!.includes(part), lines[0]);
});

test('REST が core の上限なら、ラベルの付け外しは GraphQL の mutation でやり直す', async () => {
  const { FallbackGitHub } = await loadCli();
  const cases: { name: string; run: (gh: GitHub) => Promise<unknown>; mutation: string | null; result?: unknown; ids?: string[]; rejects?: string }[] = [
    { name: 'addLabels 2つ', run: (gh) => gh.addLabels(7, ['agent:a', 'agent:b']), mutation: 'addLabelsToLabelable', result: [{ name: 'agent:a' }, { name: 'agent:b' }], ids: ['LA_a', 'LA_b'] },
    { name: 'addLabels 空', run: (gh) => gh.addLabels(7, []), mutation: null, result: [] },
    { name: 'addLabels 引けない', run: (gh) => gh.addLabels(7, ['agent:a', 'agent:none']), mutation: null, rejects: 'agent:none' },
    { name: 'removeLabel 引ける', run: (gh) => gh.removeLabel(7, 'agent:a'), mutation: 'removeLabelsFromLabelable', ids: ['LA_a'] },
    { name: 'removeLabel 引けない', run: (gh) => gh.removeLabel(7, 'agent:none'), mutation: null },
  ];
  for (const c of cases) {
    const { transport, gql } = fakeTransport(coreLimit());
    const gh = new FallbackGitHub(transport, 'o/r', () => {});
    if (c.rejects) await assert.rejects(c.run(gh), (e: unknown) => e instanceof Error && e.message.includes(c.rejects!), c.name);
    else if ('result' in c) assert.deepEqual(await c.run(gh), c.result, c.name);
    else await c.run(gh);
    const mutations = gql().filter((g) => /addLabelsToLabelable|removeLabelsFromLabelable/.test(g.query));
    if (c.name === 'addLabels 空') assert.equal(gql().length, 0, c.name);
    if (c.mutation === null) { assert.equal(mutations.length, 0, c.name); continue; }
    assert.equal(mutations.length, 1, c.name);
    assert.ok(mutations[0]!.query.includes(c.mutation), c.name);
    assert.equal(mutations[0]!.variables.labelableId ?? mutations[0]!.variables.id, 'I_7', c.name);
    for (const id of c.ids!) assert.ok(JSON.stringify(mutations[0]!.variables).includes(id), `${c.name}: ${id}`);
  }
});

test('core でない上限・ほかの 403・素の GitHub（ゲート）では GraphQL を呼ばずに同じ例外を投げ、resource が null なら切り替える', async () => {
  const { FallbackGitHub } = await loadCli();
  const cases: { name: string; error: Error; plain?: boolean; fallback: boolean }[] = [
    { name: '(a) secondary', error: new RateLimitError(403, 'secondary rate limit', { kind: 'secondary', resource: 'core', resetAt: RESET }), fallback: false },
    { name: '(b) ほかの 403', error: new HttpError(403, 'Resource not accessible by integration'), fallback: false },
    { name: '(c) resource が search', error: coreLimit('search'), fallback: false },
    { name: '(d) 素の GitHub + core の上限', error: coreLimit(), plain: true, fallback: false },
    { name: '(e) resource が null', error: coreLimit(null), fallback: true },
  ];
  for (const c of cases) {
    const { transport, gql } = fakeTransport(c.error);
    const gh: GitHub = c.plain ? new GitHub(transport, 'o/r') : new FallbackGitHub(transport, 'o/r', () => {});
    if (c.fallback) {
      await gh.comment(7, 'hello');
      assert.ok(gql().some((g) => g.query.includes('addComment')), c.name);
    } else {
      await assert.rejects(gh.comment(7, 'hello'), (e: unknown) => e === c.error, c.name);
      assert.equal(gql().length, 0, c.name);
    }
  }
});
