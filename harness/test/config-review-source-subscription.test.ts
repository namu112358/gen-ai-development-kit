// Issue #1099：reviewSourceConfig が mode subscription（appLogin 無しで通る）と routineWaitMinutes（既定 20、正の整数）を受けること、
// api は appLogin が無いと今どおり throw すること、limitErrors が routine.judgeDailyLimit（任意・正の整数）を検査することを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { limitErrors, reviewSourceConfig } from '../lib/config.ts';

const REAL_PATH = fileURLToPath(new URL('../../harness.config.json', import.meta.url));
const real = (): Record<string, any> => JSON.parse(readFileSync(REAL_PATH, 'utf8'));
const source = (reviewSource: unknown) => reviewSourceConfig({ reviewSource } as Parameters<typeof reviewSourceConfig>[0]);

test('subscription は appLogin 無しで通り、routineWaitMinutes の既定は 20、指定した値は通る', () => {
  assert.deepEqual(source({ mode: 'subscription' }), { mode: 'subscription', waitMinutes: 8, appLogin: null, routineWaitMinutes: 20 });
  assert.equal(source({ mode: 'subscription', routineWaitMinutes: 45 }).routineWaitMinutes, 45);
});

for (const bad of [0, 1.5, '5']) {
  test(`routineWaitMinutes ${JSON.stringify(bad)} は throw する`, () => {
    assert.throws(() => source({ mode: 'subscription', routineWaitMinutes: bad }), /routineWaitMinutes/);
  });
}

test('api は appLogin が無いと今どおり throw し、あれば通る。local は appLogin 無しで通る', () => {
  assert.throws(() => source({ mode: 'api' }), /appLogin/);
  assert.equal(source({ mode: 'api', appLogin: 'x[bot]' }).appLogin, 'x[bot]');
  assert.equal(source({ mode: 'local' }).appLogin, null);
});

test('limitErrors：routine.judgeDailyLimit は 3 を通し、0 を誤りにし、無ければ誤りにしない', () => {
  const withLimit = (v: unknown) => {
    const c = real();
    c.routine = { ...c.routine };
    if (v === undefined) delete c.routine.judgeDailyLimit;
    else c.routine.judgeDailyLimit = v;
    return limitErrors(c);
  };
  assert.deepEqual(withLimit(3), []);
  assert.deepEqual(withLimit(undefined), []);
  assert.ok(withLimit(0).some((e) => e.includes('routine.judgeDailyLimit')));
});
