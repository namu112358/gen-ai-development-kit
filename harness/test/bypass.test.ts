// bypass モードの判定（bypassState・bypassEligibility・bypassRoute）と、merge-route の bypassMode を確かめる（Issue #245）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bypassMergeConfig, loadConfig } from '../lib/config.ts';
import { delegateExcludeFiles } from '../lib/delegate.ts';
import { evaluateMergeRoute, type Acceptance, type BypassRecord, type DelegateRecord, type MergeRouteInput } from '../lib/merge-route.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { BYPASS_MERGE_END_KIND, BYPASS_MERGE_KIND, BYPASS_SWITCH_KIND, bypassEligibility, bypassRoute, bypassState, type BypassState } from '../gates/bypass.ts';
import { APP, config } from './support/gate-fixtures.ts';

const LABEL = bypassMergeConfig(config).label;
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();
const dashboard = (...labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
const labeled = (created_at: string | undefined, login = 'me', name = LABEL): TimelineEvent => ({ event: 'labeled', created_at, actor: { login }, label: { name } });
const unlabeled = (created_at: string, login = 'me', name = LABEL): TimelineEvent => ({ event: 'unlabeled', created_at, actor: { login }, label: { name } });

test('kind の名前', () => {
  assert.equal(BYPASS_MERGE_KIND, 'bypass-merge');
  assert.equal(BYPASS_MERGE_END_KIND, 'bypass-merge-end');
  assert.equal(BYPASS_SWITCH_KIND, 'bypass-merge-switch');
  assert.equal(LABEL, 'agent:bypass-merge');
});

// ---- bypassState ----

test('bypassState：人が付けたラベルなら active、since・by を返す', () => {
  const since = hoursAgo(1);
  const s = bypassState(dashboard(LABEL), [labeled(since)], config);
  assert.equal(s.active, true, s.reason);
  assert.equal(Date.parse(s.since!), Date.parse(since));
  assert.equal(s.by, 'me');
  assert.equal(typeof s.reason, 'string');
});

test('bypassState：期限は無い（何時間たっても有効）', () => {
  for (const h of [3, 48, 24 * 365]) {
    assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(h))], config).active, true, `${h} 時間`);
  }
});

test('bypassState：ダッシュボードにラベルが無い・ダッシュボードが無いなら active でない', () => {
  assert.equal(bypassState(dashboard(), [labeled(hoursAgo(1))], config).active, false);
  assert.equal(bypassState(null, [labeled(hoursAgo(1))], config).active, false);
  assert.equal(bypassState(dashboard('agent:delegate-merge'), [labeled(hoursAgo(1))], config).active, false, '委任のラベルだけでは有効にならない');
});

test('bypassState：付けた記録が無い・最後が外した記録なら active でない', () => {
  assert.equal(bypassState(dashboard(LABEL), [], config).active, false);
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(2)), unlabeled(hoursAgo(1))], config).active, false);
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(1), 'me', 'agent:delegate-merge')], config).active, false, 'ほかのラベルの記録は数えない');
});

test('bypassState：最後に付けた actor が App か Bot なら active でない（人が付けた後に App が付け直しても無効）', () => {
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(1), APP)], config).active, false, 'App');
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(1), 'someone[bot]')], config).active, false, '[bot]');
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(3)), unlabeled(hoursAgo(2)), labeled(hoursAgo(1), APP)], config).active, false, '最後の labeled が App');
  assert.equal(bypassState(dashboard(LABEL), [labeled(hoursAgo(3), APP), unlabeled(hoursAgo(2), APP), labeled(hoursAgo(1))], config).active, true, '最後の labeled が人');
});

test('bypassState：停止スイッチ（autoMergeStopLabel）が優先', () => {
  const s = bypassState(dashboard(LABEL, config.autoMergeStopLabel), [labeled(hoursAgo(1))], config);
  assert.equal(s.active, false);
  assert.ok(s.reason.length > 0);
});

// ---- bypassEligibility ----

type Parts = Parameters<typeof bypassEligibility>[0];
const okParts: Parts = {
  reviewPass: true, scopeOk: true, outside: [], humanMerge: [], exclude: [], agent: true, base: 'default',
  guardrail: [], risk: { ok: true, reasons: [] },
};

test('bypassEligibility：すべて揃えば eligible、reasons も skipped も空', () => {
  const r = bypassEligibility(okParts);
  assert.equal(r.eligible, true);
  assert.deepEqual(r.reasons, []);
  assert.deepEqual(r.skipped, []);
});

test('bypassEligibility：Risk・ガードレール・humanMergePaths・delegateMergeExclude（harness.config.json を含む）・Jev は飛ばす（skipped）', () => {
  const r = bypassEligibility({
    ...okParts,
    guardrail: ['harness.config.json', 'harness/lib/plan.ts'],
    risk: { ok: false, reasons: ['Risk レベルが critical'] },
    humanMerge: ['src/auth.ts'],
    exclude: ['harness.config.json', 'harness/gates/run.ts'],
    jevGate: { ok: false, reason: 'Jev が許可していません' },
  });
  assert.equal(r.eligible, true, r.reasons.join('\n'));
  assert.deepEqual(r.reasons, []);
  const all = r.skipped.join('\n');
  assert.ok(r.skipped.includes('Risk レベルが critical'), all);
  assert.ok(r.skipped.includes('Jev が許可していません'), all);
  assert.ok(r.skipped.some((s) => s.includes('harness/lib/plan.ts')), `ガードレール: ${all}`);
  assert.ok(r.skipped.some((s) => s.includes('src/auth.ts')), `humanMergePaths: ${all}`);
  assert.ok(r.skipped.some((s) => s.includes('harness/gates/run.ts')), `delegateMergeExclude: ${all}`);
  assert.ok(r.skipped.some((s) => s.includes('harness.config.json')), `harness.config.json: ${all}`);
});

test('bypassEligibility：人の PR・base が既定ブランチでない・ブロッキング・範囲外は乗せない（reasons）', () => {
  const cases: [string, Partial<Parts>][] = [
    ['人の PR', { agent: false }],
    ['stacked', { base: 'stacked' }],
    ['orphan-base', { base: 'orphan-base' }],
    ['Reviewer のブロッキング', { reviewPass: false }],
    ['範囲外', { scopeOk: false, outside: ['docs/x.md'] }],
  ];
  for (const [name, patch] of cases) {
    const r = bypassEligibility({ ...okParts, guardrail: ['harness.config.json'], exclude: ['harness.config.json'], risk: { ok: false, reasons: ['Risk レベルが critical'] }, ...patch });
    assert.equal(r.eligible, false, name);
    assert.ok(r.reasons.length > 0, `${name}: 理由が無い`);
  }
  const outside = bypassEligibility({ ...okParts, scopeOk: false, outside: ['docs/x.md'] });
  assert.ok(outside.reasons.some((s) => s.includes('docs/x.md')), outside.reasons.join('\n'));
});

// ---- bypassRoute ----

const active: BypassState = { active: true, since: hoursAgo(1), by: 'me', reason: '有効' };
const inactive: BypassState = { active: false, since: null, by: null, reason: 'ラベルが無い' };
const bypassOk: BypassRecord = { eligible: true, reasons: [], skipped: ['Risk レベルが critical', 'ガードレールに触れます: harness.config.json'] };
const delegateNo: DelegateRecord = { eligible: false, reasons: ['委任しないパスに触れます（delegateMergeExclude）: harness.config.json'], skipped: [], scopeOk: true, outside: [], exclude: ['harness.config.json'] };
const humanOnly: Acceptance = {
  version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'critical', riskOk: false, scopeOk: true, outside: [],
  guardrail: ['harness.config.json'], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical', 'ガードレールに触れます（人が Merge する）: harness.config.json'],
  delegate: delegateNo, bypass: bypassOk,
};

test('bypassRoute：有効で bypass.eligible なら ok', () => {
  assert.deepEqual(bypassRoute(active, humanOnly), { ok: true });
});

test('bypassRoute：無効・受け付けなし・bypass の記録なし・bypass.eligible 偽・ブロッキングなら ok でなく理由を返す', () => {
  const cases: [string, BypassState, Acceptance | null][] = [
    ['無効', inactive, humanOnly],
    ['受け付けなし', active, null],
    ['古い受け付け（bypass なし）', active, { ...humanOnly, bypass: undefined }],
    ['bypass.eligible 偽', active, { ...humanOnly, bypass: { eligible: false, reasons: ['範囲外'], skipped: [] } }],
    ['ブロッキング', active, { ...humanOnly, reviewPass: false, bypass: { eligible: false, reasons: ['Reviewer のブロッキング指摘があります'], skipped: [] } }],
  ];
  for (const [name, state, acceptance] of cases) {
    const r = bypassRoute(state, acceptance);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.ok(r.reason.length > 0, `${name}: 理由が空`);
  }
});

// ---- evaluateMergeRoute の bypassMode ----

const routeIn: MergeRouteInput = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance: humanOnly, delegateMode: false, bypassMode: true };

test('merge-route：bypassMode 真かつ bypass.eligible なら、autoEligible でも委任でもなくても success', () => {
  const r = evaluateMergeRoute(routeIn);
  assert.equal(r.conclusion, 'success', r.summary);
  assert.equal(r.title, 'bypass モードの条件を満たしています');
  for (const s of bypassOk.skipped) assert.ok(r.summary.includes(s), `飛ばした理由を summary に: ${r.summary}`);
});

test('merge-route：bypassMode が偽・省略（ラベルが外れた）、または bypass.eligible が偽・無いなら failure', () => {
  for (const input of [
    { ...routeIn, bypassMode: false },
    { ...routeIn, bypassMode: undefined },
    { ...routeIn, acceptance: { ...humanOnly, bypass: { eligible: false, reasons: ['範囲外'], skipped: [] } } },
    { ...routeIn, acceptance: { ...humanOnly, bypass: undefined } },
  ]) {
    const r = evaluateMergeRoute(input);
    assert.equal(r.conclusion, 'failure', JSON.stringify(input.bypassMode));
    assert.ok(r.summary.includes('Risk レベルが critical'), r.summary);
  }
});

test('merge-route：bypass でも agent:hold・停止・人の PR・Stacked・受け付けなしは failure', () => {
  const cases: [string, Partial<MergeRouteInput>][] = [
    ['hold', { hold: true }],
    ['停止', { autoMergeMode: false }],
    ['人の PR', { isAgentPr: false }],
    ['stacked', { stacked: true }],
    ['受け付けなし', { acceptance: null }],
  ];
  for (const [name, patch] of cases) {
    assert.equal(evaluateMergeRoute({ ...routeIn, ...patch }).conclusion, 'failure', name);
  }
});

test('merge-route：bypass でも auto-merge が無ければ Human Merge 経路として success', () => {
  assert.equal(evaluateMergeRoute({ ...routeIn, autoMergeEnabled: false }).title, 'auto-merge なし（Human Merge 経路）');
});

test('merge-route：autoEligible・委任で乗る受け付けは、bypassMode が真でも今までどおりのタイトル', () => {
  const auto: Acceptance = { ...humanOnly, riskLevel: 'low', riskOk: true, guardrail: [], autoEligible: true, reasons: [] };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: auto }).title, '自動 Merge 条件を満たしています');
  const delegated: Acceptance = { ...humanOnly, delegate: { ...delegateNo, eligible: true, reasons: [], exclude: [] } };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: delegated, delegateMode: true }).title, '委任承認（計画＋Merge）の条件を満たしています');
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: delegated, delegateMode: false }).title, 'bypass モードの条件を満たしています', '委任が無効なら bypass で通す');
});

// ---- 委任しないパスに bypass の本体が入る ----

test('delegateExcludeFiles：bypass の本体（harness/gates/bypass.ts・bypass-merge.ts）は委任しないパスに当たる', () => {
  const files = ['harness/gates/bypass.ts', 'harness/gates/bypass-merge.ts'];
  assert.deepEqual(delegateExcludeFiles(loadConfig(), files), [...files].sort());
});
