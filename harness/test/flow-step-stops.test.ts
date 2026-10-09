// Issue #405：step だけの止まる理由（FLOW_STEP_STOP_REASONS）が、どれも流れの一覧（FLOW_STOPS）に出てくることと、
// 読み込みが古いときの judge → stopped（harness-stale）のエッジがあることを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_STEP_STOP_REASONS, FLOW_STOPS } from '../lib/flow.ts';

test('FLOW_STEP_STOP_REASONS の理由は、どれも FLOW_STOPS のどれかの reasons にある', () => {
  const listed = new Set<string>(FLOW_STOPS.flatMap((s) => s.reasons));
  const missing = FLOW_STEP_STOP_REASONS.filter((r) => !listed.has(r));
  assert.deepEqual(missing, []);
});

test('FLOW_STOPS に judge → stopped（harness-stale）のエッジがある', () => {
  const edge = FLOW_STOPS.find((s) => s.from.includes('judge') && s.to === 'stopped' && s.reasons.includes('harness-stale'));
  assert.ok(edge, 'judge から stopped へ harness-stale で止まるエッジがありません');
});
