// auto mode の経路の PR で、テストを弱める変更が妥当かを Jev に問い、妥当なら agent/tests を success にする動作（判定の受け付け・push の後の書き直し・
// 記録の使い回しと問い直し・auto mode の経路でない PR では問わないこと）を、偽の GitHub と偽の Jev で確かめる（Issue #349）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { AUTO_MODE_TESTS_QUESTION_SET, type AutoModeTestsRecord } from '../lib/auto-mode-tests.ts';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { CHECKS, delegateConfig, LABELS, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { patchId } from '../lib/patch-id.ts';
import type { Verdict } from '../lib/verdict.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/**
 * 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の問いは jev.mode と独立）。
 * 下限と jev.testTamper は実物の harness.config.json に依存しないよう明示する
 */
const config: HarnessConfig = {
  ...base,
  jev: { ...base.jev, mode: 'off', testTamper: 'enforce', thresholds: { ...base.jev.thresholds, testTamperProbability: 0.9, autoModeTestsProbability: 0.9 } },
};

const AUTO = autoModeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールにも delegateMergeExclude にも当たる（委任でも乗らない。auto mode では乗る） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const TEST_FILE = 'a.test.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const ev = (name: string, at: string) => ({ event: 'labeled', created_at: at, actor: { login: 'me' }, label: { name } });
const autoOn = () => ev(AUTO, minutesAgo(300));
const delegateOn = () => ev(DELEGATE, minutesAgo(10));
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

// ---- 差分 ----

const testDiff = (lines: string[], start = 10): string => {
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return [`diff --git a/${TEST_FILE} b/${TEST_FILE}`, `--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`, `@@ -${start},${old} +${start},${neu} @@`, ...lines, ''].join('\n');
};
/** テストの削除・skip の追加・アサーションの書き換え（検出 3 件。削除系を含むので jev.testTamper では問わない） */
const WEAKEN_DIFF = testDiff([" test('keep', () => {", '-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);', ' });', "-test('a', () => {});", "+test.skip('a', () => {});", "-test('gone', () => {});", ' // tail']);
/** 前の push の差分（記録の patch-id が今の差分と違う） */
const OLD_DIFF = testDiff(["-test('a', () => {});", "+test.skip('a', () => {});"]);
/** アサーションの書き換えだけ（jev.testTamper でも問える） */
const ASSERT_DIFF = testDiff(['-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);']);

// ---- Issue #3 の本文・計画 ----

const ISSUE_BODY = 'ISSUE_BODY_MARK: f() は 3 を返すように変え、使わなくなった gone のテストは消す';
const PLAN_BODY = 'PLAN_BODY_MARK: f() の戻り値を 3 にし、期待値を直し、gone を消す';
const PR_BODY_MARK = 'PR_BODY_MARK';
const PR_COMMENT_MARK = 'PR_COMMENT_MARK';

let nextId = 600;
const appRecord = (kind: string, value: unknown, text = 'x') => ({
  id: nextId++, created_at: minutesAgo(60), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\n${text}\n${renderBlock('agent-app', value)}`,
});
const planComment = { id: 80, created_at: minutesAgo(600), updated_at: '', html_url: 'p', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: PLAN_BODY };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const planGate = (files: string[], patch: Record<string, unknown> = {}) => appRecord('plan-gate', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files }, ...patch });
const humanComment = { id: 77, created_at: minutesAgo(30), updated_at: '', html_url: 'h', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: PR_COMMENT_MARK };

/** 記録（kind=auto-mode-tests）。既定は WEAKEN_DIFF の 3 件を 0.95 で通した記録 */
const autoTestsRecord = (diff: string, patch: Partial<AutoModeTestsRecord> = {}) =>
  appRecord('auto-mode-tests', {
    version: 1, patchId: patchId(diff), headSha: 'a'.repeat(40), model: 'jev-old', questionSet: AUTO_MODE_TESTS_QUESTION_SET,
    findings: [{ kind: 'skip-added', file: TEST_FILE, line: 11, probability: 0.95 }], probability: 0.95, threshold: 0.9, allows: true, ...patch,
  });

/**
 * 判定の受け付け（onComment）と push（onPullRequest）用。App が書いた PR のコメントは prComments に足す（続くイベントで記録を読む）。
 * 既定は、変更ファイルが harness.config.json とテストファイル、計画の files も同じ、Issue #3 に計画ゲートの記録と計画コメントがある
 */
function world(o: {
  dashboardLabels: string[];
  events?: unknown[];
  diff?: string;
  files?: string[];
  pr?: ReturnType<typeof pr>;
  prComments?: unknown[];
  issueComments?: unknown[];
}): { fake: FakeGitHub; prComments: unknown[]; setDiff: (d: string) => void } {
  const files = o.files ?? [CONFIG_FILE, TEST_FILE];
  const prComments = o.prComments ?? [humanComment];
  let diff = o.diff ?? WEAKEN_DIFF;
  const fake = acceptanceFake({ pr: o.pr ?? pr({ body: `Closes #3\n\n${PR_BODY_MARK}` }), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments })
    .on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? diff : { behind_by: 0 }))
    .on('GET', /\/issues\/3$/, () => ({ number: 3, title: 'feat: f を 3 にする', body: ISSUE_BODY, labels: [], state: 'open' }))
    .on('GET', /\/issues\/3\/comments/, () => o.issueComments ?? [planComment, planGate(files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/(events|timeline)/, () => [])
    .on('GET', /\/issues\/5\/comments/, () => prComments)
    .on('POST', /\/issues\/5\/comments$/, (_m, body) => {
      const c = { id: nextId++, created_at: new Date().toISOString(), updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: String(body.body) };
      prComments.push(c);
      return c;
    });
  return { fake, prComments, setDiff: (d) => { diff = d; } };
}

type Answer = number | 'error' | 'missing';

/**
 * 偽の Jev。問いのキーで答えを分ける：auto mode の危険（danger）は danger、テストの行の変更（change_*）は change、
 * auto mode のテストの判定（finding_*）は finding（'missing' なら finding_0 だけ答え、残りを欠かす）。問われた要求を種類ごとに残す
 */
function fakeJev(o: { finding?: Answer; change?: number; danger?: number } = {}) {
  const findingAsks: { state: any; questions: Record<string, unknown> }[] = [];
  const changeAsks: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    const keys = Object.keys(request.questions);
    if (keys.includes('danger')) return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: o.danger ?? 0.01 } } as any };
    if (keys.every((k) => k.startsWith('change_'))) {
      changeAsks.push(request);
      return { status: 'ok', model: 'jev-test', answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: o.change ?? 0.1 }])) };
    }
    if (keys.every((k) => k.startsWith('finding_'))) {
      findingAsks.push(request as any);
      const f = o.finding ?? 0.95;
      if (f === 'error') return { status: 'error', detail: 'HTTP 500' };
      const answered = f === 'missing' ? keys.slice(0, 1) : keys;
      return { status: 'ok', model: 'jev-test', answers: Object.fromEntries(answered.map((k) => [k, { type: 'noul', noul: f === 'missing' ? 0.99 : f }])) };
    }
    return { status: 'error', detail: `想定外の問い: ${keys.join(',')}` };
  };
  return { findingAsks, changeAsks, fn };
}

const extra = (jev: ReturnType<typeof fakeJev>) => ({ config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn });

async function accept(fake: FakeGitHub, jev: ReturnType<typeof fakeJev>, v: Verdict = critical()): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), extra(jev)));
}

const sync = { action: 'synchronize', pull_request: { number: 5 } };

const testsChecks = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === CHECKS.tests).map((c) => c.body);
const conclusions = (fake: FakeGitHub): string[] => testsChecks(fake).map((b) => String(b.conclusion));
const lastSummary = (fake: FakeGitHub): string => String(testsChecks(fake).at(-1)?.output?.summary ?? '');

/** POST された kind=auto-mode-tests のコメントの本文と記録 */
function posted(fake: FakeGitHub): { body: string; record: AutoModeTestsRecord }[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && /\/issues\/5\/comments$/.test(c.path) && String(c.body?.body).includes(appMark('auto-mode-tests')))
    .map((c) => {
      const body = String(c.body.body);
      const b = extractBlock(body, 'agent-app');
      assert.ok(b.found && b.ok, '記録のブロックが読める');
      return { body, record: b.value as AutoModeTestsRecord };
    });
}

// ---- AC1・AC3・AC4：妥当なら success。state の中身。確率がコメントと記録に出る ----

test('auto mode の経路の PR（critical・harness.config.json）で、テストの削除・skip の追加・アサーションの書き換えを Jev が妥当と答えると agent/tests は success', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1, '1回だけ問う');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0, 'agent/tests を書いた');
  assert.ok(cs.every((c) => c === 'success'), cs.join(','));
});

test('Jev の要求の state に Issue の本文・計画の本文・検出した行と前後の差分が入り、PR の本文・コメントは入らない。問いは検出ごと', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(fake, jev);
  const req = jev.findingAsks[0]!;
  assert.deepEqual(Object.keys(req.state).sort(), ['findings', 'issue', 'plan']);
  assert.equal(req.state.issue.number, 3);
  assert.equal(req.state.issue.body, ISSUE_BODY);
  assert.equal(req.state.plan, PLAN_BODY);
  const findings = req.state.findings as { kind: string; file: string; before: string | null; after: string | null; hunk: string }[];
  assert.deepEqual(findings.map((f) => f.kind).sort(), ['assertion-changed', 'removed-test', 'skip-added']);
  assert.ok(findings.every((f) => f.file === TEST_FILE));
  assert.ok(findings.some((f) => f.before === 'assert.equal(f(), 2);' && f.after === 'assert.equal(f(), 3);'));
  assert.ok(findings.some((f) => f.after === "test.skip('a', () => {});"));
  assert.ok(findings.some((f) => f.before === "test('gone', () => {});"));
  assert.ok(findings.every((f) => f.hunk.includes('// tail')), '前後の差分を含む');
  assert.deepEqual(Object.keys(req.questions), ['finding_0', 'finding_1', 'finding_2']);
  const json = JSON.stringify(req);
  assert.ok(!json.includes(PR_BODY_MARK), 'PR の本文は入らない');
  assert.ok(!json.includes(PR_COMMENT_MARK), 'PR のコメントは入らない');
});

test('通したとき：auto-mode-tests の記録とコメントに検出ごとの確率が出て、要約にも確率が出る', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(fake, jev);
  const [p, ...rest] = posted(fake);
  assert.ok(p, 'kind=auto-mode-tests のコメントを書いた');
  assert.equal(rest.length, 0, '1回だけ書く');
  const r = p.record;
  assert.equal(r.version, 1);
  assert.equal(r.patchId, patchId(WEAKEN_DIFF));
  assert.equal(r.questionSet, AUTO_MODE_TESTS_QUESTION_SET);
  assert.equal(r.model, 'jev-test');
  assert.equal(r.allows, true);
  assert.equal(r.probability, 0.95);
  assert.equal(r.threshold, 0.9);
  assert.equal(r.findings.length, 3);
  assert.ok(r.findings.every((f) => f.probability === 0.95 && f.file === TEST_FILE && typeof f.line === 'number'), JSON.stringify(r.findings));
  const rows = p.body.split('\n').filter((l) => l.includes(`\`${TEST_FILE}\``) && l.includes('95%'));
  assert.equal(rows.length, 3, `コメントに検出ごとの確率の行\n${p.body}`);
  const summaryRows = lastSummary(fake).split('\n').filter((l) => l.includes(`\`${TEST_FILE}\``) && l.includes('95%'));
  assert.equal(summaryRows.length, 3, `要約に検出ごとの確率の行\n${lastSummary(fake)}`);
});

// ---- AC2・AC4：妥当でない・答えが欠ける・error・計画が無いときは failure ----

test('Jev が妥当でない（下限未満）と答えると failure のまま。記録とコメント・要約に確率が出る', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.5 });
  await accept(fake, jev);
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), cs.join(','));
  const [p] = posted(fake);
  assert.ok(p);
  assert.equal(p.record.allows, false);
  assert.equal(p.record.probability, 0.5);
  assert.deepEqual(p.record.findings.map((f) => f.probability), [0.5, 0.5, 0.5]);
  assert.equal(p.body.split('\n').filter((l) => l.includes(`\`${TEST_FILE}\``) && l.includes('50%')).length, 3, p.body);
  assert.equal(lastSummary(fake).split('\n').filter((l) => l.includes(`\`${TEST_FILE}\``) && l.includes('50%')).length, 3, lastSummary(fake));
});

test('Jev の答えが欠けた検出があると failure のまま。記録の欠けた確率は null', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 'missing' });
  await accept(fake, jev);
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), cs.join(','));
  const [p] = posted(fake);
  assert.ok(p);
  assert.equal(p.record.allows, false);
  assert.equal(p.record.probability, null);
  assert.deepEqual(p.record.findings.map((f) => f.probability), [0.99, null, null]);
});

test('Jev が error なら failure のまま（neutral にしない）。記録は書かず、要約に理由が出る', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 'error' });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1, '問うた');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), cs.join(','));
  assert.equal(posted(fake).length, 0, 'error は記録しない');
  assert.match(lastSummary(fake), /HTTP 500/);
});

test('使える計画が無い（計画コメントが無い・ゲートの後に編集された）と、Jev に問わず failure のまま', async () => {
  const files = [CONFIG_FILE, TEST_FILE];
  const cases: [string, unknown[]][] = [
    ['計画コメントが無い', [planGate(files)]],
    ['ゲートの後に編集された', [planComment, planGate(files, { planBodySha256: sha256('前の本文') })]],
  ];
  for (const [name, issueComments] of cases) {
    const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], issueComments });
    const jev = fakeJev({ finding: 0.99 });
    await accept(fake, jev);
    assert.equal(jev.findingAsks.length, 0, `${name}: 問わない`);
    const cs = conclusions(fake);
    assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), `${name}: ${cs.join(',')}`);
    assert.equal(posted(fake).length, 0, `${name}: 記録しない`);
    assert.match(lastSummary(fake), /計画/, `${name}: 要約に理由\n${lastSummary(fake)}`);
  }
});

test('計画ゲートの記録の planBodySha256 が今の計画コメントと一致すれば、その計画で問う', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], issueComments: [planComment, planGate([CONFIG_FILE, TEST_FILE], { planBodySha256: sha256(PLAN_BODY) })] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1);
  assert.equal(jev.findingAsks[0]!.state.plan, PLAN_BODY);
  assert.equal(conclusions(fake).at(-1), 'success');
});

// ---- 記録の使い回しと問い直し ----

test('同じ patch-id・同じ問いの版の記録があれば二度問わず、記録の確率で通す', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], prComments: [humanComment, autoTestsRecord(WEAKEN_DIFF)] });
  const jev = fakeJev({ finding: 0.1 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 0, '問い直さない');
  assert.equal(posted(fake).length, 0, '記録を書き足さない');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'success'), cs.join(','));
});

test('同じ patch-id でも、通さなかった記録なら問い直さず failure のまま', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], prComments: [humanComment, autoTestsRecord(WEAKEN_DIFF, { probability: 0.5, allows: false, findings: [{ kind: 'skip-added', file: TEST_FILE, line: 11, probability: 0.5 }] })] });
  const jev = fakeJev({ finding: 0.99 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 0);
  assert.equal(conclusions(fake).at(-1), 'failure');
});

test('問いの版が違う記録は使わずに問い直す', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], prComments: [humanComment, autoTestsRecord(WEAKEN_DIFF, { questionSet: AUTO_MODE_TESTS_QUESTION_SET + 100 })] });
  const jev = fakeJev({ finding: 0.5 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1);
  assert.equal(conclusions(fake).at(-1), 'failure');
});

test('記録の patch-id が今の差分と違う（push の後）なら記録を使わずに問い直し、その回の Jev が error なら failure', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], prComments: [humanComment, autoTestsRecord(OLD_DIFF)] });
  const jev = fakeJev({ finding: 'error' });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1, '問い直した');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c === 'failure'), cs.join(','));
});

test('記録の patch-id が今の差分と違うなら問い直し、妥当なら今の差分の記録を書いて success', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], prComments: [humanComment, autoTestsRecord(OLD_DIFF)] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1);
  assert.equal(posted(fake).at(-1)?.record.patchId, patchId(WEAKEN_DIFF));
  assert.equal(conclusions(fake).at(-1), 'success');
});

// ---- push（on-pr.ts の writeTestsCheck） ----

test('push：今の差分の受け付けと記録があれば、問い直さずに success のまま', async () => {
  const w = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(w.fake, jev);
  assert.equal(jev.findingAsks.length, 1);
  const before = w.fake.calls.length;
  await onPullRequest(ctxFor(w.fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.findingAsks.length, 1, '二度問わない');
  const after = w.fake.calls.slice(before).filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === CHECKS.tests);
  assert.ok(after.length > 0, 'push で agent/tests を書いた');
  assert.equal(after.at(-1)?.body.conclusion, 'success');
});

test('push：差分が変わった直後（今の差分の受け付けが無い）は Jev に問わず、success にしない', async () => {
  const w = world({ dashboardLabels: [AUTO], events: [autoOn()] });
  const jev = fakeJev({ finding: 0.95 });
  await accept(w.fake, jev);
  w.setDiff(OLD_DIFF);
  const before = w.fake.calls.length;
  await onPullRequest(ctxFor(w.fake, 'pull_request_target', sync, extra(jev)));
  assert.equal(jev.findingAsks.length, 1, '受け付けの無い差分では問わない');
  const after = w.fake.calls.slice(before).filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === CHECKS.tests);
  assert.ok(after.length > 0, 'push で agent/tests を書いた');
  assert.notEqual(after.at(-1)?.body.conclusion, 'success');
});

// ---- jev.testTamper（enforce）との順番 ----

test('アサーションの書き換えだけの差分で jev.testTamper の Jev が通すなら success で、auto mode の問いはしない', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], diff: ASSERT_DIFF });
  const jev = fakeJev({ change: 0.99, finding: 0.1 });
  await accept(fake, jev);
  assert.ok(jev.changeAsks.length > 0, 'jev.testTamper の問いをした');
  assert.equal(jev.findingAsks.length, 0, 'auto mode の問いはしない');
  assert.equal(conclusions(fake).at(-1), 'success');
  assert.doesNotMatch(lastSummary(fake), /auto mode の判定/);
});

test('アサーションの書き換えだけの差分で jev.testTamper の Jev が通さなくても、auto mode の Jev が妥当と答えれば success', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], diff: ASSERT_DIFF });
  const jev = fakeJev({ change: 0.1, finding: 0.95 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 1);
  assert.equal(conclusions(fake).at(-1), 'success');
});

// ---- AC5：auto mode の経路でない PR では問わず、結論は今までと同じ ----

/** 同じ PR を auto mode あり・なしで受け付け、auto mode の問いをしないことと、最後の agent/tests の結論が同じことを確かめる */
async function sameAsWithoutAutoMode(name: string, o: { danger?: number; files?: string[]; pr?: ReturnType<typeof pr>; v?: Verdict; withLabels?: string[]; withEvents?: unknown[]; withoutLabels?: string[]; withoutEvents?: unknown[] }) {
  const on = world({ dashboardLabels: o.withLabels ?? [AUTO], events: o.withEvents ?? [autoOn()], ...(o.files ? { files: o.files } : {}), ...(o.pr ? { pr: o.pr } : {}) });
  const jevOn = fakeJev({ finding: 0.99, danger: o.danger ?? 0.01 });
  await accept(on.fake, jevOn, o.v ?? critical());
  const off = world({ dashboardLabels: o.withoutLabels ?? [], events: o.withoutEvents ?? [], ...(o.files ? { files: o.files } : {}), ...(o.pr ? { pr: o.pr } : {}) });
  const jevOff = fakeJev({ finding: 0.99, danger: o.danger ?? 0.01 });
  await accept(off.fake, jevOff, o.v ?? critical());
  assert.equal(jevOn.findingAsks.length, 0, `${name}: auto mode の問いをしない`);
  assert.equal(posted(on.fake).length, 0, `${name}: auto-mode-tests を記録しない`);
  const a = conclusions(on.fake).at(-1);
  assert.ok(a, `${name}: agent/tests を書いた`);
  assert.equal(a, conclusions(off.fake).at(-1), `${name}: 結論が auto mode なしと同じ`);
  assert.doesNotMatch(lastSummary(on.fake), /auto mode の判定/, `${name}: 要約に auto mode の節を出さない`);
  return a;
}

test('auto mode が無効なら問わず、今までどおり Human Merge（neutral）', async () => {
  const { fake } = world({ dashboardLabels: [] });
  const jev = fakeJev({ finding: 0.99 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 0);
  assert.equal(conclusions(fake).at(-1), 'neutral');
});

test('委任でも auto mode でも乗る PR は委任で乗るので auto mode の問いをせず、結論は委任だけのときと同じ（failure）', async () => {
  const c = await sameAsWithoutAutoMode('委任', {
    files: [GUARDED, TEST_FILE],
    withLabels: [DELEGATE, AUTO], withEvents: [autoOn(), delegateOn()],
    withoutLabels: [DELEGATE], withoutEvents: [delegateOn()],
  });
  assert.equal(c, 'failure');
});

test('自動 Merge の対象の PR（low）では auto mode の問いをせず、結論は auto mode なしと同じ', async () => {
  await sameAsWithoutAutoMode('自動 Merge の対象', { files: ['docs/a.md', TEST_FILE], v: verdict() });
});

test('Human Merge の PR（auto mode が有効でも Jev が危険と答えた・停止スイッチ）では auto mode の問いをせず、結論は auto mode なしと同じ（neutral）', async () => {
  const danger = await sameAsWithoutAutoMode('危険', { danger: 0.5 });
  assert.equal(danger, 'neutral');
  const stop = await sameAsWithoutAutoMode('停止スイッチ', { withLabels: [AUTO, config.autoMergeStopLabel] });
  assert.equal(stop, 'neutral');
});

test('agent:hold の付いた PR には auto mode の問いをかけず、agent/tests を success にしない', async () => {
  const { fake } = world({ dashboardLabels: [AUTO], events: [autoOn()], pr: pr({ body: 'Closes #3', labels: [{ name: LABELS.hold }] }) });
  const jev = fakeJev({ finding: 0.99 });
  await accept(fake, jev);
  assert.equal(jev.findingAsks.length, 0, 'hold の間は問わない');
  const cs = conclusions(fake);
  assert.ok(cs.length > 0 && cs.every((c) => c !== 'success'), JSON.stringify(cs));
});
