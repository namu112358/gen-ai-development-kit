// 委任 Merge の期限切れの掃除（定期実行・PR のイベント）と、ダッシュボードの委任 Merge の状態と一覧を確かめる（Issue #212）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark } from '../lib/blocks.ts';
import { delegateMergeConfig } from '../lib/config.ts';
import { patchId } from '../lib/patch-id.ts';
import { onIssue } from '../gates/on-issue.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { onSchedule } from '../gates/stale.ts';
import { APP, DIFF, config, ctxFor, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { acceptanceComment, appRecordComment, countCalls, postedRecord } from './support/stack-fixtures.ts';

const D = delegateMergeConfig(config);
const LABEL = D.label;
const GUARDED = 'harness/lib/plan.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number): string => minutesAgo(h * 60);
const untilOf = (since: string): string => new Date(Date.parse(since) + D.hours * 3600_000).toISOString();
const labeledBy = (at: string, login = 'me') => ({ event: 'labeled', created_at: at, actor: { login }, label: { name: LABEL } });

const DELEGATE_OK = { eligible: true, reasons: [], skipped: [`ガードレールに触れます: ${GUARDED}`, 'Risk が critical です'], scopeOk: true, outside: [], exclude: [] };

/** 委任なら自動経路に乗せてよい受け付け（ガードレール・critical で autoEligible は偽） */
const delegatedAcceptance = (id: number) =>
  acceptanceComment(id, { riskLevel: 'critical', riskOk: false, autoEligible: false, reasons: [`ガードレールに触れます（人が Merge する）: ${GUARDED}`], delegate: DELEGATE_OK });

/** 自動 Merge の条件を満たす受け付け（low） */
const autoAcceptance = (id: number) => acceptanceComment(id, { autoEligible: true, reasons: [], delegate: DELEGATE_OK });

/** 委任で auto-merge を付けた App の記録（kind=delegated-merge） */
const armedRecord = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'delegated-merge', '委任 Merge で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, until: untilOf(since), by: 'me', skipped: DELEGATE_OK.skipped });

/** 委任が終わった App の記録（kind=delegated-merge-end） */
const endRecord = (id: number, headSha: string, reason: string) =>
  appRecordComment(id, 'delegated-merge-end', '委任 Merge が終わりました。', { version: 1, headSha, reason });

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

// ---- AC4：期限切れ ----

test('定期実行：期限を過ぎた委任は、先に委任で付けた auto-merge を外して終わりの記録を書き、その後でラベルを外してダッシュボードに書く', async () => {
  const since = hoursAgo(D.hours + 0.5);
  const sha5 = '5'.repeat(40);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, sha5, since)], 6: [autoAcceptance(93)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());

  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5'], 'autoEligible の PR #6 は外さない。#5 は1回だけ');
  const k5 = kindsOn(fake, 5);
  assert.ok(k5.includes('delegated-merge-end'), k5.join(','));
  assert.ok(k5.includes('human-review'), k5.join(','));
  assert.ok(!k5.includes('auto-merge-removed'), '期限切れの掃除の後に定期照合で二重に外さない');
  const end = postedRecord(fake, 'delegated-merge-end');
  assert.equal(end.reason, 'expired');
  assert.equal(end.headSha, sha5);
  assert.ok(!w.dashboardLabels.includes(LABEL), 'ラベルを外す');

  const at = (pred: (c: FakeGitHub['calls'][number]) => boolean) => fake.calls.findIndex(pred);
  const disableAt = at((c) => c.path === '/graphql' && String(c.body?.query).includes('{disablePullRequestAutoMerge('));
  const endAt = at((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments') && String(c.body.body).includes(appMark('delegated-merge-end')));
  const removeAt = at((c) => c.method === 'DELETE' && decodeURIComponent(c.path).endsWith(`/issues/1/labels/${LABEL}`));
  const noteAt = at((c) => c.method === 'POST' && c.path.endsWith('/issues/1/comments'));
  assert.ok(disableAt >= 0 && endAt > disableAt, 'auto-merge を外してから終わりの記録を書く');
  assert.ok(removeAt > endAt, '掃除の後でラベルを外す');
  assert.ok(noteAt > removeAt, 'ラベルを外せた後でダッシュボードに書く');
  assert.match(String(fake.calls[noteAt]!.body.body), /期限/);

  // 続けて、App が外したことによる unlabeled でゲートがもう一度起動しても、掃除済みの PR には何もしない
  const before = fake.calls.length;
  await onIssue(ctxFor(fake, 'issues', {
    action: 'unlabeled',
    issue: { number: 1, title: config.dashboardIssueTitle, body: '', labels: [], state: 'open' },
    label: { name: LABEL },
    sender: { login: APP },
  }));
  const again = fake.calls.slice(before);
  assert.deepEqual(kindsOn(fake, 5, again), [], '終わりの記録（removed）も human-review も二度出さない');
  assert.deepEqual(kindsOn(fake, 1, again), [], 'App が外したときはダッシュボードにコメントしない');
  assert.ok(!again.some((c) => c.path === '/graphql' && String(c.body?.query).includes('{disablePullRequestAutoMerge(')));
});

test('定期実行：委任が有効で delegate.eligible の PR の auto-merge は、定期照合でも外さない', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), []);
  assert.deepEqual(kindsOn(fake, 5), []);
  assert.ok(w.dashboardLabels.includes(LABEL), '期限内のラベルは外さない');
});

test('定期実行：委任で付けた後に今の差分が自動 Merge の対象（autoEligible）になった PR は、期限切れでも auto-merge を残す', async () => {
  const since = hoursAgo(D.hours + 0.5);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [armedRecord(92, '5'.repeat(40), since), autoAcceptance(93)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), [], '委任に頼っていない auto-merge は外さない');
  assert.deepEqual(kindsOn(fake, 5), [], '終わりの記録も human-review も出さない');
  assert.ok(!w.dashboardLabels.includes(LABEL), '期限切れのラベルは外す');
});

test('定期実行：委任のラベルが無ければ、委任で付けた auto-merge も今までどおり外す', async () => {
  const since = minutesAgo(30);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED)],
    comments: { 5: [delegatedAcceptance(91), armedRecord(92, '5'.repeat(40), since)] },
    dashboardLabels: [],
    dashboardEvents: [labeledBy(since), { event: 'unlabeled', created_at: minutesAgo(5), actor: { login: 'me' }, label: { name: LABEL } }],
  };
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge'), ['PR_5']);
});

// ---- PR のイベントでの掃除 ----

test('PR のイベント：synchronize の auto-merge の解除の直後に、記録の期限を過ぎたほかの PR の auto-merge を外す', async () => {
  const since = hoursAgo(D.hours + 0.2);
  const w: DelegateWorld = {
    prs: [agentPr(5, ARMED), agentPr(6, ARMED)],
    comments: { 6: [delegatedAcceptance(93), armedRecord(94, '6'.repeat(40), since)] },
    dashboardLabels: [LABEL],
    dashboardEvents: [labeledBy(since)],
  };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.deepEqual(mutationIds(fake, 'disablePullRequestAutoMerge').slice(0, 2), ['PR_5', 'PR_6'], 'synchronize の PR を先に、その後で期限切れの PR');
  assert.ok(kindsOn(fake, 6).includes('delegated-merge-end'), kindsOn(fake, 6).join(','));
  assert.equal(postedRecord(fake, 'delegated-merge-end').reason, 'expired');
});

test('PR のイベント：ダッシュボードに委任のラベルが無ければ、timeline も開いた PR の一覧も読まない', async () => {
  const w: DelegateWorld = { prs: [agentPr(5, ARMED)], dashboardLabels: [] };
  const fake = delegateWorldFake(w);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/pulls'), 0);
});

// ---- AC6：ダッシュボード ----

const MERGED_SECTION = '委任 Merge で Merge された PR';

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

test('ダッシュボード：委任 Merge の状態（期限・付けた人）と、委任で Merge された PR（staleHours 以内）を出す', async () => {
  const since = minutesAgo(30);
  const fake = delegateWorldFake(closedWorld([LABEL], [labeledBy(since)]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  const status = body.split('\n').find((l) => l.includes('委任 Merge') && !l.includes(MERGED_SECTION));
  assert.ok(status, `委任 Merge の状態の行がありません\n${body}`);
  assert.match(status, /有効/);
  assert.ok(status.includes(untilOf(since)), `期限（${untilOf(since)}）が状態の行にありません: ${status}`);
  assert.ok(status.includes('@me'), status);
  const section = mergedSection(body);
  assert.match(section, /#8\b/);
  for (const n of [9, 10, 11, 12]) assert.doesNotMatch(section, new RegExp(`#${n}\\b`), `#${n} は出さない`);
});

test('ダッシュボード：ラベルを外した後でも、staleHours 以内に委任で Merge された PR は一覧に出る（状態は無効）', async () => {
  const since = hoursAgo(1.5);
  const fake = delegateWorldFake(closedWorld([], [labeledBy(since), { event: 'unlabeled', created_at: hoursAgo(0.5), actor: { login: 'me' }, label: { name: LABEL } }]));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const body = dashboardBody(fake);
  const status = body.split('\n').find((l) => l.includes('委任 Merge') && !l.includes(MERGED_SECTION));
  assert.ok(status, body);
  assert.match(status, /無効/);
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
