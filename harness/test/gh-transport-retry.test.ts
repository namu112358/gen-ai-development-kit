// #715：GhTransport が gh の失敗（標準エラーの文・--include の頭）から上限を分類し、primary のリセットの時刻を gh api rate_limit で補い、secondary をやり直すことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GhTransport, RateLimitError, type GhRunner } from '../lib/github.ts';

const NOW = Date.parse('2026-10-11T00:00:00Z');
const RESET_EPOCH = 1791676800;
const RESET_ISO = new Date(RESET_EPOCH * 1000).toISOString();

type Result = ReturnType<GhRunner>;
type Call = { args: string[]; input: string | undefined };

/** 決めた順に結果を返し、呼ばれた引数を残す run */
function fakeRunner(results: Result[]): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: GhRunner = (args, input) => {
    calls.push({ args: [...args], input });
    const r = results[calls.length - 1];
    if (!r) throw new Error(`run が想定より多く呼ばれた（${calls.length} 回目）: ${JSON.stringify(args)}`);
    return r;
  };
  return { run, calls };
}

const ok = (stdout: string): Result => ({ status: 0, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): Result => ({ status: 1, stdout, stderr });

function retry() {
  const sleeps: number[] = [];
  return { sleeps, retry: { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5, now: () => NOW } };
}

test('GhTransport：標準エラーの文で primary と分類し、gh api rate_limit を1回読んで reset を resetAt にする（読めなければ null）', async () => {
  const PRIMARY_STDERR = 'gh: API rate limit exceeded for user ID 1. (HTTP 403)';
  const cases: [string, Result, string | null][] = [
    ['rate_limit が読める', ok(JSON.stringify({ resources: { core: { limit: 5000, remaining: 0, reset: RESET_EPOCH } } })), RESET_ISO],
    ['rate_limit が失敗', fail('gh: Server Error (HTTP 500)'), null],
  ];
  for (const [name, rateLimit, want] of cases) {
    const { run, calls } = fakeRunner([fail(PRIMARY_STDERR), rateLimit]);
    const { sleeps, retry: r } = retry();
    const t = new GhTransport({ retry: r }, run);
    await assert.rejects(
      () => t.request('GET', '/repos/o/r/pulls/3'),
      (e: unknown) => e instanceof RateLimitError && e.kind === 'primary' && e.status === 403 && e.resetAt === want,
      name,
    );
    assert.equal(calls.length, 2, name);
    assert.ok(!calls[0]!.args.includes('rate_limit'), name);
    assert.ok(calls[1]!.args.includes('rate_limit'), name);
    assert.deepEqual(sleeps, [], name);
  }
});

test('GhTransport：標準エラーの secondary rate limit は待ってやり直し、成功を返す', async () => {
  const { run, calls } = fakeRunner([fail('gh: You have exceeded a secondary rate limit (HTTP 403)'), ok('{"a":1}\n')]);
  const { sleeps, retry: r } = retry();
  const t = new GhTransport({ retry: r }, run);
  assert.deepEqual(await t.request('GET', '/repos/o/r/pulls/3'), { a: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.args, calls[0]!.args);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0]! >= 60000, String(sleeps[0]));
});

test('GhTransport：onResponse があれば --include の頭で分類し、rate_limit は呼ばない', async () => {
  const seen: number[] = [];
  const head = `HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: ${RESET_EPOCH}\nX-Ratelimit-Resource: core\n\n`;
  const { run, calls } = fakeRunner([fail('gh: API rate limit exceeded for user ID 1. (HTTP 403)', `${head}{"message":"API rate limit exceeded"}`)]);
  const { sleeps, retry: r } = retry();
  const t = new GhTransport({ onResponse: (i) => seen.push(i.status), retry: r }, run);
  await assert.rejects(
    () => t.request('GET', '/repos/o/r/pulls/3'),
    (e: unknown) => e instanceof RateLimitError && e.kind === 'primary' && e.resource === 'core' && e.resetAt === RESET_ISO,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.args.includes('--include'));
  assert.deepEqual(seen, [403]);
  assert.deepEqual(sleeps, []);
});
