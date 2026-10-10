// Issue #559：hq がターンを終える前に置く見張り（harness/scripts/hq-watch.ts）の待ち方を確かめる。
// heartbeat だけの束は hq を起こさずに ack して待ち続け、question などが届くと終わって hq を起こす。Orca の実物は起動しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WATCH_TYPES, watch, type CheckMessage, type CheckResult, type WorkerRow } from '../scripts/hq-watch.ts';
import type { HqLedger } from '../scripts/hq-state.ts';

const ledger = (fleets: Record<string, unknown>[] = [{ dispatch: 'd-1', theme: 'テーマA' }, { dispatch: 'd-2', theme: 'テーマB' }]): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null,
});
const WORKERS: WorkerRow[] = [{ dispatchId: 'd-1', agentTerminalHandle: 'term-a' }, { dispatchId: 'd-2', agentTerminalHandle: 'term-b' }];

const msg = (id: string, type: string, patch: Partial<CheckMessage> = {}): CheckMessage => ({ id, type, from_handle: 'term-a', body: `${id} の本文`, ...patch });
const batch = (deliveryId: string | null, messages: CheckMessage[]): CheckResult => ({ ok: true, deliveryId, messages });
const EMPTY = batch(null, []);

/** check の返り値を順に返し、呼ばれた引数・saveNote・workers の呼び出しを控える偽物 */
function fake(results: CheckResult[], opts: { workers?: WorkerRow[] | null; ledger?: HqLedger | null; now?: () => number } = {}) {
  const calls: string[][] = [];
  const notes: [string, string][] = [];
  const workerRuns: string[] = [];
  const deps = {
    check(args: string[]): CheckResult {
      calls.push(args);
      const r = results.shift();
      assert.ok(r, `check が想定より多く呼ばれた：${args.join(' ')}`);
      return r;
    },
    workers(runId: string): WorkerRow[] | null {
      workerRuns.push(runId);
      return opts.workers === undefined ? WORKERS : opts.workers;
    },
    saveNote(theme: string, note: string): void { notes.push([theme, note]); },
    ledger: (): HqLedger | null => (opts.ledger === undefined ? ledger() : opts.ledger),
    now: opts.now ?? (() => 0),
  };
  return { deps, calls, notes, workerRuns };
}

const OPTS = { ack: null, timeoutMs: 60_000, terminal: null };

/** 引数の中の `--flag value` の値。無ければ null */
const flag = (args: string[] | undefined, name: string): string | null => {
  assert.ok(args, 'check が呼ばれていない');
  const i = args.indexOf(name);
  return i < 0 ? null : (args[i + 1] ?? null);
};

test('check の引数：orchestration check --wait と種類・残り時間・--json。ack・terminal は渡したときだけ付く', () => {
  const { deps, calls } = fake([EMPTY, EMPTY]);
  watch(deps, OPTS);
  watch(deps, { ack: 'dl-0', timeoutMs: 60_000, terminal: 'term-hq' });
  const [first, second] = calls;
  assert.ok(first && second, 'check が2回呼ばれる');
  for (const a of [first, second]) {
    assert.ok(a.includes('orchestration') && a.includes('check') && a.includes('--wait') && a.includes('--json'), a.join(' '));
    assert.equal(flag(a, '--types'), WATCH_TYPES);
    assert.equal(flag(a, '--timeout-ms'), '60000');
  }
  assert.equal(flag(first, '--ack'), null);
  assert.equal(flag(first, '--terminal'), null);
  assert.equal(flag(second, '--ack'), 'dl-0', 'opts.ack は最初の check に付く');
  assert.equal(flag(second, '--terminal'), 'term-hq');
});

test('heartbeat だけの束は ack して待ち続け、question が届くと起こす（その束は ack しない）', () => {
  const question = msg('m3', 'question', { from_handle: 'term-b' });
  const { deps, calls, notes, workerRuns } = fake([
    batch('dl-1', [msg('m1', 'heartbeat'), msg('m2', 'heartbeat', { from_handle: 'term-b' })]),
    batch('dl-2', [question]),
  ]);
  const r = watch(deps, OPTS);
  assert.deepEqual(r, { wake: 'messages', deliveryId: 'dl-2', messages: [question] });
  assert.equal(calls.length, 2, 'question の束の後は check しない（dl-2 を ack しない）');
  assert.equal(flag(calls[0], '--ack'), null);
  assert.equal(flag(calls[1], '--ack'), 'dl-1');
  assert.deepEqual(notes, [['テーマA', 'm1 の本文'], ['テーマB', 'm2 の本文']]);
  assert.ok(workerRuns.every((id) => id === 'run-1'), 'workers は ledger の runId で引く');
});

test('heartbeat とほかの種類が混ざった束は、ack せず束のすべての行で起こす', () => {
  const rows = [msg('m1', 'heartbeat'), msg('m2', 'worker_done')];
  const { deps, calls } = fake([batch('dl-1', rows)]);
  assert.deepEqual(watch(deps, OPTS), { wake: 'messages', deliveryId: 'dl-1', messages: rows });
  assert.equal(calls.length, 1);
});

test('空の束は timeout、ok:false と deliveryId の無い束は error', () => {
  assert.deepEqual(watch(fake([EMPTY]).deps, OPTS), { wake: 'timeout' });
  const failed = watch(fake([{ ok: false, error: 'orca が無い' }]).deps, OPTS);
  assert.equal(failed.wake, 'error');
  const noId = watch(fake([batch(null, [msg('m1', 'question')])]).deps, OPTS);
  assert.equal(noId.wake, 'error');
});

test('締め切り：残り時間を --timeout-ms に渡し、残りが 0 以下なら check せず timeout', () => {
  let t = 1_000;
  const { deps, calls } = fake([batch('dl-1', [msg('m1', 'heartbeat')])], { now: () => t });
  const origCheck = deps.check;
  deps.check = (args) => { const r = origCheck(args); t += 60_000; return r; };
  assert.deepEqual(watch(deps, OPTS), { wake: 'timeout' });
  assert.equal(calls.length, 1, '締め切りを過ぎたら次の check をしない');
  assert.equal(flag(calls[0], '--timeout-ms'), '60000');
});

test('heartbeat の結びつけ：結びつけば控えて待ち続け、本文のある行が1つでも結びつかなければ ack せず起こす', () => {
  const cases: { name: string; hb: CheckMessage; workers?: WorkerRow[] | null; ledger?: HqLedger | null; note: [string, string] | null; wake: boolean }[] = [
    { name: 'agentTerminalHandle 経由', hb: msg('m1', 'heartbeat', { from_handle: 'term-b' }), note: ['テーマB', 'm1 の本文'], wake: false },
    { name: 'dispatch:<ID> は workers を通さない', hb: msg('m1', 'heartbeat', { from_handle: 'dispatch:d-1' }), workers: null, note: ['テーマA', 'm1 の本文'], wake: false },
    { name: '本文が空なら控えず ack だけ', hb: msg('m1', 'heartbeat', { from_handle: 'term-x', body: '' }), note: null, wake: false },
    { name: 'workers が null', hb: msg('m1', 'heartbeat'), workers: null, note: null, wake: true },
    { name: '一致する worker が無い', hb: msg('m1', 'heartbeat', { from_handle: 'term-x' }), note: null, wake: true },
    { name: 'ledger が null', hb: msg('m1', 'heartbeat'), ledger: null, note: null, wake: true },
    { name: '一致する fleet が無い', hb: msg('m1', 'heartbeat'), ledger: ledger([{ dispatch: 'd-9', theme: 'テーマZ' }]), note: null, wake: true },
  ];
  for (const c of cases) {
    const results = c.wake ? [batch('dl-1', [c.hb])] : [batch('dl-1', [c.hb]), EMPTY];
    const { deps, calls, notes } = fake(results, { workers: c.workers, ledger: c.ledger });
    const r = watch(deps, OPTS);
    if (c.wake) {
      assert.deepEqual(r, { wake: 'messages', deliveryId: 'dl-1', messages: [c.hb] }, c.name);
      assert.equal(calls.length, 1, c.name);
      assert.deepEqual(notes, [], c.name);
    } else {
      assert.deepEqual(r, { wake: 'timeout' }, c.name);
      assert.equal(flag(calls[1], '--ack'), 'dl-1', c.name);
      assert.deepEqual(notes, c.note ? [c.note] : [], c.name);
    }
  }
});
