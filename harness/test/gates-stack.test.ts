import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { reasonMark } from '../lib/config.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { onSchedule } from '../gates/stale.ts';
import { APP, HEAD, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import {
  BLOCKED, FEATURE_BASE, STACK, acceptanceComment, baseResolvedRecord, blockedLabeledBy, blockedUnlabeledBy, countCalls, fixLimitComment,
  orphanPr, orphanRecord, postedBodies, postedRecord, scheduleStackFake, stackFake, stackedPr,
} from './support/stack-fixtures.ts';

const prEvent = (action: string, extra: Record<string, unknown> = {}) => ({ action, pull_request: { number: 5 }, sender: { login: 'me' }, ...extra });
const baseChanged = { changes: { base: { ref: { from: 'main' }, sha: { from: 'b'.repeat(40) } } } };
const humanHead = { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } };
const forkHead = { ref: 'claude/x', sha: HEAD, repo: { full_name: 'evil/r' } };

const runPr = async (fake: FakeGitHub, action: string, extra: Record<string, unknown> = {}) => {
  await onPullRequest(ctxFor(fake, 'pull_request_target', prEvent(action, extra)));
  return fake.writes();
};
const runSchedule = (fake: FakeGitHub) => onSchedule(ctxFor(fake, 'schedule', {}), new Date('2026-09-27T01:00:00Z'));
const before = (w: string[], a: string, b: string) => assert.ok(w.indexOf(a) >= 0 && w.indexOf(a) < w.indexOf(b), `${a} → ${b} の順ではありません: ${w.join(' / ')}`);

// ---- orphan-base：Draft に戻して止める ----

test('opened：スタックでない PR の base が既定ブランチ以外なら、Draft に戻し理由を記録して agent:blocked を付ける', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false }) });
  const w = await runPr(fake, 'opened');
  before(w, 'convertPullRequestToDraft', 'comment:orphan-base');
  before(w, 'comment:orphan-base', 'label+agent:blocked');
  assert.ok(postedBodies(fake, 'orphan-base')[0]!.includes(reasonMark('orphan-base')), '理由コードの印がありません');
  assert.deepEqual(postedRecord(fake, 'orphan-base'), { version: 1, base: FEATURE_BASE.ref, headSha: HEAD });
  assert.ok(!w.includes('comment:draft-until-judged'), 'Draft に戻した理由は orphan-base の記録だけにする');
  assert.ok(w.some((x) => x.startsWith('check:agent/title=')) && w.some((x) => x.startsWith('check:agent/plan-link=')), '通常の処理（チェック）も続ける');
  assert.ok(w.some((x) => x.startsWith('check:agent/scope=')) && w.some((x) => x.startsWith('check:agent/tests=')));
});

test('opened：Draft で出された orphan-base の PR にも記録と agent:blocked を付ける（Draft 化は不要）', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: true }) });
  const w = await runPr(fake, 'opened');
  assert.ok(!w.includes('convertPullRequestToDraft'));
  assert.ok(w.includes('comment:orphan-base') && w.includes('label+agent:blocked'));
});

test('stack.base.ref が既定ブランチでないスタックは orphan-base として止める', async () => {
  const fake = stackFake({ pr: stackedPr({ draft: false, stack: { ...STACK, base: { ref: 'develop', sha: 'c'.repeat(40) } } }) });
  const w = await runPr(fake, 'stacked');
  assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:orphan-base') && w.includes('label+agent:blocked'), w.join(' / '));
  assert.ok(!w.includes('comment:base-resolved'));
});

test('既定ブランチ宛てで auto-merge が付いた PR の base が別ブランチに付け替わると、auto-merge を外してから Draft に戻す', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false, auto_merge: { enabled: true } }) });
  const w = await runPr(fake, 'edited', baseChanged);
  before(w, 'disablePullRequestAutoMerge', 'convertPullRequestToDraft');
  before(w, 'convertPullRequestToDraft', 'comment:orphan-base');
  assert.ok(w.includes('label+agent:blocked'));
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
});

test('edited：base の変更が無い編集（タイトルなど）では base を見ない', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false }) });
  const w = await runPr(fake, 'edited', { changes: { title: { from: 'x' } } });
  assert.ok(!w.includes('convertPullRequestToDraft') && !w.includes('comment:orphan-base') && !w.includes('label+agent:blocked'), w.join(' / '));
});

// ---- Ready に戻されたとき ----

test('ready_for_review：orphan-base の PR を Ready に戻すと再び Draft に戻す。記録とラベルは付け直さない', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false, labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft'));
  assert.ok(!w.includes('comment:orphan-base'), '同じ base の orphan-base の記録があるので書き直さない');
  assert.ok(!w.includes('label+agent:blocked'));
  assert.ok(!w.includes('comment:draft-until-judged'));
  assert.ok(!w.includes('markPullRequestReadyForReview'));
});

test('ready_for_review：人が agent:blocked を外した後に Ready にしても、Draft に戻すだけでラベルは付け直さない', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP), blockedUnlabeledBy('me')] });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft'));
  assert.ok(!w.includes('label+agent:blocked') && !w.includes('comment:orphan-base'), w.join(' / '));
});

test('ready_for_review：前の記録と別の base に付け替わっていれば記録し直す', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false, base: { ref: 'feature/other', sha: 'b'.repeat(40) } }), prComments: [orphanRecord()] });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:orphan-base'), w.join(' / '));
  assert.equal(postedRecord(fake, 'orphan-base').base, 'feature/other');
});

test('ready_for_review：orphan-base なら fork の PR も Draft に戻す', async () => {
  const fake = stackFake({ pr: orphanPr({ draft: false, head: forkHead }) });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:orphan-base'), w.join(' / '));
});

test('ready_for_review：判定前の PR を Ready にすると Draft に戻し、merge-route を最後に書き直す（チェックは書かない）', async () => {
  const fake = stackFake({ pr: pr({ draft: false }) });
  const w = await runPr(fake, 'ready_for_review');
  before(w, 'convertPullRequestToDraft', 'comment:draft-until-judged');
  assert.equal(w.at(-1), 'check:merge-route=success');
  assert.ok(!w.some((x) => /^check:agent\/(title|plan-link|scope|tests)=/.test(x)), w.join(' / '));
  assert.ok(!w.includes('comment:orphan-base') && !w.includes('label+agent:blocked'));
});

test('ready_for_review：人の PR でも判定前なら Draft に戻す', async () => {
  const fake = stackFake({ pr: pr({ draft: false, head: humanHead }) });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:draft-until-judged'));
});

test('ready_for_review：Stacked PR でも判定前なら Draft に戻す', async () => {
  const fake = stackFake({ pr: stackedPr({ draft: false }) });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(w.includes('convertPullRequestToDraft') && w.includes('comment:draft-until-judged'));
  assert.ok(!w.includes('comment:orphan-base'));
});

test('ready_for_review：現在の差分に受け付け済みの判定があれば戻さない', async () => {
  const fake = stackFake({ pr: pr({ draft: false }), prComments: [acceptanceComment(91, { autoEligible: true, reasons: [] })] });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(!w.includes('convertPullRequestToDraft') && !w.includes('comment:draft-until-judged'), w.join(' / '));
  assert.equal(w.at(-1), 'check:merge-route=success');
});

test('ready_for_review：fork の PR（orphan-base でない）は Draft に戻さない', async () => {
  const fake = stackFake({ pr: pr({ draft: false, head: forkHead }) });
  const w = await runPr(fake, 'ready_for_review');
  assert.ok(!w.includes('convertPullRequestToDraft'), w.join(' / '));
});

// ---- stacked：スタックに組み込まれたら通常の流れに戻す ----

test('stacked：orphan-base で止めた PR がスタックに入ると、App の agent:blocked を外し、記録を書き、plan-link と scope を書き直す', async () => {
  const fake = stackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'stacked');
  assert.ok(w.includes('label-agent:blocked'), w.join(' / '));
  assert.deepEqual(postedRecord(fake, 'base-resolved'), { version: 1, base: FEATURE_BASE.ref, kind: 'stacked' });
  assert.ok(w.some((x) => x.startsWith('check:agent/plan-link=')) && w.some((x) => x.startsWith('check:agent/scope=')));
  assert.ok(w.includes('check:merge-route=success'));
  assert.ok(!w.includes('markPullRequestReadyForReview'), '判定が無ければ Draft のまま');
  assert.ok(!w.includes('convertPullRequestToDraft') && !w.includes('comment:orphan-base') && !w.includes('label+agent:blocked'));
});

test('stacked：人が付けた agent:blocked は外さない（記録と書き直しは行う）', async () => {
  const fake = stackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP), blockedLabeledBy('me')] });
  const w = await runPr(fake, 'stacked');
  assert.ok(!w.includes('label-agent:blocked'), w.join(' / '));
  assert.ok(w.includes('comment:base-resolved'));
  assert.ok(w.some((x) => x.startsWith('check:agent/plan-link=')) && w.some((x) => x.startsWith('check:agent/scope=')));
});

test('stacked：最新の理由コードが fix-limit なら、App が付けた agent:blocked でも外さない', async () => {
  const fake = stackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord(), fixLimitComment()], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'stacked');
  assert.ok(!w.includes('label-agent:blocked'), w.join(' / '));
  assert.ok(w.includes('comment:base-resolved'));
});

test('stacked：現在の差分に受け付け済みの合格があれば Ready にし、merge-route を書き直す（auto-merge は付けない）', async () => {
  const fake = stackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord(), acceptanceComment(98)], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'stacked');
  assert.ok(w.includes('label-agent:blocked') && w.includes('comment:base-resolved'));
  before(w, 'markPullRequestReadyForReview', 'check:merge-route=success');
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.includes('comment:human-review'), '受け付け直しではない（fresh:false）ので依頼を出し直さない');
});

test('stacked：App の orphan-base の記録が無ければ、plan-link・scope・merge-route の書き直しだけ', async () => {
  const fake = stackFake({ pr: stackedPr() });
  const w = await runPr(fake, 'stacked');
  assert.deepEqual([...w].map((x) => x.replace(/=.*/, '')).sort(), ['check:agent/plan-link', 'check:agent/scope', 'check:merge-route'], w.join(' / '));
});

test('stacked：最新の記録が base-resolved（解消済み）なら何も外さず、記録も書き直さない', async () => {
  const fake = stackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord(), baseResolvedRecord()], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'stacked');
  assert.ok(!w.includes('label-agent:blocked') && !w.includes('comment:base-resolved'), w.join(' / '));
});

test('edited（base の付け替え）：orphan-base で止めた PR の base を既定ブランチにすると通常の流れに戻す（kind=default）', async () => {
  const fake = stackFake({ pr: pr({ labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP)] });
  const w = await runPr(fake, 'edited', baseChanged);
  assert.ok(w.includes('label-agent:blocked'), w.join(' / '));
  assert.deepEqual(postedRecord(fake, 'base-resolved'), { version: 1, base: 'main', kind: 'default' });
  assert.ok(w.some((x) => x.startsWith('check:agent/plan-link=')) && w.some((x) => x.startsWith('check:agent/scope=')));
  assert.ok(!w.includes('convertPullRequestToDraft'));
});

test('edited（base の付け替え）：下の層が Merge されて base が既定ブランチになった Stacked PR は Draft に戻さない', async () => {
  const fake = stackFake({ pr: pr({ draft: false, stack: { ...STACK, position: 1, size: 1 } }) });
  const w = await runPr(fake, 'edited', baseChanged);
  assert.ok(!w.includes('convertPullRequestToDraft') && !w.includes('comment:orphan-base') && !w.includes('label+agent:blocked'), w.join(' / '));
});

// ---- 判定の受け付け ----

const acceptedRecord = (fake: FakeGitHub) => postedRecord(fake, 'acceptance');
const routeLine = (fake: FakeGitHub) => postedBodies(fake, 'acceptance')[0]!.split('\n').find((l) => l.startsWith('| 経路 |'));

test('判定の受け付け：Stacked PR は autoEligible が偽で、経路は Human Merge。合格なら Ready にするが auto-merge も直接の Merge もしない', async () => {
  const fake = stackFake({ pr: stackedPr() });
  let merged = false;
  fake.on('PUT', /\/pulls\/5\/merge/, () => (merged = true));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const a = acceptedRecord(fake);
  assert.equal(a.autoEligible, false);
  assert.equal(a.reasons[0], 'Stacked PR のため Human Merge（GitHub の auto-merge と Merge API が使えない）');
  assert.equal(routeLine(fake), '| 経路 | Human Merge（人のレビュー待ち） |');
  const w = fake.writes();
  assert.ok(w.includes('markPullRequestReadyForReview'));
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.equal(merged, false);
  assert.ok(w.includes('check:merge-route=success') && w.includes('check:agent/review=success'));
});

test('判定の受け付け：orphan-base の PR は合格でも Ready にせず、auto-merge も直接の Merge もしない', async () => {
  const fake = stackFake({ pr: orphanPr({ labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP)] });
  let merged = false;
  fake.on('PUT', /\/pulls\/5\/merge/, () => (merged = true));
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const a = acceptedRecord(fake);
  assert.equal(a.autoEligible, false);
  assert.equal(a.reasons[0], 'スタックでないのに base が既定ブランチ以外（`orphan-base`。Draft に留めています）');
  assert.equal(routeLine(fake), '| 経路 | Human Merge（人のレビュー待ち） |');
  const w = fake.writes();
  assert.ok(!w.includes('markPullRequestReadyForReview'), w.join(' / '));
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.equal(merged, false);
  assert.ok(!w.includes('label-agent:blocked'), '判定の受け付けでは agent:blocked を外さない');
});

test('判定の受け付け：既定ブランチ宛ての PR は今までどおり自動 Merge の経路', async () => {
  const fake = stackFake({ pr: pr() });
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.equal(acceptedRecord(fake).autoEligible, true);
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'));
});

// ---- 定期実行での見直し ----

test('定期実行：スタックでない orphan-base の PR を Draft に戻し、記録と agent:blocked を付ける', async () => {
  const fake = scheduleStackFake({ pr: orphanPr({ draft: false }) });
  await runSchedule(fake);
  const w = fake.writes();
  before(w, 'convertPullRequestToDraft', 'comment:orphan-base');
  assert.ok(w.includes('label+agent:blocked'));
});

test('定期実行：orphan-base で止めた PR がスタックに入っていれば、App の agent:blocked を外し plan-link と scope を書き直す', async () => {
  const fake = scheduleStackFake({ pr: stackedPr({ labels: BLOCKED }), prComments: [orphanRecord()], events: [blockedLabeledBy(APP)] });
  await runSchedule(fake);
  const w = fake.writes();
  assert.ok(w.includes('label-agent:blocked'), w.join(' / '));
  assert.ok(w.includes('comment:base-resolved'));
  assert.ok(w.some((x) => x.startsWith('check:agent/plan-link=')) && w.some((x) => x.startsWith('check:agent/scope=')));
  assert.ok(!w.includes('convertPullRequestToDraft'));
});

test('定期実行：Stacked PR に付いた auto-merge は外す', async () => {
  const fake = scheduleStackFake({ pr: stackedPr({ draft: false, auto_merge: { enabled: true } }), prComments: [acceptanceComment(91, { autoEligible: true, reasons: [] })] });
  await runSchedule(fake);
  const w = fake.writes();
  assert.ok(w.includes('disablePullRequestAutoMerge'), w.join(' / '));
  assert.ok(!w.includes('PUT /repos/o/r/pulls/5/update-branch'));
});

test('定期実行：既定ブランチ宛て・スタック無しの PR だけなら、PR の取り直しや events の読み込みは増えない', async () => {
  const human = scheduleStackFake({ pr: pr({ head: humanHead }) });
  await runSchedule(human);
  assert.equal(countCalls(human, 'GET', '/repos/o/r/pulls/5'), 0);
  assert.equal(countCalls(human, 'GET', '/repos/o/r/issues/5/events'), 0);
  assert.equal(countCalls(human, 'GET', '/repos/o/r/issues/5/comments'), 0);
  assert.ok(!human.writes().some((x) => x !== 'PATCH /repos/o/r/issues/1'), human.writes().join(' / '));

  const agent = scheduleStackFake({ pr: pr() });
  await runSchedule(agent);
  assert.equal(countCalls(agent, 'GET', '/repos/o/r/pulls/5'), 1, 'Agent PR はコンフリクトの確認で1回だけ');
});
