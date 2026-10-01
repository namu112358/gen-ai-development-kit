// auto mode の経路でテストを弱める変更を Jev に問う仕組みの抜け穴（Issue #440）を、偽の GitHub と偽の Jev で確かめる：
// planBodySha256 の無い古い計画ゲートの記録では問わない・自動 Merge モードが無効なら success にしない・bypass だけ／委任だけで乗る PR には問わない
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, CHECKS, delegateConfig, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/** Risk の Jev（callJev）が本物の API を呼ばないよう jev.mode は off。下限は実物の harness.config.json に依存しないよう明示する */
const config: HarnessConfig = {
  ...base,
  jev: { ...base.jev, mode: 'off', testTamper: 'enforce', thresholds: { ...base.jev.thresholds, testTamperProbability: 0.9, autoModeTestsProbability: 0.9 } },
};

const AUTO = autoModeConfig(config).label;
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールにも delegateMergeExclude にも当たる（委任でも乗らない。auto mode では乗る） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const TEST_FILE = 'a.test.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const ev = (name: string, at: string) => ({ event: 'labeled', created_at: at, actor: { login: 'me' }, label: { name } });
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** skip の追加（検出 1 件。jev.testTamper では問えない種類） */
const SKIP_DIFF = `diff --git a/${TEST_FILE} b/${TEST_FILE}\n--- a/${TEST_FILE}\n+++ b/${TEST_FILE}\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n`;

const PLAN_BODY = 'PLAN_BODY: a のテストを skip する';
let nextId = 600;
const planComment = (body = PLAN_BODY, updatedAt = '') => ({ id: 80, created_at: minutesAgo(600), updated_at: updatedAt, html_url: 'p', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** 計画ゲートの記録。sha を渡さなければ planBodySha256 の無い（古い）記録 */
const planGate = (files: string[], sha?: string) => ({
  id: nextId++, created_at: minutesAgo(500), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files }, ...(sha ? { planBodySha256: sha } : {}) })}`,
});

/** 判定の受け付け用。既定は、変更ファイルと計画の files が harness.config.json とテストファイル、Issue #3 に計画コメントと sha つきの計画ゲートの記録がある */
function world(o: { dashboardLabels: string[]; events?: unknown[]; files?: string[]; issueComments?: unknown[]; allowAutoMerge?: boolean }): FakeGitHub {
  const files = o.files ?? [CONFIG_FILE, TEST_FILE];
  return acceptanceFake({ pr: pr({ body: 'Closes #3' }), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments: [], ...(o.allowAutoMerge === undefined ? {} : { allowAutoMerge: o.allowAutoMerge }) })
    .on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? SKIP_DIFF : { behind_by: 0 }))
    .on('GET', /\/issues\/3$/, () => ({ number: 3, title: 'feat: a', body: 'ISSUE_BODY', labels: [], state: 'open' }))
    .on('GET', /\/issues\/3\/comments/, () => o.issueComments ?? [planComment(), planGate(files, sha256(PLAN_BODY))])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/(events|timeline)/, () => []);
}

/** 偽の Jev。auto mode の危険（danger）は安全と答え、テストの判定（finding_*）は 0.99 で妥当と答えて、問われた回数を数える */
function fakeJev() {
  const findingAsks: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const keys = Object.keys(request.questions);
    if (keys.includes('danger')) return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: 0.01 } } as any };
    if (keys.every((k) => k.startsWith('finding_'))) findingAsks.push(request);
    return { status: 'ok', model: 'jev-test', answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: 0.99 }])) };
  };
  return { findingAsks, fn };
}

async function accept(fake: FakeGitHub, jev: ReturnType<typeof fakeJev>, v = critical()): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
}

const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === CHECKS.tests).map((c) => c.body);
const conclusions = (fake: FakeGitHub): string[] => testsChecks(fake).map((b) => String(b.conclusion));
const lastSummary = (fake: FakeGitHub): string => String(testsChecks(fake).at(-1)?.output?.summary ?? '');
const postedRecords = (fake: FakeGitHub): number =>
  fake.calls.filter((c) => c.method === 'POST' && /\/issues\/5\/comments$/.test(c.path) && String(c.body?.body).includes(appMark('auto-mode-tests'))).length;

// ---- AC1：planBodySha256 の無い古い計画ゲートの記録では問わない ----

test('planBodySha256 の無い計画ゲートの記録では、auto mode の経路でも Jev に問わず failure のまま（計画コメントの編集の有無によらない）', async () => {
  const files = [CONFIG_FILE, TEST_FILE];
  const cases: [string, unknown[]][] = [
    ['編集されていない', [planComment(), planGate(files)]],
    ['ゲートの後に編集された', [planComment('PLAN_BODY: 書き換えた計画', minutesAgo(5)), planGate(files)]],
  ];
  for (const [name, issueComments] of cases) {
    const fake = world({ dashboardLabels: [AUTO], events: [ev(AUTO, minutesAgo(300))], issueComments });
    const jev = fakeJev();
    await accept(fake, jev);
    assert.equal(jev.findingAsks.length, 0, `${name}: 問わない`);
    const cs = conclusions(fake);
    assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), `${name}: ${cs.join(',')}`);
    assert.equal(postedRecords(fake), 0, `${name}: 記録しない`);
    assert.match(lastSummary(fake), /計画/, `${name}: 要約に理由\n${lastSummary(fake)}`);
  }
});

// ---- AC2：自動 Merge モードが無効なら success にしない ----

test('自動 Merge モードが無効（Allow auto-merge が無効）なら、auto mode の経路でも Jev に問わず agent/tests は success にならない', async () => {
  // 計画の材料は揃っている（既定の sha つきの記録）ので、問わない理由は自動 Merge モードだけ
  const fake = world({ dashboardLabels: [AUTO], events: [ev(AUTO, minutesAgo(300))], allowAutoMerge: false });
  const jev = fakeJev();
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 0, '問わない');
  assert.equal(postedRecords(fake), 0, '記録しない');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c !== 'success'), cs.join(','));
});

// ---- AC3：bypass だけ・委任だけで乗る PR には問わない ----

test('bypass だけ・委任承認だけで乗る PR には、auto mode の Jev に問わない', async () => {
  const cases: [string, Parameters<typeof world>[0]][] = [
    ['bypass だけ', { dashboardLabels: [BYPASS], events: [ev(BYPASS, minutesAgo(300))] }],
    ['委任だけ', { dashboardLabels: [DELEGATE], events: [ev(DELEGATE, minutesAgo(10))], files: [GUARDED, TEST_FILE] }],
  ];
  for (const [name, o] of cases) {
    const fake = world(o);
    const jev = fakeJev();
    await accept(fake, jev);
    assert.equal(jev.findingAsks.length, 0, `${name}: 問わない`);
    assert.equal(postedRecords(fake), 0, `${name}: 記録しない`);
  }
});
