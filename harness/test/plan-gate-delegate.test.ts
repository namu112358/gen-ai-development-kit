// 計画ゲート（evaluatePlanGate）の飛ばせる理由（skippable）と、委任承認をかける delegatePlanGate・delegatePlanExclude の組み合わせを確かめる（Issue #241）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegateConfig, type HarnessConfig } from '../lib/config.ts';
import { delegatePlanExclude, delegatePlanGate, type DelegateState } from '../lib/delegate.ts';
import type { SplitChild } from '../lib/epic.ts';
import { evaluatePlanGate, type GateResult, type Plan } from '../lib/plan.ts';
import { config } from './support/gate-fixtures.ts';

const { planLabel: PLAN, mergeLabel: MERGE } = delegateConfig(config);
const SINCE = '2026-09-29T10:00:00.000Z';

/** ガードレールに当たり、delegateMergeExclude に当たらない files */
const GUARDED = 'harness/lib/plan.ts';
const GUARD_REASON = (...files: string[]) => `ガードレールに触れます（人が実装して Merge する）: ${files.join(', ')}`;
const RISK_REASON = (risk: string) => `想定 Risk が ${risk} です`;

const basePlan: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
const planOf = (patch: Partial<Plan> = {}): Plan => ({ ...basePlan, ...patch });

// ---- 委任の状態 ----

const OFF: DelegateState = { mode: 'off', active: false, planActive: false, label: null, since: null, by: null, reason: 'ラベルが無い' };
const PLAN_ONLY: DelegateState = { mode: 'plan', active: false, planActive: true, label: PLAN, since: SINCE, by: 'me', reason: '委任承認（計画のみ）' };
const PLAN_MERGE: DelegateState = { mode: 'plan+merge', active: true, planActive: true, label: MERGE, since: SINCE, by: 'you', reason: '委任承認（計画＋Merge）' };
/** ラベルはあるが無効（Bot が付けた） */
const INVALID: DelegateState = { mode: 'off', active: false, planActive: false, label: MERGE, since: SINCE, by: 'someone[bot]', reason: '人以外が付けた' };
/** 停止スイッチで無効 */
const STOPPED: DelegateState = { mode: 'off', active: false, planActive: false, label: PLAN, since: SINCE, by: 'me', reason: '停止スイッチが優先' };

const ACTIVE: [string, DelegateState][] = [['計画のみ', PLAN_ONLY], ['計画＋Merge', PLAN_MERGE]];
const INACTIVE: [string, DelegateState][] = [['委任なし', OFF], ['無効（人以外）', INVALID], ['無効（停止スイッチ）', STOPPED]];
const ALL: [string, DelegateState][] = [...INACTIVE, ...ACTIVE];

const split = (n: number): SplitChild[] =>
  Array.from({ length: n }, (_, i) => ({ title: `feat: 子 ${i}`, goal: 'g', requirements: ['r'], acceptanceCriteria: ['a'], files: [`docs/c${i}/**`], dependsOn: [] }));

/** 設定から delegateMergeExclude を外したもの */
const noExclude: HarnessConfig = (() => {
  const c: HarnessConfig = { ...config };
  delete c.delegateMergeExclude;
  return c;
})();

/** 委任で通ったことを確かめる */
function assertDelegated(r: GateResult, skipped: string[], state: DelegateState, name: string): void {
  assert.equal(r.pass, true, `${name}: 通るべき: ${r.reasons.join(' / ')}`);
  assert.deepEqual(r.reasons, [], name);
  assert.deepEqual(r.delegated, { skipped, label: state.label, mode: state.mode, by: state.by, since: state.since }, name);
}

/** 委任でも止まったことを確かめる（元の理由は残る） */
function assertStopped(r: GateResult, gate: GateResult, name: string): void {
  assert.equal(r.pass, false, `${name}: 止まるべき`);
  assert.equal(r.delegated, undefined, `${name}: 止めたのに delegated がある`);
  for (const reason of gate.reasons) assert.ok(r.reasons.includes(reason), `${name}: 元の理由「${reason}」が消えた: ${r.reasons.join(' / ')}`);
}

// ---- evaluatePlanGate の skippable ----

test('evaluatePlanGate：飛ばせる理由の無い結果は今と同じ { pass, reasons }（skippable・delegated が無い）', () => {
  assert.deepEqual(evaluatePlanGate(planOf(), 3, config), { pass: true, reasons: [] });
  assert.deepEqual(evaluatePlanGate(planOf({ risk: 'medium' }), 3, config), { pass: true, reasons: [] });
  assert.deepEqual(evaluatePlanGate(planOf({ needsHuman: true }), 3, config), { pass: false, reasons: ['Planner が人間の判断が必要と申告しています'] });
  assert.deepEqual(evaluatePlanGate(planOf({ acChangeProposed: true }), 3, config), { pass: false, reasons: ['要件・AC の変更提案があります'] });
  assert.deepEqual(evaluatePlanGate(planOf({ openQuestions: ['?'] }), 3, config), { pass: false, reasons: ['未解決の質問が 1 件あります'] });
  assert.deepEqual(evaluatePlanGate(planOf({ issue: 4 }), 3, config), { pass: false, reasons: ['計画の issue 番号（#4）がこの Issue（#3）と一致しません'] });
  assert.deepEqual(evaluatePlanGate(planOf({ files: [] }), 3, config), { pass: false, reasons: ['触るファイル一覧（files）がありません'] });
});

test('evaluatePlanGate：ガードレール・想定 Risk high / critical の理由は、その文字列のまま skippable に入る', () => {
  const g = evaluatePlanGate(planOf({ files: [GUARDED] }), 3, config);
  assert.equal(g.pass, false);
  assert.deepEqual(g.reasons, [GUARD_REASON(GUARDED)]);
  assert.deepEqual(g.skippable, [GUARD_REASON(GUARDED)]);
  assert.deepEqual(g.guardrail, [GUARDED]);

  for (const risk of ['high', 'critical'] as const) {
    const r = evaluatePlanGate(planOf({ risk }), 3, config);
    assert.deepEqual(r.reasons, [RISK_REASON(risk)], risk);
    assert.deepEqual(r.skippable, [RISK_REASON(risk)], risk);
  }

  const both = evaluatePlanGate(planOf({ risk: 'critical', files: [GUARDED] }), 3, config);
  assert.deepEqual([...both.skippable!].sort(), [GUARD_REASON(GUARDED), RISK_REASON('critical')].sort());
  assert.deepEqual([...both.reasons].sort(), [GUARD_REASON(GUARDED), RISK_REASON('critical')].sort());
});

test('evaluatePlanGate：飛ばせない理由が並んでも skippable にはガードレール・Risk だけが入る', () => {
  const g = evaluatePlanGate(planOf({ risk: 'high', files: [GUARDED], needsHuman: true, openQuestions: ['?'] }), 3, config);
  assert.equal(g.reasons.length, 4, g.reasons.join(' / '));
  assert.deepEqual([...g.skippable!].sort(), [GUARD_REASON(GUARDED), RISK_REASON('high')].sort());
  for (const s of g.skippable!) assert.ok(g.reasons.includes(s), `skippable「${s}」が reasons に無い`);
});

// ---- delegatePlanGate：飛ばせる理由だけの計画 ----

const SKIPPABLE_ONLY: [string, Plan][] = [
  ['ガードレールだけ', planOf({ files: [GUARDED] })],
  ['Risk high だけ', planOf({ risk: 'high' })],
  ['Risk critical だけ', planOf({ risk: 'critical' })],
  ['ガードレールと Risk critical', planOf({ risk: 'critical', files: [GUARDED, 'docs/a.md'] })],
  ['正しい split とガードレール', planOf({ files: [GUARDED], split: split(2) })],
];

test('delegatePlanGate：飛ばせる理由だけで止まる計画は、計画の委任（計画のみ・計画＋Merge）が有効なら通り、delegated を残す', () => {
  for (const [name, plan] of SKIPPABLE_ONLY) {
    const gate = evaluatePlanGate(plan, 3, config);
    assert.equal(gate.pass, false, `${name}: 前提（委任なしでは止まる）`);
    for (const [mode, state] of ACTIVE) assertDelegated(delegatePlanGate(gate, plan, config, state), gate.skippable!, state, `${name} × ${mode}`);
  }
});

test('delegatePlanGate：委任が無い・無効（人以外が付けた・停止スイッチ）なら、飛ばせる理由だけの計画も止まる', () => {
  for (const [name, plan] of SKIPPABLE_ONLY) {
    const gate = evaluatePlanGate(plan, 3, config);
    for (const [mode, state] of INACTIVE) assertStopped(delegatePlanGate(gate, plan, config, state), gate, `${name} × ${mode}`);
  }
});

test('delegatePlanGate：委任で通した delegated に、飛ばした理由・ラベル・段階・付けた人・付けた時刻が入る', () => {
  const plan = planOf({ risk: 'critical', files: [GUARDED] });
  const gate = evaluatePlanGate(plan, 3, config);
  const r = delegatePlanGate(gate, plan, config, PLAN_MERGE);
  assert.equal(r.pass, true);
  assert.equal(r.delegated?.label, MERGE);
  assert.equal(r.delegated?.mode, 'plan+merge');
  assert.equal(r.delegated?.by, 'you');
  assert.equal(r.delegated?.since, SINCE);
  assert.deepEqual([...r.delegated!.skipped].sort(), [GUARD_REASON(GUARDED), RISK_REASON('critical')].sort());
  const p = delegatePlanGate(gate, plan, config, PLAN_ONLY);
  assert.equal(p.delegated?.label, PLAN);
  assert.equal(p.delegated?.mode, 'plan');
});

// ---- delegatePlanGate：委任でも止まる計画 ----

const NOT_SKIPPABLE: [string, Plan][] = [
  ['needsHuman', planOf({ files: [GUARDED], needsHuman: true, needsHumanReasons: ['r'] })],
  ['acChangeProposed', planOf({ files: [GUARDED], acChangeProposed: true })],
  ['openQuestions', planOf({ files: [GUARDED], openQuestions: ['?'] })],
  ['issue の不一致', planOf({ files: [GUARDED], issue: 4 })],
  ['files の欠落', planOf({ risk: 'high', files: [] })],
  ['files の書式の誤り', planOf({ files: [GUARDED, './docs/a.md'] })],
  ['files の書式の誤り（..）', planOf({ risk: 'critical', files: ['docs/../x.md'] })],
  ['split の不正', planOf({ files: [GUARDED], split: split(1) })],
];

test('delegatePlanGate：Planner の申告・issue の不一致・files の欠落と書式の誤り・split の不正は、どの委任でも止まる', () => {
  for (const [name, plan] of NOT_SKIPPABLE) {
    const gate = evaluatePlanGate(plan, 3, config);
    assert.equal(gate.pass, false, `${name}: 前提`);
    assert.ok((gate.skippable ?? []).length > 0, `${name}: 前提（飛ばせる理由も並ぶ）`);
    for (const [mode, state] of ALL) assertStopped(delegatePlanGate(gate, plan, config, state), gate, `${name} × ${mode}`);
  }
});

test('delegatePlanGate：split の検査で止まった結果（splitInvalid）は、理由が飛ばせるものだけでも止まる', () => {
  const plan = planOf({ files: [GUARDED], split: split(1) });
  const gate: GateResult = { pass: false, reasons: [GUARD_REASON(GUARDED)], skippable: [GUARD_REASON(GUARDED)], guardrail: [GUARDED], splitInvalid: true };
  for (const [mode, state] of ACTIVE) assertStopped(delegatePlanGate(gate, plan, config, state), gate, mode);
});

test('delegatePlanGate：skippable が無い・空の結果は、どの委任でも止まる（結果はそのまま）', () => {
  const plan = planOf({ needsHuman: true });
  const gate = evaluatePlanGate(plan, 3, config);
  for (const [mode, state] of ALL) assert.deepEqual(delegatePlanGate(gate, plan, config, state), gate, mode);
  const empty: GateResult = { pass: false, reasons: ['何か'], skippable: [] };
  for (const [mode, state] of ACTIVE) assertStopped(delegatePlanGate(empty, plan, config, state), empty, `空の skippable × ${mode}`);
});

test('delegatePlanGate：通る結果（pass）は、どの委任でもそのまま返す（delegated を付けない）', () => {
  const plan = planOf();
  const gate = evaluatePlanGate(plan, 3, config);
  for (const [mode, state] of ALL) assert.deepEqual(delegatePlanGate(gate, plan, config, state), { pass: true, reasons: [] }, mode);
});

// ---- delegatePlanGate：delegateMergeExclude・harness.config.json ----

const EXCLUDED: [string, string[], string[]][] = [
  ['delegateMergeExclude のパス（harness/gates/**）', ['harness/gates/on-comment.ts'], ['harness/gates/on-comment.ts']],
  ['delegateMergeExclude のファイル', ['harness/lib/delegate.ts'], ['harness/lib/delegate.ts']],
  ['harness.config.json', ['harness.config.json'], ['harness.config.json']],
  ['harness/** のような広いパターン', ['harness/**'], ['harness/**']],
  ['一部だけが当たる', [GUARDED, 'harness/gates/run.ts'], ['harness/gates/run.ts']],
];

test('delegatePlanGate：delegateMergeExclude・harness.config.json に重なりうる files の計画は、委任でも止まり、「委任承認でも通しません」と当たったパターンを足す', () => {
  for (const [name, files, hit] of EXCLUDED) {
    const plan = planOf({ files });
    const gate = evaluatePlanGate(plan, 3, config);
    assert.equal(gate.pass, false, `${name}: 前提`);
    assert.ok((gate.skippable ?? []).length > 0, `${name}: 前提（ガードレールに当たる）`);
    for (const [mode, state] of ACTIVE) {
      const r = delegatePlanGate(gate, plan, config, state);
      assertStopped(r, gate, `${name} × ${mode}`);
      const added = r.reasons.find((x) => x.includes('委任承認でも通しません'));
      assert.ok(added, `${name} × ${mode}: 「委任承認でも通しません」の理由が無い: ${r.reasons.join(' / ')}`);
      for (const p of hit) assert.ok(added.includes(p), `${name} × ${mode}: 理由に ${p} が無い: ${added}`);
      for (const p of files.filter((f) => !hit.includes(f))) assert.ok(!added.includes(p), `${name} × ${mode}: 当たらない ${p} が理由にある: ${added}`);
    }
  }
});

test('delegatePlanGate：delegateMergeExclude が設定に無ければ、すべての files が当たり委任でも止まる', () => {
  for (const plan of [planOf({ files: [GUARDED] }), planOf({ risk: 'high', files: ['docs/**'] })]) {
    const gate = evaluatePlanGate(plan, 3, noExclude);
    for (const [mode, state] of ACTIVE) {
      const r = delegatePlanGate(gate, plan, noExclude, state);
      assertStopped(r, gate, `${plan.files.join(',')} × ${mode}`);
      assert.ok(r.reasons.some((x) => x.includes('委任承認でも通しません') && plan.files.every((f) => x.includes(f))), r.reasons.join(' / '));
    }
  }
});

// ---- delegatePlanExclude ----

test('delegatePlanExclude：delegateMergeExclude か harness.config.json に重なりうる計画のパターンだけを返す', () => {
  assert.deepEqual(delegatePlanExclude(config, ['docs/a.md', GUARDED, 'harness/lib/plan.test.ts']), []);
  assert.deepEqual(delegatePlanExclude(config, ['docs/**']), ['docs/**'], 'docs/risk-policy.md と重なりうる');
  assert.deepEqual(delegatePlanExclude(config, ['harness/gates/run.ts']), ['harness/gates/run.ts']);
  assert.deepEqual(delegatePlanExclude(config, ['harness/gates/**']), ['harness/gates/**']);
  assert.deepEqual(delegatePlanExclude(config, ['harness/**']), ['harness/**'], '広いパターンは exclude と重なりうる');
  assert.deepEqual(delegatePlanExclude(config, ['harness.config.json', 'docs/a.md']), ['harness.config.json']);
  assert.deepEqual(delegatePlanExclude(config, ['.github/workflows/gate.yml']), ['.github/workflows/gate.yml']);
});

test('delegatePlanExclude：harness.config.json は delegateMergeExclude が空でも当たる', () => {
  assert.deepEqual(delegatePlanExclude({ delegateMergeExclude: [] }, ['harness.config.json', 'docs/a.md']), ['harness.config.json']);
  assert.deepEqual(delegatePlanExclude({ delegateMergeExclude: [] }, ['harness/gates/run.ts']), []);
});

test('delegatePlanExclude：delegateMergeExclude が無い設定ではすべてのパターンが当たる', () => {
  const r = delegatePlanExclude({}, ['docs/b.md', 'docs/a.md']);
  assert.deepEqual([...r].sort(), ['docs/a.md', 'docs/b.md']);
});
