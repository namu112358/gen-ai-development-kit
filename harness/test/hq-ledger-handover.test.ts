// Issue #618：hq が交代しても、印 "handover": true の fleet（「交代する」と返して、まだ起こし直していないもの）が
// 新しい hq の控え（hq-fleets.json）から落ちないことを確かめる（carryHandoverFleets と CLI の ledger-save → ledger、--release-handover）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { carryHandoverFleets, type HqLedger } from '../scripts/hq-state.ts';

const root = join(import.meta.dirname, '..', '..');

const ledger = (fleets: Record<string, unknown>[], patch: Partial<HqLedger> = {}): HqLedger => ({
  version: 1, runId: 'run-1', hqHandle: 'term-hq', hqSession: 'sess-hq', paneHandles: [], fleets, updatedAt: null, ...patch,
});

const handed = { theme: 'jev-triage', dispatch: 'd-561', session: 'ee994008', handover: true };

// ---- carryHandoverFleets ----

const cases: { name: string; prev: HqLedger | null; next: HqLedger; release?: string[]; fleets: Record<string, unknown>[]; carried: string[] }[] = [
  {
    name: '(a) 印 handover の fleet が新しい控えに無い → 末尾に印ごと残る',
    prev: ledger([handed, { theme: 'other', dispatch: 'd-1' }]),
    next: ledger([{ theme: 'new', dispatch: 'd-2' }], { hqSession: 'sess-hq-2' }),
    fleets: [{ theme: 'new', dispatch: 'd-2' }, handed],
    carried: ['jev-triage'],
  },
  {
    name: '(b) 新しい控えに同じテーマ（印なし）がある → 足さず新しい方を使う',
    prev: ledger([handed]),
    next: ledger([{ theme: 'jev-triage', dispatch: 'd-new' }]),
    fleets: [{ theme: 'jev-triage', dispatch: 'd-new' }],
    carried: [],
  },
  {
    name: '(c) 印の無い fleet・handover が true 以外（文字列 "true"）の fleet は残さない',
    prev: ledger([{ theme: 'plain', dispatch: 'd-1' }, { theme: 'str', dispatch: 'd-3', handover: 'true' }]),
    next: ledger([]),
    fleets: [],
    carried: [],
  },
  {
    name: '(d) release に入ったテーマは残さない（前の控えに無いテーマが入っていても誤りにしない）',
    prev: ledger([handed]),
    next: ledger([]),
    release: ['jev-triage', 'absent'],
    fleets: [],
    carried: [],
  },
  {
    name: '(e) 前の控えが null → 新しい控えのまま',
    prev: null,
    next: ledger([{ theme: 'new', dispatch: 'd-2' }]),
    fleets: [{ theme: 'new', dispatch: 'd-2' }],
    carried: [],
  },
  {
    name: '(f) theme が無い要素は dispatch で比べる（同じ dispatch があれば足さない、無ければ残る、release も dispatch で外せる）',
    prev: ledger([
      { dispatch: 'd-a', handover: true },
      { dispatch: 'd-b', handover: true },
      { dispatch: 'd-c', handover: true },
      { session: 'no-key', handover: true },
    ]),
    next: ledger([{ dispatch: 'd-a' }]),
    release: ['d-c'],
    fleets: [{ dispatch: 'd-a' }, { dispatch: 'd-b', handover: true }],
    carried: ['d-b'],
  },
];

test('carryHandoverFleets：前の控えの印 handover の fleet を新しい控えに残す', () => {
  for (const c of cases) {
    const before = JSON.stringify(c.next);
    const r = carryHandoverFleets(c.prev, c.next, c.release ?? []);
    assert.deepEqual(r.ledger.fleets, c.fleets, c.name);
    assert.deepEqual(r.carried, c.carried, c.name);
    assert.equal(r.ledger.hqSession, c.next.hqSession, `${c.name}：fleets 以外は新しい控えのまま`);
    assert.equal(JSON.stringify(c.next), before, `${c.name}：引数を変えない`);
  }
});

// ---- CLI ----

const cli = (dir: string, args: string[]) =>
  spawnSync(process.execPath, ['harness/scripts/hq-state.ts', args[0]!, '--common-dir', dir, ...args.slice(1)], { cwd: root, encoding: 'utf8' });
const withDir = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), 'hq-ledger-handover-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const save = (dir: string, l: HqLedger, extra: string[] = []) => {
  const src = join(dir, 'in.json');
  writeFileSync(src, JSON.stringify(l));
  return cli(dir, ['ledger-save', src, ...extra]);
};

test('CLI ledger-save：hq が交代して印 handover の fleet の無い控えを書いても、ledger で読むと残り、標準エラーにテーマが出る（AC1）', () => withDir((dir) => {
  assert.equal(save(dir, ledger([handed])).status, 0);
  const r = save(dir, ledger([{ theme: 'new', dispatch: 'd-2' }], { hqSession: 'sess-hq-2' }));
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes('jev-triage'), r.stderr);
  const read = JSON.parse(cli(dir, ['ledger']).stdout);
  assert.equal(read.hqSession, 'sess-hq-2');
  assert.deepEqual(read.fleets, [{ theme: 'new', dispatch: 'd-2' }, handed]);
  assert.deepEqual(JSON.parse(r.stdout).fleets, read.fleets, '標準出力は保存した控え');
}));

test('CLI ledger-save --release-handover：指定したテーマの印 handover の fleet は残さない', () => withDir((dir) => {
  assert.equal(save(dir, ledger([handed])).status, 0);
  const r = save(dir, ledger([]), ['--release-handover', 'jev-triage']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(cli(dir, ['ledger']).stdout).fleets, []);
}));
