// auto mode の危険の判定（autoModeDanger。Jev の記録だけで決まる。Issue #382）と、Jev への要求・記録（autoModePlanJevRequest・autoModePrJevRequest・autoModeJevRecord）を確かめる（Issue #342）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessConfig } from '../lib/config.ts';
import {
  AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, autoModeDanger, autoModeJevRecord, autoModePlanJevRequest, autoModePrJevRequest,
  type AutoModeJevRecord,
} from '../lib/auto-mode.ts';
import { config, DIFF } from './support/gate-fixtures.ts';

const jevOk = (yes: number): AutoModeJevRecord => ({ status: 'ok', detail: 'm', yes, questionSet: 1 });

// ---- autoModeDanger は Jev の記録だけで決まる ----

const JEV: [string, AutoModeJevRecord | null | undefined, boolean, string][] = [
  ['安全', jevOk(0.05), false, 'Jev：危険の確率 5%（安全側の下限 90%）（安全）'],
  ['危険', jevOk(0.3), true, 'Jev：危険の確率 30%（安全側の下限 90%）（危険。保留）'],
  ['無い（undefined）', undefined, true, 'Jev：記録が無い（保留）'],
  ['無い（null）', null, true, 'Jev：記録が無い（保留）'],
  ['skipped', { status: 'skipped', detail: 'diff が大きい', questionSet: 1 }, true, 'Jev：skipped（diff が大きい）（保留）'],
  ['error', { status: 'error', detail: 'HTTP 500', questionSet: 1 }, true, 'Jev：error（HTTP 500）（保留）'],
  ['yes が NaN', jevOk(Number.NaN), true, 'Jev：危険の確率が読めない（保留）'],
  ['yes が無い', { status: 'ok', detail: 'm', questionSet: 1 }, true, 'Jev：危険の確率が読めない（保留）'],
];

test('autoModeDanger：Jev の記録だけで保留が決まり、理由は Jev の1行だけ', () => {
  for (const [name, jev, hold, reason] of JEV) {
    assert.deepEqual(autoModeDanger({}, { jev }), { hold, reasons: [reason] }, name);
  }
  assert.deepEqual(autoModeDanger({}, {}), { hold: true, reasons: ['Jev：記録が無い（保留）'] }, 'jev を渡さない');
});

// ---- 境界・上書き ----

test('autoModeDanger：dangerSafe 0.9 で yes 0.1 は保留しない、0.1001 は保留', () => {
  assert.equal(autoModeDanger({}, { jev: jevOk(0.1) }).hold, false);
  assert.equal(autoModeDanger({}, { jev: jevOk(0.1001) }).hold, true);
});

test('autoModeDanger：autoMode.jev.dangerSafe の上書きが効く', () => {
  const c = { autoMode: { jev: { dangerSafe: 0.5 } } };
  assert.equal(autoModeDanger(c, { jev: jevOk(0.3) }).hold, false);
  assert.equal(autoModeDanger(c, { jev: jevOk(0.6) }).hold, true);
});

// ---- Jev への要求 ----

test('autoModePlanJevRequest：state は plan と files だけ、問いは danger の noul', () => {
  const req = autoModePlanJevRequest(config, '計画の本文', ['a.ts']);
  assert.equal(req.model, config.jev.model);
  assert.deepEqual(Object.keys(req.state).sort(), ['files', 'plan']);
  assert.deepEqual(req.state, { plan: '計画の本文', files: ['a.ts'] });
  assert.deepEqual(Object.keys(req.questions), ['danger']);
  const q = autoModeConfig(config).plan;
  assert.deepEqual(req.questions.danger, { type: 'noul', instructions: q.instructions, criteria: q.criteria });
});

test('autoModePrJevRequest：state は diff と changed_files だけ（セッションが書いたものは入らない）、問いは danger の noul', () => {
  const r = autoModePrJevRequest(config, DIFF, ['docs/a.md']);
  assert.equal(r.ask, true);
  if (!r.ask) return;
  assert.equal(r.request.model, config.jev.model);
  assert.deepEqual(Object.keys(r.request.state).sort(), ['changed_files', 'diff']);
  assert.deepEqual(r.request.state, { diff: DIFF, changed_files: ['docs/a.md'] });
  assert.deepEqual(Object.keys(r.request.questions), ['danger']);
  const q = autoModeConfig(config).pr;
  assert.deepEqual(r.request.questions.danger, { type: 'noul', instructions: q.instructions, criteria: q.criteria });
});

test('autoModePrJevRequest：diff が maxDiffChars を超えたら問わず skipped（文字数が detail に入る）', () => {
  const c: HarnessConfig = { ...config, jev: { ...config.jev, maxDiffChars: 10 } };
  const diff = 'x'.repeat(11);
  const r = autoModePrJevRequest(c, diff, []);
  assert.equal(r.ask, false);
  if (r.ask) return;
  assert.equal(r.record.status, 'skipped');
  assert.equal(r.record.questionSet, AUTO_MODE_JEV_QUESTION_SET);
  assert.ok(r.record.detail?.includes('11'), r.record.detail);
  assert.equal(autoModePrJevRequest(c, 'x'.repeat(10), []).ask, true, 'ちょうどなら問う');
});

// ---- autoModeJevRecord ----

test('autoModeJevRecord：ok は model と danger の yes、error は detail、yes が数でなければ省く', () => {
  assert.equal(AUTO_MODE_JEV_QUESTION_SET, 1);
  const answers = (noul?: number) => ({ danger: { type: 'noul', ...(noul === undefined ? {} : { noul }) } });
  assert.deepEqual(autoModeJevRecord({ status: 'ok', model: 'jev-1', answers: answers(0.2) }), { status: 'ok', detail: 'jev-1', yes: 0.2, questionSet: 1 });
  assert.deepEqual(autoModeJevRecord({ status: 'ok', model: 'jev-1', answers: answers() }), { status: 'ok', detail: 'jev-1', questionSet: 1 });
  assert.deepEqual(autoModeJevRecord({ status: 'error', detail: 'HTTP 500' }), { status: 'error', detail: 'HTTP 500', questionSet: 1 });
});
