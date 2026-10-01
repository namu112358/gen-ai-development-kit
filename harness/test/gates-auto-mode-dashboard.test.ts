// auto mode の定期実行（onSchedule）を偽の GitHub と偽の Jev で確かめる（Issue #347）：
// 定期照合が auto mode で乗る PR の auto-merge を外さないこと、外すとき・委任や bypass で続けるときの auto-mode-merge-end、
// 止まっている計画の判定し直し、ダッシュボードの auto mode の状態の行と「通した・保留にした」計画と PR の節
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig } from '../lib/auto-mode.ts';
import { renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, CHECKS, delegateConfig, LABELS, reasonMark, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { patchId } from '../lib/patch-id.ts';
import { onSchedule } from '../gates/stale.ts';
import { createHash } from 'node:crypto';
import { APP, CRITIQUE, DIFF, config as base, critiqueClaim, ctxFor, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, postedBodies, postedRecord } from './support/stack-fixtures.ts';

/** Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const STOP = config.autoMergeStopLabel;
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
const H = config.staleHours;
const CONFIG_FILE = 'harness.config.json';
const GUARDED = 'harness/lib/epic.ts';
const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string, login = 'me') => ({ event, created_at: at, actor: { login }, label: { name } });
const autoOn = (at = hoursAgo(5), login = 'me') => ev('labeled', AUTO, at, login);
const autoOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', AUTO, at, login);

/** 偽の Jev。危険の問い（danger）にだけ answer で答え、問った回数を残す */
function fakeJev(answer = 0.01) {
  const asked: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request);
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return { asked, fn };
}

/** 定期実行を走らせる（設定・Jev の鍵・偽の Jev を渡す） */
async function schedule(fake: FakeGitHub, jev = fakeJev()): Promise<void> {
  await onSchedule(ctxFor(fake, 'schedule', {}, { config, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }), new Date());
}

/** GraphQL の mutation（名前指定）の対象の PR の node_id を呼んだ順に */
function mutationIds(fake: FakeGitHub, name: string): string[] {
  return fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(`{${name}(`)).map((c) => String(c.body.variables?.id));
}

/** Issue・PR（番号指定）への App のコメントの kind を書いた順に */
function kindsOn(fake: FakeGitHub, issue: number): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${issue}/comments`))
    .map((c) => String(c.body.body).match(/kind=([\w-]+)/)?.[1] ?? '?');
}

/** 書いたチェック（名前と head 指定） */
function checks(fake: FakeGitHub, name: string, sha: string): { conclusion: string }[] {
  return fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === name && c.body.head_sha === sha).map((c) => ({ conclusion: c.body.conclusion }));
}

function dashboardBody(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  return String(patch.body.body);
}

/** ダッシュボードの本文のうち、auto mode の状態の行 */
const autoStatusLine = (body: string): string | undefined => body.split('\n').find((l) => l.includes('**auto mode: '));

/** 見出し（題）から次の見出しまで */
function sectionOf(body: string, title: string): string {
  const start = body.indexOf(`### ${title}`);
  assert.ok(start >= 0, `「${title}」の節がありません\n${body}`);
  const next = body.indexOf('\n### ', start);
  return body.slice(start, next >= 0 ? next : undefined);
}

const hasRef = (section: string, n: number): boolean => new RegExp(`#${n}\\b`).test(section);

// ---- 受け付けの記録と App の記録 ----

const JEV_SAFE = { status: 'ok', detail: 'jev', yes: 0.01, questionSet: AUTO_MODE_JEV_QUESTION_SET };
const JEV_DANGER = { status: 'ok', detail: 'jev', yes: 0.5, questionSet: AUTO_MODE_JEV_QUESTION_SET };
const DANGER_LINE = 'Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）';
const DELEGATE_NO = { eligible: false, reasons: [`委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], skipped: [], scopeOk: true, outside: [], exclude: [CONFIG_FILE] };
const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };
const AUTO_OK = { eligible: true, reasons: [], skipped: ['Risk が critical です', `ガードレールに触れます: ${CONFIG_FILE}`, `委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], jev: JEV_SAFE };
const AUTO_HOLD = { eligible: false, reasons: [DANGER_LINE], skipped: AUTO_OK.skipped, jev: JEV_DANGER };
const BYPASS_OK = { eligible: true, reasons: [], skipped: AUTO_OK.skipped };
const BYPASS_NO = { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [] };

/** 受け付けの記録（critical・ガードレール。既定は auto mode でだけ乗る） */
const acceptance = (id: number, patch: Record<string, unknown> = {}) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${CONFIG_FILE}`], delegate: DELEGATE_NO, autoMode: AUTO_OK, bypass: BYPASS_NO, ...patch });

/** auto mode で auto-merge を付けた App の記録（kind=auto-mode-merge） */
const autoArmed = (id: number, headSha: string, since: string, diff = DIFF) =>
  appRecordComment(id, 'auto-mode-merge', 'auto mode で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(diff), since, by: 'me', skipped: AUTO_OK.skipped });

/** auto mode が終わった App の記録（kind=auto-mode-merge-end） */
const autoEnded = (id: number, headSha: string, reason: string) =>
  appRecordComment(id, 'auto-mode-merge-end', 'auto mode が終わりました。', { version: 1, headSha, reason });

/** コメントの作成時刻を差し替える（staleHours の判定用） */
const at = <T extends object>(c: T, createdAt: string): T => ({ ...c, created_at: createdAt });

const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, title: `feat: PR ${n}`, html_url: `https://x/${n}`, head: { ref: `claude/issue-${n}`, sha: String(n % 10).repeat(40), repo: { full_name: 'o/r' } }, ...patch });
const sha = (n: number): string => String(n % 10).repeat(40);
const ARMED = { auto_merge: { enabled: true } };

// ---- 1. 定期照合：auto mode で乗る PR の auto-merge を外さない ----

test('定期照合：auto mode が有効で受け付けの autoMode.eligible が真の Agent PR の auto-merge は外さず、auto-merge-removed も auto-mode-merge-end も書かない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [acceptance(91), autoArmed(92, sha(5), since)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn(since)],
  };
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(!kinds.includes('auto-merge-removed'), kinds.join(','));
  assert.ok(!kinds.includes('auto-mode-merge-end'), kinds.join(','));
});

// ---- 2. 外すとき：auto-mode-merge-end を書く ----

test('定期照合：auto mode で付けた auto-merge を外すとき、auto-merge-removed に加えて auto-mode-merge-end を書く（ラベル無し=removed・停止スイッチ=stopped・人以外が付けた=ineligible）。human-review は出さない', async () => {
  const since = hoursAgo(5);
  const cases: [string, string[], unknown[], string][] = [
    ['ラベル無し', [], [autoOn(since), autoOff()], 'removed'],
    ['停止スイッチ', [AUTO, STOP], [autoOn(since), ev('labeled', STOP, minutesAgo(1))], 'stopped'],
    ['人以外が付けた', [AUTO], [autoOn(since, 'someone[bot]')], 'ineligible'],
  ];
  for (const [name, labels, events, reason] of cases) {
    const w: DelegateWorld = { prs: [agentPr(5, ARMED)], comments: { 5: [acceptance(91), autoArmed(92, sha(5), since)] }, dashboardLabels: labels, dashboardEvents: events };
    const fake = delegateWorldFake(w);
    await schedule(fake);
    assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5'], name);
    const kinds = kindsOn(fake, 5);
    assert.ok(kinds.includes('auto-merge-removed'), `${name}: ${kinds.join(',')}`);
    assert.ok(kinds.includes('auto-mode-merge-end'), `${name}: ${kinds.join(',')}`);
    assert.ok(!kinds.includes('human-review'), `${name}: ${kinds.join(',')}`);
    const end = postedRecord(fake, 'auto-mode-merge-end');
    assert.equal(end.reason, reason, name);
    assert.equal(end.headSha, sha(5), name);
    assert.ok(checks(fake, CHECKS.mergeRoute, sha(5)).length > 0, `${name}: merge-route を書き直していません`);
  }
});

test('定期照合：auto mode の記録の無い PR・終わりの記録が最新の PR の auto-merge を外すときは、auto-mode-merge-end を書かない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 5: [acceptance(91)], 6: [acceptance(93), autoArmed(94, sha(6), since), autoEnded(95, sha(6), 'removed')] },
    dashboardLabels: [],
    dashboardEvents: [autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge').sort(), ['PR_5', 'PR_6']);
  for (const n of [5, 6]) {
    const kinds = kindsOn(fake, n);
    assert.ok(kinds.includes('auto-merge-removed'), `#${n}: ${kinds.join(',')}`);
    assert.ok(!kinds.includes('auto-mode-merge-end'), `#${n}: ${kinds.join(',')}`);
  }
});

test('定期照合：auto mode で付けた auto-merge を外すとき、テストを弱める差分なら agent/tests を書き直す（auto mode が終わったので neutral）', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [acceptance(91, { patchId: patchId(SKIP_DIFF) }), autoArmed(92, sha(5), since, SKIP_DIFF)] },
    files: { 5: [CONFIG_FILE, 'a.test.ts'] },
    diff: SKIP_DIFF,
    dashboardLabels: [],
    dashboardEvents: [autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('auto-mode-merge-end'), kindsOn(fake, 5).join(','));
  const tests = checks(fake, CHECKS.tests, sha(5));
  assert.ok(tests.length > 0, 'agent/tests を書き直していません');
  assert.equal(tests.at(-1)?.conclusion, 'neutral');
});

// ---- 3. 委任・bypass で続けるとき ----

test('定期照合：委任（計画＋Merge）で乗り続ける PR に auto mode の記録が残っていれば、auto-merge は外さずに auto-mode-merge-end を書く（2回目は書かない）', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [acceptance(91, { reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK, autoMode: { ...AUTO_OK, skipped: DELEGATE_OK.skipped } }), autoArmed(92, sha(5), since)] },
    dashboardLabels: [DELEGATE],
    dashboardEvents: [autoOn(since), ev('labeled', DELEGATE, minutesAgo(30)), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.deepEqual(kinds.filter((k) => k === 'auto-mode-merge-end').length, 1, kinds.join(','));
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.ok(!kinds.includes('auto-merge-removed'), kinds.join(','));
  assert.ok(postedBodies(fake, 'auto-mode-merge-end').at(-1)!.includes('委任承認（計画＋Merge）で自動経路を続けます。'), postedBodies(fake, 'auto-mode-merge-end').at(-1));

  await schedule(fake);
  assert.equal(kindsOn(fake, 5).filter((k) => k === 'auto-mode-merge-end').length, 1, '終わりの記録が最新なら書き足さない');
});

test('定期照合：bypass で乗り続ける PR に auto mode の記録が残っていれば、auto-merge は外さずに auto-mode-merge-end を書く', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [acceptance(91, { bypass: BYPASS_OK }), autoArmed(92, sha(5), since)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [ev('labeled', BYPASS, hoursAgo(6)), autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('auto-mode-merge-end'), kinds.join(','));
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.ok(!kinds.includes('auto-merge-removed'), kinds.join(','));
  assert.ok(postedBodies(fake, 'auto-mode-merge-end').at(-1)!.includes('bypass モードで自動経路を続けます。'), postedBodies(fake, 'auto-mode-merge-end').at(-1));
});

// ---- 4. 止まっている計画の判定し直し ----

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 世界に、ガードレールに触れてゲートで止まった Issue（#61）を足す（Jev が安全なら auto mode で通る） */
function addStoppedPlan(w: DelegateWorld, n = 61): void {
  const plan: Plan = { version: 1, issue: n, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE };
  const comment = { id: 8000, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: 'p8000', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
  const record = { version: 1, planCommentId: comment.id, planBodySha256: sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: 'gate', plan };
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [critiqueClaim(), comment, appRecordComment(8001, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record)];
  (w.issueEvents ??= {})[n] = [{ event: 'labeled', created_at: '2026-09-28T00:01:00Z', actor: { login: APP }, label: { name: LABELS.planReview } }];
}

test('定期実行：auto mode が有効なら、ゲートの停止で止まっている計画を判定し直し、Jev が安全なら agent:plan-ok を付ける', async () => {
  const w: DelegateWorld = { prs: [], dashboardLabels: [AUTO], dashboardEvents: [autoOn()] };
  addStoppedPlan(w);
  const fake = delegateWorldFake(w);
  const jev = fakeJev(0.01);
  await schedule(fake, jev);
  assert.ok(jev.asked.length > 0, 'Jev に問っていません');
  assert.ok(w.issues![61]!.includes(LABELS.planOk), `#61: plan-ok が無い: ${w.issues![61]!.join(',')}`);
});

test('定期実行：auto mode が無効（ラベル無し・人以外が付けた・停止スイッチ）なら、止まっている計画について Jev に問わず、plan-ok も付けない', async () => {
  const cases: [string, string[], unknown[]][] = [
    ['ラベル無し', [], []],
    ['人以外が付けた', [AUTO], [autoOn(hoursAgo(1), APP)]],
    ['停止スイッチ', [AUTO, STOP], [autoOn()]],
  ];
  for (const [name, labels, events] of cases) {
    const w: DelegateWorld = { prs: [], dashboardLabels: labels, dashboardEvents: events };
    addStoppedPlan(w);
    const fake = delegateWorldFake(w);
    const jev = fakeJev(0.01);
    await schedule(fake, jev);
    assert.equal(jev.asked.length, 0, `${name}: Jev に問った`);
    assert.ok(!w.issues![61]!.includes(LABELS.planOk), `${name}: 計画を通した`);
  }
});

// ---- 5. ダッシュボード：状態の行 ----

async function statusFor(labels: string[], events: unknown[]): Promise<{ line: string; body: string }> {
  const fake = delegateWorldFake({ prs: [], dashboardLabels: labels, dashboardEvents: events });
  await schedule(fake);
  const body = dashboardBody(fake);
  const line = autoStatusLine(body);
  assert.ok(line, `auto mode の状態の行がありません\n${body}`);
  return { line, body };
}

test('ダッシュボード：ラベルが無ければ状態の行は「**auto mode: 無効**」で始まり、付け方の説明がある。委任承認・bypass の行の下に置く', async () => {
  const { line, body } = await statusFor([], []);
  assert.ok(line.startsWith('**auto mode: 無効**'), line);
  assert.ok(line.includes(AUTO), `ラベル名の説明が無い: ${line}`);
  const lines = body.split('\n');
  const autoAt = lines.indexOf(line);
  const delegateAt = lines.findIndex((l) => l.includes('**委任承認: '));
  const bypassAt = lines.findIndex((l) => l.includes('**bypass モード: '));
  assert.ok(delegateAt >= 0 && bypassAt >= 0 && autoAt > delegateAt && autoAt > bypassAt, body);
});

test('ダッシュボード：人が付けていれば状態の行は「**auto mode: 有効**（@付けた人、…」', async () => {
  const { line } = await statusFor([AUTO], [autoOn(hoursAgo(3), 'me')]);
  assert.ok(line.includes('**auto mode: 有効**（@me'), line);
});

test('ダッシュボード：ラベルはあるが無効なら「**auto mode: 無効**」に理由（人以外が付けた・停止スイッチが優先）を書く', async () => {
  const cases: [string, string[], unknown[], string][] = [
    ['App', [AUTO], [autoOn(hoursAgo(1), APP)], '人以外が付けた'],
    ['Bot', [AUTO], [autoOn(hoursAgo(1), 'someone[bot]')], '人以外が付けた'],
    ['停止スイッチ', [AUTO, STOP], [autoOn()], '停止スイッチが優先'],
  ];
  for (const [name, labels, events, reason] of cases) {
    const { line } = await statusFor(labels, events);
    assert.ok(line.includes('**auto mode: 無効**'), `${name}: ${line}`);
    assert.ok(line.includes(`\`${AUTO}\` は付いていますが`), `${name}: ${line}`);
    assert.ok(line.includes(reason), `${name}: ${line}`);
  }
});

test('ダッシュボード：timeline が読めなければ「**auto mode: 状態を読めませんでした**」と書き、更新は続ける', async () => {
  const fake = delegateWorldFake({ prs: [], dashboardLabels: [AUTO], dashboardEvents: [autoOn()] });
  fake.on('GET', /\/issues\/1\/timeline/, () => {
    throw new Error('HTTP 502');
  });
  await schedule(fake);
  const line = autoStatusLine(dashboardBody(fake));
  assert.ok(line?.includes('**auto mode: 状態を読めませんでした**'), line);
});

// ---- 5. ダッシュボード：auto mode で通した・保留にした計画 ----

const PLAN_PASSED = `auto mode で通した計画（直近 ${H} 時間）`;
const PLAN_HELD = `auto mode で保留にした計画（直近 ${H} 時間）`;
const SKIPPED = `ガードレールに触れます: ${GUARDED}`;

/** auto mode をかけた plan-gate の記録（App のコメント、作成時刻つき） */
function planGateRecord(id: number, createdAt: string, o: { pass: boolean; hold?: boolean; autoMode?: boolean }) {
  const jev = o.hold ? JEV_DANGER : JEV_SAFE;
  const autoMode = { skipped: [SKIPPED], label: AUTO, by: 'me', since: hoursAgo(5), jev, hold: o.hold === true, reasons: [o.hold ? DANGER_LINE : 'Jev：危険の確率 1%（安全側の下限 90%）（安全）'] };
  const record = { version: 1, planCommentId: id - 1, pass: o.pass, reasons: o.pass ? [] : ['止めた理由'], ...(o.pass ? {} : { planReviewOrigin: 'gate' }), ...(o.autoMode === false ? {} : { autoMode }) };
  return at(appRecordComment(id, 'plan-gate', o.pass ? '計画ゲートを通過しました。' : '計画ゲートで停止しました。', record), createdAt);
}

/** 計画の節の世界：#21 は通した・#22 は保留・#25 は保留の後に通した。ほかは出ない */
function planWorld(): DelegateWorld {
  return {
    prs: [],
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn()],
    issues: {
      21: [LABELS.planOk],
      22: [LABELS.planReview],
      23: [LABELS.planOk],
      24: [LABELS.planOk],
      25: [LABELS.planOk],
      26: [LABELS.ready],
      27: [LABELS.planOk],
    },
    comments: {
      21: [planGateRecord(2101, hoursAgo(1), { pass: true })],
      22: [planGateRecord(2201, hoursAgo(1), { pass: false, hold: true })],
      // staleHours より古い
      23: [planGateRecord(2301, hoursAgo(H + 1), { pass: true })],
      // auto mode をかけていない（ふつうの通過）
      24: [planGateRecord(2401, hoursAgo(1), { pass: true, autoMode: false })],
      // 保留の後に通した：通した節にだけ出る
      25: [planGateRecord(2501, hoursAgo(2), { pass: false, hold: true }), planGateRecord(2502, hoursAgo(1), { pass: true })],
      // agent:plan-ok も agent:plan-review も無い
      26: [planGateRecord(2601, hoursAgo(1), { pass: true })],
      // App 以外が書いた記録
      27: [{ ...planGateRecord(2701, hoursAgo(1), { pass: true }), user: { login: 'me', type: 'User' }, author_association: 'OWNER' }],
    },
  };
}

test('ダッシュボード：auto mode で通した計画（staleHours 以内）を、付けた人と飛ばした理由つきで出す', async () => {
  const fake = delegateWorldFake(planWorld());
  await schedule(fake);
  const section = sectionOf(dashboardBody(fake), PLAN_PASSED);
  assert.ok(section.startsWith(`### ${PLAN_PASSED}（2）`), section);
  const row = section.split('\n').find((l) => hasRef(l, 21));
  assert.ok(row, section);
  assert.ok(row.includes('[#21](i21)'), row);
  assert.ok(row.includes('@me'), row);
  assert.ok(row.includes(SKIPPED), row);
  assert.ok(hasRef(section, 25), section);
  for (const n of [22, 23, 24, 26, 27]) assert.ok(!hasRef(section, n), `#${n} は出さない\n${section}`);
});

test('ダッシュボード：auto mode で保留にした計画（staleHours 以内）を、Jev の1行つきで出す。保留の後に通した計画は出さない', async () => {
  const fake = delegateWorldFake(planWorld());
  await schedule(fake);
  const section = sectionOf(dashboardBody(fake), PLAN_HELD);
  assert.ok(section.startsWith(`### ${PLAN_HELD}（1）`), section);
  const row = section.split('\n').find((l) => hasRef(l, 22));
  assert.ok(row, section);
  assert.ok(row.includes('危険の確率 50%'), row);
  for (const n of [21, 23, 24, 25, 26, 27]) assert.ok(!hasRef(section, n), `#${n} は出さない\n${section}`);
});

test('ダッシュボード：該当する計画が無ければ、計画の節は「なし」', async () => {
  const fake = delegateWorldFake({ prs: [], dashboardLabels: [AUTO], dashboardEvents: [autoOn()] });
  await schedule(fake);
  const body = dashboardBody(fake);
  for (const title of [PLAN_PASSED, PLAN_HELD]) {
    const section = sectionOf(body, title);
    assert.ok(section.startsWith(`### ${title}（0）`), section);
    assert.ok(section.includes('なし'), section);
  }
});

// ---- 5. ダッシュボード：auto mode で Merge した PR ----

const PR_MERGED = `auto mode で Merge した PR（直近 ${H} 時間）`;

function closedPr(n: number, mergedAt: string | null) {
  return agentPr(n, { state: 'closed', title: `feat: closed ${n}`, merged_at: mergedAt });
}

test('ダッシュボード：auto mode で Merge した PR（staleHours 以内、最後の記録が auto-mode-merge）を、付けた人つきで出す', async () => {
  const since = hoursAgo(5);
  const fake = delegateWorldFake({
    prs: [],
    closedPrs: [closedPr(31, hoursAgo(1)), closedPr(32, hoursAgo(1)), closedPr(33, hoursAgo(H + 1)), closedPr(34, null), closedPr(35, hoursAgo(1))],
    comments: {
      31: [acceptance(311), autoArmed(312, sha(31), since)],
      // 終わりの記録が後にある
      32: [acceptance(321), autoArmed(322, sha(32), since), autoEnded(323, sha(32), 'removed')],
      // staleHours より前に Merge
      33: [acceptance(331), autoArmed(332, sha(33), hoursAgo(H + 2))],
      // Merge されていない
      34: [acceptance(341), autoArmed(342, sha(34), since)],
      // auto mode の記録が無い
      35: [acceptance(351)],
    },
    // ラベルを外した後でも出す
    dashboardLabels: [],
    dashboardEvents: [autoOn(since), autoOff(hoursAgo(0.5))],
  });
  await schedule(fake);
  const section = sectionOf(dashboardBody(fake), PR_MERGED);
  assert.ok(section.startsWith(`### ${PR_MERGED}（1）`), section);
  const row = section.split('\n').find((l) => hasRef(l, 31));
  assert.ok(row, section);
  assert.ok(row.includes('@me'), row);
  for (const n of [32, 33, 34, 35]) assert.ok(!hasRef(section, n), `#${n} は出さない\n${section}`);
});

// ---- 5. ダッシュボード：auto mode で保留にした PR ----

const PR_HELD = `auto mode で保留にした PR（直近 ${H} 時間）`;

/** 保留の PR の世界：#41 だけが出る */
function heldPrWorld(dashboardLabels: string[], dashboardEvents: unknown[]): DelegateWorld {
  return {
    prs: [
      agentPr(41),
      // auto-merge が付いている（bypass で乗り続けるので定期照合でも外れない）
      agentPr(42, ARMED),
      agentPr(43),
      agentPr(44),
      agentPr(45),
      // 人の PR
      agentPr(46, { head: { ref: 'feature/x', sha: sha(46), repo: { full_name: 'o/r' } } }),
    ],
    comments: {
      41: [at(acceptance(411, { autoMode: AUTO_HOLD }), hoursAgo(1))],
      42: [at(acceptance(421, { autoMode: AUTO_HOLD, bypass: BYPASS_OK }), hoursAgo(1))],
      // staleHours より古い受け付け
      43: [at(acceptance(431, { autoMode: AUTO_HOLD }), hoursAgo(H + 1))],
      // Jev は安全で、ほかの理由で乗らない
      44: [at(acceptance(441, { autoMode: { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [], jev: JEV_SAFE } }), hoursAgo(1))],
      // Jev の記録が無い
      45: [at(acceptance(451, { autoMode: { eligible: false, reasons: ['Reviewer のブロッキング指摘があります'], skipped: [] } }), hoursAgo(1))],
      46: [at(acceptance(461, { autoMode: AUTO_HOLD }), hoursAgo(1))],
    },
    dashboardLabels,
    dashboardEvents,
  };
}

test('ダッシュボード：auto mode が有効なら、Jev の危険の判定で保留にした開いた Agent PR（auto-merge 無し・staleHours 以内）を Jev の1行つきで出す', async () => {
  const w = heldPrWorld([AUTO, BYPASS], [ev('labeled', BYPASS, hoursAgo(6)), autoOn()]);
  const fake = delegateWorldFake(w);
  await schedule(fake);
  assert.ok(w.prs.find((p) => p.number === 42)!.auto_merge, '#42 の auto-merge は付いたまま（前提）');
  const section = sectionOf(dashboardBody(fake), PR_HELD);
  assert.ok(section.startsWith(`### ${PR_HELD}（1）`), section);
  const row = section.split('\n').find((l) => hasRef(l, 41));
  assert.ok(row, section);
  assert.ok(row.includes('Jev：危険の確率 50%'), row);
  for (const n of [42, 43, 44, 45, 46]) assert.ok(!hasRef(section, n), `#${n} は出さない\n${section}`);
});

test('ダッシュボード：auto mode が無効なら、保留にした PR の節は「auto mode が無効です」で、PR を出さない', async () => {
  for (const [name, labels, events] of [
    ['ラベル無し', [BYPASS], [ev('labeled', BYPASS, hoursAgo(6))]],
    ['停止スイッチ', [AUTO, STOP], [autoOn()]],
  ] as [string, string[], unknown[]][]) {
    const fake = delegateWorldFake(heldPrWorld(labels, events));
    await schedule(fake);
    const section = sectionOf(dashboardBody(fake), PR_HELD);
    assert.ok(section.includes('auto mode が無効です'), `${name}: ${section}`);
    assert.ok(!hasRef(section, 41), `${name}: ${section}`);
  }
});

// ---- 5. 読み込みの失敗 ----

test('ダッシュボード：閉じた PR の一覧が読めなくても、Merge した PR の節に「読めませんでした」と書き、ほかの節と書き換えは続ける', async () => {
  const fake = delegateWorldFake(planWorld());
  fake.on('GET', /\/pulls\?state=closed/, () => {
    throw new Error('HTTP 502');
  });
  await schedule(fake);
  const body = dashboardBody(fake);
  assert.match(sectionOf(body, PR_MERGED), /読めませんでした/);
  assert.ok(hasRef(sectionOf(body, PLAN_PASSED), 21), body);
  assert.ok(autoStatusLine(body)?.includes('**auto mode: 有効**'), body);
});

test('ダッシュボード：最近更新された Issue の一覧が読めなくても、計画の節に「読めませんでした」と書き、ほかの節と書き換えは続ける', async () => {
  const since = hoursAgo(5);
  const fake = delegateWorldFake({
    prs: [],
    closedPrs: [closedPr(31, hoursAgo(1))],
    comments: { 31: [acceptance(311), autoArmed(312, sha(31), since)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn(since)],
  });
  fake.on('GET', /\/issues\?state=all/, () => {
    throw new Error('HTTP 502');
  });
  await schedule(fake);
  const body = dashboardBody(fake);
  for (const title of [PLAN_PASSED, PLAN_HELD]) assert.match(sectionOf(body, title), /読めませんでした/, title);
  assert.ok(hasRef(sectionOf(body, PR_MERGED), 31), body);
});
