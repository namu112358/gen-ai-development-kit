// 集計（harness/scripts/report.ts）の配線：App の plan-gate・acceptance の記録コメントを appRecords で読み、autoModeViewShiftOf に渡すと、
// 見解あり・なしで結論が変わった組を数え、withView が skipped（見解ありが問えなかった）の組は比べず、下限は設定の autoMode.jev.dangerSafe を使うことを確かめる（Issue #449）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, type AutoModeJevRecord } from '../lib/auto-mode.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { autoModeViewShiftOf } from '../lib/report.ts';
import { appRecords, type PlanGateRecord } from '../lib/state.ts';
import { config } from './support/gate-fixtures.ts';
import { appRecordComment } from './support/stack-fixtures.ts';

const rec = (yes: number, withView: AutoModeJevRecord['withView']): AutoModeJevRecord => ({
  status: 'ok', detail: 'jev-test', yes, questionSet: AUTO_MODE_JEV_QUESTION_SET, withView,
});
const okView = (yes: number) => ({ status: 'ok' as const, detail: 'jev-test', yes });
/** prViewRecord が作る、見解ありが問えなかったときの withView */
const SKIPPED_VIEW = { status: 'skipped' as const, detail: 'diff が大きすぎます（100 文字 > 10）' };

const planGateComment = (id: number, planCommentId: number, jev: AutoModeJevRecord) =>
  appRecordComment(id, 'plan-gate', '計画ゲート', { version: 1, planCommentId, pass: true, reasons: [], autoMode: { hold: false, jev } });
const acceptanceRecordComment = (id: number, patchId: string, jev: AutoModeJevRecord) =>
  appRecordComment(id, 'acceptance', '受け付けました。', { version: 1, verdictCommentId: 70, patchId, autoMode: { eligible: true, reasons: [], skipped: [], jev } });

function shiftFrom(cfg: HarnessConfig, comments: ReturnType<typeof appRecordComment>[]) {
  const list = comments as unknown as IssueComment[];
  const planGates = appRecords<PlanGateRecord>(cfg, list, 'plan-gate').map((r) => r.value);
  const acceptances = appRecords<Acceptance>(cfg, list, 'acceptance').map((r) => r.value);
  return autoModeViewShiftOf(cfg, planGates, acceptances);
}

const withDangerSafe = (dangerSafe: number): HarnessConfig => ({ ...config, autoMode: { ...config.autoMode, jev: { ...config.autoMode?.jev, dangerSafe } } });

test('autoModeViewShiftOf：App のコメントから読んだ記録で結論が変わる組を数え、withView が skipped の組は比べた件数に入れない', () => {
  const s = shiftFrom(config, [
    planGateComment(1, 11, rec(0.01, okView(0.5))), // 安全 → 危険
    acceptanceRecordComment(2, 'p-skip', rec(0.01, SKIPPED_VIEW)), // 見解ありが問えなかった
    planGateComment(3, 12, rec(0.5, SKIPPED_VIEW)), // 見解ありが問えなかった
  ]);
  assert.equal(s.compared, 1, 'skipped の組を比べた');
  assert.equal(s.safeToDanger, 1);
  assert.equal(s.dangerToSafe, 0);
});

test('autoModeViewShiftOf：下限は設定の autoMode.jev.dangerSafe を使う', () => {
  const comments = [acceptanceRecordComment(4, 'p-1', rec(0.05, okView(0.15)))];
  const strict = shiftFrom(withDangerSafe(0.9), comments);
  assert.deepEqual([strict.compared, strict.safeToDanger, strict.dangerToSafe], [1, 1, 0], '下限 0.9：0.95（安全）→ 0.85（危険）');
  const loose = shiftFrom(withDangerSafe(0.8), comments);
  assert.deepEqual([loose.compared, loose.safeToDanger, loose.dangerToSafe], [1, 0, 0], '下限 0.8：どちらも安全');
});
