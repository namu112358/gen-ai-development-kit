// Issue #199：fleet の待つ間の読み直し（harness/lib/fleet-watch.ts）。設定（fleet.watch の既定値と誤り）、App 待ちの行の見張り（updateWatch：
// 最初に見た行は知らせない・appStallMinutes を過ぎた plan-gate・auto-merge の行だけを1回だけ知らせる・段階や PR が変われば数え直す・人の番は数えない）、
// Merge 後の見届けが済んでいない行（pendingFollowUps：記録に頼らず事実だけで決める）、見張りの記録のパスと読み書き。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  APP_WAIT_STAGES,
  FLEET_WATCH_DEFAULTS,
  fleetWatchConfig,
  pendingFollowUps,
  readWatchRecord,
  updateWatch,
  type WatchRecord,
  watchRecordPath,
  type WatchRow,
  writeWatchRecord,
} from '../lib/fleet-watch.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const T0 = new Date('2026-09-30T00:00:00Z');
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
const CFG = { appStallMinutes: 20 };

const row = (issue: number, stage: string, pr: number | null = null): WatchRow => ({ issue, pr, stage });

// ---- 設定 ----

test('fleetWatchConfig：fleet・watch が無ければ既定値（3 分おき・20 分で App が動いていない）', () => {
  assert.deepEqual(FLEET_WATCH_DEFAULTS, { intervalMinutes: 3, appStallMinutes: 20 });
  assert.deepEqual(fleetWatchConfig({}), FLEET_WATCH_DEFAULTS);
  assert.deepEqual(fleetWatchConfig({ fleet: {} }), FLEET_WATCH_DEFAULTS);
  assert.deepEqual(fleetWatchConfig({ fleet: { nesting: 'orca' } }), FLEET_WATCH_DEFAULTS);
});

test('fleetWatchConfig：片方だけ書けば、もう片方は既定値', () => {
  assert.deepEqual(fleetWatchConfig({ fleet: { watch: { intervalMinutes: 5 } } }), { intervalMinutes: 5, appStallMinutes: 20 });
  assert.deepEqual(fleetWatchConfig({ fleet: { watch: { appStallMinutes: 45 } } }), { intervalMinutes: 3, appStallMinutes: 45 });
});

test('fleetWatchConfig：正の整数でない値・watch がオブジェクトでないときは throw', () => {
  for (const v of [0, -1, 1.5, '3', null, Number.NaN]) {
    assert.throws(() => fleetWatchConfig({ fleet: { watch: { intervalMinutes: v } } }), Error, `intervalMinutes=${String(v)}`);
    assert.throws(() => fleetWatchConfig({ fleet: { watch: { appStallMinutes: v } } }), Error, `appStallMinutes=${String(v)}`);
  }
  for (const w of [3, 'x', [], null]) assert.throws(() => fleetWatchConfig({ fleet: { watch: w } }), Error, `watch=${JSON.stringify(w)}`);
});

// ---- App 待ちの段階 ----

test('APP_WAIT_STAGES は plan-gate と auto-merge だけ（human-merge・plan-review は人の番）', () => {
  assert.deepEqual([...APP_WAIT_STAGES].sort(), ['auto-merge', 'plan-gate']);
});

// ---- updateWatch ----

test('updateWatch：記録が無い（最初の読み直し）ときは App 待ちの行を今の時刻で記録し、知らせない', () => {
  const { record, stalls } = updateWatch(null, [row(1, 'plan-gate'), row(2, 'auto-merge', 20), row(3, 'implement')], T0, CFG, SESSION);
  assert.deepEqual(stalls, []);
  assert.equal(record.version, 1);
  assert.equal(record.session, SESSION);
  assert.deepEqual(Object.keys(record.entries).sort(), ['1:-:plan-gate', '2:20:auto-merge']);
  assert.equal(record.entries['1:-:plan-gate']!.since, T0.toISOString());
  assert.equal(record.entries['1:-:plan-gate']!.notified, false);
});

test('updateWatch：human-merge・plan-review・待つ以外の段階は数えない（何分たっても知らせない）', () => {
  const rows = [row(1, 'human-merge', 10), row(2, 'plan-review'), row(3, 'judge', 30), row(4, 'merged', 40)];
  let r = updateWatch(null, rows, T0, CFG, SESSION);
  assert.deepEqual(r.record.entries, {});
  r = updateWatch(r.record, rows, at(600), CFG, SESSION);
  assert.deepEqual(r.stalls, []);
});

test('updateWatch：appStallMinutes 未満は知らせず、ちょうど以上で plan-gate・auto-merge の行を知らせる（文に #番号・段階・分・App が動いていない）', () => {
  const rows = [row(1, 'plan-gate'), row(2, 'auto-merge', 20)];
  const first = updateWatch(null, rows, T0, CFG, SESSION);
  const early = updateWatch(first.record, rows, at(19), CFG, SESSION);
  assert.deepEqual(early.stalls, []);
  assert.equal(early.record.entries['1:-:plan-gate']!.since, T0.toISOString(), 'since を引き継ぐ');
  const late = updateWatch(early.record, rows, at(20), CFG, SESSION);
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
  const rows = [row(1, 'plan-gate')];
  const first = updateWatch(null, rows, T0, CFG, SESSION);
  const notified = updateWatch(first.record, rows, at(25), CFG, SESSION);
  assert.equal(notified.stalls.length, 1);
  assert.equal(notified.record.entries['1:-:plan-gate']!.notified, true);
  const again = updateWatch(notified.record, rows, at(60), CFG, SESSION);
  assert.deepEqual(again.stalls, []);
  assert.equal(again.record.entries['1:-:plan-gate']!.notified, true);
});

test('updateWatch：App 待ちでなくなった行は記録から消え、また App 待ちになったら数え直す', () => {
  const first = updateWatch(null, [row(1, 'plan-gate')], T0, CFG, SESSION);
  const gone = updateWatch(first.record, [row(1, 'implement')], at(10), CFG, SESSION);
  assert.deepEqual(gone.record.entries, {});
  const back = updateWatch(gone.record, [row(1, 'plan-gate')], at(15), CFG, SESSION);
  assert.equal(back.record.entries['1:-:plan-gate']!.since, at(15).toISOString());
  assert.deepEqual(updateWatch(back.record, [row(1, 'plan-gate')], at(30), CFG, SESSION).stalls, [], '数え直してから 15 分');
});

test('updateWatch：段階や PR が変わった行は別の鍵として数え直し、古い鍵は消える', () => {
  const first = updateWatch(null, [row(1, 'plan-gate')], T0, CFG, SESSION);
  const stageChanged = updateWatch(first.record, [row(1, 'auto-merge', 10)], at(19), CFG, SESSION);
  assert.deepEqual(Object.keys(stageChanged.record.entries), ['1:10:auto-merge']);
  assert.equal(stageChanged.record.entries['1:10:auto-merge']!.since, at(19).toISOString());
  assert.deepEqual(updateWatch(stageChanged.record, [row(1, 'auto-merge', 10)], at(25), CFG, SESSION).stalls, []);
  const prChanged = updateWatch(stageChanged.record, [row(1, 'auto-merge', 11)], at(40), CFG, SESSION);
  assert.deepEqual(Object.keys(prChanged.record.entries), ['1:11:auto-merge']);
  assert.deepEqual(prChanged.stalls, []);
});

test('updateWatch：前の記録を書き換えない（純粋関数）', () => {
  const first = updateWatch(null, [row(1, 'plan-gate')], T0, CFG, SESSION);
  const snapshot = JSON.stringify(first.record);
  updateWatch(first.record, [row(1, 'plan-gate')], at(30), CFG, SESSION);
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
  const dir = mkdtempSync(join(tmpdir(), 'fleet-watch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = watchRecordPath(join(dir, 'common'), SESSION)!;
  assert.equal(readWatchRecord(path), null);
  const rec: WatchRecord = updateWatch(null, [row(1, 'plan-gate')], T0, CFG, SESSION).record;
  writeWatchRecord(path, rec);
  assert.deepEqual(readWatchRecord(path), rec);
  writeFileSync(path, '{not json');
  assert.equal(readWatchRecord(path), null);
  writeFileSync(path, JSON.stringify({ version: 2, session: SESSION, entries: {} }));
  assert.equal(readWatchRecord(path), null, '書式が違う');
  const fromBroken = updateWatch(readWatchRecord(path), [row(1, 'plan-gate')], at(60), CFG, SESSION);
  assert.deepEqual(fromBroken.stalls, [], '壊れた記録は空から始め、最初は知らせない');
});

// ---- Merge 後の見届け ----

test('pendingFollowUps：merged の行のうち、Issue が開いている・worktree が残るものを返す（昇順）', () => {
  const rows = [row(5, 'merged'), row(3, 'merged'), row(4, 'merged')];
  const facts = { openIssues: [5], worktreeBranches: ['claude/issue-3-x', 'main'] };
  assert.deepEqual(pendingFollowUps(rows, facts), [3, 5]);
});

test('pendingFollowUps：見届け済み（Issue が Close 済みで worktree も無い）の merged 行は返さない', () => {
  assert.deepEqual(pendingFollowUps([row(4, 'merged')], { openIssues: [], worktreeBranches: ['claude/issue-40-x', 'claude/issue-44-y'] }), [], '#40・#44 のブランチは #4 ではない');
});

test('pendingFollowUps：merged でない行は Issue が開いていても worktree が残っても返さない', () => {
  const rows = [row(1, 'human-merge', 10), row(2, 'auto-merge', 20), row(3, 'implement')];
  assert.deepEqual(pendingFollowUps(rows, { openIssues: [1, 2, 3], worktreeBranches: ['claude/issue-1-a', 'claude/issue-2-b', 'claude/issue-3-c'] }), []);
});

test('pendingFollowUps：見張りの記録を使わない（記録の有無・updateWatch の後でも同じ結果）', () => {
  const rows = [row(7, 'merged')];
  const facts = { openIssues: [7], worktreeBranches: [] };
  const before = pendingFollowUps(rows, facts);
  updateWatch(null, rows, T0, CFG, SESSION);
  assert.deepEqual(pendingFollowUps(rows, facts), before);
  assert.deepEqual(before, [7]);
});
