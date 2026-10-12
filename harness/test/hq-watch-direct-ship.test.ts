// Issue #756：hq が fleet を挟まずに直接起こした ship の heartbeat のテーマを、控えの ships から引く（harness/scripts/hq-watch.ts の
// themeForHeartbeat）。watch() を通した待ち方は hq-watch.test.ts が確かめるので、ここでは themeForHeartbeat だけを表で回す。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { themeForHeartbeat, type CheckMessage, type WorkerRow } from '../scripts/hq-watch.ts';
import type { HqLedger } from '../scripts/hq-state.ts';

const ledger = (extra: Record<string, unknown> = {}, fleets: Record<string, unknown>[] = [{ dispatch: 'd-1', theme: 'テーマA' }]): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null, ...extra,
});
const SHIPS = [{ theme: '#12 直接の ship', epic: 10, issue: 12, dispatch: 'd-s', session: null }];
const WORKERS: WorkerRow[] = [{ dispatchId: 'd-1', agentTerminalHandle: 'term-a' }, { dispatchId: 'd-s', agentTerminalHandle: 'term-s' }];

const msg = (from_handle: string): CheckMessage => ({ id: 'm1', type: 'heartbeat', from_handle, body: '#12 実装中' });

test('themeForHeartbeat：控えの ships の Dispatch からテーマを引き、ships が無い・形が違えば null、fleets にあれば fleets のテーマ', () => {
  const cases: { name: string; from: string; ledger: HqLedger; want: string | null }[] = [
    { name: 'ships の Dispatch（dispatch:<ID>）', from: 'dispatch:d-s', ledger: ledger({ ships: SHIPS }), want: '#12 直接の ship' },
    { name: 'ships の Dispatch（端末の handle）', from: 'term-s', ledger: ledger({ ships: SHIPS }), want: '#12 直接の ship' },
    { name: 'ships が無い控え', from: 'dispatch:d-s', ledger: ledger(), want: null },
    { name: 'ships が配列でない控え', from: 'dispatch:d-s', ledger: ledger({ ships: { dispatch: 'd-s', theme: '#12 直接の ship' } }), want: null },
    {
      name: 'fleets と ships の両方にあれば fleets のテーマ',
      from: 'dispatch:d-1',
      ledger: ledger({ ships: [{ dispatch: 'd-1', theme: '#99 ship のテーマ' }] }),
      want: 'テーマA',
    },
  ];
  for (const c of cases) assert.equal(themeForHeartbeat(msg(c.from), c.ledger, WORKERS), c.want, c.name);
});
