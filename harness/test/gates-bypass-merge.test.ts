// bypass モードのゲートの動作（判定の受け付け・ダッシュボードのラベルの付け外し・停止スイッチ・hold・定期照合・委任との引き継ぎ・agent/tests・ダッシュボード）を、
// 偽の GitHub への書き込みで確かめる（Issue #245）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, CHECKS, delegateConfig, LABELS } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { onComment } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { onSchedule } from '../gates/stale.ts';
import { APP, DIFF, HEAD, acceptanceFake, config, ctxFor, delegateWorldFake, pr, verdict, verdictEvent, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, countCalls, FEATURE_BASE, postedRecord } from './support/stack-fixtures.ts';

const BYPASS = bypassMergeConfig(config).label;
const D = delegateConfig(config);
const DELEGATE = D.mergeLabel;
const DELEGATE_PLAN = D.planLabel;
const STOP = config.autoMergeStopLabel;
/** ガードレールにも delegateMergeExclude にも当たる（委任でも乗らない） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';
const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string, login = 'me') => ({ event, created_at: at, actor: { login }, label: { name } });
const bypassOn = (at = hoursAgo(5), login = 'me') => ev('labeled', BYPASS, at, login);
const bypassOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', BYPASS, at, login);
const delegateOn = (at = minutesAgo(10), login = 'me') => ev('labeled', DELEGATE, at, login);
const delegateOff = (at = minutesAgo(1), login = 'me') => ev('unlabeled', DELEGATE, at, login);
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートの記録（既定は通過、files 指定） */
const planGate = (files: string[], value: Record<string, unknown> = { pass: true }) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, reasons: [], plan: { files }, ...value })}`,
});

/** 判定の受け付け（onComment）用。既定は、変更ファイルと計画の files がどちらも harness.config.json（範囲内・委任しないパス） */
function verdictFake(o: { dashboardLabels: string[]; events?: unknown[]; files?: string[]; planFiles?: string[]; plan?: Record<string, unknown>; pr?: ReturnType<typeof pr>; diff?: string; prComments?: unknown[] }): FakeGitHub {
  const files = o.files ?? [CONFIG_FILE];
  const fake = acceptanceFake({ pr: o.pr ?? pr(), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments: o.prComments ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(o.planFiles ?? files, o.plan)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })));
  if (o.diff) fake.on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? o.diff : { behind_by: 0 }));
  return fake;
}

async function accept(fake: FakeGitHub, v = critical(), extra: Parameters<typeof ctxFor>[3] = {}): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), extra));
}

/** 書いたチェック（名前指定、sha を渡せばその head のものだけ） */
function checks(fake: FakeGitHub, name: string, sha?: string): { conclusion: string; title: string }[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === name && (sha === undefined || c.body.head_sha === sha))
    .map((c) => ({ conclusion: c.body.conclusion, title: String(c.body.output?.title ?? '') }));
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

/** POST された App のコメント（Issue・PR と kind 指定）の数 */
const countKind = (fake: FakeGitHub, issue: number, kind: string): number => kindsOn(fake, issue).filter((k) => k === kind).length;

function dashboardBody(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  return String(patch.body.body);
}

// ---- 受け付けの記録と App の記録（開いた PR のコメント） ----

const DELEGATE_NO = { eligible: false, reasons: [`委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`], skipped: [], scopeOk: true, outside: [], exclude: [CONFIG_FILE] };
const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };
const BYPASS_OK = { eligible: true, reasons: [], skipped: ['Risk が critical です', `ガードレールに触れます: ${CONFIG_FILE}`, `委任しないパスに触れます（delegateMergeExclude）: ${CONFIG_FILE}`] };
const BYPASS_NO = { eligible: false, reasons: ['計画の範囲外のファイルがあります: docs/x.md'], skipped: [] };

/** bypass でだけ乗る受け付け（委任しないパスに触れ、critical） */
const bypassAcceptance = (id: number, diff = DIFF) =>
  acceptanceComment(id, { patchId: patchId(diff), riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${CONFIG_FILE}`], delegate: DELEGATE_NO, bypass: BYPASS_OK });

/** 委任でも bypass でも乗る受け付け（ガードレールに触れ、critical） */
const bothAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK, bypass: { ...BYPASS_OK, skipped: DELEGATE_OK.skipped } });

/** bypass でも乗らない受け付け */
const ineligibleAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, scopeOk: false, outside: ['docs/x.md'], reasons: ['計画の範囲外のファイルがあります: docs/x.md'], delegate: { ...DELEGATE_NO, scopeOk: false, outside: ['docs/x.md'] }, bypass: BYPASS_NO });

/** 自動 Merge の条件を満たす受け付け（low） */
const autoAcceptance = (id: number) => acceptanceComment(id, { autoEligible: true, reasons: [], delegate: DELEGATE_OK, bypass: { ...BYPASS_OK, skipped: [] } });

/** bypass で auto-merge を付けた App の記録（kind=bypass-merge） */
const bypassArmed = (id: number, headSha: string, since: string, diff = DIFF) =>
  appRecordComment(id, 'bypass-merge', 'bypass モードで自動経路に乗せました。', { version: 1, headSha, patchId: patchId(diff), since, by: 'me', skipped: BYPASS_OK.skipped });

/** bypass が終わった App の記録（kind=bypass-merge-end） */
const bypassEnded = (id: number, headSha: string, reason: string) =>
  appRecordComment(id, 'bypass-merge-end', 'bypass モードが終わりました。', { version: 1, headSha, reason });

/** 委任で auto-merge を付けた App の記録（kind=delegated-merge） */
const delegateArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'delegated-merge', '委任承認（計画＋Merge）で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, until: null, by: 'me', skipped: DELEGATE_OK.skipped });

/** 開いた Agent PR（番号ごとに head・node_id を変える） */
const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, head: { ref: `claude/issue-${n}`, sha: String(n).repeat(40), repo: { full_name: 'o/r' } }, ...patch });
const sha = (n: number): string => String(n).repeat(40);
const ARMED = { auto_merge: { enabled: true } };

/** ダッシュボード（#1）へのラベルの付け外しのイベント */
const dashboardEvent = (action: 'labeled' | 'unlabeled', label: string, sender: string, labels: string[]) => ({
  action,
  issue: { number: 1, title: config.dashboardIssueTitle, body: '', labels: labels.map((name) => ({ name })), state: 'open' },
  label: { name: label },
  sender: { login: sender },
});

// ---- AC1：bypass が有効なら、critical・ガードレール・delegateMergeExclude（harness.config.json）の PR にも auto-merge を付ける ----

test('bypass が有効：harness.config.json に触れ Risk が critical の PR を受け付けると、bypass-merge を記録してから auto-merge を付け、merge-route は success、human-review は出さない', async () => {
  const since = hoursAgo(100);
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn(since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:bypass-merge'), w.join('\n'));
  assert.ok(w.indexOf('comment:bypass-merge') < w.indexOf('enablePullRequestAutoMerge'), 'auto-merge を付ける前に記録を書く');
  assert.ok(!w.includes('comment:human-review'), w.join('\n'));
  assert.ok(!w.includes('comment:delegated-merge'), '委任の記録は書かない');
  const route = checks(fake, CHECKS.mergeRoute).at(-1);
  assert.equal(route?.conclusion, 'success');
  assert.equal(route?.title, 'bypass モードの条件を満たしています');

  const rec = postedRecord(fake, 'bypass-merge');
  assert.equal(rec.version, 1);
  assert.equal(rec.headSha, HEAD);
  assert.equal(rec.patchId, patchId(DIFF));
  assert.equal(rec.by, 'me');
  assert.equal(Date.parse(rec.since), Date.parse(since));
  assert.ok(Array.isArray(rec.skipped) && (rec.skipped as string[]).some((s) => s.includes(CONFIG_FILE)), JSON.stringify(rec.skipped));
});

test('受け付けの記録：bypass でだけ乗る PR は delegate.eligible が偽、bypass.eligible が真で skipped に harness.config.json と Risk が載る', async () => {
  const fake = verdictFake({ dashboardLabels: [] });
  await accept(fake);
  const a = postedRecord(fake, 'acceptance');
  assert.equal(a.autoEligible, false);
  assert.equal(a.delegate?.eligible, false);
  assert.ok(a.bypass, '記録に bypass が無い');
  assert.equal(a.bypass.eligible, true, (a.bypass.reasons as string[]).join('\n'));
  assert.deepEqual(a.bypass.reasons, []);
  assert.ok((a.bypass.skipped as string[]).some((s) => s.includes(CONFIG_FILE)), (a.bypass.skipped as string[]).join('\n'));
  assert.ok((a.bypass.skipped as string[]).some((s) => s.includes('critical')), (a.bypass.skipped as string[]).join('\n'));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), 'bypass が無効ならまだ付けない');
});

test('受け付けの記録：計画ゲートで止まった計画（gate）の files とは照合し、Planner の申告で止まった計画とは照合しない（委任と同じ）', async () => {
  const byGate = verdictFake({ dashboardLabels: [], plan: { pass: false, planReviewOrigin: 'gate' } });
  await accept(byGate);
  assert.equal(postedRecord(byGate, 'acceptance').bypass?.eligible, true);

  const byPlanner = verdictFake({ dashboardLabels: [], plan: { pass: false, planReviewOrigin: 'planner' } });
  await accept(byPlanner);
  assert.equal(postedRecord(byPlanner, 'acceptance').bypass?.eligible, false);
});

test('bypass が有効：humanMergePaths に触れる PR にも auto-merge を付ける', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()] });
  await accept(fake, critical(), { config: { ...config, humanMergePaths: [CONFIG_FILE] } });
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:bypass-merge'));
  assert.equal(postedRecord(fake, 'acceptance').bypass?.eligible, true);
});

test('bypass が有効：同じ patchId の bypass-merge の記録が最新なら、記録を書き足さずに auto-merge を付ける', async () => {
  const since = hoursAgo(5);
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn(since)], prComments: [bypassArmed(92, HEAD, since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'), w.join('\n'));
});

test('bypass が有効でも、自動 Merge の対象（low・docs）の PR は今までどおり自動 Merge として扱い、bypass の記録は書かない', async () => {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: [BYPASS], dashboardEvents: [bypassOn()] });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, '自動 Merge 条件を満たしています');
});

test('委任と bypass が両方有効：委任で乗る PR には委任の記録だけを書き、bypass の記録は書かない', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE, BYPASS], events: [bypassOn(), delegateOn()], files: [GUARDED] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:delegated-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, '委任承認（計画＋Merge）の条件を満たしています');
});

// ---- AC2：bypass が有効でも付けない ----

test('bypass が有効でも、Reviewer のブロッキング指摘がある PR には auto-merge を付けない（bypass.eligible は偽）', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()] });
  await accept(fake, verdict({ risk: critical().risk, review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'AC 2' }], nonBlocking: [] } }));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
  assert.equal(postedRecord(fake, 'acceptance').bypass?.eligible, false);
});

test('bypass が有効でも、計画の範囲の外のファイルがある PR には auto-merge を付けず、human-review を出す', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()], files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
  assert.ok(w.includes('comment:human-review'));
  const a = postedRecord(fake, 'acceptance');
  assert.equal(a.bypass?.eligible, false);
  assert.ok((a.bypass?.reasons as string[]).some((r) => r.includes('docs/x.md')), JSON.stringify(a.bypass));
});

test('bypass が有効でも、agent:hold のある PR には auto-merge を付けず、human-review を出す', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()], pr: pr({ labels: [{ name: LABELS.hold }] }) });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
  assert.ok(w.includes('comment:human-review'));
});

test('bypass が有効でも、base が既定ブランチでない PR には auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()], pr: pr({ base: FEATURE_BASE }) });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
});

test('bypass で乗る PR でテストを弱める変更があると、agent/tests は failure（Human Merge とみなさない）', async () => {
  const files = [CONFIG_FILE, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn()], files, diff: SKIP_DIFF });
  await accept(fake);
  const tests = checks(fake, CHECKS.tests);
  assert.ok(tests.length > 0, 'agent/tests を書いていません');
  assert.ok(tests.every((t) => t.conclusion === 'failure'), JSON.stringify(tests));
});

// ---- AC3：bypass が無効なら今の Merge 経路と変わらない ----

test('bypass が無効なら今までどおり：テストを弱める変更は neutral（Human Merge）', async () => {
  const files = [CONFIG_FILE, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [], files, diff: SKIP_DIFF });
  await accept(fake);
  assert.equal(checks(fake, CHECKS.tests).at(-1)?.conclusion, 'neutral');
});

test('ダッシュボードに bypass のラベルが無ければ今までどおり Human Merge（timeline も読まない）', async () => {
  const fake = verdictFake({ dashboardLabels: [], events: [bypassOn()] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
  assert.ok(w.includes('comment:human-review'));
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0, 'ラベルが無ければ timeline を読まない');
});

test('bypass のラベルを App や Bot が付けたなら、今までどおり Human Merge', async () => {
  for (const login of [APP, 'someone[bot]']) {
    const fake = verdictFake({ dashboardLabels: [BYPASS], events: [bypassOn(hoursAgo(1), login)] });
    await accept(fake);
    const w = fake.writes();
    assert.ok(!w.includes('enablePullRequestAutoMerge'), `${login}: ${w.join('\n')}`);
    assert.ok(!w.includes('comment:bypass-merge'), login);
    assert.ok(w.includes('comment:human-review'), login);
  }
});

test('停止スイッチ（自動 Merge モードが無効）が付いていれば、bypass のラベルがあっても auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS, STOP], events: [bypassOn()] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:bypass-merge'));
  assert.ok(w.includes('comment:human-review'));
});

// ---- AC5：ラベルを付けると、条件を満たす開いた Agent PR に付く ----

test('ラベルを付けると：bypass で乗る開いた Agent PR に auto-merge を付け、ダッシュボードに記録する。乗らない PR・人の PR・hold の PR には付けない', async () => {
  const w: DelegateWorld = {
    prs: [
      agentPr(5),
      agentPr(6),
      agentPr(7, { head: { ref: 'feature/x', sha: sha(7), repo: { full_name: 'o/r' } } }),
      agentPr(8, { labels: [{ name: LABELS.hold }] }),
    ],
    comments: { 5: [bypassAcceptance(91)], 6: [ineligibleAcceptance(92)], 7: [bypassAcceptance(93)], 8: [bypassAcceptance(94)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [bypassOn(minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('labeled', BYPASS, 'me', [BYPASS])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('bypass-merge'), kindsOn(fake, 5).join(','));
  assert.ok(!kindsOn(fake, 5).includes('human-review'));
  assert.deepEqual(kindsOn(fake, 6), [], '乗らない PR には何も書かない');
  assert.ok(!kindsOn(fake, 7).includes('bypass-merge'));
  assert.ok(!kindsOn(fake, 8).includes('bypass-merge'));
  assert.equal(countKind(fake, 1, 'bypass-merge-switch'), 1, kindsOn(fake, 1).join(','));
});

test('ラベルを付けても停止スイッチがあれば、auto-merge は付けず、ダッシュボードに記録する', async () => {
  const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [bypassAcceptance(91)] }, dashboardLabels: [BYPASS, STOP], dashboardEvents: [bypassOn(minutesAgo(1))] };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('labeled', BYPASS, 'me', [BYPASS, STOP])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), []);
  assert.ok(!kindsOn(fake, 5).includes('bypass-merge'));
  assert.equal(countKind(fake, 1, 'bypass-merge-switch'), 1);
});

test('App が付けたラベルでは bypass は有効にならず、auto-merge を付けない', async () => {
  const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [bypassAcceptance(91)] }, dashboardLabels: [BYPASS], dashboardEvents: [bypassOn(minutesAgo(1), APP)] };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('labeled', BYPASS, APP, [BYPASS])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), []);
  assert.ok(!kindsOn(fake, 5).includes('bypass-merge'));
});

// ---- AC4：ラベルを外す・停止スイッチで外れる ----

test('ラベルを外すと：bypass で付けた auto-merge を外し、merge-route を書き直し、bypass-merge-end（removed）と human-review を出す。autoEligible で付いた PR は外さない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 5: [bypassAcceptance(91), bypassArmed(92, sha(5), since)], 6: [autoAcceptance(93)] },
    dashboardLabels: [],
    dashboardEvents: [bypassOn(since), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', BYPASS, 'me', [])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5'], 'autoEligible の PR #6 は外さない');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('bypass-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  const end = postedRecord(fake, 'bypass-merge-end');
  assert.equal(end.version, 1);
  assert.equal(end.reason, 'removed');
  assert.equal(end.headSha, sha(5));
  const disableAt = fake.calls.findIndex((c) => c.path === '/graphql' && String(c.body?.query).includes('{disablePullRequestAutoMerge('));
  const routeAt = fake.calls.findLastIndex((c) => c.path.endsWith('/check-runs') && c.body.name === CHECKS.mergeRoute && c.body.head_sha === sha(5));
  assert.ok(disableAt >= 0 && routeAt > disableAt, 'auto-merge を外した後に merge-route を書き直す');
  assert.deepEqual(kindsOn(fake, 6), []);
  assert.equal(countKind(fake, 1, 'bypass-merge-switch'), 1);
});

test('ラベルを外したとき、bypass で付けた記録の無い PR・終わりの記録が最新の PR には何もしない', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5), agentPr(6)],
    comments: { 5: [bypassAcceptance(91)], 6: [bypassAcceptance(93), bypassArmed(94, sha(6), since), bypassEnded(95, sha(6), 'stopped')] },
    dashboardLabels: [],
    dashboardEvents: [bypassOn(since), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', BYPASS, 'me', [])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), []);
  assert.deepEqual(kindsOn(fake, 6), []);
});

test('ラベルを外すと、テストを弱める変更のある bypass の PR の agent/tests を neutral に書き直す', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bypassAcceptance(91, SKIP_DIFF), bypassArmed(92, sha(5), since, SKIP_DIFF)], 3: [planGate([CONFIG_FILE, 'a.test.ts'])] },
    files: { 5: [CONFIG_FILE, 'a.test.ts'] },
    diff: SKIP_DIFF,
    dashboardLabels: [],
    dashboardEvents: [bypassOn(since), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', BYPASS, 'me', [])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  assert.equal(checks(fake, CHECKS.tests, sha(5)).at(-1)?.conclusion, 'neutral');
});

test('停止スイッチを付けると：bypass で付けた auto-merge を外し、bypass-merge-end（stopped）と human-review を出す', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bypassAcceptance(91), bypassArmed(92, sha(5), since)] },
    dashboardLabels: [BYPASS, STOP],
    dashboardEvents: [bypassOn(since), ev('labeled', STOP, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('labeled', STOP, 'me', [BYPASS, STOP])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('bypass-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  assert.equal(postedRecord(fake, 'bypass-merge-end').reason, 'stopped');
});

test('停止スイッチを外して再開すると、bypass で乗る PR に auto-merge を付け直す', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5)],
    comments: { 5: [bypassAcceptance(91)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [bypassOn(hoursAgo(5)), ev('labeled', STOP, hoursAgo(1)), ev('unlabeled', STOP, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', STOP, 'me', [BYPASS])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('bypass-merge'), kindsOn(fake, 5).join(','));
});

test('agent:hold を外すと、bypass で乗る PR に auto-merge を付け直す', async () => {
  const w: DelegateWorld = { prs: [agentPr(5)], comments: { 5: [bypassAcceptance(91)] }, dashboardLabels: [BYPASS], dashboardEvents: [bypassOn()] };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'unlabeled', label: { name: LABELS.hold }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('bypass-merge'), kindsOn(fake, 5).join(','));
});

test('bypass で付けた後に新しい判定で bypass でも乗らなくなったら、auto-merge を外し bypass-merge-end（ineligible）と human-review を出す', async () => {
  const since = hoursAgo(5);
  const fake = verdictFake({
    dashboardLabels: [BYPASS], events: [bypassOn(since)], files: [CONFIG_FILE, 'docs/x.md'], planFiles: [CONFIG_FILE],
    pr: pr(ARMED), prComments: [bypassArmed(92, HEAD, since)],
  });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('disablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:bypass-merge-end'), w.join('\n'));
  assert.ok(w.includes('comment:human-review'), w.join('\n'));
  assert.equal(postedRecord(fake, 'bypass-merge-end').reason, 'ineligible');
});

// ---- 委任との引き継ぎ ----

test('委任と bypass が両方有効な間に委任のラベルを外すと、bypass で乗る PR は auto-merge が付いたまま、delegated-merge-end の後に bypass-merge を書き、human-review は出さない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bothAcceptance(91), delegateArmed(92, sha(5), since)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [bypassOn(hoursAgo(5)), delegateOn(since), delegateOff()],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', DELEGATE, 'me', [BYPASS])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('delegated-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('bypass-merge'), kinds.join(','));
  assert.ok(kinds.indexOf('delegated-merge-end') < kinds.lastIndexOf('bypass-merge'), `delegated-merge-end の後に bypass-merge: ${kinds.join(',')}`);
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.equal(checks(fake, CHECKS.mergeRoute, sha(5)).at(-1)?.conclusion, 'success');
});

test('委任と bypass が両方有効な間に、新しい判定で委任の条件を満たさなくなると、bypass で乗る PR は auto-merge が付いたまま、delegated-merge-end（ineligible）の後に bypass-merge を書く（委任に期限は無い）', async () => {
  const since = minutesAgo(30);
  const fake = verdictFake({
    dashboardLabels: [DELEGATE, BYPASS], events: [bypassOn(), delegateOn(since)],
    pr: pr(ARMED), prComments: [delegateArmed(92, HEAD, since)],
  });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('disablePullRequestAutoMerge'), `auto-merge は外さない: ${w.join('\n')}`);
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.equal(postedRecord(fake, 'delegated-merge-end').reason, 'ineligible');
  assert.ok(w.indexOf('comment:delegated-merge-end') < w.lastIndexOf('comment:bypass-merge'), `delegated-merge-end の後に bypass-merge: ${w.join(',')}`);
  assert.ok(!w.includes('comment:human-review'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, 'bypass モードの条件を満たしています');
});

test('委任と bypass が両方有効：委任を長く付けたままでも、定期実行は委任を終わらせず（期限なし）、委任で付けた auto-merge も記録も変えない', async () => {
  const since = hoursAgo(100);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bothAcceptance(91), delegateArmed(92, sha(5), since)] },
    dashboardLabels: [DELEGATE, BYPASS],
    dashboardEvents: [bypassOn(hoursAgo(101)), delegateOn(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.deepEqual(kindsOn(fake, 5), [], '委任の終わりも bypass への乗り換えも書かない');
  assert.ok(w.dashboardLabels.includes(DELEGATE), '委任のラベルは外さない（期限なし）');
  assert.ok(w.dashboardLabels.includes(BYPASS), 'bypass のラベルは外さない（期限なし）');
});

test('委任承認（計画のみ）と bypass が有効：Merge は委ねていないので、委任で乗りうる PR も bypass で乗せる（delegated-merge は書かない）', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE_PLAN, BYPASS], events: [bypassOn(), ev('labeled', DELEGATE_PLAN, minutesAgo(10))], files: [GUARDED] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:bypass-merge'), w.join('\n'));
  assert.ok(!w.includes('comment:delegated-merge'), w.join('\n'));
  assert.equal(checks(fake, CHECKS.mergeRoute).at(-1)?.title, 'bypass モードの条件を満たしています');
});

test('停止スイッチを付けると、委任で付けた auto-merge は delegated-merge-end（stopped）で外し、bypass に引き継がない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bothAcceptance(91), delegateArmed(92, sha(5), since)] },
    dashboardLabels: [DELEGATE, BYPASS, STOP],
    dashboardEvents: [bypassOn(), delegateOn(since), ev('labeled', STOP, minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('labeled', STOP, 'me', [DELEGATE, BYPASS, STOP])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  assert.equal(postedRecord(fake, 'delegated-merge-end').reason, 'stopped');
  assert.ok(!kindsOn(fake, 5).includes('bypass-merge'), kindsOn(fake, 5).join(','));
});

test('委任と bypass が両方有効な間に bypass のラベルを外すと、委任で乗る PR は auto-merge が付いたまま delegated-merge を書き、human-review は出さない', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bothAcceptance(91), bypassArmed(92, sha(5), hoursAgo(5))] },
    dashboardLabels: [DELEGATE],
    dashboardEvents: [bypassOn(hoursAgo(5)), delegateOn(minutesAgo(10)), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardEvent('unlabeled', BYPASS, 'me', [DELEGATE])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], 'auto-merge は外さない');
  assert.ok(w.prs[0]!.auto_merge, 'auto-merge が付いたまま');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('delegated-merge'), kinds.join(','));
  assert.ok(!kinds.includes('human-review'), kinds.join(','));
  assert.equal(checks(fake, CHECKS.mergeRoute, sha(5)).at(-1)?.conclusion, 'success');
});

// ---- 定期照合 ----

test('定期実行：bypass が有効なら、bypass で乗る PR の auto-merge を定期照合で外さない', async () => {
  const since = hoursAgo(50);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bypassAcceptance(91), bypassArmed(92, sha(5), since)] },
    dashboardLabels: [BYPASS],
    dashboardEvents: [bypassOn(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), []);
  assert.ok(w.dashboardLabels.includes(BYPASS), 'bypass のラベルは外さない（期限なし）');
});

test('定期実行：bypass のラベルが無ければ、bypass で付けた auto-merge も今までどおり外す', async () => {
  const since = hoursAgo(5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [bypassAcceptance(91), bypassArmed(92, sha(5), since)] },
    dashboardLabels: [],
    dashboardEvents: [bypassOn(since), bypassOff()],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
});

// ---- ダッシュボード ----

const MERGED_SECTION = 'bypass で Merge された PR';

function closedPr(n: number, mergedAt: string | null) {
  return pr({ number: n, node_id: `PR_${n}`, state: 'closed', title: `feat: closed ${n}`, html_url: `https://x/${n}`, merged_at: mergedAt, head: { ref: `claude/issue-${n}`, sha: String(n % 10).repeat(40), repo: { full_name: 'o/r' } } });
}

/** 閉じた PR：#8 だけが一覧に出る（bypass の記録が残ったまま staleHours 以内に Merge された） */
function closedWorld(dashboardLabels: string[], dashboardEvents: unknown[]): DelegateWorld {
  const since = hoursAgo(1.5);
  return {
    prs: [],
    closedPrs: [closedPr(8, hoursAgo(1)), closedPr(9, hoursAgo(1)), closedPr(10, hoursAgo(config.staleHours + 1)), closedPr(11, null), closedPr(12, hoursAgo(1))],
    comments: {
      8: [bypassAcceptance(81), bypassArmed(82, '8'.repeat(40), since)],
      9: [bypassAcceptance(91)],
      10: [bypassArmed(101, '0'.repeat(40), hoursAgo(config.staleHours + 2))],
      11: [bypassArmed(111, '1'.repeat(40), since)],
      12: [bypassArmed(121, '2'.repeat(40), since), bypassEnded(122, '2'.repeat(40), 'removed')],
    },
    dashboardLabels,
    dashboardEvents,
  };
}

function mergedSection(body: string): string {
  const start = body.indexOf(MERGED_SECTION);
  assert.ok(start >= 0, `「${MERGED_SECTION}」の節がありません\n${body}`);
  const next = body.indexOf('\n### ', start);
  return body.slice(start, next >= 0 ? next : undefined);
}

test('ダッシュボード：bypass が有効なら状態の行が「bypass モード: 有効」で、bypass で Merge された PR（staleHours 以内）を出す', async () => {
  const fake = delegateWorldFake(closedWorld([BYPASS], [bypassOn(hoursAgo(3))]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  const status = body.split('\n').filter((l) => l.startsWith('**bypass モード: '));
  assert.equal(status.length, 1, body);
  assert.ok(status[0]!.startsWith('**bypass モード: 有効**'), status[0]);
  const section = mergedSection(body);
  assert.match(section, /#8\b/);
  for (const n of [9, 10, 11, 12]) assert.doesNotMatch(section, new RegExp(`#${n}\\b`), `#${n} は出さない`);
});

test('ダッシュボード：ラベルが無ければ状態の行は「bypass モード: 無効」、ラベルを外した後でも staleHours 以内に bypass で Merge された PR は出る', async () => {
  const fake = delegateWorldFake(closedWorld([], [bypassOn(hoursAgo(3)), bypassOff(hoursAgo(0.5))]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  const status = body.split('\n').filter((l) => l.startsWith('**bypass モード: '));
  assert.equal(status.length, 1, body);
  assert.ok(status[0]!.startsWith('**bypass モード: 無効**'), status[0]);
  assert.match(mergedSection(body), /#8\b/);
});

test('ダッシュボード：停止スイッチがあれば bypass のラベルがあっても状態の行は「bypass モード: 無効」', async () => {
  const fake = delegateWorldFake(closedWorld([BYPASS, STOP], [bypassOn(hoursAgo(3))]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const status = dashboardBody(fake).split('\n').filter((l) => l.startsWith('**bypass モード: '));
  assert.equal(status.length, 1);
  assert.ok(status[0]!.startsWith('**bypass モード: 無効**'), status[0]);
});
