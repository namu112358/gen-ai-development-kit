import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, REASON_CODES } from '../lib/config.ts';
import { FLOW_EDGES, FLOW_LOOPS, FLOW_NODES, FLOW_STOP_LABELS, FLOW_STOPS, fleetStageOf, queueActionKindOf, stepNode, stepOf, type FlowNode, type FlowNodeId } from '../lib/flow.ts';

// 段階のグラフのデータ（harness/lib/flow.ts）の検査（Issue #201）：行き止まり・届かないノード・端の実在・止まる理由・終了条件と強制のされ方・step の行き先・ループの上限

const nodes = FLOW_NODES as Record<FlowNodeId, FlowNode>;
const ids = Object.keys(FLOW_NODES) as FlowNodeId[];
const isNode = (id: string): id is FlowNodeId => Object.hasOwn(FLOW_NODES, id);

/** FLOW_EDGES と FLOW_STOPS をまとめた、ノードから出る行き先 */
function successors(): Map<FlowNodeId, Set<FlowNodeId>> {
  const out = new Map<FlowNodeId, Set<FlowNodeId>>(ids.map((id) => [id, new Set<FlowNodeId>()]));
  for (const e of FLOW_EDGES) out.get(e.from)?.add(e.to);
  for (const s of FLOW_STOPS) for (const from of s.from) out.get(from)?.add(s.to);
  return out;
}
const hasEdge = (from: FlowNodeId, to: FlowNodeId): boolean => FLOW_EDGES.some((e) => e.from === from && e.to === to);

test('エッジ・止まる先・ループの両端がすべて FLOW_NODES にある', () => {
  const missing: string[] = [];
  for (const e of FLOW_EDGES) for (const end of [e.from, e.to]) if (!isNode(end)) missing.push(`edge ${e.from}→${e.to}: ${end}`);
  for (const s of FLOW_STOPS) for (const end of [...s.from, s.to]) if (!isNode(end)) missing.push(`stop ${s.from.join(',')}→${s.to}: ${end}`);
  for (const l of FLOW_LOOPS) for (const end of l.nodes) if (!isNode(end)) missing.push(`loop ${l.nodes.join('⇄')}: ${end}`);
  assert.deepEqual(missing, []);
});

test('行き止まりが無い：terminal でないノードは、FLOW_EDGES か FLOW_STOPS の出るエッジを持つ', () => {
  const out = successors();
  const deadEnds = ids.filter((id) => nodes[id].terminal !== true && (out.get(id)?.size ?? 0) === 0);
  assert.deepEqual(deadEnds, []);
});

test('terminal のノードからは出るエッジが無く、terminal は merged だけ', () => {
  const terminals = ids.filter((id) => nodes[id].terminal === true);
  assert.deepEqual(terminals, ['merged']);
  const out = successors();
  for (const id of terminals) assert.equal(out.get(id)?.size ?? 0, 0, id);
});

test('届かないノードが無い：issue から FLOW_EDGES と FLOW_STOPS をたどってすべてのノードに届く', () => {
  const out = successors();
  const seen = new Set<FlowNodeId>(['issue']);
  const stack: FlowNodeId[] = ['issue'];
  while (stack.length > 0) {
    for (const next of out.get(stack.pop()!) ?? []) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  assert.deepEqual(ids.filter((id) => !seen.has(id)), []);
});

test('どのノードからも merged に届く（抜け出せない輪が無い）', () => {
  const out = successors();
  const reaches = (start: FlowNodeId): boolean => {
    const seen = new Set<FlowNodeId>([start]);
    const stack: FlowNodeId[] = [start];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === 'merged') return true;
      for (const next of out.get(cur) ?? []) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
    return false;
  };
  assert.deepEqual(ids.filter((id) => !reaches(id)), []);
});

test('止まる理由は FLOW_STOP_LABELS か config.ts の REASON_CODES のキー', () => {
  const known = new Set<string>([...FLOW_STOP_LABELS, ...Object.keys(REASON_CODES)]);
  const unknown = FLOW_STOPS.flatMap((s) => s.reasons.filter((r) => !known.has(r)).map((r) => `${s.from.join(',')}→${s.to}: ${r}`));
  assert.deepEqual(unknown, []);
  for (const s of FLOW_STOPS) assert.ok(s.reasons.length > 0, `${s.from.join(',')}→${s.to} に理由が無い`);
  for (const l of FLOW_LOOPS) if (l.stop !== null) assert.ok(known.has(l.stop), `loop ${l.nodes.join('⇄')} の止まる理由 ${l.stop}`);
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

test('step が none でないノードは、stepNode(step) が自分か、自分から stepNode(step) へのエッジを持つ', () => {
  const bad = ids.filter((id) => {
    const step = nodes[id].step;
    if (step === 'none') return false;
    const target = stepNode(step);
    return !(target === id || hasEdge(id, target));
  });
  assert.deepEqual(bad, []);
  // stepNode の行き先はノードで、そのノードの step は自分自身
  for (const step of ['plan', 'implement', 'judge', 'fix', 'sync'] as const) {
    assert.ok(isNode(stepNode(step)), step);
    assert.equal(nodes[stepNode(step)].step, step, step);
  }
});

test('ループの両方向にエッジがあり、上限は plan⇄plan-critique が 3、fix⇄judge が fixLoop のキー、sync⇄judge が上限なし', () => {
  for (const l of FLOW_LOOPS) {
    const [a, b] = l.nodes;
    assert.ok(hasEdge(a, b), `${a}→${b}`);
    assert.ok(hasEdge(b, a), `${b}→${a}`);
    assert.ok(l.note.trim().length > 0, `${a}⇄${b} の note`);
  }
  const loopOf = (a: FlowNodeId, b: FlowNodeId) => FLOW_LOOPS.find((l) => (l.nodes[0] === a && l.nodes[1] === b) || (l.nodes[0] === b && l.nodes[1] === a));

  const critique = loopOf('plan', 'plan-critique');
  assert.ok(critique);
  assert.equal(critique.limit, 3);

  const fix = loopOf('fix', 'judge');
  assert.ok(fix);
  assert.ok(Array.isArray(fix.limit), 'fix⇄judge の上限は config のキー');
  const keys = (fix.limit as { config: string }[]).map((k) => k.config).sort();
  assert.deepEqual(keys, ['fixLoop.criticalLimit', 'fixLoop.normalLimit']);
  const config = loadConfig() as unknown as Record<string, Record<string, unknown>>;
  for (const key of keys) {
    const [group, name] = key.split('.') as [string, string];
    assert.equal(typeof config[group]?.[name], 'number', `harness.config.json の ${key}`);
  }
  assert.equal(fix.stop, 'fix-limit');

  const sync = loopOf('sync', 'judge');
  assert.ok(sync);
  assert.equal(sync.limit, null);
  assert.equal(sync.stop, null);
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
