// #714：Jev のやり直しの待ち（full jitter・Retry-After・10 秒の上限）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askJev, type JevRetryOptions } from '../lib/jev.ts';
import { askJevWithUsage } from '../scripts/jev-language.ts';

type Ask = (apiKey: string, request: { model: string; state: unknown; questions: Record<string, unknown> }, fetchImpl: typeof fetch, opts: JevRetryOptions) => Promise<{ status: string }>;

const asks: [string, Ask][] = [
  ['askJev', askJev],
  ['askJevWithUsage', askJevWithUsage],
];

const request = { model: 'jev-1.13.0', state: { diff: 'x' }, questions: { q: { instructions: 'y' } } };
const okBody = JSON.stringify({ model: 'jev-1.13.0', answers: { q: { type: 'noul', noul: 0.9 } } });

/** 偽の fetch。応答を順に返す（429＋retry-after → 503 → 200） */
function sequenceFetch(retryAfter: string) {
  const responses = [
    () => new Response('rate limited', { status: 429, headers: { 'retry-after': retryAfter } }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(okBody, { status: 200 }),
  ];
  let i = 0;
  const fn: typeof fetch = async () => responses[i++]!();
  return fn;
}

/** 待ちの ms を記録する sleep（実際には待たない） */
async function run(ask: Ask, retryAfter: string, random: number) {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const result = await ask('secret-key', request, sequenceFetch(retryAfter), { sleep, random: () => random });
  return { result, waits };
}

for (const [name, ask] of asks) {
  test(`${name}：429・503 の後に成功し、待ちは2回で、429 の後は Retry-After より短くない`, async () => {
    const { result, waits } = await run(ask, '2', 0.5);
    assert.equal(result.status, 'ok');
    assert.equal(waits.length, 2);
    assert.ok(waits[0]! >= 2000, String(waits[0]));
  });

  test(`${name}：待ちは random で変わる（full jitter）`, async () => {
    const a = await run(ask, '2', 0);
    const b = await run(ask, '2', 0.5);
    assert.equal(a.result.status, 'ok');
    assert.equal(b.result.status, 'ok');
    assert.notDeepEqual(a.waits, b.waits);
  });

  test(`${name}：Retry-After が 30 秒でも待ちは 10 秒で打ち切る`, async () => {
    const { result, waits } = await run(ask, '30', 0.5);
    assert.equal(result.status, 'ok');
    assert.equal(waits[0], 10_000);
    for (const w of waits) assert.ok(w <= 10_000, String(w));
  });
}
