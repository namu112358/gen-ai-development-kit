// evaluateMergeRoute が、auto mode（autoModeMode）の間に受け付けの記録の autoMode.eligible で通す・止める動作と、委任・bypass との順番を確かめる（Issue #345）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET } from '../lib/auto-mode.ts';
import { evaluateMergeRoute, type Acceptance, type AutoModeRecord, type BypassRecord, type DelegateRecord, type MergeRouteInput } from '../lib/merge-route.ts';

const autoOk: AutoModeRecord = {
  eligible: true, reasons: [], skipped: ['Risk レベルが critical', 'ガードレールに触れます: harness.config.json', '委任しないパスに触れます（delegateMergeExclude）: harness.config.json'],
  jev: { status: 'ok', detail: 'jev-test', yes: 0.01, questionSet: AUTO_MODE_JEV_QUESTION_SET },
};
const autoHeld: AutoModeRecord = {
  eligible: false, reasons: ['auto mode の危険の判定で保留: Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）'], skipped: [],
  jev: { status: 'ok', detail: 'jev-test', yes: 0.5, questionSet: AUTO_MODE_JEV_QUESTION_SET },
};
const delegateNo: DelegateRecord = { eligible: false, reasons: ['委任しないパスに触れます（delegateMergeExclude）: harness.config.json'], skipped: [], scopeOk: true, outside: [], exclude: ['harness.config.json'] };
const bypassOk: BypassRecord = { eligible: true, reasons: [], skipped: ['Risk レベルが critical'] };

/** 自動 Merge の対象でも委任でも通らず、auto mode でだけ通る受け付け */
const humanOnly: Acceptance = {
  version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'critical', riskOk: false, scopeOk: true, outside: [],
  guardrail: ['harness.config.json'], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical', 'ガードレールに触れます（人が Merge する）: harness.config.json'],
  delegate: delegateNo, autoMode: autoOk,
};

const routeIn: MergeRouteInput = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance: humanOnly, delegateMode: false, bypassMode: false, autoModeMode: true };

test('AC5：autoModeMode が真で autoMode.eligible なら、自動 Merge の対象でも委任でもなくても通し、飛ばす理由を summary に書く', () => {
  const r = evaluateMergeRoute(routeIn);
  assert.equal(r.conclusion, 'success', r.summary);
  assert.equal(r.title, 'auto mode の条件を満たしています');
  for (const s of autoOk.skipped) assert.ok(r.summary.includes(s), `飛ばした理由を summary に: ${r.summary}`);
});

test('AC5：autoMode.eligible が偽（Jev が危険・記録が無い）なら「auto mode でも不可: …」の理由つきで止める', () => {
  const r = evaluateMergeRoute({ ...routeIn, acceptance: { ...humanOnly, autoMode: autoHeld } });
  assert.equal(r.conclusion, 'failure');
  assert.ok(r.summary.includes(`auto mode でも不可: ${autoHeld.reasons[0]}`), r.summary);
  assert.ok(r.summary.includes('Risk レベルが critical'), '受け付けの理由も残す');
});

test('AC5：autoModeMode が偽・省略なら、autoMode.eligible でも通さず、auto mode の理由も書かない', () => {
  for (const autoModeMode of [false, undefined]) {
    const r = evaluateMergeRoute({ ...routeIn, autoModeMode });
    assert.equal(r.conclusion, 'failure', String(autoModeMode));
    assert.ok(!r.summary.includes('auto mode でも不可'), r.summary);
  }
  const held = evaluateMergeRoute({ ...routeIn, autoModeMode: false, acceptance: { ...humanOnly, autoMode: autoHeld } });
  assert.ok(!held.summary.includes('auto mode でも不可'), '無効なら auto mode の理由を書かない');
});

test('AC5：autoMode の無い古い受け付けは auto mode の対象外', () => {
  const r = evaluateMergeRoute({ ...routeIn, acceptance: { ...humanOnly, autoMode: undefined } });
  assert.equal(r.conclusion, 'failure');
  assert.notEqual(r.title, 'auto mode の条件を満たしています');
});

test('auto mode でも agent:hold・停止・人の PR・Stacked・受け付けなしは止める', () => {
  const cases: [string, Partial<MergeRouteInput>][] = [
    ['hold', { hold: true }],
    ['停止', { autoMergeMode: false }],
    ['人の PR', { isAgentPr: false }],
    ['stacked', { stacked: true }],
    ['受け付けなし', { acceptance: null }],
  ];
  for (const [name, patch] of cases) assert.equal(evaluateMergeRoute({ ...routeIn, ...patch }).conclusion, 'failure', name);
});

test('順番：委任で乗るときは委任、auto mode と bypass の両方で乗るときは auto mode、自動 Merge の対象は今までどおり', () => {
  const delegated: Acceptance = { ...humanOnly, delegate: { ...delegateNo, eligible: true, reasons: [], exclude: [] } };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: delegated, delegateMode: true }).title, '委任承認（計画＋Merge）の条件を満たしています');
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: delegated, delegateMode: false }).title, 'auto mode の条件を満たしています', '委任が無効なら auto mode');

  const both: Acceptance = { ...humanOnly, bypass: bypassOk };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: both, bypassMode: true }).title, 'auto mode の条件を満たしています');
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: { ...both, autoMode: autoHeld }, bypassMode: true }).title, 'bypass モードの条件を満たしています', 'auto mode で乗らなければ bypass');

  const auto: Acceptance = { ...humanOnly, riskLevel: 'low', riskOk: true, guardrail: [], autoEligible: true, reasons: [] };
  assert.equal(evaluateMergeRoute({ ...routeIn, acceptance: auto }).title, '自動 Merge 条件を満たしています');
});

test('auto mode でも auto-merge が無ければ Human Merge 経路として通す', () => {
  assert.equal(evaluateMergeRoute({ ...routeIn, autoMergeEnabled: false }).title, 'auto-merge なし（Human Merge 経路）');
});
