// auto mode の危険の問いで、見解ありの問いが問えない（diff が大きすぎる）ときは Jev を呼ばずに withView を skipped にし、
// 見解なしの要求で問い直さないこと、問えるときは見解あり（author_view 入り）の要求で1回だけ問うことを、prViewRecord の単体で確かめる（Issue #449）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModePrJevRequest } from '../lib/auto-mode.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { prViewRecord } from '../gates/auto-mode.ts';
import { DIFF, config as base } from './support/gate-fixtures.ts';

const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };
const FILES = ['harness.config.json'];
const VIEW = 'VIEW-449：テストを足すだけで、安全装置は弱めません。';

/** 偽の Jev。呼ばれた要求を残し、危険の確率 yes を返す */
function fakeAsk(yes: number) {
  const asked: { state: Record<string, unknown> }[] = [];
  const fn = async (request: Parameters<typeof askJev>[1]): ReturnType<typeof askJev> => {
    asked.push(request as unknown as { state: Record<string, unknown> });
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: yes } } as any };
  };
  return { asked, fn };
}

test('prViewRecord：見解ありの要求が ask: false（diff が大きすぎる）なら Jev を呼ばず、withView は skipped・yes 無し・detail が残る', async () => {
  const small: HarnessConfig = { ...config, jev: { ...config.jev, maxDiffChars: 10 } };
  const viewed = autoModePrJevRequest(small, DIFF, FILES, VIEW);
  assert.ok(!viewed.ask, '前提：diff が大きすぎて問えない要求');
  const jev = fakeAsk(0.01);
  const rec = await prViewRecord(viewed, jev.fn);
  assert.equal(jev.asked.length, 0, 'Jev を呼んだ（見解なしで問い直した）');
  assert.equal(rec.status, 'skipped');
  assert.ok(!('yes' in rec), `yes の欄がある: ${JSON.stringify(rec)}`);
  assert.equal(rec.detail, viewed.record.detail);
  assert.match(String(rec.detail), /diff が大きすぎます/);
});

test('prViewRecord：見解ありの要求が ask: true なら、author_view 入りの要求で1回だけ問い、確率が yes に入る', async () => {
  const viewed = autoModePrJevRequest(config, DIFF, FILES, VIEW);
  assert.ok(viewed.ask, '前提：問える要求');
  const jev = fakeAsk(0.7);
  const rec = await prViewRecord(viewed, jev.fn);
  assert.equal(jev.asked.length, 1);
  assert.equal(jev.asked[0]!.state.author_view, VIEW);
  assert.equal(jev.asked[0]!.state.diff, DIFF);
  assert.equal(rec.status, 'ok');
  assert.equal(rec.yes, 0.7);
});
