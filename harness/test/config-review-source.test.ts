// harness.config.json の reviewSource（judge が review-api の記録を使うか。harness/lib/config.ts の reviewSourceConfig）の既定と、
// 誤った値（null・配列・語彙の外の mode・0〜9 の整数でない waitMinutes・mode api で appLogin が空・無い）で throw することを確かめる（Issue #1042）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewSourceConfig, type HarnessConfig } from '../lib/config.ts';

const asConfig = (reviewSource: unknown): Pick<HarnessConfig, 'reviewSource'> => ({ reviewSource } as unknown as Pick<HarnessConfig, 'reviewSource'>);

test('reviewSourceConfig：キーが無ければ local・8 分・appLogin null。正しい値はそのまま読む', () => {
  assert.deepEqual(reviewSourceConfig({} as Pick<HarnessConfig, 'reviewSource'>), { mode: 'local', waitMinutes: 8, appLogin: null, routineWaitMinutes: 20 });
  const cases: [unknown, { mode: string; waitMinutes: number; appLogin: string | null; routineWaitMinutes: number }][] = [
    [{ mode: 'api', waitMinutes: 0, appLogin: 'review-api[bot]' }, { mode: 'api', waitMinutes: 0, appLogin: 'review-api[bot]', routineWaitMinutes: 20 }],
    [{ mode: 'api', waitMinutes: 9, appLogin: 'review-api[bot]' }, { mode: 'api', waitMinutes: 9, appLogin: 'review-api[bot]', routineWaitMinutes: 20 }],
  ];
  for (const [raw, want] of cases) assert.deepEqual(reviewSourceConfig(asConfig(raw)), want, JSON.stringify(raw));
  // mode local は appLogin が無くてよい
  assert.equal(reviewSourceConfig(asConfig({ mode: 'local', waitMinutes: 3 })).mode, 'local');
});

test('reviewSourceConfig：誤った値は throw する', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['配列', []],
    ['mode が語彙の外', { mode: 'shadow', waitMinutes: 8, appLogin: 'review-api[bot]' }],
    ['waitMinutes 10', { mode: 'api', waitMinutes: 10, appLogin: 'review-api[bot]' }],
    ['waitMinutes 小数', { mode: 'api', waitMinutes: 1.5, appLogin: 'review-api[bot]' }],
    ['waitMinutes 負', { mode: 'api', waitMinutes: -1, appLogin: 'review-api[bot]' }],
    ['waitMinutes 文字列', { mode: 'api', waitMinutes: '8', appLogin: 'review-api[bot]' }],
    ['mode api で appLogin が空', { mode: 'api', waitMinutes: 8, appLogin: '' }],
    ['mode api で appLogin が無い', { mode: 'api', waitMinutes: 8 }],
  ];
  for (const [name, raw] of bad) assert.throws(() => reviewSourceConfig(asConfig(raw)), Error, name);
});
