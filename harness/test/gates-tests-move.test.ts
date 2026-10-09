// テストファイルの削除を、PR 本文の対応表と Jev の移し先の判定（kind=test-move-jev）で agent/tests が通す動作（対応表の有無・Jev の error・記録の使い回し・
// 削除と書き換えの混在・auto mode の経路・diff から中身を読めない削除）を、偽の GitHub と偽の Jev でゲートの入口から確かめる（Epic #511、Issue #514）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { CHECKS, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { patchId } from '../lib/patch-id.ts';
import { TEST_MOVE_JEV_KIND, TEST_MOVE_JEV_QUESTION_SET, type TestMoveRecord } from '../lib/test-move-jev.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, HEAD, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/**
 * 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする。
 * 下限と jev.testTamper は実物の harness.config.json に依存しないよう明示する
 */
const config: HarnessConfig = {
  ...base,
  jev: { ...base.jev, mode: 'off', testTamper: 'enforce', thresholds: { ...base.jev.thresholds, testTamperProbability: 0.9, autoModeTestsProbability: 0.9 } },
};

// ---- 差分（PR #502 の形：テストファイルの削除2つと、新しいテストファイル） ----

const OLD_A = 'harness/test/move-old-a.test.ts';
const OLD_B = 'harness/test/move-old-b.test.ts';
const NEW = 'harness/test/move-new.test.ts';

const deletedFile = (path: string, lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, 'deleted file mode 100644', 'index 1111111..0000000', `--- a/${path}`, '+++ /dev/null', `@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`), ''].join('\n');
const newFile = (path: string, lines: string[]): string =>
  [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..2222222', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');

const MOVE_DIFF =
  deletedFile(OLD_A, ["test('a', () => {", '  assert.equal(f(), 2);', '});']) +
  deletedFile(OLD_B, ["test('b', () => {", "  assert.match(g(), /ok/);", '});']) +
  newFile(NEW, ["test('a', () => {", '  assert.equal(f(), 2);', '});', "test('b', () => {", "  assert.match(g(), /ok/);", '});']);

/** 下限未満で答えさせるアサーションの書き換え（削除とは別のファイル） */
const ASSERT_FILE = 'harness/test/move-other.test.ts';
const ASSERT_DIFF = [`diff --git a/${ASSERT_FILE} b/${ASSERT_FILE}`, `--- a/${ASSERT_FILE}`, `+++ b/${ASSERT_FILE}`, '@@ -5,1 +5,1 @@', '-  assert.equal(h(), 2);', '+  assert.equal(h(), 3);', ''].join('\n');

/** 中身の無いテストファイルの削除（---/+++ と hunk が無い）。消したファイルの件数と材料の件数がずれる */
const EMPTY_OLD = 'harness/test/move-empty.test.ts';
const EMPTY_DELETE_DIFF = [`diff --git a/${EMPTY_OLD} b/${EMPTY_OLD}`, 'deleted file mode 100644', 'index e69de29..0000000', ''].join('\n') + newFile(NEW, ["test('a', () => {", '  assert.ok(true);', '});']);

/** PR 本文の対応表（Markdown の表に消したファイルの名前） */
const tableBody = (deleted: string[]): string =>
  ['Closes #3', '', '| 消したファイル | 移し先 |', '| --- | --- |', ...deleted.map((f) => `| ${f.split('/').pop()} | ${NEW.split('/').pop()} |`)].join('\n');
const MOVE_BODY = tableBody([OLD_A, OLD_B]);

// ---- 偽の GitHub ----

let nextId = 700;
const appRecord = (kind: string, value: unknown) => ({
  id: nextId++, created_at: '2026-10-01T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});
const filesOf = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);

const PLAN_BODY = 'PLAN: 古いテストを1つのファイルにまとめる';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const planComment = { id: 80, created_at: '2026-09-30T00:00:00Z', updated_at: '', html_url: 'p', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: PLAN_BODY };
const planGate = (files: string[]) => appRecord('plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files }, planBodySha256: sha256(PLAN_BODY) });

/** App が書いた PR のコメントは prComments に足す（続くイベントで記録を読む） */
function world(o: { diff: string; body: string; files?: string[]; prComments?: unknown[]; dashboardLabels?: string[]; events?: unknown[] }): { fake: FakeGitHub; prComments: unknown[] } {
  const prComments = o.prComments ?? [];
  const files = o.files ?? filesOf(o.diff);
  const fake = acceptanceFake({ pr: pr({ body: o.body }), dashboardLabels: o.dashboardLabels ?? [], dashboardEvents: o.events ?? [], prComments })
    .on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? o.diff : { behind_by: 0 }))
    .on('GET', /\/issues\/3$/, () => ({ number: 3, title: 'test: 古いテストをまとめる', body: 'ISSUE', labels: [], state: 'open' }))
    .on('GET', /\/issues\/3\/comments/, () => [planComment, planGate(files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/(events|timeline)/, () => [])
    .on('GET', /\/issues\/5\/comments/, () => prComments)
    .on('POST', /\/issues\/5\/comments$/, (_m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      prComments.push(c);
      return c;
    });
  return { fake, prComments };
}

// ---- 偽の Jev（問いのキーで答えを分け、種類ごとに呼ばれた回数を数える） ----

type Answer = number | 'error';

function fakeJev(o: { deleted?: Answer; change?: number; finding?: number; danger?: number } = {}) {
  const asks = { deleted: 0, change: 0, finding: 0 };
  const fn: typeof askJev = async (_key, request) => {
    const keys = Object.keys(request.questions);
    const answer = (p: number) => ({ status: 'ok' as const, model: 'jev-test', answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: p }])) as any });
    if (keys.includes('danger')) return answer(o.danger ?? 0.01);
    if (keys.every((k) => k.startsWith('deleted_'))) {
      asks.deleted++;
      if (o.deleted === 'error') return { status: 'error', detail: 'HTTP 500' };
      return answer(o.deleted ?? 0.95);
    }
    if (keys.every((k) => k.startsWith('change_'))) {
      asks.change++;
      return answer(o.change ?? 0.1);
    }
    if (keys.every((k) => k.startsWith('finding_'))) {
      asks.finding++;
      return answer(o.finding ?? 0.1);
    }
    return { status: 'error', detail: `想定外の問い: ${keys.join(',')}` };
  };
  return { asks, fn };
}

const extra = (jev: ReturnType<typeof fakeJev>) => ({ config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });
const sync = { action: 'synchronize', pull_request: { number: 5 } };

const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === CHECKS.tests).map((c) => c.body);
const conclusions = (fake: FakeGitHub): string[] => testsChecks(fake).map((b) => String(b.conclusion));
const lastTests = (fake: FakeGitHub) => testsChecks(fake).at(-1);

/** POST された kind=test-move-jev のコメントの記録 */
function moveRecords(fake: FakeGitHub): TestMoveRecord[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && /\/issues\/5\/comments$/.test(c.path) && String(c.body?.body).includes(appMark(TEST_MOVE_JEV_KIND)))
    .map((c) => {
      const b = extractBlock(String(c.body.body), 'agent-app');
      assert.ok(b.found && b.ok, '記録のブロックが読める');
      return b.value as TestMoveRecord;
    });
}

// ---- AC1・AC2：対応表と Jev の移し先の判定 ----

test('PR #502 の形（削除2つと新しいテストファイル、本文に対応表）で Jev が下限以上と答えると agent/tests は success で、test-move-jev の記録が1件', async () => {
  const { fake } = world({ diff: MOVE_DIFF, body: MOVE_BODY });
  const jev = fakeJev({ deleted: 0.95 });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.deleted, 1, '1回だけ問う');
  assert.equal(lastTests(fake)?.conclusion, 'success');
  const records = moveRecords(fake);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.patchId, patchId(MOVE_DIFF));
  assert.equal(records[0]!.questionSet, TEST_MOVE_JEV_QUESTION_SET);
  assert.equal(records[0]!.allows, true);
  assert.deepEqual(records[0]!.files.map((f) => f.file), [OLD_A, OLD_B]);
});

test('同じ差分で本文に対応表が無ければ Jev に問わず failure（今までどおり止まる）', async () => {
  const { fake } = world({ diff: MOVE_DIFF, body: 'Closes #3' });
  const jev = fakeJev({ deleted: 0.99 });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.deleted, 0);
  assert.equal(lastTests(fake)?.conclusion, 'failure');
  assert.equal(moveRecords(fake).length, 0);
});

test('Jev が error なら failure で、記録のコメントは書かない（次のイベントで問い直す）', async () => {
  const { fake } = world({ diff: MOVE_DIFF, body: MOVE_BODY });
  const jev = fakeJev({ deleted: 'error' });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.deleted, 1);
  assert.equal(lastTests(fake)?.conclusion, 'failure');
  assert.equal(moveRecords(fake).length, 0);
});

test('同じ patch-id・同じ問いの版の記録があれば Jev に問い直さず、記録を書き足さない', async () => {
  const record: TestMoveRecord = {
    version: 1, patchId: patchId(MOVE_DIFF), headSha: HEAD, mode: 'enforce', model: 'jev-old', questionSet: TEST_MOVE_JEV_QUESTION_SET,
    files: [{ file: OLD_A, probability: 0.95 }, { file: OLD_B, probability: 0.95 }], probability: 0.95, threshold: 0.9, allows: true,
  };
  const { fake } = world({ diff: MOVE_DIFF, body: MOVE_BODY, prComments: [appRecord(TEST_MOVE_JEV_KIND, record)] });
  const jev = fakeJev({ deleted: 0.1 });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.deleted, 0, '問い直さない');
  assert.equal(moveRecords(fake).length, 0, '記録を書き足さない');
  assert.equal(lastTests(fake)?.conclusion, 'success');
});

test('削除と、下限未満のアサーションの書き換え（別ファイル）が混ざると failure（書き換えは削除を除いて jev.testTamper に問う）', async () => {
  const { fake } = world({ diff: MOVE_DIFF + ASSERT_DIFF, body: MOVE_BODY });
  const jev = fakeJev({ deleted: 0.95, change: 0.5 });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.change, 1, '削除を除いた検出で jev.testTamper に問う');
  assert.equal(lastTests(fake)?.conclusion, 'failure');
});

// ---- AC3：auto mode の経路 ----

test('auto mode の経路の PR は、削除を含み test-move-jev が通らなくても、今までどおり auto mode の Jev が妥当と答えれば success', async () => {
  const AUTO = autoModeConfig(config).label;
  const autoOn = { event: 'labeled', created_at: new Date(Date.now() - 300 * 60_000).toISOString(), actor: { login: 'me' }, label: { name: AUTO } };
  const { fake } = world({ diff: MOVE_DIFF, body: MOVE_BODY, files: ['harness.config.json', ...filesOf(MOVE_DIFF)], dashboardLabels: [AUTO], events: [autoOn] });
  const jev = fakeJev({ deleted: 0.1, finding: 0.95 });
  const critical = verdict({ risk: { ...verdict().risk, level: 'critical' } });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', critical)), extra(jev)));
  assert.equal(jev.asks.finding, 1, 'auto mode の問いをした');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'success'), cs.join(','));
});

// ---- 件数のずれ（diff から中身を読めない削除） ----

test('中身の無いテストファイルの削除（---/+++ と hunk が無い）は、対応表があっても Jev に問わず failure で、要約に読めない理由が出る', async () => {
  const { fake } = world({ diff: EMPTY_DELETE_DIFF, body: tableBody([EMPTY_OLD]) });
  const jev = fakeJev({ deleted: 0.99 });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.asks.deleted, 0);
  const body = lastTests(fake);
  assert.equal(body?.conclusion, 'failure');
  assert.match(String(body?.output?.summary), /消したファイルの中身を diff から読めません/);
});
