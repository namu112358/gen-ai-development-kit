// auto mode の危険の判定（autoModeDanger）と、Jev への要求・記録（autoModePlanJevRequest・autoModePrJevRequest・autoModeJevRecord）を確かめる（Issue #342）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessConfig } from '../lib/config.ts';
import {
  AUTO_MODE_JEV_QUESTION_SET, autoModeConfig, autoModeDanger, autoModeJevRecord, autoModePlanJevRequest, autoModePrJevRequest,
  type AutoModeJevRecord, type ClaudeDanger,
} from '../lib/auto-mode.ts';
import { config, DIFF } from './support/gate-fixtures.ts';

const jevOk = (yes: number): AutoModeJevRecord => ({ status: 'ok', detail: 'm', yes, questionSet: 1 });
const claude = (answer: ClaudeDanger['answer'], reason = `理由-${answer}`): ClaudeDanger => ({ answer, reason });

// ---- autoModeDanger の組み合わせ ----

const JEV: [string, AutoModeJevRecord | null | undefined, boolean][] = [
  ['安全', jevOk(0.05), false],
  ['危険', jevOk(0.3), true],
  ['無い（undefined）', undefined, true],
  ['無い（null）', null, true],
  ['skipped', { status: 'skipped', detail: 'diff が大きい', questionSet: 1 }, true],
  ['error', { status: 'error', detail: 'HTTP 500', questionSet: 1 }, true],
  ['yes が NaN', jevOk(Number.NaN), true],
  ['yes が無い', { status: 'ok', detail: 'm', questionSet: 1 }, true],
];
const CLAUDE: [string, ClaudeDanger | null | undefined, boolean][] = [
  ['no', claude('no'), false],
  ['yes', claude('yes'), true],
  ['unsure', claude('unsure'), true],
  ['無い', undefined, true],
  ['3つのどれでもない', { answer: 'maybe', reason: 'x' } as unknown as ClaudeDanger, true],
];

test('autoModeDanger：どちらかが危険・分からないなら保留、両方が安全なら保留しない', () => {
  for (const [jn, jev, jHold] of JEV) {
    for (const [cn, c, cHold] of CLAUDE) {
      const r = autoModeDanger({}, { jev, claude: c });
      assert.equal(r.hold, jHold || cHold, `Jev ${jn} × Claude ${cn}: ${r.reasons.join(' / ')}`);
    }
  }
});

// ---- 理由の中身 ----

const lines = (r: { reasons: string[] }) => ({
  jev: r.reasons.find((s) => s.includes('Jev')),
  claude: r.reasons.find((s) => s.includes('Claude')),
});

test('autoModeDanger：保留しないときも理由に Jev の確率と Claude の答えが入る', () => {
  const r = autoModeDanger({}, { jev: jevOk(0.05), claude: claude('no', '文書だけの変更') });
  assert.equal(r.hold, false);
  const { jev, claude: c } = lines(r);
  assert.ok(jev?.includes('5%'), r.reasons.join('\n'));
  assert.ok(c?.includes('no') && c.includes('文書だけの変更'), r.reasons.join('\n'));
});

test('autoModeDanger：危険の確率は百分率、Claude の答えと理由はそのまま', () => {
  const r = autoModeDanger({}, { jev: jevOk(0.3), claude: claude('unsure', 'データの削除があるかもしれない') });
  const { jev, claude: c } = lines(r);
  assert.ok(jev?.includes('30%'), r.reasons.join('\n'));
  assert.ok(c?.includes('unsure') && c.includes('データの削除があるかもしれない'), r.reasons.join('\n'));
});

test('autoModeDanger：skipped・error は status と detail、記録・答えが無ければ「無い」が理由に入る', () => {
  for (const status of ['skipped', 'error'] as const) {
    const r = autoModeDanger({}, { jev: { status, detail: `詳細-${status}`, questionSet: 1 }, claude: claude('no') });
    const { jev } = lines(r);
    assert.ok(jev?.includes(status) && jev.includes(`詳細-${status}`), r.reasons.join('\n'));
  }
  const r = autoModeDanger({}, {});
  const { jev, claude: c } = lines(r);
  assert.ok(jev?.includes('無い'), r.reasons.join('\n'));
  assert.ok(c?.includes('無い'), r.reasons.join('\n'));
});

// ---- 境界・上書き ----

test('autoModeDanger：dangerSafe 0.9 で yes 0.1 は保留しない、0.1001 は保留', () => {
  assert.equal(autoModeDanger({}, { jev: jevOk(0.1), claude: claude('no') }).hold, false);
  assert.equal(autoModeDanger({}, { jev: jevOk(0.1001), claude: claude('no') }).hold, true);
});

test('autoModeDanger：autoMode.jev.dangerSafe の上書きが効く', () => {
  const c = { autoMode: { jev: { dangerSafe: 0.5 } } };
  assert.equal(autoModeDanger(c, { jev: jevOk(0.3), claude: claude('no') }).hold, false);
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
