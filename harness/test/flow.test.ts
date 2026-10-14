import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLOW_NODES, FLOW_STOPS, fleetStageOf, queueActionKindOf, stepOf, type FlowNode, type FlowNodeId } from '../lib/flow.ts';

// 段階のノードのデータ（harness/lib/flow.ts）の検査（Issue #201）：止まる先の両端の実在と理由・terminal・終了条件と強制のされ方と step・stepOf・fleetStageOf・queueActionKindOf

const nodes = FLOW_NODES as Record<FlowNodeId, FlowNode>;
const ids = Object.keys(FLOW_NODES) as FlowNodeId[];
const isNode = (id: string): id is FlowNodeId => Object.hasOwn(FLOW_NODES, id);

test('止まる先の両端がすべて FLOW_NODES にあり、理由が空でない', () => {
  const missing: string[] = [];
  for (const s of FLOW_STOPS) for (const end of [...s.from, s.to]) if (!isNode(end)) missing.push(`stop ${s.from.join(',')}→${s.to}: ${end}`);
  assert.deepEqual(missing, []);
  for (const s of FLOW_STOPS) assert.ok(s.reasons.length > 0, `${s.from.join(',')}→${s.to} に理由が無い`);
});

test('terminal は merged だけで、止まる先の出どころにならない', () => {
  const terminals = ids.filter((id) => nodes[id].terminal === true);
  assert.deepEqual(terminals, ['merged']);
  for (const s of FLOW_STOPS) assert.ok(!s.from.includes('merged'), `${s.from.join(',')}→${s.to}`);
});

test('各ノードに空でない終了条件（exit）と、code・conditional・ai・human のどれかの強制のされ方がある', () => {
  for (const id of ids) {
    const n = nodes[id];
    assert.equal(typeof n.exit, 'string', id);
    assert.ok(n.exit.trim().length > 0, `${id} の exit が空`);
    assert.ok(['code', 'conditional', 'ai', 'human'].includes(n.enforcement), `${id} の enforcement: ${n.enforcement}`);
    assert.ok(['plan', 'implement', 'judge', 'fix', 'sync', 'none'].includes(n.step), `${id} の step: ${n.step}`);
  }
});

test('stepOf・fleetStageOf・queueActionKindOf はデータのとおりに引く', () => {
  for (const id of ids) {
    assert.equal(stepOf(id), nodes[id].step, id);
    assert.equal(fleetStageOf(id), nodes[id].fleetStage, id);
  }
  assert.equal(queueActionKindOf('sync'), 'resolve-conflict');
  assert.equal(queueActionKindOf('none'), null);
  for (const s of ['plan', 'implement', 'judge', 'fix'] as const) assert.equal(queueActionKindOf(s), s);
});
