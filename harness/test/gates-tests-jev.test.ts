import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import type { TamperJevRecord } from '../lib/test-tamper-jev.ts';
import { rewriteTestsCheck } from '../gates/apply.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, HEAD, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/**
 * テストの改ざんの検査（agent/tests）が止めた変更を App が Jev に問う（Issue #126、ゲート）。
 * - AC1：shadow では Jev の確率が要約と test-tamper-jev の記録に残り、agent/tests は failure のまま（確率が高くても）。同じ patch-id の記録があれば二度問わない
 * - AC2：enforce ではしきい値以上なら success、未満なら failure。削除系を含む差分は Jev に問わず failure
 * - 判定の受け付け（rewriteTestsCheck の経路）と auto-merge を付けた後の書き直しでも、enforce で Jev が通した差分は success のまま
 * - Human Merge の PR は enforce でも neutral のまま（Jev の節が足される）
 * - off・fork・JEV_API_KEY なし・test:exempt では問わない
 * Jev は ctx.askJev の偽物で差し替える。判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする。
 */

// ---- 設定（実物の harness.config.json の既定値に依存しない） ----

const configFor = (testTamper: 'off' | 'shadow' | 'enforce', threshold = 0.9, patch: Partial<HarnessConfig> = {}): HarnessConfig => ({
  ...base,
  ...patch,
  jev: { ...base.jev, mode: 'off', testTamper, thresholds: { ...base.jev.thresholds, testTamperProbability: threshold } },
});

// ---- 差分 ----

const fileDiff = (path: string, lines: string[], start = 1): string => {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
};

const TEST_FILE = 'harness/test/a.test.ts';
/** 対になったアサーションの書き換えだけ（Jev に問える） */
const ASSERT_DIFF = fileDiff(TEST_FILE, ['-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);'], 5);
/** アサーションの書き換えと skip の追加（削除系を含むので問わない） */
const SKIP_DIFF = fileDiff(TEST_FILE, ['-  assert.equal(f(), 2);', "-test('a', () => {});", '+  assert.equal(f(), 3);', "+test.skip('a', () => {});"], 5);
/** テスト定義の削除 */
const REMOVED_DIFF = fileDiff('harness/test/b.test.ts', [" test('keep', () => {});", "-test('gone', () => {", '-  assert.ok(x);', '-});']);
/** 対にならないアサーションの削除 */
const UNPAIRED_DIFF = fileDiff(TEST_FILE, ['-  assert.ok(a);', '-  assert.ok(b);', '+  assert.ok(x);'], 5);
/** ガードレール（harness/gates/run.ts）とアサーションの書き換え（Human Merge） */
const GUARD_DIFF = fileDiff('harness/gates/run.ts', ['-a', '+b']) + ASSERT_DIFF;

// ---- 偽の GitHub と偽の Jev ----

let nextId = 500;
const appComment = (kind: string, value: unknown) => ({
  id: nextId++, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});
const planGate = (files: string[]) => appComment('plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } });
const exemptRecord = (diff: string) => appComment('test-exempt', { version: 1, label: 'test:exempt', action: 'labeled', by: 'me', patchId: patchId(diff), headSha: HEAD });
const tamperRecord = (diff: string, patch: Partial<TamperJevRecord> = {}): ReturnType<typeof appComment> =>
  appComment('test-tamper-jev', {
    version: 1, patchId: patchId(diff), headSha: HEAD, mode: 'shadow', model: 'jev-test', probabilities: [0.95], probability: 0.95, threshold: 0.9, allows: false, ...patch,
  });

/** 差分から変更ファイルの一覧を作る */
const filesOf = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);

/**
 * PR のコメントを持つ偽の GitHub。App が書いたコメントは prComments に足す（続けて別のイベントを渡すと、記録を読む）
 */
function fakeFor(opts: { diff: string; pr?: Record<string, unknown>; prComments?: unknown[] }): { fake: FakeGitHub; prComments: unknown[] } {
  const prComments = opts.prComments ?? [];
  const files = filesOf(opts.diff);
  const fake = acceptanceFake({ pr: pr(opts.pr ?? {}), dashboardLabels: [], prComments })
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? opts.diff : { behind_by: 0 }))
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/3\/comments/, () => [planGate(files)])
    .on('GET', /\/issues\/5\/comments/, () => prComments)
    .on('POST', /\/issues\/5\/comments$/, (_m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      prComments.push(c);
      return c;
    });
  return { fake, prComments };
}

/** 偽の Jev。テストの改ざんの問い（change_*）だけに、対ごとに同じ確率で答える。呼ばれた要求を残す */
function fakeJev(probability: number | 'error') {
  const asked: { state: unknown; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const keys = Object.keys(request.questions);
    if (!keys.every((k) => k.startsWith('change_'))) return { status: 'error', detail: 'テストの改ざんの問いではない' };
    asked.push(request);
    if (probability === 'error') return { status: 'error', detail: 'HTTP 500' };
    return { status: 'ok', model: 'jev-test', answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: probability }])) };
  };
  return { asked, fn };
}

const sync = { action: 'synchronize', pull_request: { number: 5 } };
const withJev = (jev: ReturnType<typeof fakeJev>, config: HarnessConfig, extra: Record<string, unknown> = {}) => ({ config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn, ...extra });

const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === 'agent/tests').map((c) => c.body);
const lastTests = (fake: FakeGitHub) => testsChecks(fake).at(-1);
const conclusions = (fake: FakeGitHub) => testsChecks(fake).map((b) => b.conclusion as string);
const tamperRecords = (fake: FakeGitHub): TamperJevRecord[] =>
  fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && /kind=test-tamper-jev/.test(String(c.body.body)))
    .map((c) => {
      const b = extractBlock(String(c.body.body), 'agent-app');
      assert.ok(b.found && b.ok, '記録のブロックが読める');
      return b.value as TamperJevRecord;
    });

// ---- AC1：shadow ----

test('AC1：shadow では確率が要約と test-tamper-jev の記録に残り、agent/tests は failure のまま（確率が高くても）', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('shadow'))));
  assert.equal(jev.asked.length, 1, '1回だけ問う');
  assert.deepEqual((jev.asked[0]!.state as { changes: unknown[] }).changes, [{ file: TEST_FILE, before: 'assert.equal(f(), 2);', after: 'assert.equal(f(), 3);' }]);

  const body = lastTests(fake);
  assert.equal(body.conclusion, 'failure');
  assert.ok(!conclusions(fake).includes('success'));
  assert.match(body.output.summary, /### Jev の判定/);
  assert.match(body.output.summary, /0\.99|99%/);
  assert.match(body.output.summary, /記録だけで、この結果は変えません/);

  const records = tamperRecords(fake);
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.version, 1);
  assert.equal(r.patchId, patchId(ASSERT_DIFF));
  assert.equal(r.headSha, HEAD);
  assert.equal(r.mode, 'shadow');
  assert.equal(r.model, 'jev-test');
  assert.equal(r.probability, 0.99);
  assert.equal(r.threshold, 0.9);
  assert.equal(typeof r.allows, 'boolean');
});

test('AC1：同じ patch-id の記録があれば二度問わず、記録を増やさない', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, prComments: [tamperRecord(ASSERT_DIFF, { probability: 0.42, probabilities: [0.42] })] });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('shadow'))));
  assert.equal(jev.asked.length, 0);
  assert.deepEqual(tamperRecords(fake), []);
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'failure');
  assert.match(body.output.summary, /0\.42|42%/, '記録の確率を使う');
});

test('AC1：続けて2回ゲートが動いても、1つの差分に1回だけ問い、記録も1つ', async () => {
  const { fake, prComments } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('shadow'))));
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'reopened', pull_request: { number: 5 } }, withJev(jev, configFor('shadow'))));
  assert.equal(jev.asked.length, 1);
  assert.equal(prComments.filter((c) => /kind=test-tamper-jev/.test(String((c as { body: string }).body))).length, 1);
});

test('Jev が error を返したら記録せず、failure のまま（次のイベントで問い直す）', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev('error');
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 1);
  assert.deepEqual(tamperRecords(fake), []);
  assert.equal(lastTests(fake).conclusion, 'failure');
});

// ---- AC2：enforce ----

test('AC2：enforce ではしきい値以上なら success（Jev が弱めていないと判定）', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.95);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 1);
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'success');
  assert.match(body.output.title, /Jev が弱めていないと判定/);
  assert.match(body.output.title, /P=/);
  assert.match(body.output.summary, /### Jev の判定/);
  assert.doesNotMatch(body.output.summary, /記録だけで、この結果は変えません/);
  const [r] = tamperRecords(fake);
  assert.equal(r?.mode, 'enforce');
  assert.equal(r?.allows, true);
});

test('AC2：enforce でもしきい値未満なら failure', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.5);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 1);
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.equal(tamperRecords(fake)[0]?.allows, false);
});

test('AC2：enforce で同じ差分の shadow の記録を使い回すときは、記録の確率と今の設定から通すかを計算し直す', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, prComments: [tamperRecord(ASSERT_DIFF, { mode: 'shadow', probability: 0.95, allows: false, threshold: 0.99 })] });
  const jev = fakeJev(0.1);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce', 0.9))));
  assert.equal(jev.asked.length, 0);
  assert.equal(lastTests(fake).conclusion, 'success');
});

test('AC2：削除系（skip-added・removed-test）・対にならない削除を含む差分は、enforce でも Jev に問わず failure', async () => {
  for (const [name, diff] of [['skip-added', SKIP_DIFF], ['removed-test', REMOVED_DIFF], ['対にならない削除', UNPAIRED_DIFF]] as const) {
    const { fake } = fakeFor({ diff });
    const jev = fakeJev(0.99);
    await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
    assert.equal(jev.asked.length, 0, `${name}：問わない`);
    assert.equal(lastTests(fake).conclusion, 'failure', name);
    assert.deepEqual(tamperRecords(fake), [], `${name}：記録しない`);
  }
});

// ---- 判定の受け付け（apply.ts）と auto-merge の後の書き直し ----

test('受け付け：push で記録した差分に low の判定が来ても、enforce で Jev が通したなら success のまま（auto-merge の後も）で、問い直さない', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.95);
  const extra = withJev(jev, configFor('enforce'));
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra));
  assert.equal(lastTests(fake).conclusion, 'success');
  const before = fake.writes().length;

  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), extra));
  assert.equal(jev.asked.length, 1, '受け付けでは同じ差分の記録を使う');
  const writes = fake.writes().slice(before);
  const enable = writes.indexOf('enablePullRequestAutoMerge');
  assert.ok(enable >= 0, '自動 Merge の対象');
  assert.ok(writes.includes('check:agent/tests=success'));
  assert.ok(!writes.includes('check:agent/tests=failure'), 'failure で上書きしない');
  assert.equal(writes.lastIndexOf('check:agent/tests=success') > enable, true, 'auto-merge を付けた後の書き直しも success');
  assert.equal(tamperRecords(fake).length, 1);
});

test('受け付け：rewriteTestsCheck は Jev の結果を戻り値の jev に入れ、enforce で通した差分に success を書く', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, prComments: [tamperRecord(ASSERT_DIFF, { probability: 0.95 })] });
  const jev = fakeJev(0.1);
  const acceptance: Acceptance = {
    version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(ASSERT_DIFF), reviewPass: true, riskLevel: 'low', riskOk: true,
    scopeOk: true, outside: [], guardrail: [], humanMerge: [], autoEligible: true, reasons: [],
  };
  const r = await rewriteTestsCheck(ctxFor(fake, 'issue_comment', {}, withJev(jev, configFor('enforce'))), pr() as never, acceptance, ASSERT_DIFF);
  assert.ok(r);
  assert.ok(r.jev !== undefined && r.jev !== null, '戻り値に jev');
  assert.equal(r.relaxed, false);
  assert.equal(jev.asked.length, 0, '同じ差分の記録を使う');
  assert.equal(lastTests(fake).conclusion, 'success');
});

test('受け付け：shadow では low の判定でも今までどおり failure（auto-merge の前と後）', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.99);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), withJev(jev, configFor('shadow'))));
  const w = fake.writes();
  const enable = w.indexOf('enablePullRequestAutoMerge');
  assert.ok(enable >= 0);
  assert.ok(w.indexOf('check:agent/tests=failure') < enable);
  assert.ok(w.lastIndexOf('check:agent/tests=failure') > enable);
  assert.ok(!w.includes('check:agent/tests=success'));
});

// ---- Human Merge ----

test('Human Merge：ガードレールに触れる PR は enforce で Jev が通しても neutral のままで、Jev の節が足される', async () => {
  const { fake } = fakeFor({ diff: GUARD_DIFF });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 1, 'Human Merge の PR でも問って記録する');
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'neutral');
  assert.match(body.output.summary, /人の確認が要る変更あり/);
  assert.match(body.output.summary, /### Jev の判定/);
  assert.equal(tamperRecords(fake).length, 1);
});

test('auto-merge が付いていて Human Merge として緩めない PR でも、enforce で Jev が通せば success', async () => {
  const { fake } = fakeFor({ diff: GUARD_DIFF, pr: { auto_merge: { enabled: true } } });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'reopened', pull_request: { number: 5 } }, withJev(jev, configFor('enforce'))));
  assert.equal(lastTests(fake).conclusion, 'success');
});

// ---- 問わない場合 ----

test('off では問わず、今までどおり failure で Jev の節も出さない', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('off'))));
  assert.equal(jev.asked.length, 0);
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'failure');
  assert.doesNotMatch(body.output.summary, /### Jev の判定/);
  assert.deepEqual(tamperRecords(fake), []);
});

test('fork の PR は enforce でも問わず failure', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, pr: { head: { ref: 'claude/issue-3', sha: HEAD, repo: { full_name: 'evil/r' } } } });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 0);
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.deepEqual(tamperRecords(fake), []);
});

test('JEV_API_KEY が無ければ enforce でも問わず failure', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF });
  const jev = fakeJev(0.99);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, { config: configFor('enforce'), secrets: {}, askJev: jev.fn }));
  assert.equal(jev.asked.length, 0);
  assert.equal(lastTests(fake).conclusion, 'failure');
});

test('test:exempt が効いていれば問わず、今までどおり例外で success', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, pr: { labels: [{ name: 'test:exempt' }] }, prComments: [exemptRecord(ASSERT_DIFF)] });
  const jev = fakeJev(0.1);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 0);
  assert.deepEqual(conclusions(fake), ['success']);
  assert.match(lastTests(fake).output.title, /例外/);
});

test('Agent PR でない同じリポジトリの PR でも問って記録する（enforce で通せば success）', async () => {
  const { fake } = fakeFor({ diff: ASSERT_DIFF, pr: { head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } } });
  const jev = fakeJev(0.95);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }, withJev(jev, configFor('enforce'))));
  assert.equal(jev.asked.length, 1);
  assert.equal(tamperRecords(fake).length, 1);
  assert.equal(lastTests(fake).conclusion, 'success');
});
