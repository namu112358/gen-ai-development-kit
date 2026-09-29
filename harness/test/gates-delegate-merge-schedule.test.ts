// 委任承認に期限が無いこと（定期実行・PR のイベントでラベルも auto-merge も外さない）と、ダッシュボードの委任承認の状態と一覧を確かめる（Issue #212・#241）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchId } from '../lib/patch-id.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { onSchedule } from '../gates/stale.ts';
import { DELEGATE, DIFF, config, ctxFor, delegateLabeled, delegateStatusLine, delegateUnlabeled, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, countCalls } from './support/stack-fixtures.ts';

const MERGE = DELEGATE.mergeLabel;
const PLAN = DELEGATE.planLabel;
const GUARDED = 'harness/lib/plan.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const labeledBy = (at: string, login = 'me', label = MERGE) => delegateLabeled(label, at, login);

const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };

/** 委任なら自動経路に乗せてよい受け付け（ガードレール・critical で autoEligible は偽） */
const delegatedAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK });

/** 委任で auto-merge を付けた App の記録（kind=delegated-merge。期限は無いので until は null） */
const armedRecord = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'delegated-merge', '委任承認で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, until: null, by: 'me', skipped: DELEGATE_OK.skipped });

/** 委任が終わった App の記録（kind=delegated-merge-end） */
const endRecord = (id: number, headSha: string, reason: string) =>
  appRecordComment(id, 'delegated-merge-end', '委任承認が終わりました。', { version: 1, headSha, reason });

const agentPr = (n: number, patch: Record<string, unknown> = {}) =>
  pr({ number: n, node_id: `PR_${n}`, draft: false, head: { ref: `claude/issue-${n}`, sha: String(n).repeat(40), repo: { full_name: 'o/r' } }, ...patch });

const ARMED = { auto_merge: { enabled: true } };

function mutationIds(fake: FakeGitHub, name: string): string[] {
  return fake.calls.filter((c) => c.path === '/graphql' && String(c.body?.query).includes(`{${name}(`)).map((c) => String(c.body.variables?.id));
}

function kindsOn(fake: FakeGitHub, issue: number, calls = fake.calls): string[] {
  return calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${issue}/comments`))
    .map((c) => String(c.body.body).match(/kind=([\w-]+)/)?.[1] ?? '?');
}

function dashboardBody(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  return String(patch.body.body);
}

/** ダッシュボードの委任のラベルを App が外した呼び出し */
const labelRemovals = (fake: FakeGitHub): string[] =>
  fake.calls.filter((c) => c.method === 'DELETE' && /\/issues\/1\/labels\//.test(c.path)).map((c) => decodeURIComponent(c.path.split('/labels/')[1]!));

// ---- 期限は無い ----

test('定期実行：1000 時間前に付けた agent:delegate-merge でも、ラベルを外さず、委任で付けた auto-merge も外さない', async () => {
  const since = hoursAgo(1000);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [MERGE],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), [], '終わりの記録も human-review も auto-merge-removed も出さない');
  assert.deepEqual(labelRemovals(fake), [], 'App はダッシュボードのラベルを外さない');
  assert.ok(w.dashboardLabels.includes(MERGE));
  assert.deepEqual(kindsOn(fake, 1), [], 'ダッシュボードにコメントしない（期限切れの知らせは無い）');
});

test('定期実行：1000 時間前に付けた agent:delegate-plan も外さない', async () => {
  const since = hoursAgo(1000);
  const w: DelegateWorld = { prs: [], dashboardLabels: [PLAN], dashboardEvents: [labeledBy(since, 'me', PLAN)] };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(labelRemovals(fake), []);
  assert.ok(w.dashboardLabels.includes(PLAN));
});

test('定期実行：委任（計画＋Merge）が有効で delegate.eligible の PR の auto-merge は、定期照合でも外さない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [MERGE],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), []);
});

test('定期実行：agent:delegate-plan だけなら委任 Merge は無効で、委任で付けた auto-merge は定期照合で外す', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [PLAN],
    dashboardEvents: [labeledBy(since, 'me', PLAN)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
});

test('定期実行：委任のラベルが無ければ、委任で付けた auto-merge も今までどおり外す', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [],
    dashboardEvents: [labeledBy(since), delegateUnlabeled(MERGE, minutesAgo(5))],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
});

// ---- PR のイベント ----

test('PR のイベント：synchronize は自分の auto-merge だけを外し、1000 時間前の委任で付けたほかの PR の auto-merge は外さない', async () => {
  const since = hoursAgo(1000);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 6: [delegatedAcceptance(93), armedRecord(94, '6'.repeat(40), since)] },
    dashboardLabels: [MERGE],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.ok(!mutationIds(fake, 'disablePullRequestAutoMerge').includes('PR_6'), mutationIds(fake, 'disablePullRequestAutoMerge').join(','));
  assert.ok(!kindsOn(fake, 6).includes('delegated-merge-end'), kindsOn(fake, 6).join(','));
  assert.deepEqual(labelRemovals(fake), []);
});

test('PR のイベント：ダッシュボードに委任のラベルが無ければ、timeline も開いた PR の一覧も読まない', async () => {
  const w: DelegateWorld = { prs: [agentPr(5, ARMED)], dashboardLabels: [] };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls'), 0);
});

// ---- ダッシュボード ----

const MERGED_SECTION = '委任承認で Merge された PR';

function closedPr(n: number, mergedAt: string | null) {
  return pr({ number: n, node_id: `PR_${n}`, state: 'closed', title: `feat: closed ${n}`, html_url: `https://x/${n}`, merged_at: mergedAt, head: { ref: `claude/issue-${n}`, sha: String(n % 10).repeat(40), repo: { full_name: 'o/r' } } });
}

/** 閉じた PR：#8 だけが一覧に出る（委任の記録が残ったまま staleHours 以内に Merge された） */
function closedWorld(dashboardLabels: string[], dashboardEvents: unknown[]): DelegateWorld {
  const since = hoursAgo(1.5);
  return {
    prs: [],
    closedPrs: [
      closedPr(8, hoursAgo(1)),
      closedPr(9, hoursAgo(1)),
      closedPr(10, hoursAgo(config.staleHours + 1)),
      closedPr(11, null),
      closedPr(12, hoursAgo(1)),
    ],
    comments: {
      8: [delegatedAcceptance(81), armedRecord(82, '8'.repeat(40), since)],
      9: [delegatedAcceptance(91)],
      10: [armedRecord(101, '0'.repeat(40), hoursAgo(config.staleHours + 2))],
      11: [armedRecord(111, '1'.repeat(40), since)],
      12: [armedRecord(121, '2'.repeat(40), since), endRecord(122, '2'.repeat(40), 'removed')],
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

async function statusFor(labels: string[], events: unknown[]): Promise<string> {
  const fake = delegateWorldFake({ prs: [], dashboardLabels: labels, dashboardEvents: events });
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  const line = delegateStatusLine(body);
  assert.ok(line, `委任承認の状態の行がありません\n${body}`);
  return line;
}

test('ダッシュボード：agent:delegate-merge が有効なら状態の行は「**委任承認: 計画＋Merge**」（付けた人を書き、期限は書かない）', async () => {
  const line = await statusFor([MERGE], [labeledBy(hoursAgo(1000))]);
  assert.ok(line.includes('**委任承認: 計画＋Merge**'), line);
  assert.ok(line.includes('@me'), line);
  assert.ok(!line.includes('期限'), line);
});

test('ダッシュボード：agent:delegate-plan だけが有効なら状態の行は「**委任承認: 計画のみ**」', async () => {
  const line = await statusFor([PLAN], [labeledBy(minutesAgo(30), 'me', PLAN)]);
  assert.ok(line.includes('**委任承認: 計画のみ**'), line);
  assert.ok(line.includes('@me'), line);
});

test('ダッシュボード：どちらも有効でなければ状態の行は「**委任承認: 無効**」（ラベルなし・停止スイッチ・Bot が付けた）', async () => {
  const cases: [string, string[], unknown[]][] = [
    ['ラベルなし', [], []],
    ['停止スイッチ', [MERGE, config.autoMergeStopLabel], [labeledBy(minutesAgo(30))]],
    ['停止スイッチ（計画のみ）', [PLAN, config.autoMergeStopLabel], [labeledBy(minutesAgo(30), 'me', PLAN)]],
    ['Bot が付けた', [MERGE], [labeledBy(minutesAgo(30), 'someone[bot]')]],
  ];
  for (const [name, labels, events] of cases) {
    const line = await statusFor(labels, events);
    assert.ok(line.includes('**委任承認: 無効**'), `${name}: ${line}`);
  }
});

test('ダッシュボード：委任承認で Merge された PR（staleHours 以内）を出す', async () => {
  const fake = delegateWorldFake(closedWorld([MERGE], [labeledBy(minutesAgo(30))]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const section = mergedSection(dashboardBody(fake));
  assert.match(section, /#8\b/);
  for (const n of [9, 10, 11, 12]) assert.doesNotMatch(section, new RegExp(`#${n}\\b`), `#${n} は出さない`);
});

test('ダッシュボード：ラベルを外した後でも、staleHours 以内に委任で Merge された PR は一覧に出る（状態は無効）', async () => {
  const since = hoursAgo(1.5);
  const fake = delegateWorldFake(closedWorld([], [labeledBy(since), delegateUnlabeled(MERGE, hoursAgo(0.5))]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  assert.ok(delegateStatusLine(body)?.includes('**委任承認: 無効**'), body);
  assert.match(mergedSection(body), /#8\b/);
});

test('ダッシュボード：閉じた PR の一覧が読めなくても、「読めませんでした」と書いて更新は続ける', async () => {
  const fake = delegateWorldFake(closedWorld([], []));
  fake.on('GET', /\/pulls\?state=closed/, () => {
    throw new Error('HTTP 502');
  });
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.match(mergedSection(dashboardBody(fake)), /読めませんでした/);
});
