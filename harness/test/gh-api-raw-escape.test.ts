// Issue #333：raw の要求（ジョブのログ・diff など）だけ gh api に --allow-escape-sequences を付け、色の制御文字を含む応答を読む（harness/lib/github.ts）。
// 古い gh がこのフラグを知らないときは、フラグを外して1回だけやり直し、ほかのエラーや raw でない要求ではやり直さないことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GhTransport,
  HttpError,
  ghApiArgs,
  isUnknownEscapeFlagError,
  withoutEscapeFlag,
  type GhRunner,
} from '../lib/github.ts';

const FLAG = '--allow-escape-sequences';
const UNKNOWN_FLAG_STDERR = 'unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]\n';

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

// ---- ghApiArgs ----

test('ghApiArgs：raw なら Accept の直後に --allow-escape-sequences が付く（body なし）', () => {
  assert.deepEqual(ghApiArgs('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }, false), [
    'api', '--method', 'GET', 'repos/o/r/actions/jobs/7/logs', '-H', 'Accept: application/vnd.github+json', FLAG,
  ]);
});

test('ghApiArgs：raw・accept 指定', () => {
  assert.deepEqual(ghApiArgs('GET', '/repos/o/r/pulls/3', { accept: 'application/vnd.github.diff', raw: true }, false), [
    'api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github.diff', FLAG,
  ]);
});

test('ghApiArgs：raw・body あり・include 真の順（Accept → フラグ → --include → --input -）', () => {
  assert.deepEqual(ghApiArgs('POST', '/markdown', { body: { text: 'x' }, raw: true }, true), [
    'api', '--method', 'POST', 'markdown', '-H', 'Accept: application/vnd.github+json', FLAG, '--include', '--input', '-',
  ]);
});

test('ghApiArgs：raw・allow404・include 真', () => {
  assert.deepEqual(ghApiArgs('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true, allow404: true }, true), [
    'api', '--method', 'GET', 'repos/o/r/actions/jobs/7/logs', '-H', 'Accept: application/vnd.github+json', FLAG, '--include',
  ]);
});

test('ghApiArgs：raw でなければ付かない（今の引数と同じ）', () => {
  const cases: [string, string, Parameters<typeof ghApiArgs>[2], boolean, string[]][] = [
    ['GET', '/repos/o/r/pulls/3', {}, false, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github+json']],
    ['GET', '/repos/o/r/pulls/3', {}, true, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github+json', '--include']],
    ['POST', '/graphql', { body: { query: 'q' } }, false, ['api', '--method', 'POST', 'graphql', '-H', 'Accept: application/vnd.github+json', '--input', '-']],
    ['POST', '/graphql', { body: { query: 'q' } }, true, ['api', '--method', 'POST', 'graphql', '-H', 'Accept: application/vnd.github+json', '--include', '--input', '-']],
    ['GET', '/repos/o/r/pulls/9', { allow404: true }, false, ['api', '--method', 'GET', 'repos/o/r/pulls/9', '-H', 'Accept: application/vnd.github+json']],
    ['GET', '/repos/o/r/pulls/3', { accept: 'application/vnd.github.diff' }, false, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github.diff']],
    ['GET', '/repos/o/r/pulls/3', { raw: false }, false, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github+json']],
  ];
  for (const [m, p, o, inc, want] of cases) {
    const got = ghApiArgs(m, p, o, inc);
    assert.deepEqual(got, want, JSON.stringify({ m, p, o, inc }));
    assert.ok(!got.includes(FLAG));
  }
});

test('ghApiArgs：raw なら --allow-escape-sequences はちょうど1つ', () => {
  const cases: Parameters<typeof ghApiArgs>[2][] = [
    { raw: true },
    { raw: true, accept: 'application/vnd.github.diff' },
    { raw: true, body: { a: 1 } },
    { raw: true, allow404: true },
  ];
  for (const o of cases) {
    for (const inc of [false, true]) {
      const a = ghApiArgs('GET', '/x', o, inc);
      assert.equal(a.filter((s) => s === FLAG).length, 1, JSON.stringify(a));
      const h = a.indexOf('-H');
      assert.equal(a[h + 2], FLAG, JSON.stringify(a));
    }
  }
});

// ---- isUnknownEscapeFlagError ----

test('isUnknownEscapeFlagError：このフラグを知らない gh のエラーだけ真', () => {
  assert.equal(isUnknownEscapeFlagError('unknown flag: --allow-escape-sequences'), true);
  assert.equal(isUnknownEscapeFlagError(UNKNOWN_FLAG_STDERR), true);
  assert.equal(isUnknownEscapeFlagError('error: unknown flag: --allow-escape-sequences\r\n'), true);
});

test('isUnknownEscapeFlagError：ほかのエラーでは偽', () => {
  for (const s of [
    '',
    'unknown flag: --foo',
    'unknown flag: --include',
    'gh: Not Found (HTTP 404)',
    'gh: Server Error (HTTP 502)',
    'error: the response contains terminal escape sequences; pass --allow-escape-sequences to print them',
    '--allow-escape-sequences',
  ]) {
    assert.equal(isUnknownEscapeFlagError(s), false, JSON.stringify(s));
  }
});

// ---- withoutEscapeFlag ----

test('withoutEscapeFlag：フラグを除いた新しい配列を返し、元は変えない', () => {
  const a = ['api', '--method', 'GET', 'x', '-H', 'Accept: a', FLAG, '--include'];
  const copy = [...a];
  const b = withoutEscapeFlag(a);
  assert.deepEqual(b, ['api', '--method', 'GET', 'x', '-H', 'Accept: a', '--include']);
  assert.notEqual(b, a);
  assert.deepEqual(a, copy);
  assert.deepEqual(withoutEscapeFlag(['api', 'x']), ['api', 'x']);
});

test('withoutEscapeFlag(ghApiArgs(raw)) は、フラグが無かった今までの引数と同じ', () => {
  const cases: [string, string, Parameters<typeof ghApiArgs>[2], boolean, string[]][] = [
    ['GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }, false, ['api', '--method', 'GET', 'repos/o/r/actions/jobs/7/logs', '-H', 'Accept: application/vnd.github+json']],
    ['GET', '/repos/o/r/pulls/3', { raw: true, accept: 'application/vnd.github.diff' }, true, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github.diff', '--include']],
    ['POST', '/markdown', { raw: true, body: { text: 'x' } }, false, ['api', '--method', 'POST', 'markdown', '-H', 'Accept: application/vnd.github+json', '--input', '-']],
    ['POST', '/markdown', { raw: true, body: { text: 'x' } }, true, ['api', '--method', 'POST', 'markdown', '-H', 'Accept: application/vnd.github+json', '--include', '--input', '-']],
  ];
  for (const [m, p, o, inc, want] of cases) assert.deepEqual(withoutEscapeFlag(ghApiArgs(m, p, o, inc)), want);
});

// ---- GhTransport（run を差し替える） ----

test('GhTransport：raw の成功では制御文字を含む文字列をそのまま返し、フラグ付きで1回だけ呼ぶ', async () => {
  const log = '2026-09-30T00:00:00Z \x1b[31merror\x1b[0m: failed\n\x1b[36;1mrun\x1b[0m\n';
  const { run, calls } = fakeRunner([ok(log)]);
  const t = new GhTransport({}, run);
  assert.equal(await t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }), log);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.args.includes(FLAG));
});

test('GhTransport：raw で gh がフラグを知らなければ、フラグを外して1回だけやり直す', async () => {
  const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), ok('plain log\n')]);
  const t = new GhTransport({}, run);
  assert.equal(await t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }), 'plain log\n');
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.args.includes(FLAG));
  assert.deepEqual(calls[1]!.args, ['api', '--method', 'GET', 'repos/o/r/actions/jobs/7/logs', '-H', 'Accept: application/vnd.github+json']);
});

test('GhTransport：やり直しでも body は同じ標準入力で渡す', async () => {
  const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), ok('<p>x</p>')]);
  const t = new GhTransport({}, run);
  assert.equal(await t.request('POST', '/markdown', { raw: true, body: { text: 'x' } }), '<p>x</p>');
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.input, JSON.stringify({ text: 'x' }));
  assert.equal(calls[1]!.input, JSON.stringify({ text: 'x' }));
  assert.deepEqual(calls[1]!.args, withoutEscapeFlag(calls[0]!.args));
  assert.ok(!calls[1]!.args.includes(FLAG));
});

test('GhTransport：やり直しも失敗なら HttpError を投げ、3回目は無い', async () => {
  const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), fail('gh: Server Error (HTTP 502)')]);
  const t = new GhTransport({}, run);
  await assert.rejects(
    () => t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }),
    (e: unknown) => e instanceof HttpError && e.status === 502,
  );
  assert.equal(calls.length, 2);
});

test('GhTransport：やり直しでもまた未知のフラグなら、それ以上やり直さずに投げる', async () => {
  const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), fail(UNKNOWN_FLAG_STDERR)]);
  const t = new GhTransport({}, run);
  await assert.rejects(() => t.request('GET', '/x', { raw: true }), HttpError);
  assert.equal(calls.length, 2);
});

test('GhTransport：やり直しで 404 なら allow404 のとき null、無ければ HttpError(404)', async () => {
  {
    const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), fail('gh: Not Found (HTTP 404)')]);
    const t = new GhTransport({}, run);
    assert.equal(await t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true, allow404: true }), null);
    assert.equal(calls.length, 2);
  }
  {
    const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR), fail('gh: Not Found (HTTP 404)')]);
    const t = new GhTransport({}, run);
    await assert.rejects(
      () => t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }),
      (e: unknown) => e instanceof HttpError && e.status === 404,
    );
    assert.equal(calls.length, 2);
  }
});

test('GhTransport：raw でも 404 ではやり直さない（allow404 なら null、無ければ HttpError）', async () => {
  {
    const { run, calls } = fakeRunner([fail('gh: Not Found (HTTP 404)')]);
    const t = new GhTransport({}, run);
    assert.equal(await t.request('GET', '/x', { raw: true, allow404: true }), null);
    assert.equal(calls.length, 1);
  }
  {
    const { run, calls } = fakeRunner([fail('gh: Not Found (HTTP 404)')]);
    const t = new GhTransport({}, run);
    await assert.rejects(() => t.request('GET', '/x', { raw: true }), (e: unknown) => e instanceof HttpError && e.status === 404);
    assert.equal(calls.length, 1);
  }
});

test('GhTransport：raw でもほかの未知のフラグや制御文字で止まったエラーではやり直さない', async () => {
  for (const stderr of [
    'unknown flag: --foo',
    'error: the response contains terminal escape sequences; pass --allow-escape-sequences to print them',
    'gh: Server Error (HTTP 500)',
  ]) {
    const { run, calls } = fakeRunner([fail(stderr)]);
    const t = new GhTransport({}, run);
    await assert.rejects(() => t.request('GET', '/x', { raw: true }), HttpError, stderr);
    assert.equal(calls.length, 1, stderr);
  }
});

test('GhTransport：raw でない要求は、未知のフラグのエラーでもやり直さない', async () => {
  const { run, calls } = fakeRunner([fail(UNKNOWN_FLAG_STDERR)]);
  const t = new GhTransport({}, run);
  await assert.rejects(() => t.request('GET', '/repos/o/r/pulls/3', {}), HttpError);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.args.includes(FLAG));
});

test('GhTransport：raw でない要求はフラグ無しで呼び、JSON を読む（空なら null）', async () => {
  {
    const { run, calls } = fakeRunner([ok('{"a":1}\n')]);
    const t = new GhTransport({}, run);
    assert.deepEqual(await t.request('GET', '/repos/o/r/pulls/3'), { a: 1 });
    assert.deepEqual(calls[0]!.args, ['api', '--method', 'GET', 'repos/o/r/pulls/3', '-H', 'Accept: application/vnd.github+json']);
    assert.equal(calls[0]!.input, undefined);
  }
  {
    const { run } = fakeRunner([ok('')]);
    const t = new GhTransport({}, run);
    assert.equal(await t.request('DELETE', '/repos/o/r/issues/3/labels/x'), null);
  }
});

test('GhTransport：onResponse があれば --include 付きで、やり直しの後も頭を除いた本文を返す', async () => {
  const seen: number[] = [];
  const body = 'line \x1b[32mok\x1b[0m\n';
  const { run, calls } = fakeRunner([
    fail(UNKNOWN_FLAG_STDERR),
    ok(`HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4999\n\n${body}`),
  ]);
  const t = new GhTransport({ onResponse: (i) => seen.push(i.status) }, run);
  assert.equal(await t.request('GET', '/repos/o/r/actions/jobs/7/logs', { raw: true }), body);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.args.includes('--include'));
  assert.ok(calls[0]!.args.includes(FLAG));
  assert.deepEqual(calls[1]!.args, ['api', '--method', 'GET', 'repos/o/r/actions/jobs/7/logs', '-H', 'Accept: application/vnd.github+json', '--include']);
  assert.equal(seen.at(-1), 200);
});
