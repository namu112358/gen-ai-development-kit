// 委任承認で計画ゲートを通す動作（計画コメントの判定・ダッシュボードのラベルを付けたときと定期実行での既存の Issue の判定し直し）を、偽の GitHub で確かめる（Issue #241）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, reasonMark } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import type { Plan } from '../lib/plan.ts';
import { onComment, reviewDelegatedPlans } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { onSchedule } from '../gates/stale.ts';
import { APP, CRITIQUE, DELEGATE, config, critiqueClaim, ctxFor, delegateLabeled, delegateUnlabeled, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment, countCalls, dashboardLabelEvent } from './support/stack-fixtures.ts';

const PLAN = DELEGATE.planLabel;
const MERGE = DELEGATE.mergeLabel;
/** ガードレールに当たり、delegateMergeExclude に当たらない files */
const GUARDED = 'harness/lib/epic.ts';
const GUARD_REASON = `ガードレールに触れます（人が実装して Merge する）: ${GUARDED}`;

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const planOf = (issue: number, patch: Partial<Plan> = {}): Plan => ({
  version: 1, issue, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE, ...patch,
});

let nextCommentId = 5000;

/** 人（OWNER）の計画コメント */
function planComment(plan: Plan, association = 'OWNER') {
  const id = nextCommentId++;
  return { id, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: `p${id}`, author_association: association, user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
}

/** 計画コメントの投稿（issue_comment created） */
const planEvent = (issue: number, labels: string[], comment: ReturnType<typeof planComment>) => ({
  action: 'created',
  issue: { number: issue, labels: labels.map((name) => ({ name })), state: 'open' },
  comment,
});

/** App が付けた・人が付けた agent:plan-review の events */
const planReviewLabeled = (login: string, at = '2026-09-28T00:01:00Z') => ({ event: 'labeled', created_at: at, actor: { login }, label: { name: LABELS.planReview } });
const planReviewUnlabeled = (login: string, at: string) => ({ event: 'unlabeled', created_at: at, actor: { login }, label: { name: LABELS.planReview } });

/** App の計画ゲートの停止の記録（kind=plan-gate） */
function stoppedRecord(comment: ReturnType<typeof planComment>, plan: Plan, o: { origin?: 'gate' | 'planner'; sha?: string; withPlan?: boolean } = {}) {
  const record: Record<string, unknown> = {
    version: 1, planCommentId: comment.id, planBodySha256: o.sha ?? sha256(comment.body), pass: false, reasons: ['止めた理由'], planReviewOrigin: o.origin ?? 'gate',
  };
  if (o.withPlan !== false) record.plan = plan;
  return appRecordComment(nextCommentId++, 'plan-gate', `${reasonMark('high-risk')}\n計画ゲートで停止しました。`, record);
}

/**
 * 世界に、App のゲートの停止で止まった Issue を足す。
 * 既定は「記録に plan があり pass:false・planReviewOrigin:gate、最後に agent:plan-review を付けたのが App、本文の sha が記録と同じ」
 */
function addStopped(w: DelegateWorld, n: number, plan: Plan, o: { origin?: 'gate' | 'planner'; sha?: string; withPlan?: boolean; events?: unknown[] } = {}): void {
  const comment = planComment(plan);
  (w.issues ??= {})[n] = [LABELS.ready, LABELS.planReview];
  (w.comments ??= {})[n] = [critiqueClaim(), comment, stoppedRecord(comment, plan, o)];
  (w.issueEvents ??= {})[n] = o.events ?? [planReviewLabeled(APP)];
}

/** App のコメントの POST（Issue 番号指定、kind 指定なら絞る）の本文 */
function postsOn(fake: FakeGitHub, n: number, kind?: string): string[] {
  return fake.calls
    .filter((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`) && (kind === undefined || String(c.body.body).includes(appMark(kind))))
    .map((c) => String(c.body.body));
}

/** Issue へのラベルの書き込み（POST・DELETE） */
function labelWrites(fake: FakeGitHub, n: number): string[] {
  return fake.calls
    .filter((c) => (c.method === 'POST' && c.path.endsWith(`/issues/${n}/labels`)) || (c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)))
    .map((c) => (c.method === 'POST' ? `+${(c.body.labels as string[]).join(',')}` : `-${decodeURIComponent(c.path.split('/labels/')[1]!)}`));
}

/** 最後に投稿した計画ゲートの記録 */
function lastGateRecord(fake: FakeGitHub, n: number): Record<string, any> {
  const body = postsOn(fake, n, 'plan-gate').at(-1);
  assert.ok(body, `#${n} に plan-gate を投稿していません`);
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok, `#${n} の plan-gate の記録を読めません`);
  return block.value as Record<string, any>;
}

/** 計画の委任が有効な世界（PLAN か MERGE を人が付けた） */
function delegatedWorld(labels: string[], at = minutesAgo(10), login = 'me'): DelegateWorld {
  return { prs: [], dashboardLabels: [...labels], dashboardEvents: labels.filter((l) => l === PLAN || l === MERGE).map((l) => delegateLabeled(l, at, login)) };
}

/** 計画コメントを投稿し、ゲートを通す */
async function postPlan(w: DelegateWorld, plan: Plan, o: { n?: number; labels?: string[]; events?: unknown[] } = {}): Promise<FakeGitHub> {
  const n = o.n ?? plan.issue;
  const labels = o.labels ?? [LABELS.ready];
  (w.issues ??= {})[n] = [...labels];
  (w.comments ??= {})[n] ??= [critiqueClaim()];
  if (o.events) (w.issueEvents ??= {})[n] = o.events;
  const fake = delegateWorldFake(w);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(n, labels, planComment(plan))));
  return fake;
}

function assertPassedByDelegation(fake: FakeGitHub, n: number, o: { mode: 'plan' | 'plan+merge'; label: string; since: string; skipped: string[] }): void {
  const writes = labelWrites(fake, n);
  assert.ok(writes.some((x) => x.startsWith('+') && x.includes(LABELS.planOk)), `plan-ok を付けていない: ${writes.join(' ')}`);
  assert.ok(!writes.some((x) => x.startsWith('+') && x.includes(LABELS.planReview)), `plan-review を付けた: ${writes.join(' ')}`);
  const rec = lastGateRecord(fake, n);
  assert.equal(rec.pass, true);
  assert.deepEqual(rec.reasons, []);
  assert.ok(rec.delegated, '記録に delegated が無い');
  assert.deepEqual([...rec.delegated.skipped].sort(), [...o.skipped].sort());
  assert.equal(rec.delegated.label, o.label);
  assert.equal(rec.delegated.mode, o.mode);
  assert.equal(rec.delegated.by, 'me');
  assert.equal(Date.parse(rec.delegated.since), Date.parse(o.since));
  const body = postsOn(fake, n, 'plan-gate').at(-1)!;
  // 「委任承認（計画のみ）」「委任承認（計画のみ、`ラベル`、…）」のどちらの書き方でもよい
  const name = o.mode === 'plan' ? /委任承認（計画のみ[）、]/ : /委任承認（計画＋Merge[）、]/;
  assert.match(body, name, '本文に委任承認の段階の呼び名が無い');
  assert.ok(body.includes(o.label), `本文にラベル ${o.label} が無い:\n${body}`);
  assert.ok(body.includes('@me'), `本文に @付けた人 が無い:\n${body}`);
  assert.ok(body.includes(rec.delegated.since), `本文に付けた時刻 ${rec.delegated.since} が無い:\n${body}`);
  for (const s of o.skipped) assert.ok(body.includes(s), `本文に飛ばした理由「${s}」が無い:\n${body}`);
}

function assertStopped(fake: FakeGitHub, n: number): Record<string, any> {
  const writes = labelWrites(fake, n);
  assert.ok(!writes.some((x) => x.startsWith('+') && x.includes(LABELS.planOk)), `plan-ok を付けた: ${writes.join(' ')}`);
  assert.ok(writes.some((x) => x.startsWith('+') && x.includes(LABELS.planReview)), `plan-review を付けていない: ${writes.join(' ')}`);
  const rec = lastGateRecord(fake, n);
  assert.equal(rec.pass, false);
  assert.equal(rec.delegated, undefined, '止めた記録に delegated がある');
  return rec;
}

// ---- 計画コメントの判定（onComment） ----

test('計画：委任が無ければ、ガードレールだけで止まる計画は今までどおり止まり、ダッシュボードの timeline は読まない', async () => {
  const fake = await postPlan(delegatedWorld([]), planOf(21));
  const rec = assertStopped(fake, 21);
  assert.equal(rec.planReviewOrigin, 'gate');
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0);
});

test('計画：agent:delegate-plan が有効なら、ガードレールだけで止まる計画に plan-ok を付け、記録とコメントに委任承認（計画のみ）を残す', async () => {
  const at = minutesAgo(10);
  const fake = await postPlan(delegatedWorld([PLAN], at), planOf(21));
  assertPassedByDelegation(fake, 21, { mode: 'plan', label: PLAN, since: at, skipped: [GUARD_REASON] });
});

test('計画：agent:delegate-merge が有効なら、Risk critical だけで止まる計画に plan-ok を付け、委任承認（計画＋Merge）を残す', async () => {
  const at = minutesAgo(10);
  const fake = await postPlan(delegatedWorld([MERGE], at), planOf(21, { risk: 'critical', files: ['docs/a.md'] }));
  assertPassedByDelegation(fake, 21, { mode: 'plan+merge', label: MERGE, since: at, skipped: ['想定 Risk が critical です'] });
});

test('計画：ガードレールと Risk high の両方でも、委任が有効なら通り、両方の理由を飛ばしたと書く', async () => {
  const at = minutesAgo(10);
  const fake = await postPlan(delegatedWorld([PLAN, MERGE], at), planOf(21, { risk: 'high' }));
  assertPassedByDelegation(fake, 21, { mode: 'plan+merge', label: MERGE, since: at, skipped: [GUARD_REASON, '想定 Risk が high です'] });
});

test('計画：委任承認に期限は無い（1000 時間前に付けたラベルでも通す）', async () => {
  const at = minutesAgo(1000 * 60);
  const fake = await postPlan(delegatedWorld([PLAN], at), planOf(21));
  assertPassedByDelegation(fake, 21, { mode: 'plan', label: PLAN, since: at, skipped: [GUARD_REASON] });
});

test('計画：委任でも、飛ばせない理由（Planner の申告・issue の不一致・files の欠落と誤り・exclude・harness.config.json・広いパターン）があれば止まる', async () => {
  const cases: [string, Plan, RegExp?][] = [
    ['needsHuman', planOf(21, { needsHuman: true, needsHumanReasons: ['r'] })],
    ['acChangeProposed', planOf(21, { acChangeProposed: true })],
    ['openQuestions', planOf(21, { openQuestions: ['?'] })],
    ['issue の不一致', planOf(99)],
    ['files の欠落', planOf(21, { risk: 'high', files: [] })],
    ['files の書式の誤り', planOf(21, { files: [GUARDED, './docs/a.md'] })],
    ['delegateMergeExclude', planOf(21, { files: ['harness/gates/on-comment.ts'] }), /委任承認でも通しません[^\n]*harness\/gates\/on-comment\.ts/],
    ['harness.config.json', planOf(21, { files: ['harness.config.json'] }), /委任承認でも通しません[^\n]*harness\.config\.json/],
    ['harness/**', planOf(21, { files: ['harness/**'] }), /委任承認でも通しません[^\n]*harness\/\*\*/],
  ];
  for (const [name, plan, excluded] of cases) {
    const fake = await postPlan(delegatedWorld([PLAN, MERGE]), plan, { n: 21 });
    const rec = assertStopped(fake, 21);
    if (excluded) {
      assert.ok((rec.reasons as string[]).some((r) => excluded.test(r)), `${name}: 記録の reasons に exclude の理由が無い: ${rec.reasons.join(' / ')}`);
      assert.match(postsOn(fake, 21, 'plan-gate').at(-1)!, excluded, `${name}: コメントに exclude の理由が無い`);
    }
  }
});

test('計画：delegateMergeExclude が設定に無ければ、委任でもすべての計画を止める', async () => {
  const bare = { ...config };
  delete bare.delegateMergeExclude;
  const w = delegatedWorld([MERGE]);
  w.issues = { 21: [LABELS.ready] };
  w.comments = { 21: [] };
  const fake = delegateWorldFake(w);
  await onComment(ctxFor(fake, 'issue_comment', planEvent(21, [LABELS.ready], planComment(planOf(21))), { config: bare }));
  assertStopped(fake, 21);
});

test('計画：人が付けた agent:plan-review がある Issue は、委任でも止まったまま', async () => {
  const fake = await postPlan(delegatedWorld([PLAN, MERGE]), planOf(21), { labels: [LABELS.ready, LABELS.planReview], events: [planReviewLabeled('me')] });
  const writes = labelWrites(fake, 21);
  assert.ok(!writes.some((x) => x.startsWith('+') && x.includes(LABELS.planOk)), writes.join(' '));
  assert.ok(!writes.includes(`-${LABELS.planReview}`), '人の印を外した');
  const rec = lastGateRecord(fake, 21);
  assert.equal(rec.pass, false);
  assert.equal(rec.delegated, undefined);
});

test('計画：委任のラベルが無効（Bot が付けた・付けた時刻が未来・停止スイッチ）なら止まる', async () => {
  const worlds: [string, DelegateWorld][] = [
    ['Bot', delegatedWorld([PLAN], minutesAgo(10), 'someone[bot]')],
    ['App', delegatedWorld([MERGE], minutesAgo(10), APP)],
    ['未来', delegatedWorld([PLAN], minutesAgo(-60))],
    ['停止スイッチ', delegatedWorld([PLAN, MERGE, config.autoMergeStopLabel])],
  ];
  for (const [name, w] of worlds) {
    const fake = await postPlan(w, planOf(21));
    assert.equal(lastGateRecord(fake, 21).pass, false, name);
    assertStopped(fake, 21);
  }
});

test('計画：通る計画・飛ばせる理由の無い停止では、委任のラベルがあってもダッシュボードの timeline を読まない', async () => {
  for (const plan of [planOf(21, { files: ['docs/a.md'] }), planOf(21, { files: ['docs/a.md'], needsHuman: true })]) {
    const fake = await postPlan(delegatedWorld([MERGE]), plan);
    assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/1/timeline'), 0, JSON.stringify(plan));
    assert.equal(lastGateRecord(fake, 21).delegated, undefined);
  }
});

// ---- 既存の Issue の判定し直し（reviewDelegatedPlans） ----

/**
 * 止まった Issue の世界：
 * #21 ガードレールだけ（App のゲートの停止）→ 通す、#26 Risk critical だけ → 通す、
 * #22 Planner の申告、#23 人が付けた印、#24 exclude、#25 本文の sha が記録と違う、#27 記録に plan が無い、#28 最後に印を付けたのが人 → 止まったまま
 */
function stoppedWorld(labels: string[], at = minutesAgo(10)): DelegateWorld {
  const w = delegatedWorld(labels, at);
  addStopped(w, 21, planOf(21));
  addStopped(w, 26, planOf(26, { risk: 'critical', files: ['docs/a.md'] }));
  addStopped(w, 22, planOf(22, { needsHuman: true, needsHumanReasons: ['r'] }), { origin: 'planner' });
  addStopped(w, 23, planOf(23), { events: [planReviewLabeled('me')] });
  addStopped(w, 24, planOf(24, { files: ['harness/gates/on-comment.ts'] }));
  addStopped(w, 25, planOf(25), { sha: sha256('別の本文') });
  addStopped(w, 27, planOf(27), { withPlan: false });
  addStopped(w, 28, planOf(28), { events: [planReviewLabeled(APP), planReviewUnlabeled('me', '2026-09-28T01:00:00Z'), planReviewLabeled('me', '2026-09-28T02:00:00Z')] });
  return w;
}

const RELEASED = [21, 26];
const KEPT = [22, 23, 24, 25, 27, 28];

function assertReleased(fake: FakeGitHub, w: DelegateWorld, mode: 'plan' | 'plan+merge', label: string): void {
  for (const n of RELEASED) {
    assert.ok(w.issues![n]!.includes(LABELS.planOk), `#${n}: plan-ok が無い: ${w.issues![n]!.join(',')}`);
    assert.ok(!w.issues![n]!.includes(LABELS.planReview), `#${n}: plan-review が残っている`);
    const rec = lastGateRecord(fake, n);
    assert.equal(rec.pass, true, `#${n}`);
    assert.equal(rec.delegated?.mode, mode, `#${n}`);
    assert.equal(rec.delegated?.label, label, `#${n}`);
    const name = mode === 'plan' ? /委任承認（計画のみ[）、]/ : /委任承認（計画＋Merge[）、]/;
    assert.match(postsOn(fake, n, 'plan-gate').at(-1)!, name, `#${n}: 本文に委任承認の段階の呼び名が無い`);
  }
}

function assertKept(fake: FakeGitHub, w: DelegateWorld): void {
  for (const n of KEPT) {
    assert.deepEqual(postsOn(fake, n), [], `#${n}: コメントを増やした`);
    assert.deepEqual(labelWrites(fake, n), [], `#${n}: ラベルを変えた`);
    assert.ok(w.issues![n]!.includes(LABELS.planReview), `#${n}: plan-review が外れた`);
  }
}

test('ダッシュボードに agent:delegate-plan を付けると、飛ばせる理由だけで App が止めた既存の Issue が plan-ok になり、ほかは止まったまま', async () => {
  const w = stoppedWorld([PLAN]);
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('labeled', PLAN, 'me', [PLAN])));
  assertReleased(fake, w, 'plan', PLAN);
  assertKept(fake, w);
  assert.ok(postsOn(fake, 1, 'delegate-merge-switch').some((b) => b.includes('委任承認（計画のみ）を有効にしました')));
});

test('ダッシュボードに agent:delegate-merge を付けても、既存の Issue を委任承認（計画＋Merge）で判定し直す', async () => {
  const w = stoppedWorld([MERGE]);
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('labeled', MERGE, 'me', [MERGE])));
  assertReleased(fake, w, 'plan+merge', MERGE);
  assertKept(fake, w);
});

test('ラベルを付けても委任が有効にならない（停止スイッチ・Bot が付けた）なら、既存の Issue は止まったまま', async () => {
  const stopped = stoppedWorld([PLAN, config.autoMergeStopLabel]);
  const bot = stoppedWorld([]);
  bot.dashboardLabels = [PLAN];
  bot.dashboardEvents = [delegateLabeled(PLAN, minutesAgo(10), 'someone[bot]')];
  for (const [name, w, labels] of [['停止スイッチ', stopped, [PLAN, config.autoMergeStopLabel]], ['Bot', bot, [PLAN]]] as const) {
    const fake = delegateWorldFake(w);
    await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('labeled', PLAN, name === 'Bot' ? 'someone[bot]' : 'me', [...labels])));
    for (const n of [...RELEASED, ...KEPT]) {
      assert.deepEqual(postsOn(fake, n), [], `${name} #${n}`);
      assert.deepEqual(labelWrites(fake, n), [], `${name} #${n}`);
    }
  }
});

test('ラベルを外しても、委任で付けた agent:plan-ok は外れない（定期実行でも）', async () => {
  const w = stoppedWorld([PLAN]);
  const fake = delegateWorldFake(w);
  await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('labeled', PLAN, 'me', [PLAN])));
  assertReleased(fake, w, 'plan', PLAN);
  w.dashboardLabels = [];
  w.dashboardEvents!.push(delegateUnlabeled(PLAN, minutesAgo(1)));
  const before = fake.calls.length;
  await onIssue(ctxFor(fake, 'issues', dashboardLabelEvent('unlabeled', PLAN, 'me', [])));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const after = fake.calls.slice(before);
  for (const n of RELEASED) {
    assert.ok(w.issues![n]!.includes(LABELS.planOk), `#${n}: plan-ok が外れた`);
    assert.ok(!after.some((c) => c.method === 'DELETE' && c.path.includes(`/issues/${n}/labels/`)), `#${n}: ラベルを外した`);
  }
});

test('定期実行：計画の委任が有効なら既存の Issue を判定し直し、2回目は何もしない', async () => {
  const w = stoppedWorld([PLAN]);
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  assertReleased(fake, w, 'plan', PLAN);
  assertKept(fake, w);
  assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')), 'ダッシュボードを更新していない');

  const before = fake.calls.length;
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  const again = fake.calls.slice(before);
  for (const n of [...RELEASED, ...KEPT]) {
    assert.ok(!again.some((c) => c.method === 'POST' && c.path.endsWith(`/issues/${n}/comments`)), `#${n}: 2回目にコメントした`);
  }
});

test('定期実行：委任のラベルが無ければ既存の Issue は判定し直さない', async () => {
  const w = stoppedWorld([]);
  const fake = delegateWorldFake(w);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  for (const n of [...RELEASED, ...KEPT]) {
    assert.deepEqual(postsOn(fake, n), [], `#${n}`);
    assert.deepEqual(labelWrites(fake, n), [], `#${n}`);
  }
});

test('定期実行：判定し直しが失敗しても（Issue の events が読めない）、ダッシュボードは更新する', async () => {
  const w = stoppedWorld([PLAN]);
  const fake = delegateWorldFake(w);
  fake.on('GET', /\/issues\/(21|26)\/(events|timeline)/, () => {
    throw new Error('HTTP 502');
  });
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date());
  for (const n of RELEASED) assert.ok(!w.issues![n]!.includes(LABELS.planOk), `#${n}: 印を付けたのが App か確かめられないのに通した`);
  assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')), 'ダッシュボードを更新していない');
});

test('reviewDelegatedPlans：渡した委任の状態が計画の委任でなければ何もしない。渡さなければダッシュボードから読む', async () => {
  const off: DelegateState = { mode: 'off', active: false, planActive: false, label: null, since: null, by: null, reason: 'ラベルが無い' };
  const w = stoppedWorld([PLAN]);
  const fake = delegateWorldFake(w);
  await reviewDelegatedPlans(ctxFor(fake, 'schedule', {}), new Date(), off);
  assert.deepEqual(fake.writes(), [], '計画の委任が無効なら何も書かない');

  await reviewDelegatedPlans(ctxFor(fake, 'schedule', {}), new Date());
  assertReleased(fake, w, 'plan', PLAN);
  assertKept(fake, w);
});
