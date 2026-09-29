// 委任 Merge の判定（delegateState・delegateExcludeFiles・delegateEligibility）と、merge-route・判定の受け付けへの記録を確かめる（Issue #211）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { delegateMergeConfig, type HarnessConfig } from '../lib/config.ts';
import { delegateEligibility, delegateExcludeFiles, delegateState } from '../lib/delegate.ts';
import { GitHub } from '../lib/github.ts';
import { evaluateMergeRoute, type Acceptance, type DelegateRecord, type MergeRouteInput } from '../lib/merge-route.ts';
import { plannedFilesForDelegate, type TimelineEvent } from '../lib/state.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

const LABEL = delegateMergeConfig(config).label;
const HOURS = delegateMergeConfig(config).hours;
const NOW = new Date('2026-09-29T12:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

const dashboard = (...labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
const labeled = (created_at: string | undefined, login = 'me', name = LABEL): TimelineEvent => ({ event: 'labeled', created_at, actor: { login }, label: { name } });

// ---- delegateState ----

test('delegateState：期限内（人が付けて1時間）なら active、since・until・by を返す', () => {
  const since = hoursAgo(1);
  const s = delegateState(dashboard(LABEL), [labeled(since)], config, NOW);
  assert.equal(s.active, true, s.reason);
  assert.equal(Date.parse(s.since!), Date.parse(since));
  assert.equal(Date.parse(s.until!), Date.parse(since) + HOURS * 3600_000);
  assert.equal(s.by, 'me');
  assert.equal(typeof s.reason, 'string');
});

test('delegateState：ダッシュボードにラベルが無い・ダッシュボードが無いなら active でない', () => {
  assert.equal(delegateState(dashboard(), [labeled(hoursAgo(1))], config, NOW).active, false);
  assert.equal(delegateState(null, [labeled(hoursAgo(1))], config, NOW).active, false);
});

test('delegateState：ラベルはあるが付けたイベントが無い・最後が外したイベントなら active でない', () => {
  assert.equal(delegateState(dashboard(LABEL), [], config, NOW).active, false);
  const unlabeled: TimelineEvent = { event: 'unlabeled', created_at: hoursAgo(0.5), actor: { login: 'me' }, label: { name: LABEL } };
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(1)), unlabeled], config, NOW).active, false);
});

test('delegateState：期限切れ（hours を過ぎた・ちょうど hours）なら active でない', () => {
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(HOURS + 1))], config, NOW).active, false);
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(HOURS))], config, NOW).active, false, 'now >= since + hours は切れ');
});

test('delegateState：停止スイッチ（autoMergeStopLabel）がダッシュボードにあれば active でない', () => {
  assert.equal(delegateState(dashboard(LABEL, config.autoMergeStopLabel), [labeled(hoursAgo(1))], config, NOW).active, false);
});

test('delegateState：時刻が読めない・未来の時刻なら active でない', () => {
  assert.equal(delegateState(dashboard(LABEL), [labeled(undefined)], config, NOW).active, false, 'created_at なし');
  assert.equal(delegateState(dashboard(LABEL), [labeled('not-a-date')], config, NOW).active, false, '読めない created_at');
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(-1))], config, NOW).active, false, '未来の created_at');
});

test('delegateState：付けた actor が App か Bot なら active でない', () => {
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(1), APP)], config, NOW).active, false, 'App');
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(1), 'someone[bot]')], config, NOW).active, false, '[bot]');
});

test('delegateState：hours は設定（delegateMerge.hours）から取る', () => {
  const longer: HarnessConfig = { ...config, delegateMerge: { ...delegateMergeConfig(config), hours: 10 } };
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(5))], longer, NOW).active, true);
  assert.equal(delegateState(dashboard(LABEL), [labeled(hoursAgo(5))], config, NOW).active, HOURS > 5);
});

// ---- delegateExcludeFiles ----

test('delegateExcludeFiles：delegateMergeExclude に当たるファイルを、ソート・重複なしで返す', () => {
  const files = ['harness/gates/run.ts', 'docs/a.md', 'harness/lib/delegate.ts', 'harness/gates/run.ts', 'harness/lib/plan.ts'];
  assert.deepEqual(delegateExcludeFiles(config, files), ['harness/gates/run.ts', 'harness/lib/delegate.ts']);
});

test('delegateExcludeFiles：harness.config.json は一覧に無くても当たる', () => {
  assert.deepEqual(delegateExcludeFiles({ delegateMergeExclude: [] }, ['harness.config.json', 'docs/a.md']), ['harness.config.json']);
});

test('delegateExcludeFiles：delegateMergeExclude が無い設定ではすべてのファイルが当たる', () => {
  assert.deepEqual(delegateExcludeFiles({}, ['docs/b.md', 'docs/a.md']), ['docs/a.md', 'docs/b.md']);
});

// ---- delegateEligibility ----

type EligParts = Parameters<typeof delegateEligibility>[0];
const okParts: EligParts = {
  reviewPass: true, scopeOk: true, outside: [], humanMerge: [], exclude: [], agent: true, base: 'default',
  guardrail: [], risk: { ok: true, reasons: [] },
};

test('delegateEligibility：ガードレールに触れ Risk が critical でも、ほかの条件を満たせば eligible。skipped にガードレールと Risk が入る', () => {
  const r = delegateEligibility({ ...okParts, guardrail: ['harness/lib/plan.ts'], risk: { ok: false, reasons: ['Risk レベルが critical'] } });
  assert.equal(r.eligible, true, r.reasons.join('\n'));
  assert.ok(r.skipped.some((s) => s.includes('ガードレール')), r.skipped.join('\n'));
  assert.ok(r.skipped.includes('Risk レベルが critical'), r.skipped.join('\n'));
});

test('delegateEligibility：すべて揃えば eligible、skipped は空', () => {
  const r = delegateEligibility(okParts);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.skipped, []);
  assert.equal(r.scopeOk, true);
});

test('delegateEligibility：除外・範囲外・ブロッキング・humanMergePaths・Jev・人の PR・base のどれかがあれば eligible でない', () => {
  const cases: [string, Partial<EligParts>][] = [
    ['delegateMergeExclude', { exclude: ['harness/gates/run.ts'] }],
    ['harness.config.json', { exclude: ['harness.config.json'] }],
    ['範囲外', { scopeOk: false, outside: ['package.json'] }],
    ['Reviewer のブロッキング', { reviewPass: false }],
    ['humanMergePaths', { humanMerge: ['src/auth.ts'] }],
    ['Jev', { jevGate: { ok: false, reason: 'Jev が許可していません' } }],
    ['人の PR', { agent: false }],
    ['stacked', { base: 'stacked' }],
    ['orphan-base', { base: 'orphan-base' }],
  ];
  for (const [name, patch] of cases) {
    const r = delegateEligibility({ ...okParts, guardrail: ['harness/lib/plan.ts'], risk: { ok: false, reasons: ['Risk レベルが critical'] }, ...patch });
    assert.equal(r.eligible, false, name);
    assert.ok(r.reasons.length > 0, `${name}: 理由がない`);
  }
  assert.equal(delegateEligibility({ ...okParts, jevGate: { ok: true, reason: '' } }).eligible, true, 'Jev が許せば通る');
});

test('delegateEligibility：scopeOk・outside・exclude を記録用に写す', () => {
  const r = delegateEligibility({ ...okParts, scopeOk: false, outside: ['package.json'], exclude: ['harness.config.json'] });
  assert.equal(r.scopeOk, false);
  assert.deepEqual(r.outside, ['package.json']);
  assert.deepEqual(r.exclude, ['harness.config.json']);
});

// ---- evaluateMergeRoute ----

const delegateOk: DelegateRecord = { eligible: true, reasons: [], skipped: ['ガードレールに触れます: harness/lib/plan.ts', 'Risk レベルが critical'], scopeOk: true, outside: [], exclude: [] };
const humanOnly: Acceptance = {
  version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'critical', riskOk: false, scopeOk: true, outside: [],
  guardrail: ['harness/lib/plan.ts'], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical', 'ガードレールに触れます（人が Merge する）: harness/lib/plan.ts'],
  delegate: delegateOk,
};
const routeIn: MergeRouteInput = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance: humanOnly, delegateMode: true };

test('merge-route：delegateMode 真かつ delegate.eligible 真なら、autoEligible が偽でも success', () => {
  const r = evaluateMergeRoute(routeIn);
  assert.equal(r.conclusion, 'success', r.summary);
  assert.equal(r.title, '委任 Merge の条件を満たしています');
  assert.ok(r.summary.includes('Risk レベルが critical'), `summary に skipped: ${r.summary}`);
});

test('merge-route：delegateMode が偽・省略、または delegate.eligible が偽・無ければ今までどおり failure', () => {
  for (const input of [
    { ...routeIn, delegateMode: false },
    { ...routeIn, delegateMode: undefined },
    { ...routeIn, acceptance: { ...humanOnly, delegate: { ...delegateOk, eligible: false, reasons: ['範囲外'] } } },
    { ...routeIn, acceptance: { ...humanOnly, delegate: undefined } },
  ]) {
    const r = evaluateMergeRoute(input);
    assert.equal(r.conclusion, 'failure');
    assert.ok(r.summary.includes('Risk レベルが critical'), r.summary);
  }
});

test('merge-route：委任でも agent:hold・停止・人の PR・Stacked・受け付けなしは failure', () => {
  const cases: [string, Partial<MergeRouteInput>, string][] = [
    ['hold', { hold: true }, '`agent:hold` が付いています'],
    ['停止', { autoMergeMode: false }, '自動 Merge モードが無効です'],
    ['人の PR', { isAgentPr: false }, 'Agent の PR ではありません'],
    ['stacked', { stacked: true }, 'base が既定ブランチではありません'],
    ['受け付けなし', { acceptance: null }, '現在の差分に対して有効な判定がありません'],
  ];
  for (const [name, patch, reason] of cases) {
    const r = evaluateMergeRoute({ ...routeIn, ...patch });
    assert.equal(r.conclusion, 'failure', name);
    assert.ok(r.summary.includes(reason), `${name}: ${r.summary}`);
  }
});

test('merge-route：委任でも auto-merge が無ければ Human Merge 経路として success', () => {
  const r = evaluateMergeRoute({ ...routeIn, autoMergeEnabled: false });
  assert.equal(r.conclusion, 'success');
  assert.equal(r.title, 'auto-merge なし（Human Merge 経路）');
});

test('merge-route：自動 Merge の条件を満たす受け付けは delegateMode に関わらず今までどおり success', () => {
  const auto: Acceptance = { ...humanOnly, riskLevel: 'low', riskOk: true, guardrail: [], autoEligible: true, reasons: [], delegate: undefined };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: auto, delegateMode: false }).title, '自動 Merge 条件を満たしています');
});

// ---- plannedFilesForDelegate ----

const planGate = (value: Record<string, unknown>) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nstop\n${renderBlock('agent-app', { version: 1, planCommentId: 80, reasons: [], ...value })}`,
});

function fakeWithGate(gate: ReturnType<typeof planGate>): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: [] }).on('GET', /\/issues\/3\/comments/, () => [gate]);
}

test('plannedFilesForDelegate：通過した計画、ゲートで止まった計画（planReviewOrigin: gate）の files を返す', async () => {
  for (const value of [
    { pass: true, plan: { files: ['docs/**'] } },
    { pass: false, planReviewOrigin: 'gate', plan: { files: ['docs/**'] } },
  ]) {
    const r = await plannedFilesForDelegate(new GitHub(fakeWithGate(planGate(value)), 'o/r'), config, 5);
    assert.deepEqual(r, { files: ['docs/**'] }, JSON.stringify(value));
  }
});

test('plannedFilesForDelegate：Planner の申告で止まった計画・出どころの無い止まった計画・plan の無い記録とは照合しない', async () => {
  for (const value of [
    { pass: false, planReviewOrigin: 'planner', plan: { files: ['docs/**'] } },
    { pass: false, plan: { files: ['docs/**'] } },
    { pass: false, planReviewOrigin: 'gate' },
  ]) {
    const r = await plannedFilesForDelegate(new GitHub(fakeWithGate(planGate(value)), 'o/r'), config, 5);
    assert.ok('missing' in r, JSON.stringify(value));
  }
});

// ---- 判定の受け付け（on-comment） ----

/** 計画ゲートの記録と変更ファイルを差し替えた受け付けの偽物 */
function acceptanceWith(gate: Record<string, unknown>, files: string[]): FakeGitHub {
  return acceptanceFake({ pr: pr(), dashboardLabels: [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(gate)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })));
}

const acceptanceComment = (fake: FakeGitHub): string =>
  String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments') && /kind=acceptance/.test(c.body.body))!.body.body);

function recorded(fake: FakeGitHub): Acceptance {
  const block = extractBlock(acceptanceComment(fake), 'agent-app');
  assert.ok(block.found && block.ok, '受け付けの記録が読めない');
  return (block as { value: Acceptance }).value;
}

const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

async function accept(fake: FakeGitHub, v = critical(), extra: Parameters<typeof ctxFor>[3] = {}): Promise<void> {
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), extra));
}

test('受け付け：ガードレールに触れ Risk が critical の PR は delegate.eligible が真、skipped にガードレールと Risk。auto-merge はまだ付けない', async () => {
  const fake = acceptanceWith({ pass: true, plan: { files: ['harness/lib/plan.ts'] } }, ['harness/lib/plan.ts']);
  await accept(fake);
  const a = recorded(fake);
  assert.equal(a.autoEligible, false);
  assert.ok(a.delegate, '記録に delegate が無い');
  assert.equal(a.delegate.eligible, true, a.delegate.reasons.join('\n'));
  assert.ok(a.delegate.skipped.some((s) => s.includes('ガードレール')), a.delegate.skipped.join('\n'));
  assert.ok(a.delegate.skipped.some((s) => s.includes('critical')), a.delegate.skipped.join('\n'));
  assert.deepEqual(a.delegate.exclude, []);
  assert.match(acceptanceComment(fake), /\| 委任 Merge \|/);
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), '委任ではまだ auto-merge を付けない');
});

test('受け付け：delegateMergeExclude・harness.config.json に当たる PR は delegate.eligible が偽で、exclude に載る', async () => {
  for (const file of ['harness/gates/run.ts', 'harness.config.json']) {
    const fake = acceptanceWith({ pass: true, plan: { files: [file] } }, [file]);
    await accept(fake);
    const a = recorded(fake);
    assert.equal(a.delegate?.eligible, false, file);
    assert.deepEqual(a.delegate?.exclude, [file]);
    assert.match(acceptanceComment(fake), /\| 委任 Merge \|/);
  }
});

test('受け付け：範囲外のファイル・Reviewer のブロッキング・humanMergePaths があれば delegate.eligible が偽', async () => {
  const outside = acceptanceWith({ pass: true, plan: { files: ['harness/lib/plan.ts'] } }, ['harness/lib/plan.ts', 'package.json']);
  await accept(outside);
  assert.equal(recorded(outside).delegate?.eligible, false, '範囲外');
  assert.equal(recorded(outside).delegate?.scopeOk, false);
  assert.ok(recorded(outside).delegate?.outside.includes('package.json'));

  const blocking = acceptanceWith({ pass: true, plan: { files: ['harness/lib/plan.ts'] } }, ['harness/lib/plan.ts']);
  await accept(blocking, verdict({ risk: critical().risk, review: { pass: false, blocking: [{ kind: 'ac-unmet', detail: 'AC 2' }], nonBlocking: [] } }));
  assert.equal(recorded(blocking).delegate?.eligible, false, 'ブロッキング');

  const human = acceptanceWith({ pass: true, plan: { files: ['docs/**'] } }, ['docs/a.md']);
  await accept(human, critical(), { config: { ...config, humanMergePaths: ['docs/**'] } });
  assert.equal(recorded(human).delegate?.eligible, false, 'humanMergePaths');
});

test('受け付け：計画ゲートで止まった計画（gate）の files とは照合し、Planner の申告で止まった計画とは照合しない', async () => {
  const byGate = acceptanceWith({ pass: false, planReviewOrigin: 'gate', plan: { files: ['harness/lib/plan.ts'] } }, ['harness/lib/plan.ts']);
  await accept(byGate);
  const g = recorded(byGate);
  assert.equal(g.scopeOk, false, '自動 Merge の範囲照合は通過した計画だけ');
  assert.equal(g.delegate?.scopeOk, true);
  assert.equal(g.delegate?.eligible, true, g.delegate?.reasons.join('\n'));

  const byPlanner = acceptanceWith({ pass: false, planReviewOrigin: 'planner', plan: { files: ['harness/lib/plan.ts'] } }, ['harness/lib/plan.ts']);
  await accept(byPlanner);
  const p = recorded(byPlanner);
  assert.equal(p.delegate?.scopeOk, false);
  assert.equal(p.delegate?.eligible, false);
});
