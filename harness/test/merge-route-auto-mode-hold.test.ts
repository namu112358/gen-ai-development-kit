// auto mode の Jev の危険の判定で保留（autoModeHolds）の読み方と、保留なら委任承認でも merge-route が自動経路を通さないことを確かめる（Issue #942）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET } from '../lib/auto-mode.ts';
import { AUTO_MODE_HOLD_REASON_PREFIX, autoModeHolds, evaluateMergeRoute, type Acceptance, type AutoModeRecord, type DelegateRecord, type MergeRouteInput } from '../lib/merge-route.ts';

const HOLD_LINE = 'auto mode の危険の判定で保留のため、委任承認・bypass でも自動経路に乗せません';

const jev = (yes: number) => ({ status: 'ok' as const, detail: 'jev-test', yes, questionSet: AUTO_MODE_JEV_QUESTION_SET });
const held: AutoModeRecord = { eligible: false, hold: true, reasons: [`${AUTO_MODE_HOLD_REASON_PREFIX}: Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）`], skipped: [], jev: jev(0.5) };
const delegateOk: DelegateRecord = { eligible: true, reasons: [], skipped: ['ガードレールに触れます: harness/lib/epic.ts', 'Risk レベルが critical'], scopeOk: true, outside: [], exclude: [] };

/** 自動 Merge の対象ではなく、委任なら乗る受け付け（auto mode は保留） */
const acceptance: Acceptance = {
  version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'critical', riskOk: false, scopeOk: true, outside: [],
  guardrail: ['harness/lib/epic.ts'], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical', 'ガードレールに触れます（人が Merge する）: harness/lib/epic.ts'],
  delegate: delegateOk, autoMode: held,
};

test('autoModeHolds：hold があればそれ、無い古い受け付けは reasons の文頭、autoMode が無い・受け付けが無ければ偽', () => {
  const notHeldReason = '計画の範囲外のファイルがあります: docs/x.md';
  /** hold の欄ができる前の受け付けが書いた保留の理由（文字どおり。定数を変えても古い記録を読めること） */
  const oldHeldReason = 'auto mode の危険の判定で保留: Jev：危険の確率 50%（安全側の下限 90%）（危険。保留）';
  const cases: [string, Acceptance | null, boolean][] = [
    ['hold が真', acceptance, true],
    ['hold が偽（reasons に保留の文頭があっても hold を優先）', { ...acceptance, autoMode: { ...held, hold: false } }, false],
    ['hold の無い古い受け付けで保留の文頭', { ...acceptance, autoMode: { eligible: false, reasons: [notHeldReason, oldHeldReason], skipped: [], jev: jev(0.5) } }, true],
    ['hold の無い古い受け付けで保留でない理由だけ', { ...acceptance, autoMode: { eligible: false, reasons: [notHeldReason], skipped: [] } }, false],
    ['hold の無い古い受け付けで乗れる', { ...acceptance, autoMode: { eligible: true, reasons: [], skipped: [], jev: jev(0.01) } }, false],
    ['autoMode が無い', { ...acceptance, autoMode: undefined }, false],
    ['受け付けが無い', null, false],
  ];
  for (const [name, a, want] of cases) assert.equal(autoModeHolds(a), want, name);
});

const routeIn: MergeRouteInput = { autoMergeEnabled: true, isAgentPr: true, hold: false, autoMergeMode: true, acceptance, delegateMode: true, bypassMode: false, autoModeMode: true };

test('auto mode が有効で受け付けが保留なら、委任承認が有効で delegate.eligible でも merge-route は failure で、保留の1行を理由に書く', () => {
  const r = evaluateMergeRoute(routeIn);
  assert.equal(r.conclusion, 'failure', r.summary);
  assert.notEqual(r.title, '委任承認（計画＋Merge）の条件を満たしています');
  assert.ok(r.summary.includes(HOLD_LINE), r.summary);
});

test('auto mode が無効なら、保留の記録があっても委任承認で今どおり success', () => {
  const r = evaluateMergeRoute({ ...routeIn, autoModeMode: false });
  assert.equal(r.conclusion, 'success', r.summary);
  assert.equal(r.title, '委任承認（計画＋Merge）の条件を満たしています');
  assert.ok(!r.summary.includes(HOLD_LINE), r.summary);
});
