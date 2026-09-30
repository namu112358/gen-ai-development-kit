// Issue #409：fleet の「あなたがすること」のペイン（panes.ts todo）が、hq がいない間の質問の控えを先頭に出すことを確かめる。
// todoDraw がどのセッションの控えを読むか（--session、無ければスナップショットの session、どちらも無ければ読まない）を偽の readPending で確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { renderTodo, type PaneSnapshot } from '../lib/panes.ts';
import { addPending, answerPending, renderPending, type PendingFile } from '../scripts/hq-state.ts';
import { todoDraw } from '../scripts/panes.ts';

const row = (issue: number): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-review', stageLabel: FLEET_STAGES['plan-review'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null,
});
const snap = (patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: '2026-09-30T00:00:00.000Z', session: 'sess-snap', label: null, intervalSeconds: 180, issues: [409],
  status: statusData([row(409)]), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});
const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const AT = '2026-09-30T00:00:00.000Z';

const pending = (session: string): PendingFile =>
  addPending(null, session, { issue: 409, stage: 'plan', question: '進めてよいか', options: ['進める', 'やめる'], messageId: 'm1' }, AT);

/** 呼ばれたセッションを控える偽の readPending */
const fake = (result: (session: string) => PendingFile | null) => {
  const calls: string[] = [];
  return { calls, read: (session: string) => { calls.push(session); return result(session); } };
};

test('todoDraw：--session の控えがあれば、控えの行・空行・renderTodo の順に出す', () => {
  const f = fake((s) => pending(s));
  const s = snap();
  const out = todoDraw('sess-arg', f.read)(s, NOW, 100);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c === 'sess-arg'), JSON.stringify(f.calls));
  const lines = renderPending(pending('sess-arg'));
  assert.ok(lines.length > 0);
  assert.equal(out, `${lines.join('\n')}\n\n${renderTodo(s, NOW, 100)}`);
});

test('todoDraw：--session が無ければスナップショットの session で控えを読む', () => {
  const f = fake((s) => pending(s));
  const out = todoDraw(null, f.read)(snap(), NOW, 100);
  assert.ok(f.calls.length > 0 && f.calls.every((c) => c === 'sess-snap'), JSON.stringify(f.calls));
  assert.ok(out.includes('hq がいない間の質問（fleet のタブで答える）'));
  assert.ok(out.includes('#409'));
});

test('todoDraw：--session もスナップショットも無ければ控えを読まず、renderTodo と同じ', () => {
  const f = fake((s) => pending(s));
  assert.equal(todoDraw(null, f.read)(null, NOW, 100), renderTodo(null, NOW, 100));
  assert.deepEqual(f.calls, []);
});

test('todoDraw：控えが無い・答えの無い質問が無ければ renderTodo と同じ', () => {
  const s = snap();
  assert.equal(todoDraw('sess-arg', fake(() => null).read)(s, NOW, 100), renderTodo(s, NOW, 100));
  const answered = answerPending(pending('sess-arg'), 409, '進める', AT);
  assert.equal(todoDraw('sess-arg', fake(() => answered).read)(s, NOW, 100), renderTodo(s, NOW, 100));
});

test('todoDraw：スナップショットが無くても --session の控えは出す', () => {
  const f = fake((s) => pending(s));
  const out = todoDraw('sess-arg', f.read)(null, NOW, 100);
  assert.deepEqual([...new Set(f.calls)], ['sess-arg']);
  assert.ok(out.endsWith(renderTodo(null, NOW, 100)));
  assert.ok(out.includes('#409'));
});
