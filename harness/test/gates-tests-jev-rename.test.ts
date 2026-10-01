/**
 * 名前だけ変えたテスト定義を agent/tests が Jev に問う（Issue #421、ゲート）。
 * - jev.testTamper が enforce で Jev（ctx.askJev の偽物）が下限以上を返せば、名前の変更とアサーションの書き換えだけの PR は test:exempt 無しで success
 * - 下限未満なら failure。shadow では確率が高くても failure のまま
 * - PR #408 の形（名前の変更 11・アサーションの書き換え 23）の差分を 34 問で1回だけ問い、enforce で通せば success
 * - 組にならない定義の削除を含む差分は、今までどおり Jev に問わず failure（概要に「テスト定義の削除」）
 * 判定の受け付けで Risk の Jev が本物の API を呼ばないよう、jev.mode は off にする。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { TamperJevRecord } from '../lib/test-tamper-jev.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, acceptanceFake, config as base, ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';

// ---- 設定（実物の harness.config.json の既定値に依存しない） ----

const configFor = (testTamper: 'off' | 'shadow' | 'enforce', threshold = 0.9): HarnessConfig => ({
  ...base,
  jev: { ...base.jev, mode: 'off', testTamper, thresholds: { ...base.jev.thresholds, testTamperProbability: threshold } },
});

// ---- 差分 ----

const fileDiff = (path: string, lines: string[], start = 1): string => {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
};

const TEST_FILE = 'harness/test/patrol.test.ts';
const OLD_408 = "test('差あり：flakyTests の消えた項目でも差として数え、qa-retro を回し test-prune を勧める', () => {";
const NEW_408 = "test('差あり：flakyTests の消えた項目でも差として数え、qa-retro と test-prune を回す（同じ件数なら表の順）', () => {";

/** 名前の変更（PR #408 の例）と、その中のアサーションの書き換えだけ（Jev に問える） */
const RENAME_DIFF = fileDiff(TEST_FILE, [`-${OLD_408}`, `+${NEW_408}`, '   const r = decide();', "-  assert.deepEqual(r.run, ['qa-retro']);", "+  assert.deepEqual(r.run, ['qa-retro', 'test-prune']);", ' });'], 97);

/** 名前の変更と、組にならない定義の削除（今までどおり止める） */
const REMOVED_DIFF = fileDiff(TEST_FILE, [`-${OLD_408}`, `+${NEW_408}`, ' });', ' ', "-test('消えたテスト', () => {});"], 97);

/** PR #408 の形：名前を変えたテスト 11 件と、その中のアサーションの書き換え 23 件 */
function diff408(): string {
  const lines: string[] = [];
  for (let i = 0; i < 11; i++) {
    lines.push(`-test('項目 ${i}：qa-retro を回し test-prune を勧める', () => {`, `+test('項目 ${i}：qa-retro と test-prune を回す（同じ件数なら表の順）', () => {`);
    lines.push(`   const r = decide(${i});`);
    for (let j = 0; j < (i === 0 ? 3 : 2); j++) {
      lines.push(`-  assert.equal(r.reviews[${j}], 'qa-retro-${i}-${j}');`, `+  assert.equal(r.reviews[${j}], 'test-prune-${i}-${j}');`, `   // ${i}-${j}`);
    }
    lines.push(' });', ' ');
  }
  return fileDiff(TEST_FILE, lines, 90);
}

// ---- 偽の GitHub と偽の Jev ----

let nextId = 900;
const appComment = (kind: string, value: unknown) => ({
  id: nextId++, created_at: '2026-10-01T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\nx\n${renderBlock('agent-app', value)}`,
});
const planGate = (files: string[]) => appComment('plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } });
const filesOf = (diff: string) => [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);

/** PR のコメントを持つ偽の GitHub（test:exempt のラベルも記録も無い） */
function fakeFor(diff: string): FakeGitHub {
  const prComments: unknown[] = [];
  const files = filesOf(diff);
  return acceptanceFake({ pr: pr({}), dashboardLabels: [], prComments })
    .on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? diff : { behind_by: 0 }))
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/3\/comments/, () => [planGate(files)])
    .on('GET', /\/issues\/5\/comments/, () => prComments)
    .on('POST', /\/issues\/5\/comments$/, (_m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      prComments.push(c);
      return c;
    });
}

/** 偽の Jev。テストの改ざんの問い（change_*）だけに、対ごとに同じ確率で答える。呼ばれた要求を残す */
function fakeJev(probability: number) {
  const asked: { state: unknown; questions: Record<string, unknown> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const keys = Object.keys(request.questions);
    if (!keys.every((k) => k.startsWith('change_'))) return { status: 'error', detail: 'テストの改ざんの問いではない' };
    asked.push(request);
    return { status: 'ok', model: 'jev-test', answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: probability }])) };
  };
  return { asked, fn };
}

const sync = { action: 'synchronize', pull_request: { number: 5 } };
const run = async (diff: string, mode: 'shadow' | 'enforce', probability: number) => {
  const fake = fakeFor(diff);
  const jev = fakeJev(probability);
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync, { config: configFor(mode), secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
  return { fake, jev };
};

const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === 'agent/tests').map((c) => c.body);
const lastTests = (fake: FakeGitHub) => testsChecks(fake).at(-1);
const tamperRecords = (fake: FakeGitHub): TamperJevRecord[] =>
  fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && /kind=test-tamper-jev/.test(String(c.body.body)))
    .map((c) => {
      const b = extractBlock(String(c.body.body), 'agent-app');
      assert.ok(b.found && b.ok, '記録のブロックが読める');
      return b.value as TamperJevRecord;
    });
const labelWrites = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && /\/labels$/.test(c.path)).map((c) => JSON.stringify(c.body));

// ---- enforce ----

test('enforce：名前の変更とアサーションの書き換えだけの PR は、Jev が下限以上なら test:exempt 無しで success', async () => {
  const { fake, jev } = await run(RENAME_DIFF, 'enforce', 0.95);
  assert.equal(jev.asked.length, 1, '1回だけ問う');
  assert.deepEqual((jev.asked[0]!.state as { changes: unknown[] }).changes, [
    { file: TEST_FILE, before: OLD_408, after: NEW_408 },
    { file: TEST_FILE, before: "assert.deepEqual(r.run, ['qa-retro']);", after: "assert.deepEqual(r.run, ['qa-retro', 'test-prune']);" },
  ]);
  assert.match((jev.asked[0]!.questions.change_0 as { instructions: string }).instructions, /test name/i, '名前の変更の問い');
  assert.doesNotMatch((jev.asked[0]!.questions.change_1 as { instructions: string }).instructions, /test name/i, 'アサーションの問い');

  const body = lastTests(fake);
  assert.equal(body.conclusion, 'success');
  assert.match(body.output.title, /Jev が弱めていないと判定/);
  assert.doesNotMatch(body.output.title, /例外/, 'test:exempt の例外で通したのではない');
  assert.ok(!labelWrites(fake).some((l) => l.includes('test:exempt')), 'test:exempt を付けない');
  const [r] = tamperRecords(fake);
  assert.equal(r?.mode, 'enforce');
  assert.equal(r?.allows, true);
});

test('enforce：Jev が下限未満なら failure で、概要に「テストの名前の変更」が出て「テスト定義の削除」は出ない', async () => {
  const { fake, jev } = await run(RENAME_DIFF, 'enforce', 0.5);
  assert.equal(jev.asked.length, 1);
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'failure');
  assert.match(body.output.summary, /テストの名前の変更/);
  assert.doesNotMatch(body.output.summary, /\*\*テスト定義の削除\*\*/);
  assert.equal(tamperRecords(fake)[0]?.allows, false);
});

test('shadow：名前の変更も問って記録するが、確率が高くても failure のまま', async () => {
  const { fake, jev } = await run(RENAME_DIFF, 'shadow', 0.99);
  assert.equal(jev.asked.length, 1);
  assert.equal(lastTests(fake).conclusion, 'failure');
  assert.equal(tamperRecords(fake).length, 1);
});

test('PR #408 の形（名前の変更 11・アサーションの書き換え 23）：34 問を1回で問い、enforce で通せば success', async () => {
  const { fake, jev } = await run(diff408(), 'enforce', 0.95);
  assert.equal(jev.asked.length, 1);
  assert.equal(Object.keys(jev.asked[0]!.questions).length, 34);
  assert.equal((jev.asked[0]!.state as { changes: unknown[] }).changes.length, 34);
  const named = Object.values(jev.asked[0]!.questions).filter((q) => /test name/i.test((q as { instructions: string }).instructions));
  assert.equal(named.length, 11, '名前の変更の問いは 11 問');
  assert.equal(lastTests(fake).conclusion, 'success');
});

// ---- 組にならない定義の削除は今までどおり ----

test('組にならない定義の削除を含む差分は、enforce でも Jev に問わず failure（概要に「テスト定義の削除」）', async () => {
  const { fake, jev } = await run(REMOVED_DIFF, 'enforce', 0.99);
  assert.equal(jev.asked.length, 0, '問わない');
  const body = lastTests(fake);
  assert.equal(body.conclusion, 'failure');
  assert.match(body.output.summary, /テスト定義の削除/);
  assert.deepEqual(tamperRecords(fake), [], '記録しない');
});
