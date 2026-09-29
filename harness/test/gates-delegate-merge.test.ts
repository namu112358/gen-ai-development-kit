// 委任 Merge のゲートの動作（判定の受け付け・ダッシュボードのラベルの付け外し・agent/tests）を、偽の GitHub への書き込みで確かめる（Issue #212）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { CHECKS, delegateMergeConfig, LABELS } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { onComment } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { APP, DIFF, HEAD, acceptanceFake, config, ctxFor, delegateWorldFake, pr, verdict, verdictEvent, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, countCalls, postedBodies, postedRecord } from './support/stack-fixtures.ts';

const D = delegateMergeConfig(config);
const LABEL = D.label;
const GUARDED = 'harness/lib/plan.ts';
const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const untilOf = (since: string): string => new Date(Date.parse(since) + D.hours * 3600_000).toISOString();
const labeledBy = (at: string, login = 'me') => ({ event: 'labeled', created_at: at, actor: { login }, label: { name: LABEL } });
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートを通った計画（files 指定） */
const planGate = (files: string[]) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } })}`,
});

/** 判定の受け付け（onComment）用。変更ファイルと計画の files は同じ（範囲内）。既定はガードレールに触れる harness/lib/plan.ts */
function verdictFake(o: { dashboardLabels: string[]; events?: unknown[]; files?: string[]; pr?: ReturnType<typeof pr>; diff?: string; prComments?: unknown[] }): FakeGitHub {
  const files = o.files ?? [GUARDED];
  const fake = acceptanceFake({ pr: o.pr ?? pr(), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments: o.prComments ?? [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })));
  if (o.diff) fake.on('GET', /\/compare\//, (_m, _b, opts) => (opts.raw ? o.diff : { behind_by: 0 }));
  return fake;
}

async function accept(fake: FakeGitHub, v = critical()): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v))));
}

/** 書いたチェック（名前指定、sha を渡せばその head のものだけ） */
function checks(fake: FakeGitHub, name: string, sha?: string): { conclusion: string; title: string; sha: string }[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith('/check-runs') && c.body.name === name && (sha === undefined || c.body.head_sha === sha))
    .map((c) => ({ conclusion: c.body.conclusion, title: String(c.body.output?.title ?? ''), sha: c.body.head_sha }));
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

function bodiesOn(fake: FakeGitHub, issue: number, kind?: string): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${issue}/comments`) && (kind === undefined || String(c.body.body).includes(appMark(kind))))
    .map((c) => String(c.body.body));
}

// ---- 受け付けの記録と App の記録（開いた PR のコメント） ----

const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };

/** 委任なら自動経路に乗せてよい受け付け（ガードレール・critical で autoEligible は偽） */
const delegatedAcceptance = (id: number, diff = DIFF) =>
  acceptanceComment(id, { patchId: patchId(diff), riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK });

/** 委任でも乗せない受け付け（delegateMergeExclude に当たる） */
const excludedAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: ['ガードレールに触れます（人が Merge する）: harness/gates/run.ts'], delegate: { ...DELEGATE_OK, eligible: false, reasons: ['委任しないパスに触れます（delegateMergeExclude）: harness/gates/run.ts'], exclude: ['harness/gates/run.ts'] } });

/** 自動 Merge の条件を満たす受け付け（low） */
const autoAcceptance = (id: number) => acceptanceComment(id, { autoEligible: true, reasons: [], delegate: DELEGATE_OK });

/** 委任で auto-merge を付けた App の記録（kind=delegated-merge） */
const armedRecord = (id: number, headSha: string, since: string, diff = DIFF) =>
  appRecordComment(id, 'delegated-merge', '委任 Merge で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(diff), since, until: untilOf(since), by: 'me', skipped: DELEGATE_OK.skipped });

/** 開いた Agent PR（番号ごとに head・node_id を変える） */
const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, head: { ref: `claude/issue-${n}`, sha: String(n).repeat(40), repo: { full_name: 'o/r' } }, ...patch });

/** ダッシュボード（#1）へのラベルの付け外しのイベント */
const switchEvent = (action: 'labeled' | 'unlabeled', sender: string, labels: string[]) => ({
  action,
  issue: { number: 1, title: config.dashboardIssueTitle, body: '', labels: labels.map((name) => ({ name })), state: 'open' },
  label: { name: LABEL },
  sender: { login: sender },
});

// ---- AC1：委任が有効なら、ガードレール・critical の PR にも auto-merge を付ける ----

test('委任が有効：ガードレールに触れ Risk が critical の PR を受け付けると、記録を書いてから auto-merge を付け、merge-route は success、human-review は出さない', async () => {
  const since = minutesAgo(10);
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(w.includes('comment:delegated-merge'), w.join('\n'));
  assert.ok(w.indexOf('comment:delegated-merge') < w.indexOf('enablePullRequestAutoMerge'), 'auto-merge を付ける前に記録を書く');
  assert.ok(!w.includes('comment:human-review'), '委任で乗せるときは人にレビューを依頼しない');
  const route = checks(fake, CHECKS.mergeRoute).at(-1);
  assert.equal(route?.conclusion, 'success');
  assert.equal(route?.title, '委任 Merge の条件を満たしています');

  const rec = postedRecord(fake, 'delegated-merge');
  assert.equal(rec.version, 1);
  assert.equal(rec.headSha, HEAD);
  assert.equal(rec.patchId, patchId(DIFF));
  assert.equal(rec.by, 'me');
  assert.equal(Date.parse(rec.since), Date.parse(since));
  assert.equal(Date.parse(rec.until), Date.parse(untilOf(since)));
  assert.ok((rec.skipped as string[]).some((s) => s.includes('ガードレール')), JSON.stringify(rec.skipped));
  const body = postedBodies(fake, 'delegated-merge').at(-1)!;
  assert.match(body, /委任 Merge/);
  assert.match(body, /ガードレール/, '飛ばした理由を本文に載せる');
});

test('委任が有効：同じ差分・同じ期限の delegated-merge の記録が最新なら、記録を書き足さずに auto-merge を付ける', async () => {
  const since = minutesAgo(10);
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(since)], prComments: [armedRecord(92, HEAD, since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'), w.join('\n'));
});

// ---- AC2：残りが短い・ラベル無し・停止スイッチ・agent:hold・委任の対象外では付けない ----

test('委任の期限までの残りが minRemainingMinutes 未満なら auto-merge を付けず、human-review に残りが短いことを書く', async () => {
  const since = minutesAgo(D.hours * 60 - (D.minRemainingMinutes - 10));
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(since)] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'), w.join('\n'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
  assert.match(postedBodies(fake, 'human-review').at(-1)!, /残り/);
});

test('ダッシュボードに委任のラベルが無ければ今までどおり Human Merge（timeline も読まない）', async () => {
  const fake = verdictFake({ dashboardLabels: [], events: [labeledBy(minutesAgo(10))] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0, 'ラベルが無ければ timeline を読まない');
});

test('停止スイッチが付いていれば、委任のラベルが期限内でも auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [LABEL, config.autoMergeStopLabel], events: [labeledBy(minutesAgo(10))] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
});

test('PR に agent:hold があれば、委任が有効でも auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(minutesAgo(10))], pr: pr({ labels: [{ name: LABELS.hold }] }) });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
});

test('委任の期限を過ぎていれば（ラベルが残っていても）auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(minutesAgo(D.hours * 60 + 5))] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
});

test('委任しないパス（delegateMergeExclude）に触れる PR は、委任が有効でも auto-merge を付けない', async () => {
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(minutesAgo(10))], files: ['harness/gates/run.ts'] });
  await accept(fake);
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:delegated-merge'));
  assert.ok(w.includes('comment:human-review'));
});

// ---- AC3：ダッシュボードのラベルを付けると付き、外すと外れる ----

test('ラベルを付けると：条件を満たす開いた PR に auto-merge を付け、ダッシュボードに有効にしたことを書く（対象外の PR には付けない）', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5), agentPr(6)],
    comments: { 5: [delegatedAcceptance(91)], 6: [excludedAcceptance(92)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('labeled', 'me', [LABEL])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), ['PR_5']);
  assert.ok(kindsOn(fake, 5).includes('delegated-merge'), kindsOn(fake, 5).join(','));
  assert.ok(!kindsOn(fake, 5).includes('human-review'));
  assert.deepEqual(kindsOn(fake, 6), [], '対象外の PR には何も書かない');
  const switched = bodiesOn(fake, 1, 'delegate-merge-switch');
  assert.equal(switched.length, 1, kindsOn(fake, 1).join(','));
  assert.match(switched[0]!, /有効/);
  assert.match(switched[0]!, /@me/);
});

test('ラベルを付けたとき、条件を満たす PR が複数あってもダッシュボードの timeline は1回だけ読む', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5), agentPr(6)],
    comments: { 5: [delegatedAcceptance(91)], 6: [delegatedAcceptance(92)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('labeled', 'me', [LABEL])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge').sort(), ['PR_5', 'PR_6']);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 1);
});

test('ラベルを付けても委任が有効にならない（停止スイッチ）なら、理由をダッシュボードに書き、auto-merge は付けない', async () => {
  const w: DelegateWorld = {
    prs: [agentPr(5)],
    comments: { 5: [delegatedAcceptance(91)] },
    dashboardLabels: [LABEL, config.autoMergeStopLabel],
    dashboardEvents: [labeledBy(minutesAgo(1))],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('labeled', 'me', [LABEL, config.autoMergeStopLabel])));
  assert.deepEqual(mutationIds(fake, 'enablePullRequestAutoMerge'), []);
  assert.ok(!kindsOn(fake, 5).includes('delegated-merge'));
  const switched = bodiesOn(fake, 1, 'delegate-merge-switch');
  assert.equal(switched.length, 1);
  assert.match(switched[0]!, /停止スイッチ/);
});

test('ラベルを外すと：委任で付けた PR の auto-merge を外し、merge-route を書き直し、終わりの記録と human-review を出す。autoEligible で付いた PR は外さない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, { auto_merge: { enabled: true } }), agentPr(6, { auto_merge: { enabled: true } })],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)], 6: [autoAcceptance(93)] },
    dashboardLabels: [],
    dashboardEvents: [labeledBy(since), { event: 'unlabeled', created_at: minutesAgo(1), actor: { login: 'me' }, label: { name: LABEL } }],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('unlabeled', 'me', [])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5'], 'autoEligible の PR #6 は外さない');
  const kinds = kindsOn(fake, 5);
  assert.ok(kinds.includes('delegated-merge-end'), kinds.join(','));
  assert.ok(kinds.includes('human-review'), kinds.join(','));
  assert.equal(postedRecord(fake, 'delegated-merge-end').reason, 'removed');
  assert.equal(postedRecord(fake, 'delegated-merge-end').headSha, '5'.repeat(40));
  // auto-merge を外した後に merge-route を書き直す
  const disableAt = fake.calls.findIndex((c) => c.path === '/graphql' && String(c.body?.query).includes('{disablePullRequestAutoMerge('));
  const routeAt = fake.calls.findLastIndex((c) => c.path.endsWith('/check-runs') && c.body.name === CHECKS.mergeRoute && c.body.head_sha === '5'.repeat(40));
  assert.ok(disableAt >= 0 && routeAt > disableAt, 'auto-merge を外した後に merge-route を書き直す');
  assert.deepEqual(kindsOn(fake, 6), []);
  const switched = bodiesOn(fake, 1, 'delegate-merge-switch');
  assert.equal(switched.length, 1);
  assert.match(switched[0]!, /@me/);
});

test('App が外した（期限切れ）ラベルの unlabeled では、ダッシュボードにコメントしない', async () => {
  const since = minutesAgo(D.hours * 60 + 10);
  const w: DelegateWorld = {
    prs: [agentPr(5)],
    comments: { 5: [delegatedAcceptance(91)] },
    dashboardLabels: [],
    dashboardEvents: [labeledBy(since), { event: 'unlabeled', created_at: minutesAgo(1), actor: { login: APP }, label: { name: LABEL } }],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('unlabeled', APP, [])));
  assert.deepEqual(kindsOn(fake, 1), []);
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
});

// ---- AC5：委任で乗る PR のテストの改ざんは agent/tests を failure にする ----

test('委任で自動経路に乗る PR でテストを弱める変更があると、agent/tests は failure（neutral にしない）', async () => {
  const files = [GUARDED, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [LABEL], events: [labeledBy(minutesAgo(10))], files, diff: SKIP_DIFF });
  await accept(fake);
  const tests = checks(fake, CHECKS.tests);
  assert.ok(tests.length > 0, 'agent/tests を書いていません');
  assert.ok(tests.every((t) => t.conclusion === 'failure'), JSON.stringify(tests));
});

test('委任が無ければ、ガードレールに触れる PR のテストの変更は今までどおり neutral（Human Merge）', async () => {
  const files = [GUARDED, 'a.test.ts'];
  const fake = verdictFake({ dashboardLabels: [], files, diff: SKIP_DIFF });
  await accept(fake);
  assert.equal(checks(fake, CHECKS.tests).at(-1)?.conclusion, 'neutral');
});

test('委任が終わると（ラベルを外す）、テストを弱める変更のある PR の agent/tests を neutral に書き直す', async () => {
  const since = minutesAgo(30);
  const sha = '5'.repeat(40);
  const w: DelegateWorld = {
    prs: [agentPr(5, { auto_merge: { enabled: true } })],
    comments: { 5: [delegatedAcceptance(91, SKIP_DIFF), armedRecord(92, sha, since, SKIP_DIFF)], 3: [planGate([GUARDED, 'a.test.ts'])] },
    files: { 5: [GUARDED, 'a.test.ts'] },
    diff: SKIP_DIFF,
    dashboardLabels: [],
    dashboardEvents: [labeledBy(since), { event: 'unlabeled', created_at: minutesAgo(1), actor: { login: 'me' }, label: { name: LABEL } }],
  };
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', switchEvent('unlabeled', 'me', [])));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
  assert.equal(checks(fake, CHECKS.tests, sha).at(-1)?.conclusion, 'neutral');
});

// ---- gate.yml：ラベルの付け外しでゲートが起動する ----

test('gate.yml：Issue の項に委任 Merge のラベルがあり、設定のラベル名と同じ', () => {
  const yml = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'gate.yml'), 'utf8');
  const start = yml.indexOf("(github.event_name != 'issues' ||");
  const end = yml.indexOf("(github.event_name != 'pull_request_target' ||");
  assert.ok(start >= 0 && end > start, 'gate.yml の Issue の項が読めません');
  const issues = yml.slice(start, end);
  assert.ok(issues.includes("github.event.label.name == 'agent:delegate-merge'"), issues);
  assert.equal(LABEL, 'agent:delegate-merge', 'gate.yml のラベル名と設定（delegateMerge.label）をそろえる');
});
