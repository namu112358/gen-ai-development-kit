// Jev のラベルの下限をラベルごとに分ける（#229）：labelThreshold・decideJevLabels・decideReapply（純粋な関数）と、
// harness.config.json の値を確かめる。今の記録の確率（65〜79% の medium）が見直した下限でどう扱われるかもここで見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { decideJevLabels, decideReapply, labelThreshold } from '../gates/label-apply.ts';
import { config } from './support/gate-fixtures.ts';

type Thresholds = HarnessConfig['jev']['thresholds'];
const withThresholds = (patch: Partial<Thresholds>, base: Thresholds = { lowProbability: 0.9, noulSafe: 0.9 }): HarnessConfig => ({
  ...config,
  jev: { ...config.jev, thresholds: { ...base, ...patch } },
});
/** 見直した下限（harness.config.json と同じ値を明示する） */
const reviewed = withThresholds({ labelProbability: 0.8, labelProbabilityByLabel: { 'priority:medium': 0.5 } });
const noThreshold = withThresholds({ labelProbabilityByLabel: { 'priority:medium': 0.5 } });

const both = { priority: true, area: true };
const onlyPriority = { priority: true, area: false };
const summary = (priority: [string, number], area: [string, number] = ['docs', 0.99]) => ({ priority, area });

// --- 設定 ---

test('harness.config.json：labelProbability は 0.8 のまま、priority:medium だけ下限 0.5', () => {
  const loaded = loadConfig();
  assert.equal(loaded.jev.thresholds.labelProbability, 0.8);
  assert.deepEqual(loaded.jev.thresholds.labelProbabilityByLabel, { 'priority:medium': 0.5 });
  assert.equal(labelThreshold(loaded, 'priority:medium'), 0.5);
  assert.equal(labelThreshold(loaded, 'priority:high'), 0.8);
  assert.equal(labelThreshold(loaded, 'area:docs'), 0.8);
});

// --- labelThreshold ---

test('labelThreshold：byLabel にあるラベルはその値、無いラベルは labelProbability', () => {
  assert.equal(labelThreshold(reviewed, 'priority:medium'), 0.5);
  assert.equal(labelThreshold(reviewed, 'priority:high'), 0.8);
  assert.equal(labelThreshold(reviewed, 'priority:low'), 0.8);
  assert.equal(labelThreshold(reviewed, 'area:harness'), 0.8);
  assert.equal(labelThreshold(withThresholds({ labelProbability: 0.8 }), 'priority:medium'), 0.8, 'byLabel が無ければ labelProbability');
});

test('labelThreshold：labelProbability が未設定なら、byLabel があっても undefined', () => {
  assert.equal(labelThreshold(noThreshold, 'priority:medium'), undefined);
  assert.equal(labelThreshold(noThreshold, 'priority:high'), undefined);
  assert.equal(labelThreshold(withThresholds({}), 'priority:medium'), undefined);
});

test('labelThreshold：byLabel の値が 0〜1 の有限の数でなければ無視して labelProbability を使う（0 と 1 は使う）', () => {
  const bad: unknown[] = [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, true];
  for (const v of bad) {
    const c = withThresholds({ labelProbability: 0.8, labelProbabilityByLabel: { 'priority:medium': v as number } });
    assert.equal(labelThreshold(c, 'priority:medium'), 0.8, `値 ${String(v)} は無視する`);
  }
  assert.equal(labelThreshold(withThresholds({ labelProbability: 0.8, labelProbabilityByLabel: { 'priority:medium': 0 } }), 'priority:medium'), 0);
  assert.equal(labelThreshold(withThresholds({ labelProbability: 0.8, labelProbabilityByLabel: { 'priority:medium': 1 } }), 'priority:medium'), 1);
});

// --- decideJevLabels（今の記録の確率） ---

test('decideJevLabels：今の記録の medium（#216 0.79・#218 0.66・#219 0.65・#229 0.66）は見直した下限で付く', () => {
  for (const p of [0.79, 0.66, 0.65, 0.66]) {
    const r = decideJevLabels(reviewed, summary(['medium', p]), onlyPriority);
    assert.deepEqual(r.map((x) => [x.label, x.applied]), [['priority:medium', true]], `medium ${p}`);
    assert.equal(r[0]!.reason, undefined);
  }
  const edge = decideJevLabels(reviewed, summary(['medium', 0.5]), onlyPriority);
  assert.equal(edge[0]!.applied, true, '下限ちょうどは付く');
});

test('decideJevLabels：medium 0.49 は付かず、理由に medium の下限 50% が出る', () => {
  const r = decideJevLabels(reviewed, summary(['medium', 0.49]), onlyPriority);
  assert.deepEqual(r.map((x) => [x.label, x.applied]), [['priority:medium', false]]);
  assert.equal(r[0]!.reason, '確率 49% が下限 50% 未満');
});

test('decideJevLabels：high 0.79 と area（docs）0.79 は付かず、理由に下限 80% が出る', () => {
  const r = decideJevLabels(reviewed, summary(['high', 0.79], ['docs', 0.79]), both);
  assert.deepEqual(r.map((x) => [x.label, x.applied]), [['priority:high', false], ['area:docs', false]]);
  assert.equal(r[0]!.reason, '確率 79% が下限 80% 未満');
  assert.equal(r[1]!.reason, '確率 79% が下限 80% 未満');

  const ok = decideJevLabels(reviewed, summary(['high', 0.8], ['docs', 0.8]), both);
  assert.deepEqual(ok.map((x) => [x.label, x.applied]), [['priority:high', true], ['area:docs', true]]);
});

test('decideJevLabels：labelProbability が未設定なら、byLabel があっても付けない（既存の文言）', () => {
  const r = decideJevLabels(noThreshold, summary(['medium', 0.99], ['docs', 0.99]), both);
  assert.ok(r.every((x) => !x.applied));
  for (const x of r) assert.equal(x.reason, '`jev.thresholds.labelProbability` が未設定のため付けません（提案のみ）');
});

test('decideJevLabels：byLabel の値がおかしければ labelProbability で判定する', () => {
  const c = withThresholds({ labelProbability: 0.8, labelProbabilityByLabel: { 'priority:medium': 1.5 } });
  const r = decideJevLabels(c, summary(['medium', 0.66]), onlyPriority);
  assert.equal(r[0]!.applied, false);
  assert.equal(r[0]!.reason, '確率 66% が下限 80% 未満');
});

// --- decideReapply（下限に届かず付かなかった既存の Issue） ---

const item = (label: string | null, probability: unknown, question = 'priority', choice = 'medium') => ({
  question, choice, probability, label, reason: '確率 66% が下限 80% 未満',
});
const record = (notApplied: unknown) => ({ version: 1, model: 'm', answers: {}, threshold: 0.8, added: [], notApplied });

test('decideReapply：#229 と同じ記録（medium 0.66 が下限 80% で付かなかった）は、見直した下限で付け直す', () => {
  const r = decideReapply(reviewed, record([item('priority:medium', 0.66)]), onlyPriority);
  assert.deepEqual(r, [{ label: 'priority:medium', probability: 0.66, threshold: 0.5 }]);
});

test('decideReapply：notApplied が配列でない古い記録や、記録でない値は []', () => {
  assert.deepEqual(decideReapply(reviewed, { version: 1, model: 'm', answers: {}, added: [] }, both), []);
  assert.deepEqual(decideReapply(reviewed, record('priority:medium'), both), []);
  assert.deepEqual(decideReapply(reviewed, record({ 0: item('priority:medium', 0.66) }), both), []);
  assert.deepEqual(decideReapply(reviewed, null, both), []);
  assert.deepEqual(decideReapply(reviewed, undefined, both), []);
  assert.deepEqual(decideReapply(reviewed, 'x', both), []);
});

test('decideReapply：label が null・文字列でないもの、確率が数でないものは返さない', () => {
  const r = decideReapply(reviewed, record([
    item(null, 0.99, 'area', 'other'),
    { question: 'priority', choice: 'medium', probability: 0.9, label: 3 },
    item('priority:medium', '0.9'),
    item('priority:medium', Number.NaN),
    item('priority:medium', null),
    'priority:medium',
    null,
  ]), both);
  assert.deepEqual(r, []);
});

test('decideReapply：今は足りている（needs が false）ラベルと、無いラベルは返さない', () => {
  const rec = record([item('priority:medium', 0.66), item('area:docs', 0.95, 'area', 'docs')]);
  assert.deepEqual(decideReapply(reviewed, rec, { priority: false, area: false }), []);
  assert.deepEqual(decideReapply(reviewed, rec, { priority: false, area: true }), [{ label: 'area:docs', probability: 0.95, threshold: 0.8 }]);
  assert.deepEqual(decideReapply(reviewed, rec, { priority: true, area: false }), [{ label: 'priority:medium', probability: 0.66, threshold: 0.5 }]);

  const unknown = record([item('priority:urgent', 0.99), item('area:no-such-area', 0.99, 'area', 'no-such-area'), item('type:feat', 0.99)]);
  assert.deepEqual(decideReapply(reviewed, unknown, both), [], 'PRIORITIES・classification.areas に無いラベルは付けない');
});

test('decideReapply：下限に届かないものは返さない', () => {
  const r = decideReapply(reviewed, record([item('priority:high', 0.79, 'priority', 'high'), item('priority:medium', 0.49)]), both);
  assert.deepEqual(r, []);
  const area = decideReapply(reviewed, record([item('area:docs', 0.79, 'area', 'docs')]), both);
  assert.deepEqual(area, []);
});

test('decideReapply：同じラベルは1回だけ返す', () => {
  const r = decideReapply(reviewed, record([item('priority:medium', 0.66), item('priority:medium', 0.7)]), onlyPriority);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.label, 'priority:medium');
});

test('decideReapply：labelProbability が未設定なら []（byLabel があっても）', () => {
  assert.deepEqual(decideReapply(noThreshold, record([item('priority:medium', 0.99)]), both), []);
});
