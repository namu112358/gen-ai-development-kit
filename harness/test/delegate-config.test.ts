// 委任承認の設定（delegateConfig）と、ダッシュボードのラベルから決まる委任承認の状態（delegateState）を確かめる（Issue #241）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELEGATE_DEFAULTS, delegateConfig, type HarnessConfig } from '../lib/config.ts';
import { delegateState } from '../lib/delegate.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { APP, config } from './support/gate-fixtures.ts';

const { planLabel: PLAN, mergeLabel: MERGE } = delegateConfig(config);
const NOW = new Date('2026-09-29T12:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

const dashboard = (...labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
const labeled = (name: string, created_at: string | undefined, login = 'me'): TimelineEvent => ({ event: 'labeled', created_at, actor: { login }, label: { name } });
const unlabeled = (name: string, created_at: string, login = 'me'): TimelineEvent => ({ event: 'unlabeled', created_at, actor: { login }, label: { name } });

/** delegate・delegateMerge を外した設定に patch を足す */
function withDelegate(patch: Pick<HarnessConfig, 'delegate' | 'delegateMerge'>): HarnessConfig {
  const c: HarnessConfig = { ...config };
  delete c.delegate;
  delete c.delegateMerge;
  return { ...c, ...patch };
}

// ---- delegateConfig ----

test('DELEGATE_DEFAULTS：既定のラベルは agent:delegate-plan と agent:delegate-merge', () => {
  assert.deepEqual({ ...DELEGATE_DEFAULTS }, { planLabel: 'agent:delegate-plan', mergeLabel: 'agent:delegate-merge' });
});

test('delegateConfig：設定が無ければ既定値、harness.config.json では agent:delegate-plan と agent:delegate-merge', () => {
  assert.deepEqual(delegateConfig({}), { planLabel: 'agent:delegate-plan', mergeLabel: 'agent:delegate-merge' });
  assert.deepEqual(delegateConfig(config), { planLabel: 'agent:delegate-plan', mergeLabel: 'agent:delegate-merge' });
});

test('delegateConfig：delegate の planLabel・mergeLabel を読む（片方だけならもう片方は既定値）', () => {
  assert.deepEqual(delegateConfig({ delegate: { planLabel: 'x:plan', mergeLabel: 'x:merge' } }), { planLabel: 'x:plan', mergeLabel: 'x:merge' });
  assert.deepEqual(delegateConfig({ delegate: { planLabel: 'x:plan' } }), { planLabel: 'x:plan', mergeLabel: 'agent:delegate-merge' });
  assert.deepEqual(delegateConfig({ delegate: { mergeLabel: 'x:merge' } }), { planLabel: 'agent:delegate-plan', mergeLabel: 'x:merge' });
});

test('delegateConfig：古い delegateMerge.label だけでも mergeLabel として読む（hours・minRemainingMinutes は結果に出ない）', () => {
  assert.deepEqual(delegateConfig({ delegateMerge: { label: 'old:merge', hours: 2, minRemainingMinutes: 30 } }), { planLabel: 'agent:delegate-plan', mergeLabel: 'old:merge' });
  assert.deepEqual(delegateConfig({ delegateMerge: { hours: 5 } }), { planLabel: 'agent:delegate-plan', mergeLabel: 'agent:delegate-merge' });
});

test('delegateConfig：delegate と delegateMerge の両方があれば delegate が優先する', () => {
  assert.deepEqual(delegateConfig({ delegate: { mergeLabel: 'new:merge' }, delegateMerge: { label: 'old:merge' } }), { planLabel: 'agent:delegate-plan', mergeLabel: 'new:merge' });
  assert.deepEqual(delegateConfig({ delegate: { planLabel: 'new:plan' }, delegateMerge: { label: 'old:merge' } }), { planLabel: 'new:plan', mergeLabel: 'old:merge' });
});

// ---- delegateState：有効 ----

test('delegateState：人が agent:delegate-merge を付けていれば plan+merge（active・planActive とも真、label は merge ラベル）', () => {
  const since = hoursAgo(1);
  const s = delegateState(dashboard(MERGE), [labeled(MERGE, since)], config, NOW);
  assert.equal(s.mode, 'plan+merge', s.reason);
  assert.equal(s.active, true);
  assert.equal(s.planActive, true);
  assert.equal(s.label, MERGE);
  assert.equal(Date.parse(s.since!), Date.parse(since));
  assert.equal(s.by, 'me');
  assert.equal(typeof s.reason, 'string');
  assert.ok(!('until' in s), '期限（until）は無くなった');
});

test('delegateState：人が agent:delegate-plan だけを付けていれば plan（active は偽、planActive は真、label は plan ラベル）', () => {
  const since = hoursAgo(1);
  const s = delegateState(dashboard(PLAN), [labeled(PLAN, since)], config, NOW);
  assert.equal(s.mode, 'plan', s.reason);
  assert.equal(s.active, false, '計画のみでは Merge は委ねない');
  assert.equal(s.planActive, true);
  assert.equal(s.label, PLAN);
  assert.equal(Date.parse(s.since!), Date.parse(since));
  assert.equal(s.by, 'me');
});

test('delegateState：両方のラベルが有効なら plan+merge（label は merge ラベル）', () => {
  const s = delegateState(dashboard(PLAN, MERGE), [labeled(PLAN, hoursAgo(3)), labeled(MERGE, hoursAgo(1), 'you')], config, NOW);
  assert.equal(s.mode, 'plan+merge');
  assert.equal(s.active, true);
  assert.equal(s.planActive, true);
  assert.equal(s.label, MERGE);
  assert.equal(s.by, 'you');
});

test('delegateState：merge ラベルが無効（Bot が付けた）でも plan ラベルが有効なら plan', () => {
  const s = delegateState(dashboard(PLAN, MERGE), [labeled(PLAN, hoursAgo(1)), labeled(MERGE, hoursAgo(1), 'someone[bot]')], config, NOW);
  assert.equal(s.mode, 'plan', s.reason);
  assert.equal(s.active, false);
  assert.equal(s.planActive, true);
  assert.equal(s.label, PLAN);
});

test('delegateState：期限は無い（付けてから 2・24・1000 時間たっても有効）', () => {
  for (const h of [2, 24, 1000]) {
    const m = delegateState(dashboard(MERGE), [labeled(MERGE, hoursAgo(h))], config, NOW);
    assert.equal(m.mode, 'plan+merge', `${h} 時間: ${m.reason}`);
    assert.equal(m.active, true, `${h} 時間`);
    const p = delegateState(dashboard(PLAN), [labeled(PLAN, hoursAgo(h))], config, NOW);
    assert.equal(p.mode, 'plan', `${h} 時間: ${p.reason}`);
    assert.equal(p.planActive, true, `${h} 時間`);
  }
});

test('delegateState：古い設定の delegateMerge.hours は読まない（hours: 1 でも 1000 時間後に有効）', () => {
  const old = withDelegate({ delegateMerge: { label: MERGE, hours: 1, minRemainingMinutes: 30 } });
  const s = delegateState(dashboard(MERGE), [labeled(MERGE, hoursAgo(1000))], old, NOW);
  assert.equal(s.active, true, s.reason);
});

test('delegateState：設定のラベル名（delegate・古い delegateMerge.label）で判定する', () => {
  const custom = withDelegate({ delegate: { planLabel: 'x:plan', mergeLabel: 'x:merge' } });
  assert.equal(delegateState(dashboard('x:plan'), [labeled('x:plan', hoursAgo(1))], custom, NOW).mode, 'plan');
  assert.equal(delegateState(dashboard('x:merge'), [labeled('x:merge', hoursAgo(1))], custom, NOW).mode, 'plan+merge');
  assert.equal(delegateState(dashboard(MERGE), [labeled(MERGE, hoursAgo(1))], custom, NOW).mode, 'off', '既定の名前は見ない');
  const old = withDelegate({ delegateMerge: { label: 'old:merge' } });
  assert.equal(delegateState(dashboard('old:merge'), [labeled('old:merge', hoursAgo(1))], old, NOW).mode, 'plan+merge');
});

// ---- delegateState：無効 ----

function assertOff(s: ReturnType<typeof delegateState>, reason: string | RegExp, name: string): void {
  assert.equal(s.mode, 'off', `${name}: ${s.reason}`);
  assert.equal(s.active, false, name);
  assert.equal(s.planActive, false, name);
  if (typeof reason === 'string') assert.ok(s.reason.includes(reason), `${name}: reason「${s.reason}」に「${reason}」が無い`);
  else assert.match(s.reason, reason, name);
}

test('delegateState：ダッシュボードが無い・どちらのラベルも無いなら off（ラベルが無い）', () => {
  assertOff(delegateState(null, [labeled(MERGE, hoursAgo(1))], config, NOW), 'ラベルが無い', 'ダッシュボードなし');
  assertOff(delegateState(dashboard(), [labeled(MERGE, hoursAgo(1)), labeled(PLAN, hoursAgo(1))], config, NOW), 'ラベルが無い', 'ラベルなし');
  assertOff(delegateState(dashboard('priority:high'), [], config, NOW), 'ラベルが無い', '関係の無いラベルだけ');
});

test('delegateState：ラベルはあるが付けた記録が無い・最後が外した記録なら off', () => {
  for (const label of [PLAN, MERGE]) {
    assertOff(delegateState(dashboard(label), [], config, NOW), 'ラベルを付けた記録が無い', `${label}: 記録なし`);
    assertOff(delegateState(dashboard(label), [labeled(label, hoursAgo(2)), unlabeled(label, hoursAgo(1))], config, NOW), 'ラベルを付けた記録が無い', `${label}: 外した記録が最後`);
    assertOff(delegateState(dashboard(label), [labeled(label === PLAN ? MERGE : PLAN, hoursAgo(1))], config, NOW), 'ラベルを付けた記録が無い', `${label}: 別のラベルの記録だけ`);
  }
});

test('delegateState：付けた時刻が読めないなら off', () => {
  for (const label of [PLAN, MERGE]) {
    assertOff(delegateState(dashboard(label), [labeled(label, undefined)], config, NOW), '付けた時刻が読めない', `${label}: created_at なし`);
    assertOff(delegateState(dashboard(label), [labeled(label, 'not-a-date')], config, NOW), '付けた時刻が読めない', `${label}: 読めない created_at`);
  }
});

test('delegateState：App（<appSlug>[bot]）や [bot] が付けたなら off（人以外が付けた）', () => {
  for (const label of [PLAN, MERGE]) {
    assertOff(delegateState(dashboard(label), [labeled(label, hoursAgo(1), APP)], config, NOW), '人以外が付けた', `${label}: App`);
    assertOff(delegateState(dashboard(label), [labeled(label, hoursAgo(1), 'someone[bot]')], config, NOW), '人以外が付けた', `${label}: [bot]`);
  }
});

test('delegateState：付けた時刻が未来なら off', () => {
  for (const label of [PLAN, MERGE]) {
    assertOff(delegateState(dashboard(label), [labeled(label, hoursAgo(-1))], config, NOW), '付けた時刻が未来', label);
  }
});

test('delegateState：停止スイッチ（autoMergeStopLabel）がダッシュボードにあれば、計画の委任も Merge の委任も off', () => {
  for (const labels of [[PLAN], [MERGE], [PLAN, MERGE]]) {
    const events = labels.map((l) => labeled(l, hoursAgo(1)));
    assertOff(delegateState(dashboard(...labels, config.autoMergeStopLabel), events, config, NOW), '停止スイッチ', labels.join('+'));
  }
});
