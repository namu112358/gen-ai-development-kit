// auto mode のダッシュボードのラベルの付け外し・停止スイッチ・PR の agent:hold を外したときの auto-merge の付け外しと、
// gate.yml がそのラベルで起動することを、偽の GitHub と偽の Jev で確かめる（Issue #346）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, autoModeConfig } from '../lib/auto-mode.ts';
import { renderBlock } from '../lib/blocks.ts';
import { AUTO_MODE_LABEL_DEFAULT, CHECKS, LABELS, reasonMark, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { patchId } from '../lib/patch-id.ts';
import { onIssue } from '../gates/on-issue.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, CRITIQUE, DIFF, config as base, critiqueClaim, ctxFor, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, dashboardLabelEvent, postedRecord } from './support/stack-fixtures.ts';

/** Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const STOP = config.autoMergeStopLabel;
const CONFIG_FILE = 'harness.config.json';
const GUARDED = 'harness/lib/epic.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string, login = 'me') => ({ event, created_at: at, actor: { login }, label: { name } });
const autoOn = (at = hoursAgo(5), login = 'me') => ev('labeled', AUTO, at, login);
const autoOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', AUTO, at, login);

/** 偽の Jev。危険の問い（danger）にだけ answer で答える */
function fakeJev(answer = 0.01) {
  const fn: typeof askJev = async (_key, request) => {
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
  return fn;
}

/** ゲートの文脈（設定・Jev の鍵・偽の Jev） */
const extra = () => ({ config, secrets: { jevApiKey: 'jev-key' }, askJev: fakeJev() });

/** ダッシュボード（#1）のラベルの付け外しを onIssue に渡す */
const onDashboard = (fake: FakeGitHub, action: 'labeled' | 'unlabeled', label: string, labels: string[], sender = 'me') =>
  onIssue(ctxFor(fake, 'issues', dashboardLabelEvent(action, label, sender, labels), extra()));

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

const countKind = (fake: FakeGitHub, issue: number, kind: string): number => kindsOn(fake, issue).filter((k) => k === kind).length;

// ---- 受け付けの記録と App の記録（開いた PR のコメント） ----

const JEV_SAFE = { status: 'ok', detail: 'jev', yes: 0.01, questionSet: AUTO_MODE_JEV_QUESTION_SET };
const DELEGATE_NO = { eligible: false, reasons: [`委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], skipped: [], scopeOk: true, outside: [], exclude: [CONFIG_FILE] };
const DELEGATE_OK = { eligible: true, reasons: [], skipped: [], scopeOk: true, outside: [], exclude: [] };
const AUTO_OK = { eligible: true, reasons: [], skipped: ['Risk が critical です', `ガードレールに触れます: ${CONFIG_FILE}`, `委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], jev: JEV_SAFE };
const AUTO_NO = { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [] };
const BYPASS_NO = { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [] };

/** auto mode でだけ乗る受け付け（委任しないパスに触れ、critical） */
const autoAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${CONFIG_FILE}`], delegate: DELEGATE_NO, autoMode: AUTO_OK, bypass: BYPASS_NO });

/** auto mode でも乗らない受け付け */
const ineligibleAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, scopeOk: false, outside: ['docs/x.md'], reasons: ['計画の範囲外のファイルがあります: docs/x.md'], delegate: { ...DELEGATE_NO, scopeOk: false, outside: ['docs/x.md'] }, autoMode: AUTO_NO, bypass: BYPASS_NO });

/** 自動 Merge の条件を満たす受け付け（low） */
const lowAcceptance = (id: number) => acceptanceComment(id, { autoEligible: true, reasons: [], delegate: DELEGATE_OK, autoMode: { eligible: false, reasons: [], skipped: [] }, bypass: { eligible: true, reasons: [], skipped: [] } });

/** auto mode で auto-merge を付けた App の記録（kind=auto-mode-merge） */
const autoArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'auto-mode-merge', 'auto mode で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, by: 'me', skipped: AUTO_OK.skipped });

/** auto mode が終わった App の記録（kind=auto-mode-merge-end） */
const autoEnded = (id: number, headSha: string, reason: string) =>
  appRecordComment(id, 'auto-mode-merge-end', 'auto mode が終わりました。', { version: 1, headSha, reason });

/** 開いた Agent PR（番号ごとに head・node_id を変える） */
const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, head: { ref: `claude/issue-${n}`, sha: String(n).repeat(40), repo: { full_name: 'o/r' } }, ...patch });
const sha = (n: number): string => String(n).repeat(40);
const ARMED = { auto_merge: { enabled: true } };

// ---- 止まった計画（ラベルを付けたときに判定し直す） ----

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

// ---- ラベルを付けると ----

test('ラベルを付けると：auto-mode-switch を書き、止まった計画を判定し直し（plan-ok）、auto mode で乗る開いた Agent PR に auto-merge を付ける。乗らない PR・人の PR・hold の PR には付けない', async () => {
  const w: DelegateWorld = {
    prs: [
      agentPr(5),
      agentPr(6),
      agentPr(7, { head: { ref: 'feature/x', sha: sha(7), repo: { full_name: 'o/r' } } }),
      agentPr(8, { labels: [{ name: LABELS.hold }] }),
    ],
    comments: { 5: [autoAcceptance(91)], 6: [ineligibleAcceptance(92)], 7: [autoAcceptance(93)], 8: [autoAcceptance(94)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn(minutesAgo(1))],
  };
  addStoppedPlan(w);
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'labeled', AUTO, [AUTO]);
  assert.equal(countKind(fake, 1, 'auto-mode-switch'), 1, kindsOn(fake, 1).join(','));
  assert.ok(w.issues![61]!.includes(LABELS.planOk), `#61: plan-ok が無い: ${w.issues![61]!.join(',')}`);
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('auto-mode-merge'), kindsOn(fake, 5).join(','));
  assert.ok(!kindsOn(fake, 5).includes('human-review'));
  const rec = postedRecord(fake, 'auto-mode-merge');
  assert.equal(rec.headSha, sha(5));
  assert.equal(rec.by, 'me');
  assert.deepEqual(kindsOn(fake, 6), [], '乗らない PR には何も書かない');
  assert.ok(!kindsOn(fake, 7).includes('auto-mode-merge'), '人の PR には付けない');
  assert.ok(!kindsOn(fake, 8).includes('auto-mode-merge'), 'hold の PR には付けない');
});

test('App・Bot が付けたラベルでは auto mode は有効にならず、auto-mode-switch に理由を書くだけで auto-merge を付けず、計画も通さない', async () => {
  for (const login of [APP, 'someone[bot]']) {
    const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [autoAcceptance(91)] }, dashboardLabels: [AUTO], dashboardEvents: [autoOn(minutesAgo(1), login)] };
    addStoppedPlan(w);
    const fake = delegateWorldFake(w);
    await onDashboard(fake, 'labeled', AUTO, [AUTO], login);
    assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), [], login);
    assert.ok(!kindsOn(fake, 5).includes('auto-mode-merge'), login);
    assert.equal(countKind(fake, 1, 'auto-mode-switch'), 1, `${login}: ${kindsOn(fake, 1).join(',')}`);
    assert.ok(!w.issues![61]!.includes(LABELS.planOk), `${login}: 計画を通した`);
  }
});

test('ラベルを付けても停止スイッチがあれば、auto-merge は付けず、ダッシュボードに記録する', async () => {
  const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [autoAcceptance(91)] }, dashboardLabels: [AUTO, STOP], dashboardEvents: [autoOn(minutesAgo(1))] };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'labeled', AUTO, [AUTO, STOP]);
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), []);
  assert.ok(!kindsOn(fake, 5).includes('auto-mode-merge'));
  assert.equal(countKind(fake, 1, 'auto-mode-switch'), 1);
});

// ---- ラベルを外すと ----

test('ラベルを外すと：auto mode で付けた auto-merge を外し、merge-route を書き直し、auto-mode-merge-end（removed）と human-review を出す。autoEligible で付いた PR は外さない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 5: [autoAcceptance(91), autoArmed(92, sha(5), since)], 6: [lowAcceptance(93)] },
    dashboardLabels: [],
    dashboardEvents: [autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', AUTO, []);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5'], 'autoEligible の PR #6 は外さない');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('auto-mode-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  const end = postedRecord(fake, 'auto-mode-merge-end');
  assert.equal(end.version, 1);
  assert.equal(end.reason, 'removed');
  assert.equal(end.headSha, sha(5));
  const disableAt = fake.calls.findIndex((c) => c.path === '/graphql' && String(c.body?.query).includes('{disablePullRequestAutoMerge('));
  const routeAt = fake.calls.findLastIndex((c) => c.path.endsWith('/check-runs') && c.body.name === CHECKS.mergeRoute && c.body.head_sha === sha(5));
  assert.ok(disableAt >= 0 && routeAt > disableAt, 'auto-merge を外した後に merge-route を書き直す');
  assert.deepEqual(kindsOn(fake, 6), []);
  assert.equal(countKind(fake, 1, 'auto-mode-switch'), 1, '人が外したらダッシュボードに記録する');
});

test('App がラベルを外したときは、ダッシュボードに auto-mode-switch を書かない', async () => {
  const w: DelegateWorld = { prs: [], dashboardLabels: [], dashboardEvents: [autoOn(), autoOff(minutesAgo(1), APP)] };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', AUTO, [], APP);
  assert.equal(countKind(fake, 1, 'auto-mode-switch'), 0, kindsOn(fake, 1).join(','));
});

test('ラベルを外したとき、auto mode で付けた記録の無い PR・終わりの記録が最新の PR には何もしない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5), agentPr(6)],
    comments: { 5: [autoAcceptance(91)], 6: [autoAcceptance(93), autoArmed(94, sha(6), since), autoEnded(95, sha(6), 'stopped')] },
    dashboardLabels: [],
    dashboardEvents: [autoOn(since), autoOff()],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', AUTO, []);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), []);
  assert.deepEqual(kindsOn(fake, 6), []);
});

// ---- 停止スイッチ・hold ----

test('停止スイッチを付けると：auto mode で付けた auto-merge を外し、auto-mode-merge-end（stopped）と human-review を出す', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [autoAcceptance(91), autoArmed(92, sha(5), since)] },
    dashboardLabels: [AUTO, STOP],
    dashboardEvents: [autoOn(since), ev('labeled', STOP, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'labeled', STOP, [AUTO, STOP]);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('auto-mode-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  assert.equal(postedRecord(fake, 'auto-mode-merge-end').reason, 'stopped');
});

test('停止スイッチを外して再開すると、auto mode で乗る PR に auto-merge を付け直す', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5)],
    comments: { 5: [autoAcceptance(91)] },
    dashboardLabels: [AUTO],
    dashboardEvents: [autoOn(hoursAgo(5)), ev('labeled', STOP, hoursAgo(1)), ev('unlabeled', STOP, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onDashboard(fake, 'unlabeled', STOP, [AUTO]);
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('auto-mode-merge'), kindsOn(fake, 5).join(','));
});

test('agent:hold を外すと、auto mode で乗る PR に auto-merge を付け直す', async () => {
  const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [autoAcceptance(91)] }, dashboardLabels: [AUTO], dashboardEvents: [autoOn()] };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'unlabeled', label: { name: LABELS.hold }, sender: { login: 'me' }, pull_request: { number: 5 } }, extra()));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('auto-mode-merge'), kindsOn(fake, 5).join(','));
});

// ---- gate.yml：ラベルの付け外しでゲートが起動する ----

test('gate.yml：Issue の項に auto mode のラベルがあり、設定の既定のラベル名と同じ', () => {
  const yml = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'gate.yml'), 'utf8');
  const start = yml.indexOf("(github.event_name != 'issues' ||");
  const end = yml.indexOf("(github.event_name != 'pull_request_target' ||");
  assert.ok(start >= 0 && end > start, 'gate.yml の Issue の項が読めません');
  const issues = yml.slice(start, end);
  assert.ok(issues.includes("github.event.label.name == 'agent:auto-mode'"), `agent:auto-mode が無い\n${issues}`);
  assert.equal(AUTO_MODE_LABEL_DEFAULT, 'agent:auto-mode', 'gate.yml のラベル名と設定（AUTO_MODE_LABEL_DEFAULT）をそろえる');
  assert.equal(AUTO, AUTO_MODE_LABEL_DEFAULT, 'harness.config.json の autoMode.label と既定をそろえる');
});
