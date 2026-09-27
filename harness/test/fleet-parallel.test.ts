import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, mergeTreeResult, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr, type PrConflict } from '../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';

// 領域の上限を設定していても fleet の選び方には効かないことを確かめるため、あえて上限を付ける
const config = { ...loadConfig(), areaConcurrency: { harness: 2 } };

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const issueFacts = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null, ...patch,
});
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts =>
  issueFacts(n, { labels: ['agent:ready', 'agent:plan-ok'], gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, ...patch });
const prFacts = (n: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue: 1, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, patch: Partial<FleetPr> = {}, facts: Partial<PrFacts> = {}): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, facts), ...patch,
});
const fi = (facts: IssueFacts, planFiles: string[] | null = null, prs: FleetPr[] = [], closed = false): FleetIssue => ({ facts, closed, planFiles, prs });
const facts = (issues: FleetIssue[], prConflicts: PrConflict[] = []): FleetFacts => ({ issues, prConflicts });
const conflict = (a: number, b: number, untested = false): PrConflict => ({ prs: [a, b], untested });
const select = (f: FleetFacts, max: number | null = null) => selectFleet(config, f, fleetStatus(f), max);

test('並行：同じ領域の候補は、領域の上限（areaConcurrency）を超えても除外しない', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/a.ts']),
    fi(planOk(2), ['harness/lib/b.ts']),
    fi(planOk(3), ['harness/lib/c.ts']),
    fi(planOk(4), ['harness/lib/d.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2, 3, 4], 'area:harness の上限 2 は効かない');
  assert.equal(s.excluded.size, 0);
  assert.equal('areas' in s, false, 'FleetSelection に areas は無い');
});

test('並行：同じ領域の PR が既に開いていても、新しい候補を領域の上限で除外しない', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/a.ts'], [openPr(10)]),
    fi(planOk(2), ['harness/lib/b.ts'], [openPr(20)]),
    fi(planOk(3), ['harness/lib/c.ts']),
    fi(planOk(4), ['harness/gates/d.ts']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2, 3, 4]);
  for (const reason of s.excluded.values()) assert.doesNotMatch(reason, /area:|上限/);
});

test('本数：max が null なら全部選び、数を渡せばそこで止まる（理由にさばける数を含む）', () => {
  const issues = [1, 2, 3, 4, 5, 6].map((n) => fi(planOk(n), [`docs/${n}.md`]));
  const f = facts(issues);
  assert.deepEqual(select(f, null).selected, [1, 2, 3, 4, 5, 6], '既定では本数を制限しない');
  const two = select(f, 2);
  assert.deepEqual(two.selected, [1, 2]);
  for (const n of [3, 4, 5, 6]) assert.match(two.excluded.get(n)!, /さばける数（2）/);
});

test('本数：max を渡しても並べ方は今のまま（PR のある Issue → 優先度 → agent:ready の順）', () => {
  const f = facts([
    fi(planOk(1, { labels: ['agent:ready', 'agent:plan-ok', 'priority:low'] })),
    fi(planOk(2, { labels: ['agent:ready', 'agent:plan-ok', 'priority:highest'] })),
    fi(planOk(3)),
    fi(planOk(4, { labels: ['agent:ready', 'agent:plan-ok', 'priority:high'] })),
    fi(planOk(5, { labels: ['agent:ready', 'agent:plan-ok', 'priority:lowest'] }), null, [openPr(50)]),
  ]);
  assert.deepEqual(select(f, 3).selected, [5, 2, 4]);
  assert.deepEqual(select(f, null).selected, [5, 2, 4, 3, 1]);
});

test('PR 同士：prConflicts に載らなければ、計画の files が重なっていても両方選ぶ', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/fleet.ts'], [openPr(10)]),
    fi(planOk(2), ['harness/lib/fleet.ts'], [openPr(20)]),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 2]);
  assert.equal(s.excluded.size, 0);
  assert.equal(s.overlaps.get(1), undefined, 'PR 同士は files の重なりを表示しない');
  assert.equal(s.overlaps.get(2), undefined);
});

test('PR 同士：prConflicts に載れば、並べた順で後の側が待ち、理由に先の Issue 番号が入る', () => {
  const issues = [
    fi(planOk(1), ['docs/a.md'], [openPr(10)]),
    fi(planOk(2), ['harness/lib/b.ts'], [openPr(20)]),
  ];
  const s = select(facts(issues, [conflict(10, 20)]));
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), '#1 と衝突するため待つ（先に Merge された側に合わせて sync）');
  assert.deepEqual(s.overlaps.get(1), [2], '衝突した組は重なりとして表示する（Issue 番号）');
  assert.deepEqual(s.overlaps.get(2), [1]);

  // 組の PR の並びが逆でも同じ
  const r = select(facts(issues, [conflict(20, 10)]));
  assert.deepEqual(r.selected, [1]);
  assert.match(r.excluded.get(2)!, /#1 と衝突するため待つ/);

  // 優先度で並びが変われば、待つ側も変わる
  const prio = select(facts([
    fi(planOk(1), ['docs/a.md'], [openPr(10)]),
    fi(planOk(2, { labels: ['agent:ready', 'agent:plan-ok', 'priority:highest'] }), ['harness/lib/b.ts'], [openPr(20)]),
  ], [conflict(10, 20)]));
  assert.deepEqual(prio.selected, [2]);
  assert.match(prio.excluded.get(1)!, /#2 と衝突するため待つ/);
});

test('PR 同士：衝突を見る相手は既に選んだ PR だけ（待つ側とだけ衝突する PR は選ぶ）', () => {
  const f = facts([
    fi(planOk(1), null, [openPr(10)]),
    fi(planOk(2), null, [openPr(20)]),
    fi(planOk(3), null, [openPr(30)]),
  ], [conflict(10, 20), conflict(20, 30)]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 3]);
  assert.match(s.excluded.get(2)!, /#1 と衝突するため待つ/);
  assert.equal(s.excluded.has(3), false);
});

test('PR 同士：prConflicts に載っていない組は、ほかの組が衝突していても選ぶ', () => {
  // 1 と 2 は衝突、1 と 3・2 と 3 は載っていないので 3 は選ぶ
  const f = facts([
    fi(planOk(1), null, [openPr(10)]),
    fi(planOk(2), null, [openPr(20)]),
    fi(planOk(3), null, [openPr(30)]),
  ], [conflict(10, 20)]);
  assert.deepEqual(select(f).selected, [1, 3]);
});

test('PR の無い Issue：今のまま、既に選んだ Issue や PR 段階の Issue と計画の files が重なれば待つ', () => {
  const f = facts([
    fi(planOk(1), ['harness/lib/fleet.ts']),
    fi(planOk(2), ['harness/lib/*.ts']),
    fi(planOk(3), ['docs/a.md']),
  ]);
  const s = select(f);
  assert.deepEqual(s.selected, [1, 3]);
  assert.match(s.excluded.get(2)!, /#1 と触るファイルが重なるため待つ/);
  assert.deepEqual(s.overlaps.get(1), [2]);
  assert.deepEqual(s.overlaps.get(2), [1]);

  // PR 段階の Issue（優先度が低くても先）と重なる新しい Issue は待つ
  const pr = facts([
    fi(planOk(4, { labels: ['agent:ready', 'agent:plan-ok', 'priority:highest'] }), ['docs/a.md']),
    fi(planOk(5, { labels: ['agent:ready', 'agent:plan-ok', 'priority:lowest'] }), ['docs/**'], [openPr(50)]),
  ]);
  const p = select(pr);
  assert.deepEqual(p.selected, [5]);
  assert.match(p.excluded.get(4)!, /#5 と触るファイルが重なるため待つ/);
  assert.deepEqual(p.overlaps.get(4), [5], 'PR の無い Issue が絡む組は計画の files の重なりを表示する');
  assert.deepEqual(p.overlaps.get(5), [4]);

  // 着手宣言のある（実装中の）Issue と重なっても待つ
  const claimed = facts([
    fi(planOk(6, { claim: { by: 'manual', at: '2026-09-26T00:00:00Z' } }), ['docs/a.md']),
    fi(planOk(7), ['docs/a.md']),
  ]);
  const c = select(claimed);
  assert.deepEqual(c.selected, []);
  assert.match(c.excluded.get(7)!, /#6 と触るファイルが重なるため待つ/);
});

test('mergeTreeResult：git merge-tree の終了コード 0 は clean、1 は conflict、それ以外は untested', () => {
  assert.equal(mergeTreeResult(0), 'clean');
  assert.equal(mergeTreeResult(1), 'conflict');
  for (const status of [null, 2, 128, 129, -1]) assert.equal(mergeTreeResult(status), 'untested', String(status));
});

test('表：領域の表を出さず、max が null なら「選んだ数：x」、数なら「選んだ数：x/y」', () => {
  const f = facts([fi(planOk(1), ['harness/lib/a.ts'], [openPr(10)]), fi(issueFacts(2))]);
  const rows = fleetStatus(f);
  const t = renderFleetStatus(rows, select(f, null), null);
  assert.match(t, /\| #1 t1 \| #10 \| 判定待ち \| judge \| 選ぶ \|/);
  assert.match(t, /\| #2 t2 \| — \| 計画なし \| plan \| 選ぶ \|/);
  assert.match(t, /選んだ数：2(?!\/)/);
  assert.doesNotMatch(t, /選んだ数：2\//);
  assert.doesNotMatch(t, /\| 領域 \|/);
  assert.doesNotMatch(t, /area:/);

  const n = renderFleetStatus(rows, select(f, 3), 3);
  assert.match(n, /選んだ数：2\/3/);
  assert.doesNotMatch(n, /\| 領域 \|/);
});

test('表：git merge-tree で試せなかった組は衝突ありとして扱い、メモの列に書く', () => {
  const f = facts([
    fi(planOk(1), null, [openPr(10)]),
    fi(planOk(2), null, [openPr(20)]),
  ], [conflict(10, 20, true)]);
  const s = select(f);
  assert.deepEqual(s.selected, [1], '試せなかった組は衝突ありに倒す');
  assert.match(s.excluded.get(2)!, /#1 と衝突するため待つ/);
  assert.match(s.notes.get(2)!, /試せなかったため衝突ありとして扱う/);
  const t = renderFleetStatus(fleetStatus(f), s, null);
  const row = t.split('\n').find((l) => l.startsWith('| #2 t2 |'))!;
  assert.match(row, /試せなかったため衝突ありとして扱う/);

  // 試せた衝突（untested: false）にはこのメモを付けない
  const tested = select(facts(f.issues, [conflict(10, 20)]));
  assert.equal(tested.notes.get(2), undefined);
  assert.doesNotMatch(renderFleetStatus(fleetStatus(f), tested, null), /試せなかった/);
});
