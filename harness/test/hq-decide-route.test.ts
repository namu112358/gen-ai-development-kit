// Issue #780：hq の手順7の判定（harness/scripts/hq-decide.ts の routeDelivery・handoverDecision）を、入力と期待の表で確かめる。
// route は便りの種類・件名・本文ごとの action（交代の質問は印 [交代] と「交代しますか」の両方、ready の本文の1行目の印
// （自動 Merge は list、Human Merge と印なしは tell-now）と notice の3つの場合（人の判断が要る・要らない・印なし。Issue #772）、
// 知らない種類は ask-human）。handover は decision と failed の5つの値（claims-remain・no-session・epic-differs・issues-differ・unknown-fleet）。
// CLI は route の1件だけ（--wake のファイルを読んで JSON を標準出力に書く）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { handoverDecision, routeDelivery } from '../scripts/hq-decide.ts';
import type { CheckMessage } from '../scripts/hq-watch.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- routeDelivery ----

const routes: { msg: CheckMessage; action: string; dispatch: string | null }[] = [
  { msg: { id: 'm1', type: 'heartbeat', from_handle: 'dispatch:d-A', body: '#10 実装中' }, action: 'heartbeat-save', dispatch: 'd-A' },
  { msg: { id: 'm2', type: 'question', from_handle: 'dispatch:d-A', body: '[交代] Epic #50、Issue #10 #11' }, action: 'handover-check', dispatch: 'd-A' },
  { msg: { id: 'm3', type: 'question', from_handle: 'term-9', body: 'ハーネスが更新されました。交代しますか？' }, action: 'handover-check', dispatch: null },
  { msg: { id: 'm4', type: 'question', from_handle: 'dispatch:d-A', body: '#10 の計画の files を広げてよいですか' }, action: 'ask-human', dispatch: 'd-A' },
  { msg: { id: 'm5', type: 'escalation', from_handle: 'dispatch:d-A', body: '止まりました' }, action: 'escalation', dispatch: 'd-A' },
  { msg: { id: 'm6', type: 'worker_done', from_handle: 'dispatch:d-A' }, action: 'worker-done', dispatch: 'd-A' },
  { msg: { id: 'm7', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-120' }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm8', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 は人の判断が要る' }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm9', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 の計画を出し直した' }, action: 'notice-unmarked', dispatch: 'd-A' },
  { msg: { id: 'm7a', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-121', body: '自動 Merge：#11 は合格\n判定は low' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm7b', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-122', body: '  Human Merge：#12 は人の Merge 待ち  \n自動 Merge にはならない' }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm7c', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-123', body: '  自動 Merge  \n' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm7d', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-124', body: '#13 は合格\n自動 Merge' }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm8a', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 の計画を出し直した。人の判断は要らない' }, action: 'intel', dispatch: 'd-A' },
  { msg: { id: 'm8b', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', body: '#10 は人の判断は要らない。#11 は人の判断が要る' }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm8c', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', payload: { body: '#10 は人の判断が要る' } }, action: 'tell-now', dispatch: 'd-A' },
  { msg: { id: 'm8d', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', payload: '#10 は人の判断は要らない' }, action: 'intel', dispatch: 'd-A' },
  { msg: { id: 'm8e', type: 'status', from_handle: 'dispatch:d-A', subject: 'notice', payload: { text: '#10 の計画を出し直した' } }, action: 'notice-unmarked', dispatch: 'd-A' },
  { msg: { id: 'm10', type: 'status', from_handle: 'dispatch:d-A', subject: 'merged-120' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm11', type: 'status', from_handle: 'dispatch:d-A', subject: 'verdict-120' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm12', type: 'status', from_handle: 'dispatch:d-A', subject: 'wait-10' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm13', type: 'status', from_handle: 'dispatch:d-A' }, action: 'list', dispatch: 'd-A' },
  { msg: { id: 'm14', type: 'something-new', from_handle: 'dispatch:d-A', body: '?' }, action: 'ask-human', dispatch: 'd-A' },
];

test('routeDelivery：便りの種類・件名・本文ごとの action（届いた順のまま）', () => {
  const r = routeDelivery({ deliveryId: 'dl-1', messages: routes.map((c) => c.msg) });
  assert.equal(r.deliveryId, 'dl-1');
  assert.deepEqual(
    r.items.map((i) => ({ id: i.id, type: i.type, from: i.from, dispatch: i.dispatch, action: i.action })),
    routes.map((c) => ({ id: c.msg.id, type: c.msg.type, from: c.msg.from_handle, dispatch: c.dispatch, action: c.action })),
  );
});

// ---- handoverDecision ----

type HandoverInput = Parameters<typeof handoverDecision>[0];
type Ledger = HandoverInput['ledgerFleets'];

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const claim: FleetClaimInfo = { by: 'manual', stage: 'implement', session: 'sess-old', own: false };
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});

const LEDGER = [
  { theme: 'a', epic: 50, dispatch: 'd-A', session: 's-A', issues: [10, 11] },
  { theme: 'b', epic: null, dispatch: 'd-B', session: null, issues: [20] },
  { theme: 'c', epic: null, dispatch: 'd-C', session: 's-C', issues: [30] },
] as Ledger;
const FREE_A = statusData([row(10), row(11)]);
const WORKERS = [{ dispatchId: 'd-A', agentTerminalHandle: 'term-9' }];

const handovers: { name: string; input: Partial<HandoverInput>; decision: 'auto' | 'ask'; failed: string[]; theme?: string; dispatch?: string }[] = [
  { name: 'dispatch: の送り手・条件がそろう（Issue の順は問わない）→ auto', input: { issues: [11, 10] }, decision: 'auto', failed: [], theme: 'a', dispatch: 'd-A' },
  { name: '端末の送り手を worker-list で引く → auto', input: { fromHandle: 'term-9', workers: WORKERS }, decision: 'auto', failed: [], theme: 'a', dispatch: 'd-A' },
  {
    name: '単発（epic: null）の fleet で条件がそろう → auto',
    input: { fromHandle: 'dispatch:d-C', epic: null, issues: [30], status: statusData([row(30)]) },
    decision: 'auto', failed: [], theme: 'c', dispatch: 'd-C',
  },
  { name: '(a) Issue の宣言が残る（セッションは問わない）→ ask', input: { status: statusData([row(10, { claim }), row(11)]) }, decision: 'ask', failed: ['claims-remain'], theme: 'a', dispatch: 'd-A' },
  { name: '(a) PR の宣言が残る → ask', input: { status: statusData([row(10), row(11, { pr: 120, prClaim: { ...claim, own: true } })]) }, decision: 'ask', failed: ['claims-remain'] },
  {
    name: '(b) 控えのその fleet の session が null → ask',
    input: { fromHandle: 'dispatch:d-B', epic: null, issues: [20], status: statusData([row(20)]) },
    decision: 'ask', failed: ['no-session'], theme: 'b', dispatch: 'd-B',
  },
  { name: '(c) 質問の Epic が控えと違う → ask', input: { epic: 51 }, decision: 'ask', failed: ['epic-differs'] },
  { name: '(c) 単発と書いた質問が Epic の fleet から来た → ask', input: { epic: null }, decision: 'ask', failed: ['epic-differs'] },
  { name: '(c) Issue 番号の集合が控えより少ない → ask', input: { issues: [10] }, decision: 'ask', failed: ['issues-differ'] },
  { name: '(c) Issue 番号の集合が控えより多い → ask', input: { issues: [10, 11, 12] }, decision: 'ask', failed: ['issues-differ'] },
  {
    name: '当てはまらない条件はすべて failed に入る',
    input: { epic: 51, issues: [10], status: statusData([row(10, { claim })]) },
    decision: 'ask', failed: ['claims-remain', 'epic-differs', 'issues-differ'],
  },
  { name: 'Dispatch が控えに無い → ask', input: { fromHandle: 'dispatch:d-X' }, decision: 'ask', failed: ['unknown-fleet'] },
  { name: '端末の送り手を worker-list で引けない（worker-list なし）→ ask', input: { fromHandle: 'term-9', workers: null }, decision: 'ask', failed: ['unknown-fleet'] },
  { name: '端末の送り手が worker-list に無い → ask', input: { fromHandle: 'term-0', workers: WORKERS }, decision: 'ask', failed: ['unknown-fleet'] },
];

test('handoverDecision：読み込みが古い交代の質問を、聞かずに交代してよいか', () => {
  for (const c of handovers) {
    const input: HandoverInput = {
      fromHandle: 'dispatch:d-A', workers: null, epic: 50, issues: [10, 11], status: FREE_A, ledgerFleets: LEDGER, ...c.input,
    };
    const r = handoverDecision(input);
    assert.equal(r.decision, c.decision, `${c.name}：decision`);
    assert.deepEqual([...r.failed].sort(), [...c.failed].sort(), `${c.name}：failed`);
    if (c.theme !== undefined) assert.equal(r.theme, c.theme, `${c.name}：theme`);
    if (c.dispatch !== undefined) assert.equal(r.dispatch, c.dispatch, `${c.name}：dispatch`);
  }
});

// ---- CLI（route の1件だけ） ----

test('CLI route --wake：hq-watch.ts の出力のファイルを読み、振り分けを JSON で標準出力に書く', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-decide-route-'));
  try {
    const file = join(dir, 'wake.json');
    writeFileSync(file, JSON.stringify({ wake: 'messages', deliveryId: 'dl-9', messages: [{ id: 'm1', type: 'status', from_handle: 'dispatch:d-A', subject: 'ready-120' }] }));
    const r = spawnSync(process.execPath, ['harness/scripts/hq-decide.ts', 'route', '--wake', file], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.deliveryId, 'dl-9');
    assert.deepEqual(out.items.map((i: { id: string; action: string; dispatch: string | null }) => [i.id, i.action, i.dispatch]), [['m1', 'tell-now', 'd-A']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
