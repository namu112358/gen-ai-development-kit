// 集計（harness/lib/report.ts）で、auto mode の危険の問いの見解あり・なし（shadow）の結論が変わった件数（安全→危険・危険→安全）を数え、
// 計画コメント・patch-id ごとに1件にまとめ、比べられない記録を数えず、Markdown に件数を出すかを確かめる（Issue #426）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, type AutoModeJevRecord } from '../lib/auto-mode.ts';
import { autoModeViewRecords, autoModeViewShift, renderAutoModeViewShift } from '../lib/report.ts';

const SAFE = 0.9;

const rec = (yes: number | undefined, withView?: AutoModeJevRecord['withView'], status: AutoModeJevRecord['status'] = 'ok'): AutoModeJevRecord => ({
  status, detail: 'jev-test', ...(yes === undefined ? {} : { yes }), questionSet: AUTO_MODE_JEV_QUESTION_SET, ...(withView ? { withView } : {}),
});
const view = (yes: number | undefined, status: 'ok' | 'skipped' | 'error' = 'ok') => ({ status, ...(yes === undefined ? {} : { yes }) });

test('autoModeViewShift：見解なし安全→見解あり危険、見解なし危険→見解あり安全を数え、変わらないものは比べた件数にだけ入る', () => {
  const s = autoModeViewShift(SAFE, [
    rec(0.01, view(0.5)), // 安全 → 危険
    rec(0.02, view(0.3)), // 安全 → 危険
    rec(0.5, view(0.01)), // 危険 → 安全
    rec(0.01, view(0.02)), // 安全 → 安全
    rec(0.6, view(0.7)), // 危険 → 危険
  ]);
  assert.equal(s.compared, 5);
  assert.equal(s.safeToDanger, 2);
  assert.equal(s.dangerToSafe, 1);
});

test('autoModeViewShift：結論の下限は autoModeDanger と同じ（1 - yes が下限ちょうどなら安全、未満なら危険）', () => {
  const s = autoModeViewShift(SAFE, [rec(0.1, view(0.11)), rec(0.11, view(0.1))]);
  assert.equal(s.compared, 2);
  assert.equal(s.safeToDanger, 1, '0.1（安全）→ 0.11（危険）');
  assert.equal(s.dangerToSafe, 1, '0.11（危険）→ 0.1（安全）');
});

test('autoModeViewShift：meanDiff は（見解あり - 見解なし）の平均', () => {
  const s = autoModeViewShift(SAFE, [rec(0.1, view(0.3)), rec(0.5, view(0.1))]);
  assert.ok(s.meanDiff !== null);
  assert.ok(Math.abs(s.meanDiff - ((0.2 + -0.4) / 2)) < 1e-9, String(s.meanDiff));
});

test('autoModeViewShift：比べられない記録（withView が無い・ok でない・確率が読めない、見解なしが ok でない・確率が無い）は数えない', () => {
  const s = autoModeViewShift(SAFE, [
    rec(0.01),
    rec(0.01, view(0.5, 'error')),
    rec(0.01, view(0.5, 'skipped')),
    rec(0.01, view(undefined)),
    rec(0.01, view(Number.NaN)),
    rec(undefined, view(0.5)),
    rec(Number.POSITIVE_INFINITY, view(0.5)),
    rec(0.01, view(0.5), 'error'),
    rec(0.01, view(0.5), 'skipped'),
  ]);
  assert.deepEqual(s, { compared: 0, safeToDanger: 0, dangerToSafe: 0, meanDiff: null });
});

test('autoModeViewShift：記録が無ければ 0 件で meanDiff は null', () => {
  assert.deepEqual(autoModeViewShift(SAFE, []), { compared: 0, safeToDanger: 0, dangerToSafe: 0, meanDiff: null });
});

test('autoModeViewRecords：同じ計画コメント・同じ patch-id の記録は何回出ても最後の1件だけを数え、jev の無い記録は除く', () => {
  const planGates = [
    { planCommentId: 1, autoMode: { jev: rec(0.01, view(0.01)) } },
    { planCommentId: 1, autoMode: { jev: rec(0.01, view(0.5)) } },
    { planCommentId: 1, autoMode: { jev: rec(0.01, view(0.5)) } },
    { planCommentId: 2, autoMode: { jev: rec(0.5, view(0.01)) } },
    { planCommentId: 3 },
    { planCommentId: 4, autoMode: {} },
  ];
  const acceptances = [
    { patchId: 'p1', autoMode: { jev: rec(0.01, view(0.5)) } },
    { patchId: 'p1', autoMode: { jev: rec(0.01, view(0.5)) } },
    { patchId: 'p2' },
  ];
  const records = autoModeViewRecords(planGates, acceptances);
  assert.equal(records.length, 3, '計画コメント 1・2 と patch-id p1 の3件');
  assert.ok(records.some((r) => r.withView?.yes === 0.5 && r.yes === 0.01), '計画コメント 1 は最後の記録');
  assert.ok(!records.some((r) => r.yes === 0.01 && r.withView?.yes === 0.01), '計画コメント 1 の古い記録が残っている');
  const s = autoModeViewShift(SAFE, records);
  assert.equal(s.compared, 3);
  assert.equal(s.safeToDanger, 2, '計画コメント 1 と p1 を1件ずつ');
  assert.equal(s.dangerToSafe, 1);
});

test('renderAutoModeViewShift：見出しと、比べた件数・安全→危険・危険→安全の件数が出る', () => {
  const s = autoModeViewShift(SAFE, [rec(0.01, view(0.5)), rec(0.02, view(0.5)), rec(0.5, view(0.01)), rec(0.01, view(0.01)), rec(0.01, view(0.02)), rec(0.01, view(0.03)), rec(0.01, view(0.04))]);
  assert.deepEqual([s.compared, s.safeToDanger, s.dangerToSafe], [7, 2, 1]);
  const md = renderAutoModeViewShift(s);
  assert.equal(typeof md, 'string');
  assert.ok(md.includes('auto mode の見解あり・なし（shadow）'), md);
  for (const n of ['7', '2', '1']) assert.match(md, new RegExp(`(^|\\D)${n}(\\D|$)`), `件数 ${n} が出ていない:\n${md}`);
});

test('renderAutoModeViewShift：比べた記録が無くても書ける（0 件）', () => {
  const md = renderAutoModeViewShift(autoModeViewShift(SAFE, []));
  assert.ok(md.includes('auto mode の見解あり・なし（shadow）'));
  assert.match(md, /(^|\D)0(\D|$)/);
});
