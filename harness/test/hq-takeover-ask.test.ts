// Issue #771：止まった宣言・担当のいない PR の引き継ぎを hq が1日1回まとめて聞く判定（harness/scripts/hq-takeover-ask.ts）を確かめる。Orca・GitHub は起動しない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { hqStateDir } from '../scripts/hq-state.ts';
import {
  HQ_TAKEOVER_DEFAULTS, hqTakeoverConfig, recordTakeoverAnswer, takeoverAskDecision, takeoverPath,
  type TakeoverItem, type TakeoverRecord,
} from '../scripts/hq-takeover-ask.ts';

const root = join(import.meta.dirname, '..', '..');
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const HOUR = 3600000;
const hoursAgo = (h: number): string => new Date(NOW - h * HOUR).toISOString();
const H = 24;

const item = (key: string, state = 'stale'): TakeoverItem => ({ key, state, line: `${key} ${state}` });
const rec = (lastAskedAt: string | null, declined: { key: string; state: string }[] = []): TakeoverRecord => ({ version: 1, lastAskedAt, declined });

// ---- hqTakeoverConfig ----

test('hqTakeoverConfig：書いていなければ既定値 24、書いた正の整数はそのまま', () => {
  assert.deepEqual(HQ_TAKEOVER_DEFAULTS, { takeoverAskHours: 24 });
  assert.deepEqual(hqTakeoverConfig({}), { takeoverAskHours: 24 });
  assert.deepEqual(hqTakeoverConfig({ hq: {} }), { takeoverAskHours: 24 });
  assert.deepEqual(hqTakeoverConfig({ hq: { takeoverAskHours: 6 } }), { takeoverAskHours: 6 });
});

test('hqTakeoverConfig：0・負・小数・文字列は throw', () => {
  for (const v of [0, -1, 1.5, '24']) {
    assert.throws(() => hqTakeoverConfig({ hq: { takeoverAskHours: v } }), String(v));
  }
});

// ---- takeoverAskDecision ----

test('takeoverAskDecision：記録が無ければ見つけたものを聞く（due 真・nextAskAt null）', () => {
  const found = [item('#1'), item('PR#2', 'no-owner')];
  for (const record of [null, rec(null)]) {
    const d = takeoverAskDecision({ found, record, now: NOW, hours: H });
    assert.equal(d.due, true);
    assert.deepEqual(d.ask.map((x) => x.key), ['#1', 'PR#2']);
    assert.equal(d.held, 2);
    assert.equal(d.skippedDeclined, 0);
    assert.equal(d.nextAskAt, null);
  }
});

test('takeoverAskDecision：hours 未満は due 偽で held に件数、ちょうど hours で due 真', () => {
  const found = [item('#1'), item('#3')];
  const early = takeoverAskDecision({ found, record: rec(hoursAgo(H - 1)), now: NOW, hours: H });
  assert.equal(early.due, false);
  assert.equal(early.held, 2);
  assert.equal(early.nextAskAt, new Date(NOW + HOUR).toISOString());
  const just = takeoverAskDecision({ found, record: rec(hoursAgo(H)), now: NOW, hours: H });
  assert.equal(just.due, true);
  assert.equal(just.nextAskAt, new Date(NOW).toISOString());
});

test('takeoverAskDecision：見つけたものが無ければ間隔を過ぎても due 偽', () => {
  for (const record of [null, rec(hoursAgo(H * 3))]) {
    const d = takeoverAskDecision({ found: [], record, now: NOW, hours: H });
    assert.deepEqual([d.due, d.held, d.ask.length], [false, 0, 0]);
  }
});

test('takeoverAskDecision：見送った key は state が同じなら外れて skippedDeclined、変われば ask に戻る', () => {
  const record = rec(hoursAgo(H), [{ key: '#1', state: 'stale' }, { key: '#2', state: 'stale' }]);
  const d = takeoverAskDecision({ found: [item('#1', 'stale'), item('#2', 'expired'), item('#3')], record, now: NOW, hours: H });
  assert.deepEqual(d.ask.map((x) => [x.key, x.state]), [['#2', 'expired'], ['#3', 'stale']]);
  assert.equal(d.skippedDeclined, 1);
  assert.equal(d.held, 2);
  assert.equal(d.due, true);
  // 見送ったものだけなら聞かない
  const only = takeoverAskDecision({ found: [item('#1', 'stale')], record, now: NOW, hours: H });
  assert.deepEqual([only.due, only.held, only.skippedDeclined], [false, 0, 1]);
});

test('takeoverAskDecision：読めない lastAskedAt は記録なし扱い、同じ key は先のものだけ使う', () => {
  const d = takeoverAskDecision({ found: [item('#1', 'a'), item('#1', 'b')], record: rec('not-a-date'), now: NOW, hours: H });
  assert.equal(d.due, true);
  assert.equal(d.nextAskAt, null);
  assert.deepEqual(d.ask.map((x) => [x.key, x.state]), [['#1', 'a']]);
  assert.equal(d.held, 1);
});

// ---- recordTakeoverAnswer ----

test('recordTakeoverAnswer：lastAskedAt を now にし、見送りを足す・置き換える、引き継いだものを外す', () => {
  const first = recordTakeoverAnswer(null, { now: NOW, declined: [{ key: '#1', state: 'stale' }], taken: [] });
  assert.deepEqual(first, rec(new Date(NOW).toISOString(), [{ key: '#1', state: 'stale' }]));

  const later = NOW + H * HOUR;
  const second = recordTakeoverAnswer(rec(hoursAgo(H), [{ key: '#1', state: 'stale' }, { key: '#2', state: 'stale' }]), {
    now: later, declined: [{ key: '#1', state: 'expired' }, { key: '#3', state: 'no-owner' }], taken: ['#2'],
  });
  assert.equal(second.version, 1);
  assert.equal(second.lastAskedAt, new Date(later).toISOString());
  const byKey = Object.fromEntries(second.declined.map((x) => [x.key, x.state]));
  assert.deepEqual(byKey, { '#1': 'expired', '#3': 'no-owner' });
  assert.equal(second.declined.length, 2);
});

// ---- takeoverPath・CLI ----

test('takeoverPath：hqStateDir の下の hq-takeover-ask.json', () => {
  assert.equal(takeoverPath('/x/.git'), join(hqStateDir('/x/.git'), 'hq-takeover-ask.json'));
});

const cli = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['harness/scripts/hq-takeover-ask.ts', ...args, '--common-dir', dir], { cwd: root, encoding: 'utf8' });

test('CLI：check は記録を書かずに判定を出し、record の後の check は見送りを外して間隔待ちになる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-takeover-'));
  try {
    const found = join(dir, 'found.json');
    writeFileSync(found, JSON.stringify([item('#1'), item('#2')]));
    const c1 = cli(dir, 'check', found);
    assert.equal(c1.status, 0, c1.stderr);
    const d1 = JSON.parse(c1.stdout) as { due: boolean; held: number; nextAskAt: string | null };
    assert.deepEqual([d1.due, d1.held, d1.nextAskAt], [true, 2, null]);
    assert.equal(existsSync(takeoverPath(dir)), false);

    const answer = join(dir, 'answer.json');
    writeFileSync(answer, JSON.stringify({ declined: [{ key: '#1', state: 'stale' }], taken: ['#2'] }));
    const r = cli(dir, 'record', answer);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(takeoverPath(dir)), true);

    const c2 = cli(dir, 'check', found);
    assert.equal(c2.status, 0, c2.stderr);
    const d2 = JSON.parse(c2.stdout) as { due: boolean; held: number; skippedDeclined: number; nextAskAt: string | null };
    assert.deepEqual([d2.due, d2.held, d2.skippedDeclined], [false, 1, 1]);
    assert.equal(typeof d2.nextAskAt, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：記録ファイルが壊れている・version が違うときは記録なし扱い', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-takeover-'));
  try {
    const found = join(dir, 'found.json');
    writeFileSync(found, JSON.stringify([item('#1')]));
    const path = takeoverPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    for (const body of ['{not json', JSON.stringify({ version: 2, lastAskedAt: new Date().toISOString(), declined: [{ key: '#1', state: 'stale' }] })]) {
      writeFileSync(path, body);
      const c = cli(dir, 'check', found);
      assert.equal(c.status, 0, c.stderr);
      const d = JSON.parse(c.stdout) as { due: boolean; held: number; skippedDeclined: number };
      assert.deepEqual([d.due, d.held, d.skippedDeclined], [true, 1, 0], body);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：found が配列でない・要素の key/state/line が文字列でないときは終了コード 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-takeover-'));
  try {
    const found = join(dir, 'found.json');
    for (const bad of [{ key: '#1', state: 's', line: 'l' }, [{ key: 1, state: 's', line: 'l' }], [{ key: '#1', state: null, line: 'l' }], [{ key: '#1', state: 's' }]]) {
      writeFileSync(found, JSON.stringify(bad));
      assert.equal(cli(dir, 'check', found).status, 1, JSON.stringify(bad));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
