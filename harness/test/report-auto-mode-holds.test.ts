// 集計（harness/lib/report.ts）で、auto mode の危険の判定で保留した計画・PR を、記録の事実（今の dangerSafe で決め直さない）から拾い、
// その後の結果（そのまま・直させた・閉じた）と危険の確率の帯ごとに数え、Markdown に出すかを確かめる（Issue #491）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MODE_JEV_QUESTION_SET, type AutoModeJevRecord } from '../lib/auto-mode.ts';
import { autoModeHoldStats, autoModePlanHold, autoModePrHold, renderAutoModeHolds, type AutoModeHoldRow } from '../lib/report.ts';

const jev = (yes?: number, status: AutoModeJevRecord['status'] = 'ok'): AutoModeJevRecord => ({
  status, detail: 'jev-test', ...(yes === undefined ? {} : { yes }), questionSet: AUTO_MODE_JEV_QUESTION_SET,
});
const held = (patchId: string, yes = 0.5, extra: object = {}) => ({ patchId, autoMode: { eligible: false, jev: jev(yes) }, ...extra });
const ok = (patchId: string) => ({ patchId, autoMode: { eligible: true, jev: jev(0.01) } });

test('autoModePrHold：保留（jev があり eligible が偽）の最後の記録と、最後の受け付けの patch-id・Merge でその後を決める', () => {
  type Acc = Parameters<typeof autoModePrHold>[1];
  const cases: [string, Acc, boolean, AutoModeHoldRow | null][] = [
    ['同じ patch-id で Merge＝そのまま', [held('p1')], true, { kind: 'pr', target: 7, yes: 0.5, outcome: 'as-is' }],
    ['違う patch-id で Merge＝直させた', [held('p1'), ok('p2')], true, { kind: 'pr', target: 7, yes: 0.5, outcome: 'fixed' }],
    ['未 Merge で閉じた＝閉じた', [held('p1')], false, { kind: 'pr', target: 7, yes: 0.5, outcome: 'closed' }],
    ['保留の後の carriedFrom の受け付けは比べない', [held('p1'), { ...ok('p9'), carriedFrom: 3 }], true, { kind: 'pr', target: 7, yes: 0.5, outcome: 'as-is' }],
    ['carriedFrom の保留だけなら数えない', [held('p1', 0.5, { carriedFrom: 3 })], true, null],
    ['jev の無い受け付けは数えない', [{ patchId: 'p1', autoMode: { eligible: false } }], true, null],
    ['autoMode の無い受け付けは数えない', [{ patchId: 'p1' }], true, null],
    ['eligible が真の受け付けだけなら数えない', [ok('p1')], true, null],
    ['yes が今の線より低くても eligible が偽なら数える', [held('p1', 0.05)], true, { kind: 'pr', target: 7, yes: 0.05, outcome: 'as-is' }],
    ['保留が複数なら最後の保留の patch-id で比べる', [held('p1', 0.3), held('p2', 0.6)], true, { kind: 'pr', target: 7, yes: 0.6, outcome: 'as-is' }],
    ['skipped の保留は yes が null', [{ patchId: 'p1', autoMode: { eligible: false, jev: jev(undefined, 'skipped') } }], true, { kind: 'pr', target: 7, yes: null, outcome: 'as-is' }],
    ['受け付けが無い', [], true, null],
  ];
  for (const [name, acceptances, merged, want] of cases) assert.deepEqual(autoModePrHold(7, acceptances, merged), want, name);
});

test('autoModePlanHold：hold が真の最後の記録と、その後の計画の出し直し・Issue の状態でその後を決める', () => {
  type Gates = Parameters<typeof autoModePlanHold>[1];
  const hold = (id: number, yes = 0.5) => ({ planCommentId: id, autoMode: { jev: jev(yes), hold: true } });
  const pass = (id: number) => ({ planCommentId: id, autoMode: { jev: jev(0.01), hold: false } });
  const done = { state: 'closed', stateReason: 'completed' };
  const cases: [string, Gates, { state: string; stateReason?: string | null }, AutoModeHoldRow | null][] = [
    ['出し直し（別の計画コメント）＝直させた', [hold(1), pass(2)], done, { kind: 'plan', target: 9, yes: 0.5, outcome: 'fixed' }],
    ['同じ計画コメントの再実行だけなら直させたにしない', [hold(1), pass(1)], done, { kind: 'plan', target: 9, yes: 0.5, outcome: 'as-is' }],
    ['completed＝そのまま', [hold(1, 0.3)], done, { kind: 'plan', target: 9, yes: 0.3, outcome: 'as-is' }],
    ['not_planned＝閉じた', [hold(1)], { state: 'closed', stateReason: 'not_planned' }, { kind: 'plan', target: 9, yes: 0.5, outcome: 'closed' }],
    ['state_reason が null＝閉じた', [hold(1)], { state: 'closed', stateReason: null }, { kind: 'plan', target: 9, yes: 0.5, outcome: 'closed' }],
    ['開いている＝数えない', [hold(1)], { state: 'open' }, null],
    ['hold の無い記録は数えない', [pass(1), { planCommentId: 2 }], done, null],
  ];
  for (const [name, gates, state, want] of cases) assert.deepEqual(autoModePlanHold(9, gates, state), want, name);
});

test('autoModeHoldStats・renderAutoModeHolds：帯の境（0.2 は 〜20%、0.5 は 20〜50%、確率なし）で数え、見出し・行・0件の文を出す', () => {
  const row = (kind: 'plan' | 'pr', target: number, yes: number | null, outcome: AutoModeHoldRow['outcome']): AutoModeHoldRow => ({ kind, target, yes, outcome });
  const stats = autoModeHoldStats([
    row('pr', 1, 0.2, 'as-is'),
    row('pr', 2, 0.5, 'fixed'),
    row('pr', 3, 0.45, 'closed'),
    row('pr', 4, null, 'as-is'),
    row('plan', 5, 0.51, 'fixed'),
  ]);
  const pick = (kind: string, band: string) => stats.find((s) => s.kind === kind && s.band === band);
  assert.deepEqual(pick('pr', '〜20%'), { kind: 'pr', band: '〜20%', held: 1, asIs: 1, fixed: 0, closed: 0 });
  assert.deepEqual(pick('pr', '20〜50%'), { kind: 'pr', band: '20〜50%', held: 2, asIs: 0, fixed: 1, closed: 1 });
  assert.deepEqual(pick('pr', '確率なし'), { kind: 'pr', band: '確率なし', held: 1, asIs: 1, fixed: 0, closed: 0 });
  assert.deepEqual(pick('plan', '50%〜'), { kind: 'plan', band: '50%〜', held: 1, asIs: 0, fixed: 1, closed: 0 });
  assert.equal(stats.filter((s) => s.held > 0).length, 4, '保留の無い組を数えている');

  const md = renderAutoModeHolds(stats);
  assert.ok(md.includes('auto mode で保留した計画・PR のその後'), md);
  assert.ok(md.split('\n').some((l) => l.includes('20〜50%') && /(^|\D)2(\D|$)/.test(l)), `20〜50% の行が無い:\n${md}`);

  const empty = renderAutoModeHolds(autoModeHoldStats([]));
  assert.ok(empty.includes('auto mode で保留した計画・PR のその後'), empty);
  assert.ok(empty.replace('auto mode で保留した計画・PR のその後', '').includes('保留'), `0 件の文が無い:\n${empty}`);
});
