// Issue #278：ダッシュボードの読み直しの間隔（exponential backoff + jitter、下限と上限）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffDelayMs } from '../scripts/dashboard/backoff.ts';

test('backoffDelayMs：random を固定すると、回数ごとに baseMs * 2 ** attempt で延びる', () => {
  const random = () => 0.75;
  const opts = { baseMs: 1000, capMs: 60_000, random };
  assert.equal(backoffDelayMs(1, opts), 1500);
  assert.equal(backoffDelayMs(2, opts), 3000);
  assert.equal(backoffDelayMs(3, opts), 6000);
  assert.equal(backoffDelayMs(4, opts), 12_000);
});

test('backoffDelayMs：capMs より長くならない', () => {
  const opts = { baseMs: 1000, capMs: 5000, random: () => 0.999 };
  assert.equal(backoffDelayMs(10, opts), Math.floor(0.999 * 5000));
  assert.equal(backoffDelayMs(30, opts), Math.floor(0.999 * 5000));
  for (let a = 0; a < 40; a++) assert.ok(backoffDelayMs(a, opts) <= 5000, `attempt ${a}`);
});

test('backoffDelayMs：jitter は random で 0 から上限までばらつく（random が 0 なら floorMs だけ）', () => {
  assert.equal(backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0 }), 0);
  assert.equal(backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0.5 }), 4000);
  assert.equal(backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0.25 }), 2000);
  assert.notEqual(
    backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0.1 }),
    backoffDelayMs(3, { baseMs: 1000, capMs: 60_000, random: () => 0.9 }),
  );
});

test('backoffDelayMs：floorMs（Retry-After・リセットの時刻）より早くならない。上限の外に足す', () => {
  assert.equal(backoffDelayMs(1, { baseMs: 1000, capMs: 60_000, floorMs: 30_000, random: () => 0 }), 30_000);
  assert.equal(backoffDelayMs(1, { baseMs: 1000, capMs: 60_000, floorMs: 30_000, random: () => 0.5 }), 31_000);
  assert.equal(backoffDelayMs(20, { baseMs: 1000, capMs: 5000, floorMs: 120_000, random: () => 0.5 }), 122_500);
});

test('backoffDelayMs：floorMs の既定は 0、random の既定は Math.random（範囲の中に収まる）', () => {
  for (let i = 0; i < 50; i++) {
    const d = backoffDelayMs(2, { baseMs: 1000, capMs: 60_000 });
    assert.ok(Number.isInteger(d));
    assert.ok(d >= 0 && d < 4000, String(d));
  }
});
