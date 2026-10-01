// 集計（harness/lib/report.ts）で、auto mode でテストを弱める変更を Jev が妥当と答えて通した件数と、
// 通した差分のまま Merge されなかった（人が後から直させた）件数を数え、指標の表に2行を出すかを確かめる（Issue #349）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutoModeTestsRecord } from '../lib/auto-mode-tests.ts';
import { loadConfig } from '../lib/config.ts';
import { autoModeTestsDecision, renderReport, summarize, type ReportRow } from '../lib/report.ts';

const config = loadConfig();
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const record = (patchId: string, allows: boolean): AutoModeTestsRecord => ({
  version: 1, patchId, headSha: 'h'.repeat(40), model: 'jev-test', questionSet: 1,
  findings: [{ kind: 'skip-added', file: 'a.test.ts', line: 1, probability: allows ? 0.95 : 0.5 }],
  probability: allows ? 0.95 : 0.5, threshold: 0.9, allows,
});

// ---- autoModeTestsDecision ----

test('autoModeTestsDecision：通した記録で、Merge され最後の受け付けの patch-id が同じなら fixed=false', () => {
  assert.deepEqual(autoModeTestsDecision([record(A, true)], true, A), { fixed: false });
});

test('autoModeTestsDecision：通した記録で、違う差分で Merge された（受け付けが無いときも）なら fixed=true（人が後から直させた）', () => {
  assert.deepEqual(autoModeTestsDecision([record(A, true)], true, B), { fixed: true });
  assert.deepEqual(autoModeTestsDecision([record(A, true)], true, null), { fixed: true });
});

test('autoModeTestsDecision：未 Merge・通さなかった記録・記録なしは数えない（null）', () => {
  assert.equal(autoModeTestsDecision([record(A, true)], false, A), null, '未 Merge');
  assert.equal(autoModeTestsDecision([record(A, false)], true, A), null, '通さなかった');
  assert.equal(autoModeTestsDecision([], true, A), null, '記録なし');
});

test('autoModeTestsDecision：最後の記録だけを使う', () => {
  assert.equal(autoModeTestsDecision([record(A, true), record(B, false)], true, B), null, '最後が通さなかったなら数えない');
  assert.deepEqual(autoModeTestsDecision([record(A, false), record(B, true)], true, B), { fixed: false });
});

// ---- summarize・renderReport ----

let nextPr = 1;
const row = (autoModeTests: ReportRow['autoModeTests']): ReportRow => ({
  pr: nextPr++, createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T01:00:00Z', closedAt: null, acceptance: null,
  rejected: 0, fixRequests: 0, reverted: false, fixedBy: [], autoModeTests,
});

/** 通した 3 件（うち人が直させた 1 件）。null・未設定は数えない */
const rows = (): ReportRow[] => [row({ fixed: false }), row({ fixed: false }), row({ fixed: true }), row(null), { ...row(null), autoModeTests: undefined }];

test('summarize：auto mode で通した件数と、そのうち人が後から直させた件数', () => {
  assert.deepEqual(summarize(config, rows()).autoModeTests, { allowed: 3, fixed: 1 });
});

test('summarize：autoModeTests の無い既存の行の形でも 0 件', () => {
  const plain: ReportRow = { pr: 999, createdAt: '2026-09-01T00:00:00Z', mergedAt: null, closedAt: null, acceptance: null, rejected: 0, fixRequests: 0, reverted: false, fixedBy: [] };
  assert.deepEqual(summarize(config, [plain]).autoModeTests, { allowed: 0, fixed: 0 });
});

/** 指標の表で、最初の列がちょうど label の行 */
const lineOf = (report: string, label: string): string => {
  const line = report.split('\n').find((l) => l.startsWith('| ') && (l.split('|')[1] ?? '').trim() === label);
  assert.ok(line, `「${label}」の行がある`);
  return line;
};
const valueOf = (line: string) => (line.split('|')[2] ?? '').trim();

test('renderReport：指標の表に「auto mode で通した」と「auto mode で通した・人が後から直させた」の2行が出て、件数が入る', () => {
  const rs = rows();
  const report = renderReport(summarize(config, rs), rs, 30);
  assert.equal(valueOf(lineOf(report, 'テストの改ざん：auto mode で通した')), '3');
  assert.equal(valueOf(lineOf(report, 'テストの改ざん：auto mode で通した・人が後から直させた')), '1');
  assert.ok(report.indexOf('auto mode で通した') < report.indexOf('| PR | Merge |'), '指標の表の中（PR ごとの表より前）');
});
