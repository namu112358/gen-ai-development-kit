import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onPullRequest } from '../gates/on-pr.ts';
import { writePlanLink } from '../gates/plan-link.ts';
import { GitHub, HttpError, type RequestOptions } from '../lib/github.ts';
import { linkedIssues } from '../lib/state.ts';
import { FakeGitHub, acceptanceFake, config, ctxFor, planGateComment, pr } from './support/gate-fixtures.ts';
import { FEATURE_BASE, STACK, countCalls, stackedPr } from './support/stack-fixtures.ts';

/**
 * Issue #269：PR を作った直後に GitHub が closingIssuesReferences をまだ埋めていないとき、agent/plan-link が failure になる遅れ。
 * base が既定ブランチの PR（default）で一覧が空なら、本文の `Closes #N` で補う（N がこのリポジトリの Issue で、PR でも 404 でもないときだけ）。
 * 一覧が空でなければ今の一覧のまま、orphan-base は補わない、スタックの層は今のまま本文の Refs・Closes。
 * ゲート（plan-link の writePlanLink・onPullRequest の opened）と、関数（state.ts の linkedIssues）の両方を確かめる。
 */

const HUMAN_HEAD = { ref: 'feature/x', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } };

/** closingIssuesReferences の応答 */
const closingReply = (numbers: number[]) => ({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes: numbers.map((number) => ({ number, repository: { nameWithOwner: 'o/r' } })) } } } } });

/**
 * 404 の Issue。本物の Transport（FetchTransport・GhTransport）と同じく、allow404 なら null を返し、そうでなければ HttpError(404) を投げる
 * （FakeGitHub のルートが無いときの unrouted のエラーでは代わりにしない）
 */
const notFound = (n: number) => (_m: RegExpMatchArray, _b: unknown, o: RequestOptions) => {
  if (o.allow404) return null;
  throw new HttpError(404, `GET /repos/o/r/issues/${n} -> 404: Not Found`);
};

/** Issue の応答（PR なら pull_request のキーを持つ） */
const issueReply = (n: number, isPr = false) => () => ({ number: n, title: `t${n}`, state: 'open', ...(isPr ? { pull_request: { url: `https://api.github.com/repos/o/r/pulls/${n}` } } : {}) });

/**
 * ゲート用の偽の GitHub。acceptanceFake（#3 に計画ゲートの記録）に、closingIssuesReferences の応答と GET /issues/{N} を足す。
 * #3 は計画のある Issue、#4 は計画の無い Issue、#5 は PR、#99 は 404
 */
function lagFake(opts: { pr: ReturnType<typeof pr>; closing: number[]; issue3?: (m: RegExpMatchArray, b: unknown, o: RequestOptions) => unknown }): FakeGitHub {
  return acceptanceFake({ pr: opts.pr, dashboardLabels: [] })
    .on('GET', /\/issues\/4\/comments/, () => [])
    .on('GET', /\/issues\/3$/, opts.issue3 ?? issueReply(3))
    .on('GET', /\/issues\/4$/, issueReply(4))
    .on('GET', /\/issues\/5$/, issueReply(5, true))
    .on('GET', /\/issues\/99$/, notFound(99))
    .on('POST', /\/graphql/, (_m, body) => (String(body.query).includes('closingIssuesReferences') ? closingReply(opts.closing) : { data: {} }));
}

const planLinkConclusions = (fake: FakeGitHub) => fake.writes().filter((w) => w.startsWith('check:agent/plan-link='));
const runLink = async (fake: FakeGitHub) => {
  await writePlanLink(ctxFor(fake, 'pull_request_target', {}), 5);
  return planLinkConclusions(fake);
};

// ---- ゲート（agent/plan-link） ----

test('plan-link（#269）：closingIssuesReferences が空でも、本文の Closes #N が計画のある Issue なら success（opened）', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, body: 'Closes #3' }), closing: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.deepEqual(planLinkConclusions(fake), ['check:agent/plan-link=success']);
  assert.ok(countCalls(fake, 'GET', '/repos/o/r/issues/3') >= 1, 'Issue かどうかを GET /issues/3 で確かめる（opened では plan-link と範囲照合の両方が紐付けを読む）');
});

test('plan-link（#269）：writePlanLink でも、一覧が空で本文の Closes #3 なら success', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, body: 'Closes #3' }), closing: [] });
  assert.deepEqual(await runLink(fake), ['check:agent/plan-link=success']);
});

test('plan-link（#269）：本文の Closes #N の N が PR（pull_request のキーがある）なら紐付けに使わず failure、計画の有無を読みに行かない', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, body: 'Closes #5' }), closing: [] });
  assert.deepEqual(await runLink(fake), ['check:agent/plan-link=failure']);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/5'), 1);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/5/comments'), 0, 'PR の番号の計画を読まない');
});

test('plan-link（#269）：本文の Closes #N の N が存在しない（404）なら紐付けに使わず failure', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, body: 'Closes #99' }), closing: [] });
  assert.deepEqual(await runLink(fake), ['check:agent/plan-link=failure']);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/99'), 1);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/99/comments'), 0);
});

test('plan-link（#269）：closingIssuesReferences が空でなければ今の一覧で紐付き、本文の Closes を読みに行かない', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, body: 'Closes #4' }), closing: [3] });
  assert.deepEqual(await runLink(fake), ['check:agent/plan-link=success']);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/4'), 0, '一覧が空でないときは本文で補わない');
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/4/comments'), 0);
});

test('plan-link（#269）：本文の Issue を読んで 404 以外のエラー（500）なら投げる（failure にしない）', async () => {
  const fake = lagFake({
    pr: pr({ head: HUMAN_HEAD, body: 'Closes #3' }),
    closing: [],
    issue3: () => { throw new HttpError(500, 'GET /repos/o/r/issues/3 -> 500: Server Error'); },
  });
  await assert.rejects(writePlanLink(ctxFor(fake, 'pull_request_target', {}), 5), (e: unknown) => e instanceof HttpError && e.status === 500);
  assert.deepEqual(planLinkConclusions(fake), [], 'チェックを書かない');
});

test('plan-link（#269）：base が既定ブランチ以外で stack の無い PR（orphan-base）は本文で補わず failure、GET /issues/3 を読まない', async () => {
  const fake = lagFake({ pr: pr({ head: HUMAN_HEAD, base: FEATURE_BASE, body: 'Closes #3' }), closing: [] });
  assert.deepEqual(await runLink(fake), ['check:agent/plan-link=failure']);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/3'), 0);
});

// ---- linkedIssues（関数） ----

/** closingIssuesReferences と GET /issues/{N} の応答を決めた偽の GitHub（pr-link.test.ts の linkFake に倣う） */
function linkFake(opts: { closing?: number[] } = {}): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\/3$/, issueReply(3))
    .on('GET', /\/issues\/4$/, issueReply(4))
    .on('GET', /\/issues\/5$/, issueReply(5, true))
    .on('GET', /\/issues\/99$/, notFound(99))
    .on('GET', /\/issues\/3\/comments/, () => [planGateComment])
    .on('POST', /\/graphql/, (_m, body) => (String(body.query).includes('closingIssuesReferences') ? closingReply(opts.closing ?? []) : { data: {} }));
}
const ghOf = (fake: FakeGitHub) => new GitHub(fake, 'o/r');
const issueGets = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'GET' && /\/issues\/\d+$/.test(c.path)).map((c) => c.path);

test('linkedIssues（#269）：default で一覧が空なら本文の Closes で補う（PR・404 の番号と Refs は使わない、本文に出てくる順）', async () => {
  const one = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(one), config, pr({ body: 'Closes #3' })), [3]);

  const mixed = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(mixed), config, pr({ body: 'Closes #5\nFixes #4\nCloses #99\nresolves #3\nRefs #6' })), [4, 3]);
  assert.ok(!issueGets(mixed).includes('/repos/o/r/issues/6'), 'Refs の番号は読みに行かない');

  const refsOnly = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(refsOnly), config, pr({ body: 'Refs #3' })), [], 'スタックでない PR の Refs は今のまま紐付かない');
  assert.deepEqual(issueGets(refsOnly), [], 'Refs の番号は読みに行かない');

  const none = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(none), config, pr({ body: '説明だけ' })), []);
  assert.deepEqual(issueGets(none), []);
});

test('linkedIssues（#269）：default で一覧が空でなければ、その一覧のまま（本文で補わない）', async () => {
  const fake = linkFake({ closing: [4] });
  assert.deepEqual(await linkedIssues(ghOf(fake), config, pr({ body: 'Closes #3' })), [4]);
  assert.deepEqual(issueGets(fake), []);
});

test('linkedIssues（#269）：orphan-base（stack の無い別ブランチ宛て・形の崩れた stack）は本文で補わない', async () => {
  const noStack = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(noStack), config, pr({ base: FEATURE_BASE, body: 'Closes #3' })), []);
  assert.deepEqual(issueGets(noStack), []);

  const malformed = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(malformed), config, stackedPr({ body: 'Closes #3', stack: { ...STACK, position: 'x' } })), []);
  assert.deepEqual(issueGets(malformed), []);
});

test('linkedIssues（#269）：スタックの層は今のまま本文の Refs・Closes（GET /issues/{N} を読まない）', async () => {
  const fake = linkFake({ closing: [] });
  assert.deepEqual(await linkedIssues(ghOf(fake), config, stackedPr({ body: 'Closes #3' })), [3]);
  assert.deepEqual(await linkedIssues(ghOf(fake), config, stackedPr({ body: 'Refs #4' })), [4]);
  assert.deepEqual(issueGets(fake), []);
});

test('linkedIssues（#269）：本文の Issue を読んで 404 以外のエラーなら投げる', async () => {
  const fake = linkFake({ closing: [] })
    .on('GET', /\/issues\/3$/, () => { throw new HttpError(500, 'GET /repos/o/r/issues/3 -> 500'); });
  await assert.rejects(linkedIssues(ghOf(fake), config, pr({ body: 'Closes #3' })), (e: unknown) => e instanceof HttpError && e.status === 500);
});
