// Issue #402：collect が読んだ Epic（読み方は panes-hq-epics.test.ts）のスナップショット（epics・issueEpic）から hq の Epic のページが
// Close の数を描くこと、hq の描く入口（startHqRender）が控えとスナップショットだけを読み（run が無く GitHub を
// 読まない）、描くたびに控えを読み直して今動いている fleet を見つけることを、偽の deps と schedule で確かめる。
// CLI の入口（ペインの名前が無い `panes.ts hq` は todo、--session は止まる）は子のプロセスの --once で確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { CLEAR_SCREEN, stripAnsi, type PaneSnapshot } from '../lib/panes.ts';
import { readHqView, renderHqBoard, type HqView } from '../lib/panes-hq.ts';
import {
  collectOnce, startHqRender, type CollectDeps, type CollectOptions, type HqRenderDeps, type RunResult,
} from '../scripts/panes.ts';
import { config } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.length, selected: rows.map((r) => r.issue), max: null, mode: null,
});
const NOW = Date.parse('2026-09-30T01:00:00.000Z');

/** 偽の gh の応答：Epic 281（11 CLOSED・12 OPEN の sub-issues が1ページ・記録なし） */
const SUB_ISSUES = { data: { repository: { issue: { subIssues: { nodes: [{ number: 11, title: 'a', state: 'CLOSED' }, { number: 12, title: 'b', state: 'OPEN' }], pageInfo: { hasNextPage: false, endCursor: null } } } } } };

interface Call { cmd: string; args: string[] }

function fakeDeps(o: { issues?: number[]; prev?: PaneSnapshot | null } = {}): { deps: CollectDeps; calls: Call[]; written: PaneSnapshot[] } {
  const calls: Call[] = [];
  const written: PaneSnapshot[] = [];
  const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: '' });
  const rows = (o.issues ?? [11, 12, 22]).map((n) => row(n));
  const deps: CollectDeps = {
    run(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') return ok(JSON.stringify([{ number: 281, title: 'Epic', state: 'OPEN' }]));
      if (cmd === 'gh' && args[0] === 'api' && args[1] === 'graphql') return ok(JSON.stringify(SUB_ISSUES));
      if (cmd === 'gh' && args[0] === 'api' && args.includes('--slurp')) return ok('[[]]');
      if (cmd === 'gh') return { status: 1, stdout: '', stderr: 'not found' };
      if (args[1] === 'fleet-status') return ok(JSON.stringify(statusData(rows)));
      return { status: 1, stdout: '', stderr: 'unknown' };
    },
    exists: () => false,
    readSnapshot: () => o.prev ?? null,
    writeSnapshot: (_p, s) => { written.push(s); },
    now: () => new Date(NOW),
    env: { PATH: '/bin' },
    root: '/repo',
    home: '/home/u',
    node: 'node-bin',
  };
  return { deps, calls, written };
}
const opts = (issues: number[] = [11, 12, 22]): CollectOptions => ({
  session: 'sess-1', label: 'fleet-a', issues, snapshotPath: '/tmp/agent-harness-panes/sess-1.json', transcriptCwd: '/work', intervalSeconds: 180, config,
});

// ---- collectOnce：fleet の Issue が0件 ----

test('collectOnce：fleet の Issue が0件なら Epic を読まない（gh を呼ばない）', () => {
  const { deps, calls } = fakeDeps({ issues: [] });
  collectOnce(deps, opts([]));
  assert.equal(calls.filter((c) => c.cmd === 'gh').length, 0);
});

// ---- collect から描くまで：描く側は GitHub を読まない ----

test('collect が書いたスナップショットから、Epic のページが Close の数を描く（描く側は gh を呼ばない）', () => {
  const { deps } = fakeDeps();
  const s = collectOnce(deps, opts());
  const v = readHqView({ fleets: [{ theme: 'ペイン', epic: 281, session: 'sess-1', startedAt: '2026-09-30T00:50:00.000Z' }] }, () => s, NOW, 10);
  const text = stripAnsi(renderHqBoard(v, 'epic', NOW, 120));
  assert.ok(text.includes('1/2'), text);
  assert.ok(text.includes('#281'), text);
});

test('lib/panes-hq.ts は node:child_process・node:fs・github・scripts を import しない', () => {
  const src = readFileSync(join(root, 'harness', 'lib', 'panes-hq.ts'), 'utf8');
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
  for (const s of specs) {
    assert.ok(!['node:child_process', 'child_process', 'node:fs', 'fs', 'node:fs/promises'].includes(s), s);
    assert.doesNotMatch(s, /github(\.ts)?$/, s);
    assert.doesNotMatch(s, /scripts\//, s);
  }
});

// ---- startHqRender ----

test('startHqRender：HqRenderDeps に run が無い（描く側は GitHub を読めない）', () => {
  type HasRun = 'run' extends keyof HqRenderDeps ? true : false;
  const noRun: HasRun = false;
  assert.equal(noRun, false);
});

test('startHqRender：すぐ1回描き、以後は控えを読み直して今の fleet を見つける（セッションを渡さない）', () => {
  let ledger: { fleets: Record<string, unknown>[] } | null = { fleets: [{ theme: 'a', session: 'sess-a', startedAt: '2026-09-30T00:59:00.000Z' }] };
  const snaps: Record<string, PaneSnapshot> = {
    'sess-a': { version: 1, at: '2026-09-30T00:59:00.000Z', session: 'sess-a', label: null, intervalSeconds: 180, issues: [], status: null, prs: [], usage: null, history: [], since: {}, error: null },
  };
  const used: string[] = [];
  const read: string[] = [];
  const out: string[] = [];
  const deps: HqRenderDeps = {
    readLedger: () => { used.push('readLedger'); return ledger; },
    readSnapshot: (s) => { used.push('readSnapshot'); read.push(s); return snaps[s] ?? null; },
    write: (t) => { used.push('write'); out.push(t); },
    now: () => NOW,
    width: () => 90,
    height: () => 30,
    staleMinutes: 10,
  };
  const views: HqView[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const redraw = startHqRender(deps, (v, now, width, height) => { views.push(v); return `DRAW ${now} ${width} ${height}`; }, (fn, ms) => { scheduled.push({ fn, ms }); });

  assert.equal(out.length, 1, 'すぐ1回描く');
  assert.equal(out[0], `${CLEAR_SCREEN}DRAW ${NOW} 90 30`);
  assert.deepEqual(views[0]?.fleets.map((f) => f.fleet.session), ['sess-a']);
  assert.equal(views[0]?.fleets[0]?.state, 'ok');
  assert.equal(scheduled[0]?.ms, 5000, '既定の間隔は 5000ms');

  ledger = { fleets: [...ledger.fleets, { theme: 'b', session: 'sess-b', startedAt: '2026-09-30T00:59:00.000Z' }] };
  scheduled[0]?.fn();
  assert.equal(out.length, 2);
  assert.ok(out[1]?.startsWith(CLEAR_SCREEN));
  assert.deepEqual(views[1]?.fleets.map((f) => f.fleet.theme), ['a', 'b'], '控えに足された fleet を次の描画で見つける');
  assert.ok(read.includes('sess-b'));

  ledger = null;
  redraw();
  assert.equal(out.length, 3, '返した関数で描き直す');
  assert.equal(views[2]?.ledger, false);
  assert.deepEqual([...new Set(used)].sort(), ['readLedger', 'readSnapshot', 'write']);

  const s2: number[] = [];
  startHqRender(deps, () => '', (_fn, ms) => { s2.push(ms); }, 1000);
  assert.equal(s2[0], 1000);
});

// ---- CLI の入口（子のプロセスで --once。控えは無いパスを --fleets で渡す） ----

const script = join(root, 'harness', 'scripts', 'panes.ts');
const missingLedger = join(root, 'harness', 'test', 'no-such-hq-fleets.json');
const cli = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });

test('panes.ts hq：ペインの名前が無ければ todo（人待ち）を描く（intel の skill の案内が止まらない）', () => {
  const bare = cli(['hq', '--once', '--fleets', missingLedger]);
  assert.equal(bare.status, 0, bare.stderr);
  const todo = cli(['hq', 'todo', '--once', '--fleets', missingLedger]);
  assert.equal(todo.status, 0, todo.stderr);
  assert.match(bare.stdout, /人待ち/);
  assert.equal(bare.stdout, todo.stdout);
});

test('panes.ts hq：--session を渡すと止まる', () => {
  const r = cli(['hq', 'todo', '--once', '--session', 'abc', '--fleets', missingLedger]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--session/);
});
