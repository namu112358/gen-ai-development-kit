// agent.ts api-review（harness/scripts/agent/commands/api-review.ts の apiReview）を偽の GitHub と差し替えた時計で確かめる（Issue #1042）。
// 設定（reviewSource）が無い・mode local なら GitHub を一度も読まずに disabled、mode subscription なら読まず待たずに subscription、記録が無いまま waitMinutes を過ぎたら timeout（0 なら読み直さない）、
// review-api の posted の記録があれば Reviewer・Risk のファイルを書き、そのファイルを composeVerdict に渡すとサブエージェントを呼ばずに判定コメントが組めることを見る
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { test } from 'node:test';
import type { HarnessConfig } from '../lib/config.ts';
import type { GitHub } from '../lib/github.ts';
import { composeVerdict } from '../lib/session-inputs.ts';
import { config } from './support/gate-fixtures.ts';
import { APP, BASE_DEPS, HEAD, MODELS, PR, fakeGh, judgeInputFile, loadCommand, postedComment } from './support/judge-api-review.ts';

const withSource = (reviewSource: unknown): HarnessConfig => ({ ...config, reviewSource } as unknown as HarnessConfig);
const withoutSource = (): HarnessConfig => {
  const { reviewSource: _drop, ...rest } = config as HarnessConfig & { reviewSource?: unknown };
  return rest as HarnessConfig;
};

/** どのメソッドに触れても数えて投げる偽の GitHub */
function untouchableGh(): { gh: GitHub; touched: string[] } {
  const touched: string[] = [];
  const gh = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      touched.push(String(prop));
      throw new Error(`GitHub を読んだ：${String(prop)}`);
    },
  }) as unknown as GitHub;
  return { gh, touched };
}

/** 差し替えた時計：sleep で進む。読み直しが止まらないときのために回数の上限で投げる */
function fakeClock() {
  let now = Date.UTC(2026, 9, 13);
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length > 100) throw new Error('読み直しが止まらない');
      now += ms;
    },
  };
}

const noPatch = () => assert.fail('samePatch は呼ばない（head の違う記録が無い）');

test('api-review：reviewSource が無い・mode local・mode subscription なら GitHub を一度も読まず待たずに local を返す', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);
  for (const [name, cfg, reason] of [
    ['reviewSource が無い', withoutSource(), 'disabled'],
    ['mode local', withSource({ mode: 'local' }), 'disabled'],
    ['mode subscription', withSource({ mode: 'subscription' }), 'subscription'],
  ] as const) {
    const { gh, touched } = untouchableGh();
    const clock = fakeClock();
    const out = await apiReview(gh, cfg, PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch, ...BASE_DEPS });
    assert.deepEqual(out, { action: 'local', reason }, name);
    assert.deepEqual(touched, [], `${name}: GitHub を読んだ`);
    assert.deepEqual(clock.sleeps, [], `${name}: 待った`);
  }
});

test('api-review：記録が無いまま waitMinutes を過ぎたら timeout（30 秒おきに読み直す。0 なら読み直さない）', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);

  const waiting = fakeGh(() => []);
  const clock = fakeClock();
  const out = await apiReview(waiting.gh, withSource({ mode: 'api', waitMinutes: 1, appLogin: APP }), PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch, ...BASE_DEPS });
  assert.deepEqual(out, { action: 'local', reason: 'timeout' });
  assert.ok(clock.sleeps.length >= 1 && clock.sleeps.length <= 3, `sleep の回数 ${clock.sleeps.length}`);
  assert.ok(clock.sleeps.every((ms) => ms === 30_000), `sleep の長さ ${clock.sleeps.join(',')}`);
  assert.ok(waiting.calls.filter((c) => c.startsWith('listComments')).length >= 2, '読み直していない');

  const once = fakeGh(() => []);
  const clock0 = fakeClock();
  const out0 = await apiReview(once.gh, withSource({ mode: 'api', waitMinutes: 0, appLogin: APP }), PR, file, { now: clock0.now, sleep: clock0.sleep, samePatch: noPatch, ...BASE_DEPS });
  assert.deepEqual(out0, { action: 'local', reason: 'timeout' });
  assert.deepEqual(clock0.sleeps, [], 'waitMinutes 0 で待った');
  assert.equal(once.calls.filter((c) => c.startsWith('listComments')).length, 1, 'waitMinutes 0 で読み直した');
});

test('api-review：posted の記録から Reviewer・Risk のファイルを書き、composeVerdict に渡すと判定コメントが組める', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);
  const { gh } = fakeGh(() => [postedComment()]);
  const clock = fakeClock();
  const out = await apiReview(gh, withSource({ mode: 'api', waitMinutes: 8, appLogin: APP }), PR, file, { now: clock.now, sleep: clock.sleep, samePatch: noPatch, ...BASE_DEPS });
  assert.equal(out.action, 'api');
  const { reviewer, risk, recordUrl, recordHead, models } = out as { reviewer: string; risk: string; recordUrl: string; recordHead: string; models: unknown };
  t.after(() => {
    for (const p of [reviewer, risk]) rmSync(dirname(p), { recursive: true, force: true });
  });
  assert.equal(basename(reviewer), `api-reviewer-${PR}-${HEAD.slice(0, 7)}.json`);
  assert.equal(basename(risk), `api-risk-${PR}-${HEAD.slice(0, 7)}.json`);
  assert.equal(recordUrl, 'https://example.test/c7');
  assert.equal(recordHead, HEAD);
  assert.deepEqual(models, MODELS);
  assert.deepEqual(clock.sleeps, [], '記録があるのに待った');

  const composed = composeVerdict({
    pr: PR,
    judgedHead: recordHead,
    currentHead: recordHead,
    reviewer: JSON.parse(readFileSync(reviewer, 'utf8')),
    risk: JSON.parse(readFileSync(risk, 'utf8')),
    meta: { model: MODELS.review, judgedBy: '付き添いのセッション' },
  });
  assert.ok(composed.ok, composed.ok ? '' : composed.errors.join(' / '));
  assert.ok(composed.value.includes('```agent-verdict'), composed.value);
});
