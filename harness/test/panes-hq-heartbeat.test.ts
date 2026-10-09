// Issue #438：fleet の heartbeat の一言の控え（git の共通ディレクトリの下の agent-harness/hq/hq-heartbeat.json）と、hq のログのペイン。
// renderHqLog が一言を時刻・[テーマ] とともに Issue の行と時刻順にまぜること、freshHeartbeats が古い一言と控えに無い fleet の一言を落とすこと、
// readHeartbeatAt が無い・壊れた控えで null を返すこと、CLI の hq-state.ts heartbeat-save が同じテーマを置き換えること、
// panes.ts hq log --once が控えの隣の一言を出すことを、要点の語句だけで確かめる（文言を丸ごと固定しない）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStatusRow } from '../lib/fleet.ts';
import { stripAnsi, type PaneSnapshot } from '../lib/panes.ts';
import { renderHqLog, type HqView } from '../lib/panes-hq.ts';
import { freshHeartbeats, heartbeatPath, readHeartbeatAt, type HeartbeatFile } from '../scripts/hq-state.ts';

const root = join(import.meta.dirname, '..', '..');
const NOW = Date.parse('2026-09-30T00:10:00.000Z');
const minutesAgo = (m: number, base = NOW): string => new Date(base - m * 60000).toISOString();
const hhmm = (iso: string): string => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-heartbeat-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const row = (issue: number): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-ok', stageLabel: FLEET_STAGES['plan-ok'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const snap = (session: string, since: Record<number, string>): PaneSnapshot => {
  const rows = Object.keys(since).map((n) => row(Number(n)));
  return {
    version: 1, at: minutesAgo(1), session, label: null, intervalSeconds: 180, issues: rows.map((r) => r.issue),
    status: { version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null },
    prs: [], usage: null, history: [],
    since: Object.fromEntries(Object.entries(since).map(([n, at]) => [n, { signature: 's', at }])), error: null,
  };
};

// ---- renderHqLog：一言を Issue の行と時刻順にまぜる（AC1） ----

test('renderHqLog：一言を時刻・[テーマ] とともに、Issue の行と時刻の新しい順にまぜて出す', () => {
  const v: HqView = {
    ledger: true,
    fleets: [{ fleet: { theme: 'ops', epic: null, session: 's-a', startedAt: minutesAgo(30) }, snap: snap('s-a', { 11: minutesAgo(5), 12: minutesAgo(9) }), state: 'ok' }],
  };
  const noteAt = minutesAgo(7);
  const text = stripAnsi(renderHqLog(v, NOW, 120, 40, [{ theme: 'ops', note: '計画の批評中', at: noteAt }]));
  const i11 = text.indexOf('#11');
  const iNote = text.indexOf('計画の批評中');
  const i12 = text.indexOf('#12');
  assert.ok(i11 >= 0 && i11 < iNote && iNote < i12, text);
  const line = text.split('\n').find((l) => l.includes('計画の批評中')) ?? '';
  assert.ok(line.includes(hhmm(noteAt)) && line.includes('[ops]'), line);
});

// ---- freshHeartbeats：古い一言と控えに無い fleet の一言を落とす ----

test('freshHeartbeats：staleMinutes を超えた一言と、themes に無いテーマの一言を落とす', () => {
  const file: HeartbeatFile = {
    version: 1,
    notes: [
      { theme: 'a', note: '新しい', at: minutesAgo(5) },
      { theme: 'b', note: '古い', at: minutesAgo(40) },
      { theme: 'gone', note: '片付けた fleet', at: minutesAgo(1) },
    ],
  };
  assert.deepEqual(freshHeartbeats(file, ['a', 'b'], NOW, 30).map((n) => n.theme), ['a']);
});

// ---- readHeartbeatAt：無い・読めない控え（AC2） ----

test('readHeartbeatAt：無いパスと壊れた JSON は null（投げない）で、freshHeartbeats(null) は空', () => withDir((dir) => {
  assert.equal(readHeartbeatAt(join(dir, 'no-such.json')), null);
  const broken = join(dir, 'hq-heartbeat.json');
  writeFileSync(broken, '{壊れた');
  assert.equal(readHeartbeatAt(broken), null);
  assert.deepEqual(freshHeartbeats(null, ['a'], NOW, 30), []);
}));

// ---- CLI hq-state.ts heartbeat-save ----

test('CLI heartbeat-save：控えに書き、同じテーマを2回書くと後の一言の1件に置き換わる', () => withDir((dir) => {
  const save = (note: string) =>
    spawnSync(process.execPath, ['harness/scripts/hq-state.ts', 'heartbeat-save', '--common-dir', dir, '--theme', 'ops', '--note', note], { cwd: root, encoding: 'utf8' });
  const first = save('前の一言');
  assert.equal(first.status, 0, first.stderr);
  const second = save('後の一言');
  assert.equal(second.status, 0, second.stderr);
  const file = JSON.parse(readFileSync(heartbeatPath(dir), 'utf8')) as HeartbeatFile;
  assert.equal(file.notes.length, 1, JSON.stringify(file));
  assert.equal(file.notes[0]?.theme, 'ops');
  assert.equal(file.notes[0]?.note, '後の一言');
}));

// ---- CLI panes.ts hq log --once：控えの隣の一言を出す（AC1 を入口から） ----

test('CLI hq log --once：控えの隣の hq-heartbeat.json に今の一言があれば、時刻・[テーマ] とともに出す', () => withDir((dir) => {
  const now = Date.now();
  const at = minutesAgo(0, now);
  const ledgerFile = join(dir, 'hq-fleets.json');
  writeFileSync(ledgerFile, JSON.stringify({
    version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], updatedAt: at,
    fleets: [{ theme: 'ops', session: null, startedAt: at }],
  }));
  const heartbeat: HeartbeatFile = { version: 1, notes: [{ theme: 'ops', note: '実装の途中', at }] };
  writeFileSync(join(dir, 'hq-heartbeat.json'), JSON.stringify(heartbeat));
  const r = spawnSync(process.execPath, ['harness/scripts/panes.ts', 'hq', 'log', '--once', '--fleets', ledgerFile], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.includes('実装の途中')) ?? '';
  assert.ok(line.includes('[ops]') && line.includes(hhmm(at)), r.stdout);
}));
