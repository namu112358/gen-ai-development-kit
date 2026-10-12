// Issue #780：hq の手順8の判定（harness/scripts/hq-decide.ts の assignSlots）を、入力と期待の表で確かめる。
// 動いている ship の数（plan-gate を数えない・prClaim を優先・控えの集合の外を数えない）、空いた枠の割り当ての順 (a)→(b)→(c)→(d)、
// 空きが0になった後は wait、同じ回の start-fleet の後の同じ Epic の子・単発の Issue はその新しい fleet への add になること。
// 設定の既定値は hq-max-parallel-ships.test.ts が見ているので、ここでは limits を直に渡す。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FLEET_STAGES, type FleetClaimInfo, type FleetStage, type FleetStatusData, type FleetStatusRow } from '../lib/fleet.ts';
import { assignSlots } from '../scripts/hq-decide.ts';

type AssignInput = Parameters<typeof assignSlots>[0];
type Ledger = AssignInput['ledgerFleets'];

const row = (issue: number, patch: Partial<FleetStatusRow> = {}): FleetStatusRow => {
  const stage: FleetStage = patch.stage ?? 'plan-ok';
  return {
    issue, title: `t${issue}`, pr: null, stage, stageLabel: FLEET_STAGES[stage], next: 'implement', selected: true, waitReason: null,
    overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null, ...patch,
  };
};
const claim = (stage: string | null): FleetClaimInfo => ({ by: 'manual', stage, session: 'sess-x', own: false });
const statusData = (rows: FleetStatusRow[]): FleetStatusData => ({
  version: 1, rows, selectedCount: rows.filter((r) => r.selected).length, selected: rows.filter((r) => r.selected).map((r) => r.issue), max: null, mode: null,
});
const fleet = (theme: string, epic: number | null, issues: number[]): Ledger[number] =>
  ({ theme, epic, dispatch: `d-${theme}`, session: `s-${theme}`, issues }) as Ledger[number];

/**
 * actions を比べやすい文字列にする。新しい fleet は start-fleet の index ではなく、その回の start-fleet の何番目か（new#0…）で書く
 * （index の数え始めに依らない）。wait の reason は文言を固定しない。
 */
function summarize(actions: ReturnType<typeof assignSlots>['actions']): string[] {
  const starts = actions.filter((a) => a.kind === 'start-fleet').map((a) => (a as { index: number }).index);
  return actions.map((a) => {
    if (a.kind === 'start-fleet') return `start ${a.issue} epic=${a.epic ?? 'none'} new#${starts.indexOf(a.index)}`;
    if (a.kind === 'add') {
      if (a.newFleet === null) return `add ${a.issue} -> ${a.theme}(${a.dispatch})`;
      assert.ok(starts.includes(a.newFleet), `add ${a.issue} の newFleet ${a.newFleet} が同じ回の start-fleet の index にありません`);
      return `add ${a.issue} -> new#${starts.indexOf(a.newFleet)}`;
    }
    assert.equal(typeof a.reason, 'string', `wait ${a.issue} に reason がありません`);
    return `wait ${a.issue}`;
  });
}

const cases: {
  name: string;
  input: AssignInput;
  running: number;
  perFleet: { theme: string; dispatch: string; running: number }[];
  free: number;
  actions: string[];
}[] = [
  {
    name: '動いている ship の数：plan-gate を数えない・prClaim を優先・stage が null は数える・控えの集合の外は数えない。空きが0なら wait',
    input: {
      status: statusData([
        row(1, { selected: false, claim: claim('implement') }), // 数える
        row(2, { selected: false, claim: claim('plan-gate') }), // 数えない
        row(3, { selected: false, claim: claim('plan-gate'), prClaim: claim('judge') }), // prClaim を優先して数える
        row(4, { selected: false, claim: claim('implement'), prClaim: claim('plan-gate') }), // prClaim を優先して数えない
        row(5, { selected: false }), // 宣言なし
        row(6, { selected: false, claim: claim(null) }), // stage が null は数える
        row(7, { claim: claim('implement') }), // 控えの集合の外：数えず、選ばれているので割り当ての対象
      ]),
      ledgerFleets: [fleet('A', null, [1, 2, 3, 4, 5, 6])],
      epicChildren: {},
      liveFleets: 1,
      limits: { hqMaxParallelShips: 3, hqMaxFleets: 2, fleetMaxParallelShips: 9 },
    },
    running: 3,
    perFleet: [{ theme: 'A', dispatch: 'd-A', running: 3 }],
    free: 0,
    actions: ['wait 7'],
  },
  {
    name: '(a) Epic の子は数が多くてもその fleet → (b) 数の一番少ない fleet → (c) 新しい fleet → 同じ Epic の子は新しい fleet に (a) → (d) 空き待ち。選ばれていない行・控えにある行は見ない',
    input: {
      status: statusData([
        row(10, { claim: claim('implement') }), // 控えにある（A の1）
        row(11), // Epic 50 の子 → (a) A
        row(12), // 単発 → (b) B（0 < A）
        row(14), // 単発 → (b) B（A=2・B=1）
        row(31), // Epic 60 の子 → (c) 新しい fleet（Epic 60）
        row(32), // Epic 60 の子 → (a) 同じ回の新しい fleet
        row(13), // 単発 → (b) 空きの fleet なし・(c) fleet の数が上限 → (d)
        row(15, { selected: false }), // 選ばれていない
      ]),
      ledgerFleets: [fleet('A', 50, [10]), fleet('B', null, [20])],
      epicChildren: { '50': [10, 11], '60': [31, 32] },
      liveFleets: 2,
      limits: { hqMaxParallelShips: 9, hqMaxFleets: 3, fleetMaxParallelShips: 2 },
    },
    running: 1,
    perFleet: [{ theme: 'A', dispatch: 'd-A', running: 1 }, { theme: 'B', dispatch: 'd-B', running: 0 }],
    free: 8,
    actions: ['add 11 -> A(d-A)', 'add 12 -> B(d-B)', 'add 14 -> B(d-B)', 'start 31 epic=60 new#0', 'add 32 -> new#0', 'wait 13'],
  },
  {
    name: '控えが空・Epic の子の一覧なし：単発の新しい fleet を1つ起こし、続く単発は (b) でそこへ足し、空きが0になった後は wait',
    input: {
      status: statusData([row(40), row(41), row(42)]),
      ledgerFleets: [],
      epicChildren: {},
      liveFleets: 0,
      limits: { hqMaxParallelShips: 2, hqMaxFleets: 2, fleetMaxParallelShips: 2 },
    },
    running: 0,
    perFleet: [],
    free: 2,
    actions: ['start 40 epic=none new#0', 'add 41 -> new#0', 'wait 42'],
  },
];

test('assignSlots：動いている ship の数と空いた枠の割り当て', () => {
  for (const c of cases) {
    const r = assignSlots(c.input);
    assert.equal(r.running, c.running, `${c.name}：running`);
    assert.deepEqual(r.perFleet, c.perFleet, `${c.name}：perFleet`);
    assert.equal(r.free, c.free, `${c.name}：free（hq.maxParallelShips − running）`);
    assert.deepEqual(summarize(r.actions), c.actions, `${c.name}：actions`);
  }
});
