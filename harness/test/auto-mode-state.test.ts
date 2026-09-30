// auto mode の有効・無効（autoModeState）と設定（autoModeConfig）、設定ファイル・ラベルの一覧を確かめる（Issue #342）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AUTO_MODE_LABEL_DEFAULT, allLabelDefs, loadConfig, type HarnessConfig } from '../lib/config.ts';
import { AUTO_MODE_DANGER_SAFE_DEFAULT, AUTO_MODE_JEV_DEFAULTS, autoModeConfig, autoModeState } from '../lib/auto-mode.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { APP, config } from './support/gate-fixtures.ts';

const LABEL = autoModeConfig(config).label;
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();
const dashboard = (...labels: string[]) => ({ labels: labels.map((name) => ({ name })) });
const labeled = (created_at: string, login = 'me', name = LABEL): TimelineEvent => ({ event: 'labeled', created_at, actor: { login }, label: { name } });

// ---- autoModeState ----

test('autoModeState：人が付けたラベルなら active、since・by を返す', () => {
  const since = hoursAgo(1);
  const s = autoModeState(dashboard(LABEL), [labeled(since)], config);
  assert.equal(s.active, true, s.reason);
  assert.equal(Date.parse(s.since!), Date.parse(since));
  assert.equal(s.by, 'me');
});

test('autoModeState：ラベルは文字列の一覧でも読める', () => {
  assert.equal(autoModeState({ labels: [LABEL] }, [labeled(hoursAgo(1))], config).active, true);
});

test('autoModeState：ラベルが無い・ダッシュボードが無い・付けた記録が無いなら active でない', () => {
  assert.equal(autoModeState(dashboard(), [labeled(hoursAgo(1))], config).active, false, 'ラベルが無い');
  assert.equal(autoModeState(null, [labeled(hoursAgo(1))], config).active, false, 'ダッシュボードが無い');
  assert.equal(autoModeState(dashboard(LABEL), [], config).active, false, '記録が無い');
});

test('autoModeState：最後に付けたのが App か Bot なら active でない', () => {
  assert.equal(autoModeState(dashboard(LABEL), [labeled(hoursAgo(1), APP)], config).active, false, 'App');
  assert.equal(autoModeState(dashboard(LABEL), [labeled(hoursAgo(1), 'someone[bot]')], config).active, false, '[bot]');
});

test('autoModeState：停止スイッチがあれば active でなく、理由がある', () => {
  const s = autoModeState(dashboard(LABEL, config.autoMergeStopLabel), [labeled(hoursAgo(1))], config);
  assert.equal(s.active, false);
  assert.ok(s.reason.length > 0);
});

test('autoModeState：設定の label で読むラベルが変わる', () => {
  const c: HarnessConfig = { ...config, autoMode: { label: 'agent:auto-x' } };
  const ev = [labeled(hoursAgo(1), 'me', 'agent:auto-x')];
  assert.equal(autoModeState(dashboard('agent:auto-x'), ev, c).active, true);
  assert.equal(autoModeState(dashboard(AUTO_MODE_LABEL_DEFAULT), [labeled(hoursAgo(1), 'me', AUTO_MODE_LABEL_DEFAULT)], c).active, false);
});

// ---- autoModeConfig ----

test('autoModeConfig：節が無ければ既定値', () => {
  const r = autoModeConfig({});
  assert.equal(r.label, AUTO_MODE_LABEL_DEFAULT);
  assert.equal(r.dangerSafe, AUTO_MODE_DANGER_SAFE_DEFAULT);
  assert.equal(AUTO_MODE_DANGER_SAFE_DEFAULT, 0.9);
  assert.deepEqual(r.plan, AUTO_MODE_JEV_DEFAULTS.plan);
  assert.deepEqual(r.pr, AUTO_MODE_JEV_DEFAULTS.pr);
  for (const q of [AUTO_MODE_JEV_DEFAULTS.plan, AUTO_MODE_JEV_DEFAULTS.pr]) {
    assert.ok(q.instructions.length > 0 && q.criteria.true.length > 0 && q.criteria.false.length > 0);
  }
});

test('autoModeConfig：設定の値で上書きできる', () => {
  const plan = { instructions: 'p?', criteria: { true: 'pt', false: 'pf' } };
  const pr = { instructions: 'r?', criteria: { true: 'rt', false: 'rf' } };
  const r = autoModeConfig({ autoMode: { label: 'agent:x', jev: { dangerSafe: 0.5, plan, pr } } });
  assert.deepEqual(r, { label: 'agent:x', dangerSafe: 0.5, plan, pr });
});

test('autoModeConfig：誤った値は throw', () => {
  const q = (patch: object) => ({ instructions: 'i', criteria: { true: 't', false: 'f' }, ...patch });
  const bad: [string, unknown][] = [
    ['label が空', { label: '' }],
    ['label が文字列でない', { label: 1 }],
    ['dangerSafe が数でない', { jev: { dangerSafe: '0.9' } }],
    ['dangerSafe が NaN', { jev: { dangerSafe: Number.NaN } }],
    ['dangerSafe が 0 未満', { jev: { dangerSafe: -0.1 } }],
    ['dangerSafe が 1 超', { jev: { dangerSafe: 1.1 } }],
    ['plan の instructions が空', { jev: { plan: q({ instructions: '' }) } }],
    ['pr の criteria.true が空', { jev: { pr: q({ criteria: { true: '', false: 'f' } }) } }],
    ['pr の criteria.false が文字列でない', { jev: { pr: q({ criteria: { true: 't', false: 1 } }) } }],
  ];
  for (const [name, autoMode] of bad) {
    assert.throws(() => autoModeConfig({ autoMode } as Pick<HarnessConfig, 'autoMode'>), Error, name);
  }
});

// ---- 設定ファイル・ラベルの一覧 ----

const template = JSON.parse(readFileSync(new URL('../templates/harness.config.json', import.meta.url), 'utf8')) as HarnessConfig;
const EXCLUDE = ['harness/lib/auto-mode.ts', '.claude/agents/plan-critic.md', 'harness/lib/plan.ts', 'harness/lib/session-inputs.ts'];

for (const [name, c] of [['harness.config.json', loadConfig()], ['雛形', template]] as const) {
  test(`${name}：delegateMergeExclude に auto mode の判定に関わるファイルがある`, () => {
    const exclude = (c as { delegateMergeExclude?: string[] }).delegateMergeExclude ?? [];
    for (const f of EXCLUDE) assert.ok(exclude.includes(f), `${f} が無い`);
  });

  test(`${name}：autoMode の節があり、値がコードの既定と同じ`, () => {
    assert.ok(c.autoMode, 'autoMode の節が無い');
    const r = autoModeConfig(c);
    assert.equal(r.label, AUTO_MODE_LABEL_DEFAULT);
    assert.equal(r.dangerSafe, AUTO_MODE_DANGER_SAFE_DEFAULT);
    assert.deepEqual(r.plan, AUTO_MODE_JEV_DEFAULTS.plan);
    assert.deepEqual(r.pr, AUTO_MODE_JEV_DEFAULTS.pr);
  });
}

test('ラベルの一覧に auto mode のラベルがある（説明は 100 文字以下）', () => {
  const def = allLabelDefs(loadConfig()).find((d) => d.name === AUTO_MODE_LABEL_DEFAULT);
  assert.ok(def, `${AUTO_MODE_LABEL_DEFAULT} が無い`);
  assert.equal(AUTO_MODE_LABEL_DEFAULT, 'agent:auto-mode');
  assert.ok(def.description.length <= 100);
});
