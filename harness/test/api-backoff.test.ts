// #714：待ち方（harness/lib/backoff.ts）の Retry-After の読み取り
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryAfterMs } from '../lib/backoff.ts';

const now = Date.parse('2026-10-11T00:00:00Z');

test('retryAfterMs：秒数は ms にする（前後の空白は除く）', () => {
  assert.equal(retryAfterMs('5', now), 5000);
  assert.equal(retryAfterMs(' 5 ', now), 5000);
  assert.equal(retryAfterMs('0', now), 0);
});

test('retryAfterMs：HTTP-date は now からの差の ms、過去の日時は 0', () => {
  assert.equal(retryAfterMs(new Date(now + 30_000).toUTCString(), now), 30_000);
  assert.equal(retryAfterMs(new Date(now - 60_000).toUTCString(), now), 0);
});

test('retryAfterMs：不正な値は null', () => {
  for (const value of [null, undefined, '', 'abc', '-1', '1.5']) {
    assert.equal(retryAfterMs(value, now), null, JSON.stringify(value));
  }
});
