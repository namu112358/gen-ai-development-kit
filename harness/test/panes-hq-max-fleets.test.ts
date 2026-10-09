// Issue #522：このリポジトリの hq.maxFleets（harness.config.json）で、fleet が5つまでなら hq の人待ちのペインに上限の注意が出ず、
// 超えると出ることを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { hqConfig, type HarnessConfig } from '../lib/config.ts';
import { stripAnsi } from '../lib/panes.ts';
import { renderHqTodo, type HqFleetView, type HqView } from '../lib/panes-hq.ts';

const root = join(import.meta.dirname, '..', '..');
const readJson = (path: string): HarnessConfig => JSON.parse(readFileSync(path, 'utf8')) as HarnessConfig;
const { maxFleets } = hqConfig(readJson(join(root, 'harness.config.json')));

const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const view = (n: number): HqView => ({
  ledger: true,
  fleets: Array.from({ length: n }, (_, i): HqFleetView => ({
    fleet: { theme: `f${i}`, epic: null, session: null, startedAt: '2026-09-30T00:09:00.000Z' },
    snap: null,
    state: 'starting',
  })),
});
const todo = (n: number): string => stripAnsi(renderHqTodo(view(n), NOW, 160, maxFleets));

// n=6 は panes-hq.test.ts の「超えると警告の行」と重なるが、このリポジトリの値 5 が境目であることを固定するために残す。
for (const [n, warned] of [[4, false], [5, false], [6, true]] as const) {
  test(`renderHqTodo：このリポジトリの hq.maxFleets で fleet が ${n} 個なら上限の注意が${warned ? '出る' : '出ない'}`, () => {
    const text = todo(n);
    if (warned) assert.match(text, /hq\.maxFleets/);
    else assert.doesNotMatch(text, /hq\.maxFleets/);
  });
}
