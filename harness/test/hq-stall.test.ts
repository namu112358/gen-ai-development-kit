// Issue #287：hq が進んでいない fleet を見つける判定（harness/lib/hq-stall.ts）と、それを JSON で出す `panes.ts fleets` を確かめる。
// しきい値の定数 HQ_STALL_DEFAULTS の値（#1076 で設定キーを外し、定数だけで動かす）、スナップショットの古さと AI の番の行の長さの境界、
// `--session` で渡したセッションだけを読むこと（無いものは missing）、`--session` なしで止まることを確かめる。
// 後半は Issue #199：fleet の待つ間の読み直し（旧 harness/lib/fleet-watch.ts。#1025 で hq-stall.ts に寄せた）。定数 FLEET_WATCH_DEFAULTS の値、App 待ちの行の見張り（updateWatch：
// 最初に見た行は知らせない・appStallMinutes を過ぎた plan-gate・auto-merge の行だけを1回だけ知らせる・段階や PR が変われば数え直す・人の番は数えない）、
// Merge 後の見届けが済んでいない行（pendingFollowUps：記録に頼らず事実だけで決める）、見張りの記録のパスと読み書き、
// fleet-status.ts が --watch のときだけ updateWatch を呼ぶこと（#199。fleet-watch-skill.test.ts から移した）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import {
  APP_WAIT_STAGES,
  FLEET_WATCH_DEFAULTS,
  fleetStall,
  HQ_STALL_DEFAULTS,
  missingFleet,
  pendingFollowUps,
  readWatchRecord,
  updateWatch,
  type WatchRecord,
  watchRecordPath,
  type WatchRow,
  writeWatchRecord,
} from '../lib/hq-stall.ts';
import type { PaneSince, PaneSnapshot } from '../lib/panes.ts';
import { agentSourceFiles } from './support/agent-source.ts';
import { readText } from './support/skill-text.ts';

const root = join(import.meta.dirname, '..', '..');
const PANES = join(root, 'harness', 'scripts', 'panes.ts');

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const own = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-1', own: true });
const other = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-other', own: false });

const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const MIN = 60000;
/** NOW から m 分前の ISO */
const minsAgo = (m: number): string => new Date(NOW - m * MIN).toISOString();
const sinceOf = (entries: [number, number][]): PaneSince => Object.fromEntries(entries.map(([issue, m]) => [String(issue), { signature: 'x', at: minsAgo(m) }]));

const snap = (rows: FleetStatusRow[], patch: Partial<PaneSnapshot> = {}): PaneSnapshot => ({
  version: 1, at: minsAgo(1), session: 'sess-1', label: 'テーマA', intervalSeconds: 180, issues: rows.map((r) => r.issue),
  status: statusData(rows), prs: [], usage: null, history: [], since: {}, error: null, ...patch,
});

const CFG = { staleSnapshotMinutes: 30, stuckMinutes: 120 };

// ---- しきい値の定数 ----

test('HQ_STALL_DEFAULTS：staleSnapshotMinutes 30・stuckMinutes 120', () => {
  assert.deepEqual(HQ_STALL_DEFAULTS, { staleSnapshotMinutes: 30, stuckMinutes: 120 });
});

// ---- fleetStall：スナップショットの古さ ----

test('fleetStall：session・label・totalUsd をスナップショットから写す', () => {
  const s = fleetStall(snap([], { session: 'abc', label: 'テーマB', usage: { totalUsd: 1.25, perModel: {} } }), NOW, CFG);
  assert.equal(s.session, 'abc');
  assert.equal(s.label, 'テーマB');
  assert.equal(s.totalUsd, 1.25);
  assert.equal(s.missing, undefined);
});

test('fleetStall：usage が無ければ totalUsd は null', () => {
  assert.equal(fleetStall(snap([], { usage: null }), NOW, CFG).totalUsd, null);
});

test('fleetStall：スナップショットの at が staleSnapshotMinutes 以上前なら staleSnapshot（境界は「以上」）', () => {
  const before = fleetStall(snap([], { at: minsAgo(29) }), NOW, CFG);
  assert.equal(before.staleSnapshot, false);
  assert.equal(before.stalled, false);
  const at = fleetStall(snap([], { at: minsAgo(30) }), NOW, CFG);
  assert.equal(at.staleSnapshot, true);
  assert.equal(at.stalled, true);
  const after = fleetStall(snap([], { at: minsAgo(31) }), NOW, CFG);
  assert.equal(after.staleSnapshot, true);
  assert.equal(after.snapshotAgeMinutes, 31);
});

test('fleetStall：しきい値は cfg に従う', () => {
  const s = fleetStall(snap([], { at: minsAgo(10) }), NOW, { staleSnapshotMinutes: 10, stuckMinutes: 120 });
  assert.equal(s.staleSnapshot, true);
});

// ---- fleetStall：進んでいない行 ----

test('fleetStall：AI の番の行の since が stuckMinutes 以上前なら stuck（境界は「以上」）', () => {
  const rows = [row(1), row(2), row(3)];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 119], [2, 120], [3, 180]]) }), NOW, CFG);
  assert.deepEqual(s.stuck?.map((x) => x.issue).sort(), [2, 3]);
  assert.deepEqual(s.stuck?.find((x) => x.issue === 2)?.minutes, 120);
  assert.deepEqual(s.stuck?.find((x) => x.issue === 3)?.minutes, 180);
  assert.equal(s.staleSnapshot, false);
  assert.equal(s.stalled, true, 'stuck があれば stalled');
});

test('fleetStall：自分の宣言で AI が作業中の行（implement・judge など）も stuck に入る', () => {
  const rows = [row(1, { claim: own('implement') }), row(2, { stage: 'judge', pr: 50, prClaim: own('judge') })];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 200], [2, 200]]) }), NOW, CFG);
  assert.deepEqual(s.stuck?.map((x) => x.issue).sort(), [1, 2]);
});

test('fleetStall：人の番・App の番・待ち・終わった行は、長くても stuck に入れない', () => {
  const rows = [
    row(1, { stage: 'human-merge', pr: 50 }), // human
    row(2, { stage: 'plan-review' }), // human
    row(3, { stage: 'plan-gate' }), // app
    row(4, { stage: 'auto-merge', pr: 51 }), // app
    row(5, { stage: 'plan-ok', selected: false, waitReason: '重なり #1' }), // wait
    row(6, { stage: 'merged' }), // done
  ];
  const s = fleetStall(snap(rows, { since: sinceOf(rows.map((r) => [r.issue, 600] as [number, number])) }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：ほかのセッションの宣言の行（other）は stuck に入れない', () => {
  const rows = [row(1, { claim: other('implement') })];
  const s = fleetStall(snap(rows, { since: sinceOf([[1, 600]]) }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：since が無い行・at が読めない行は stuck に入れない', () => {
  const rows = [row(1), row(2)];
  const since: PaneSince = { '2': { signature: 'x', at: 'not-a-date' } };
  const s = fleetStall(snap(rows, { since }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
  assert.equal(s.stalled, false);
});

test('fleetStall：fleet-status が読めていない（status が null）なら stuck は空', () => {
  const s = fleetStall(snap([], { status: null }), NOW, CFG);
  assert.deepEqual(s.stuck, []);
});

test('fleetStall：stuckMinutes は cfg に従う', () => {
  const s = fleetStall(snap([row(1)], { since: sinceOf([[1, 45]]) }), NOW, { staleSnapshotMinutes: 30, stuckMinutes: 45 });
  assert.deepEqual(s.stuck?.map((x) => x.issue), [1]);
});

// ---- missingFleet ----

test('missingFleet：{ session, missing: true, stalled: true }', () => {
  assert.deepEqual(missingFleet('abc'), { session: 'abc', missing: true, stalled: true });
});

// ---- CLI：panes.ts fleets ----

/** OS の一時ディレクトリを dir に差し替えて panes.ts を動かす */
function runPanes(dir: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir };
  return spawnSync(process.execPath, [PANES, ...args], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
}

function writeSnap(dir: string, s: PaneSnapshot): void {
  const d = join(dir, 'agent-harness-panes');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${s.session}.json`), JSON.stringify(s));
}

test('panes.ts fleets：--session で渡したセッションのスナップショットだけを読み、FleetStall の配列を JSON で出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-stall-'));
  try {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 24 * 60 * MIN).toISOString();
    writeSnap(dir, snap([row(1)], { session: 'fleetA', label: 'テーマA', at: recent, since: { '1': { signature: 'x', at: recent } } }));
    writeSnap(dir, snap([row(2)], { session: 'fleetB', label: 'テーマB', at: old, usage: { totalUsd: 3.5, perModel: {} } }));
    writeSnap(dir, snap([], { session: 'fleetOld', at: old })); // 渡さないセッションは読まない
    const r = runPanes(dir, ['fleets', '--session', 'fleetA', '--session', 'fleetB', '--session', 'fleetGone']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { session: string; missing?: boolean; label?: string | null; staleSnapshot?: boolean; stalled: boolean; totalUsd?: number | null }[];
    assert.ok(Array.isArray(out));
    assert.deepEqual(out.map((x) => x.session), ['fleetA', 'fleetB', 'fleetGone']);
    const [a, b, gone] = out;
    assert.equal(a!.label, 'テーマA');
    assert.equal(a!.staleSnapshot, false);
    assert.equal(a!.stalled, false);
    assert.equal(b!.staleSnapshot, true, '既定の 30 分より古い');
    assert.equal(b!.stalled, true);
    assert.equal(b!.totalUsd, 3.5);
    assert.deepEqual(gone, { session: 'fleetGone', missing: true, stalled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('panes.ts fleets：--session が無ければ終了コード 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-stall-'));
  try {
    writeSnap(dir, snap([], { session: 'fleetA' }));
    const r = runPanes(dir, ['fleets']);
    assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.notEqual(r.stderr.trim(), '', '使い方を示す');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- fleet の待つ間の読み直し（旧 harness/test/fleet-watch.test.ts） ---

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const T0 = new Date('2026-09-30T00:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const WATCH_CFG = { appStallMinutes: 20 };

const watchRow = (issue: number, stage: string, pr: number | null = null): WatchRow => ({ issue, pr, stage });

// ---- 見張りの定数 ----

test('FLEET_WATCH_DEFAULTS：3 分おき・20 分で App が動いていない', () => {
  assert.deepEqual(FLEET_WATCH_DEFAULTS, { intervalMinutes: 3, appStallMinutes: 20 });
});

// ---- App 待ちの段階 ----

test('APP_WAIT_STAGES は plan-gate と auto-merge だけ（human-merge・plan-review は人の番）', () => {
  assert.deepEqual([...APP_WAIT_STAGES].sort(), ['auto-merge', 'plan-gate']);
});

// ---- updateWatch ----

test('updateWatch：記録が無い（最初の読み直し）ときは App 待ちの行を今の時刻で記録し、知らせない', () => {
  const { record, stalls } = updateWatch(null, [watchRow(1, 'plan-gate'), watchRow(2, 'auto-merge', 20), watchRow(3, 'implement')], T0, WATCH_CFG, SESSION);
  assert.deepEqual(stalls, []);
  assert.equal(record.version, 1);
  assert.equal(record.session, SESSION);
  assert.deepEqual(Object.keys(record.entries).sort(), ['1:-:plan-gate', '2:20:auto-merge']);
  assert.equal(record.entries['1:-:plan-gate']!.since, T0.toISOString());
  assert.equal(record.entries['1:-:plan-gate']!.notified, false);
});

test('updateWatch：human-merge・plan-review・待つ以外の段階は数えない（何分たっても知らせない）', () => {
  const rows = [watchRow(1, 'human-merge', 10), watchRow(2, 'plan-review'), watchRow(3, 'judge', 30), watchRow(4, 'merged', 40)];
  let r = updateWatch(null, rows, T0, WATCH_CFG, SESSION);
  assert.deepEqual(r.record.entries, {});
  r = updateWatch(r.record, rows, at(600), WATCH_CFG, SESSION);
  assert.deepEqual(r.stalls, []);
});

test('updateWatch：appStallMinutes 未満は知らせず、ちょうど以上で plan-gate・auto-merge の行を知らせる（文に #番号・段階・分・App が動いていない）', () => {
  const rows = [watchRow(1, 'plan-gate'), watchRow(2, 'auto-merge', 20)];
  const first = updateWatch(null, rows, T0, WATCH_CFG, SESSION);
  const early = updateWatch(first.record, rows, at(19), WATCH_CFG, SESSION);
  assert.deepEqual(early.stalls, []);
  assert.equal(early.record.entries['1:-:plan-gate']!.since, T0.toISOString(), 'since を引き継ぐ');
  const late = updateWatch(early.record, rows, at(20), WATCH_CFG, SESSION);
  assert.deepEqual(late.stalls.map((s) => s.issue).sort(), [1, 2]);
  const s1 = late.stalls.find((s) => s.issue === 1)!;
  assert.equal(s1.stage, 'plan-gate');
  assert.equal(s1.pr, null);
  assert.equal(s1.minutes, 20);
  // 文の形：#<番号>（PR があれば PR の番号を間に入れてよい） は <段階> のまま <分> 分、App が動いていない
  assert.match(s1.text, /#1(?!\d)[^\n]* は plan-gate のまま 20 分、App が動いていない/, s1.text);
  const s2 = late.stalls.find((s) => s.issue === 2)!;
  assert.equal(s2.pr, 20);
  assert.match(s2.text, /#2(?!\d)[^\n]* は auto-merge のまま 20 分、App が動いていない/, s2.text);
});

test('updateWatch：同じ行の知らせは1回だけ（notified を残し、2回目以降は出さない）', () => {
  const rows = [watchRow(1, 'plan-gate')];
  const first = updateWatch(null, rows, T0, WATCH_CFG, SESSION);
  const notified = updateWatch(first.record, rows, at(25), WATCH_CFG, SESSION);
  assert.equal(notified.stalls.length, 1);
  assert.equal(notified.record.entries['1:-:plan-gate']!.notified, true);
  const again = updateWatch(notified.record, rows, at(60), WATCH_CFG, SESSION);
  assert.deepEqual(again.stalls, []);
  assert.equal(again.record.entries['1:-:plan-gate']!.notified, true);
});

test('updateWatch：App 待ちでなくなった行は記録から消え、また App 待ちになったら数え直す', () => {
  const first = updateWatch(null, [watchRow(1, 'plan-gate')], T0, WATCH_CFG, SESSION);
  const gone = updateWatch(first.record, [watchRow(1, 'implement')], at(10), WATCH_CFG, SESSION);
  assert.deepEqual(gone.record.entries, {});
  const back = updateWatch(gone.record, [watchRow(1, 'plan-gate')], at(15), WATCH_CFG, SESSION);
  assert.equal(back.record.entries['1:-:plan-gate']!.since, at(15).toISOString());
  assert.deepEqual(updateWatch(back.record, [watchRow(1, 'plan-gate')], at(30), WATCH_CFG, SESSION).stalls, [], '数え直してから 15 分');
});

test('updateWatch：段階や PR が変わった行は別の鍵として数え直し、古い鍵は消える', () => {
  const first = updateWatch(null, [watchRow(1, 'plan-gate')], T0, WATCH_CFG, SESSION);
  const stageChanged = updateWatch(first.record, [watchRow(1, 'auto-merge', 10)], at(19), WATCH_CFG, SESSION);
  assert.deepEqual(Object.keys(stageChanged.record.entries), ['1:10:auto-merge']);
  assert.equal(stageChanged.record.entries['1:10:auto-merge']!.since, at(19).toISOString());
  assert.deepEqual(updateWatch(stageChanged.record, [watchRow(1, 'auto-merge', 10)], at(25), WATCH_CFG, SESSION).stalls, []);
  const prChanged = updateWatch(stageChanged.record, [watchRow(1, 'auto-merge', 11)], at(40), WATCH_CFG, SESSION);
  assert.deepEqual(Object.keys(prChanged.record.entries), ['1:11:auto-merge']);
  assert.deepEqual(prChanged.stalls, []);
});

test('updateWatch：前の記録を書き換えない（純粋関数）', () => {
  const first = updateWatch(null, [watchRow(1, 'plan-gate')], T0, WATCH_CFG, SESSION);
  const snapshot = JSON.stringify(first.record);
  updateWatch(first.record, [watchRow(1, 'plan-gate')], at(30), WATCH_CFG, SESSION);
  assert.equal(JSON.stringify(first.record), snapshot);
});

// ---- 見張りの記録 ----

test('watchRecordPath：<共通ディレクトリ>/agent-harness/watch/<ID>.json、ID が無い・形が違えば null', () => {
  assert.equal(watchRecordPath('/repo/.git', SESSION), join('/repo/.git', 'agent-harness', 'watch', `${SESSION}.json`));
  assert.equal(watchRecordPath('/repo/.git', null), null);
  assert.equal(watchRecordPath('/repo/.git', ''), null);
  assert.equal(watchRecordPath('/repo/.git', '../escape'), null);
});

test('writeWatchRecord → readWatchRecord で同じ中身。無い・壊れた記録は null で、updateWatch は空から始める', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-stall-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = watchRecordPath(join(dir, 'common'), SESSION)!;
  assert.equal(readWatchRecord(path), null);
  const rec: WatchRecord = updateWatch(null, [watchRow(1, 'plan-gate')], T0, WATCH_CFG, SESSION).record;
  writeWatchRecord(path, rec);
  assert.deepEqual(readWatchRecord(path), rec);
  writeFileSync(path, '{not json');
  assert.equal(readWatchRecord(path), null);
  writeFileSync(path, JSON.stringify({ version: 2, session: SESSION, entries: {} }));
  assert.equal(readWatchRecord(path), null, '書式が違う');
  const fromBroken = updateWatch(readWatchRecord(path), [watchRow(1, 'plan-gate')], at(60), WATCH_CFG, SESSION);
  assert.deepEqual(fromBroken.stalls, [], '壊れた記録は空から始め、最初は知らせない');
});

// ---- Merge 後の見届け ----

test('pendingFollowUps：merged の行のうち、Issue が開いている・worktree が残るものを返す（昇順）', () => {
  const rows = [watchRow(5, 'merged'), watchRow(3, 'merged'), watchRow(4, 'merged')];
  const facts = { openIssues: [5], worktreeBranches: ['claude/issue-3-x', 'main'] };
  assert.deepEqual(pendingFollowUps(rows, facts), [3, 5]);
});

test('pendingFollowUps：見届け済み（Issue が Close 済みで worktree も無い）の merged 行は返さない', () => {
  assert.deepEqual(pendingFollowUps([watchRow(4, 'merged')], { openIssues: [], worktreeBranches: ['claude/issue-40-x', 'claude/issue-44-y'] }), [], '#40・#44 のブランチは #4 ではない');
});

test('pendingFollowUps：merged でない行は Issue が開いていても worktree が残っても返さない', () => {
  const rows = [watchRow(1, 'human-merge', 10), watchRow(2, 'auto-merge', 20), watchRow(3, 'implement')];
  assert.deepEqual(pendingFollowUps(rows, { openIssues: [1, 2, 3], worktreeBranches: ['claude/issue-1-a', 'claude/issue-2-b', 'claude/issue-3-c'] }), []);
});

test('pendingFollowUps：見張りの記録を使わない（記録の有無・updateWatch の後でも同じ結果）', () => {
  const rows = [watchRow(7, 'merged')];
  const facts = { openIssues: [7], worktreeBranches: [] };
  const before = pendingFollowUps(rows, facts);
  updateWatch(null, rows, T0, WATCH_CFG, SESSION);
  assert.deepEqual(pendingFollowUps(rows, facts), before);
  assert.deepEqual(before, [7]);
});

// ---- fleet-status.ts の --watch ----
const FLEET_STATUS = 'harness/scripts/agent/commands/fleet-status.ts';

test('fleet-status.ts：--watch を splitArgs の前に取り除き、使い方に [--watch] があり、--watch のときだけ updateWatch を呼ぶ', () => {
  assert.ok(agentSourceFiles().includes(FLEET_STATUS));
  const src = readText(FLEET_STATUS);
  assert.ok(src.includes('[--watch]'), '使い方に [--watch] がありません');
  assert.ok(src.includes("'--watch'"), '--watch を読んでいません');
  const calls = [...src.matchAll(/updateWatch\(/g)].map((m) => m.index!);
  assert.ok(calls.length > 0, 'updateWatch を呼んでいません');
  /** --watch の分岐（watch・watchCfg などの変数の if・三項・&&）の直後か */
  const guarded = (before: string): boolean => /if \(\s*watch\w*\b[^)]*\)\s*\{[^}]*$|\bwatch\w*\s*(\?|&&)\s*[^\n]*$/.test(before);
  for (const i of calls) {
    if (guarded(src.slice(Math.max(0, i - 600), i))) continue;
    // 補助の関数の中で呼ぶなら、その関数を呼ぶ所がすべて --watch の分岐の中にあること
    const fn = [...src.slice(0, i).matchAll(/function (\w+)\(/g)].at(-1)?.[1];
    assert.ok(fn, 'updateWatch が --watch の分岐の中にありません');
    const sites = [...src.matchAll(new RegExp(`(?<!function )\\b${fn}\\(`, 'g'))].map((m) => m.index!);
    assert.ok(sites.length > 0, `${fn} を呼ぶ所がありません`);
    for (const s of sites) {
      const lineStart = src.lastIndexOf('\n', s) + 1;
      assert.ok(guarded(src.slice(Math.max(0, s - 600), s)) || guarded(src.slice(lineStart, s)), `${fn}（updateWatch を呼ぶ）が --watch の分岐の外で呼ばれています`);
    }
  }
  for (const w of ['pendingFollowUps(', 'FLEET_WATCH_DEFAULTS', '--porcelain', 'watchRecordPath(']) assert.ok(src.includes(w), `fleet-status.ts に ${w} がありません`);
});
