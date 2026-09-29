// Issue #220：ダッシュボードのセッションの列を、動いているものと「ほか N 件」に畳むものに分ける処理（page.html の splitSessions）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PAGE_PATH } from '../scripts/dashboard.ts';
import type { SessionNode } from '../scripts/dashboard/graph.ts';

type SplitSessions = (sessions: SessionNode[]) => { running: SessionNode[]; others: SessionNode[] };

const html = readFileSync(PAGE_PATH, 'utf8');
const script = (): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  return m[1]!;
};

function load(): SplitSessions {
  const context: Record<string, unknown> = {};
  runInNewContext(script(), context);
  assert.equal(typeof context.splitSessions, 'function', 'splitSessions が定義されていない');
  const fn = context.splitSessions as SplitSessions;
  // vm の別レルムの配列・オブジェクトを deepEqual で比べられるよう、JSON で持ち帰る
  return (sessions) => JSON.parse(JSON.stringify(fn(sessions)));
}

const sub = (running: boolean) => ({ type: 'test-designer', description: 'd', lastAt: '2026-09-28T23:50:00Z', running });
const node = (id: string, running: boolean, subRunning: boolean[] = []): SessionNode => ({
  id: `session-${id}`, session: id, short: id.slice(0, 8), local: true, running, lastAt: '2026-09-28T23:50:00Z', subagents: subRunning.map(sub),
});
const ids = (xs: SessionNode[]) => xs.map((s) => s.id);

test('page.html の script は document の無い環境で実行しても例外にならず、splitSessions を定義する', () => {
  const context: Record<string, unknown> = {};
  assert.doesNotThrow(() => runInNewContext(script(), context));
  assert.equal(typeof context.splitSessions, 'function');
});

test('本体が動いているセッションは running に入る', () => {
  const split = load();
  const { running, others } = split([node('a', true), node('b', true, [false])]);
  assert.deepEqual(ids(running), ['session-a', 'session-b']);
  assert.deepEqual(others, []);
});

test('本体は止まっていてもサブエージェントのどれかが動いていれば running に入る', () => {
  const split = load();
  const { running, others } = split([node('a', false, [false, true]), node('b', false, [true])]);
  assert.deepEqual(ids(running), ['session-a', 'session-b']);
  assert.deepEqual(others, []);
});

test('本体もサブエージェントも動いていないセッションは others に入る', () => {
  const split = load();
  const { running, others } = split([node('a', false), node('b', false, [false, false])]);
  assert.deepEqual(running, []);
  assert.deepEqual(ids(others), ['session-a', 'session-b']);
});

test('混ざっていれば分け、それぞれ入力の順番のまま。中身はそのまま', () => {
  const split = load();
  const input = [node('c', false), node('a', true), node('d', false, [false]), node('b', false, [true]), node('e', false)];
  const { running, others } = split(input);
  assert.deepEqual(ids(running), ['session-a', 'session-b']);
  assert.deepEqual(ids(others), ['session-c', 'session-d', 'session-e']);
  assert.deepEqual(running[1], input[3]);
});

test('空の配列なら両方とも空', () => {
  const split = load();
  assert.deepEqual(split([]), { running: [], others: [] });
});
