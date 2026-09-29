// Issue #283：fleet-status の中身を JSON でも出す（fleetStatusData）。同じ事実から作った表（renderFleetStatus）と、
// 行の順・段階・次にやること・選ぶか待つかと理由・重なり・メモ・選んだ数・進め方が一致し、着手宣言の段階とセッションが出ることを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { FLEET_STAGES, fleetStatus, fleetStatusData, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { Claim, IssueFacts, PrFacts } from '../lib/queue.ts';

const root = join(import.meta.dirname, '..', '..');
// 実物の harness.config.json の既定値に依存しないよう、sharedFiles を明示する
const base = loadConfig();
const config = { ...base, fleet: { ...base.fleet, sharedFiles: ['docs/plan.md'] } };
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const OTHER = '9b8c7d6e-1111-2222-3333-444455556666';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const prFacts = (n: number, issue: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, issue: number, claim: Claim | null = null): FleetPr => ({
  number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue, { claim }),
});
const mergedPr = (n: number): FleetPr => ({ number: n, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null });
const fi = (facts: IssueFacts, planFiles: string[] | null = null, prs: FleetPr[] = []): FleetIssue => ({ facts, closed: false, planFiles, prs });
const manual = (patch: Partial<Extract<Claim, { by: 'manual' }>> = {}): Claim => ({ by: 'manual', at: '2026-09-26T11:00:00Z', ...patch });

/**
 * 選ぶ行・触るファイルが重なって待つ行・共有ファイルだけの重なり・PR の段階・着手宣言（このセッション／ほかのセッション／解除済み／段階・session の無いもの／Routine）・
 * 止まる印（r.note と sel.notes の両方があるメモ）・Merge 済み・タイトルに | を含む行をそろえた事実
 */
const facts: FleetFacts = {
  issues: [
    fi(planOk(1, { claim: manual({ session: SESSION, stage: 'implement' }) }), ['a.ts']),
    fi(planOk(2), ['a.ts']),
    fi(planOk(3, { title: 'x|y' }), ['docs/plan.md']),
    fi(planOk(4), ['docs/plan.md']),
    fi(planOk(5), null, [openPr(50, 5, manual({ session: SESSION, stage: 'judge' }))]),
    fi(planOk(6), null, [openPr(60, 6, manual({ session: OTHER, stage: 'fix' }))]),
    fi(planOk(7, { claim: manual() }), null),
    fi(planOk(8, { labels: ['agent:ready', 'agent:plan-ok', 'agent:hold'], claim: manual({ session: OTHER, stage: 'plan' }) }), ['h.ts']),
    fi(planOk(9, { claim: { ...manual({ session: OTHER, stage: 'implement' }), released: true } }), ['z.ts']),
    fi(planOk(10), null, [mergedPr(100)]),
    fi(planOk(11, { claim: { by: 'routine', session: OTHER, at: '2026-09-26T11:00:00Z' } }), null),
  ],
  prConflicts: [],
};

type Cells = { issue: string; pr: string; stage: string; next: string; chosen: string; overlap: string; note: string };

/** 表の Markdown の行を列に分ける（\| は列の区切りにしない） */
function tableRows(table: string): Cells[] {
  return table.split('\n').filter((l) => l.startsWith('| #')).map((l) => {
    const c = l.split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim().replace(/\\\|/g, '|'));
    assert.equal(c.length, 7, l);
    return { issue: c[0]!, pr: c[1]!, stage: c[2]!, next: c[3]!, chosen: c[4]!, overlap: c[5]!, note: c[6]! };
  });
}

type Data = ReturnType<typeof fleetStatusData>;

/** JSON の行から、表の列に出るはずの文を作る */
function expectedCells(r: Data['rows'][number]): Cells {
  const blocking = r.overlaps.map((n) => `#${n}`).join(', ');
  const shared = r.sharedOnlyOverlaps.map((n) => `#${n}`).join(', ');
  return {
    issue: `#${r.issue} ${r.title}`,
    pr: r.pr === null ? '—' : `#${r.pr}`,
    stage: r.stageLabel,
    next: r.next === 'none' ? '—' : r.next,
    chosen: r.selected ? '選ぶ' : `待つ：${r.waitReason ?? ''}`,
    overlap: [blocking, shared ? `共有ファイルのみ（並行可）：${shared}` : ''].filter((x) => x).join('。') || '—',
    note: r.note ?? '',
  };
}

function build(max: number | null, current: string | null, mode?: { nesting: 'orca' | 'flat'; maxParallelShips: number }) {
  const rows = fleetStatus(facts);
  const sel = selectFleet(config, facts, rows, max, current);
  return { rows, sel, table: renderFleetStatus(rows, sel, max, mode), data: fleetStatusData(facts, rows, sel, max, current, mode) };
}

const rowOf = (d: Data, n: number) => d.rows.find((r) => r.issue === n)!;

test('JSON の行は、表の行と同じ順で、各列（Issue・PR・段階・次にやること・選択・重なり・メモ）が一致する', () => {
  for (const max of [null, 2]) {
    for (const current of [SESSION, null]) {
      const { table, data } = build(max, current);
      const cells = tableRows(table);
      assert.deepEqual(data.rows.map((r) => `#${r.issue} ${r.title}`), cells.map((c) => c.issue), `行の順（max=${max}, current=${current}）`);
      for (const [i, r] of data.rows.entries()) {
        assert.equal(r.stageLabel, FLEET_STAGES[r.stage], `#${r.issue} の stageLabel は FLEET_STAGES の文言`);
        assert.deepEqual(expectedCells(r), cells[i], `#${r.issue}（max=${max}, current=${current}）`);
      }
    }
  }
});

test('JSON の中身：選ぶ・待つと理由・重なり・共有ファイルだけの重なり・メモ（r.note と sel.notes をつなぐ）', () => {
  const { sel, data } = build(null, SESSION);
  assert.equal(data.version, 1);
  assert.deepEqual(data.selected, sel.selected);
  assert.deepEqual(data.rows.filter((r) => r.selected).map((r) => r.issue), sel.selected, '選んだ行が選んだ順に先');
  const rest = data.rows.filter((r) => !r.selected).map((r) => r.issue);
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b), '残りは Issue 番号順');

  const r1 = rowOf(data, 1);
  assert.equal(r1.selected, true);
  assert.equal(r1.waitReason, null, '選ぶ行の理由は null');
  assert.deepEqual(r1.overlaps, [2]);
  assert.equal(r1.stage, 'plan-ok');
  assert.equal(r1.next, 'implement');

  const r2 = rowOf(data, 2);
  assert.equal(r2.selected, false);
  assert.equal(r2.waitReason, '#1 と触るファイルが重なるため待つ');
  assert.deepEqual(r2.overlaps, [1]);
  assert.deepEqual(r2.sharedOnlyOverlaps, []);
  assert.equal(r2.note, null, 'メモが空なら null');

  assert.equal(rowOf(data, 3).title, 'x|y', 'JSON のタイトルは表のエスケープ（\\|）をしない');
  assert.deepEqual(rowOf(data, 3).sharedOnlyOverlaps, [4]);
  assert.deepEqual(rowOf(data, 3).overlaps, []);
  assert.equal(rowOf(data, 4).selected, true, '共有ファイルだけの重なりでは待たない');

  const r5 = rowOf(data, 5);
  assert.equal(r5.pr, 50);
  assert.equal(r5.stage, 'judge');
  assert.equal(r5.stageLabel, '判定待ち');
  assert.equal(r5.next, 'judge');

  assert.match(rowOf(data, 6).waitReason!, /^着手宣言あり（ほかのセッションが着手中・段階 fix/);

  const r8 = rowOf(data, 8);
  assert.equal(r8.stage, 'stopped');
  assert.equal(r8.next, 'none');
  assert.equal(r8.note, `\`agent:hold\`。${sel.notes.get(8)}`, 'r.note と sel.notes を「。」でつなぐ');

  const r10 = rowOf(data, 10);
  assert.equal(r10.stage, 'merged');
  assert.equal(r10.pr, 100);
  assert.equal(r10.waitReason, 'Merge 済み');
});

test('--max で待つ行の理由も表と同じ', () => {
  const { data, table } = build(2, SESSION);
  assert.equal(data.max, 2);
  assert.equal(data.selectedCount, 2);
  const waitMax = data.rows.filter((r) => r.waitReason === '--max で指定した、人が1回にさばける数（2）に達した');
  assert.ok(waitMax.length > 0, '前提：--max で待つ行がある');
  for (const r of waitMax) assert.ok(table.includes(`| 待つ：--max で指定した、人が1回にさばける数（2）に達した |`), `#${r.issue}`);
});

test('選んだ数・max・進め方が表の末尾の行と一致する', () => {
  const cases: { max: number | null; mode?: { nesting: 'orca' | 'flat'; maxParallelShips: number } }[] = [
    { max: null },
    { max: 2 },
    { max: null, mode: { nesting: 'orca', maxParallelShips: 3 } },
    { max: 2, mode: { nesting: 'orca', maxParallelShips: 3 } },
    { max: null, mode: { nesting: 'flat', maxParallelShips: 3 } },
  ];
  for (const c of cases) {
    const { table, data, sel } = build(c.max, SESSION, c.mode);
    const label = JSON.stringify(c);
    const lines = table.split('\n');
    const countLine = lines.find((l) => l.startsWith('選んだ数：'))!;
    assert.equal(data.selectedCount, sel.selected.length, label);
    assert.equal(Number(/^選んだ数：(\d+)/.exec(countLine)![1]), data.selectedCount, label);
    assert.equal(data.max, c.max, label);
    if (c.max !== null) assert.ok(countLine.startsWith(`選んだ数：${data.selectedCount}/${c.max}`), label);
    const modeLine = lines.find((l) => l.startsWith('進め方：'));
    if (!c.mode) {
      assert.equal(data.mode, null, label);
      assert.equal(modeLine, undefined, label);
      continue;
    }
    assert.equal(data.mode!.nesting, c.mode.nesting, label);
    assert.equal(data.mode!.parallel, c.max ?? c.mode.maxParallelShips, label);
    if (c.mode.nesting === 'orca') assert.ok(modeLine!.includes(`同時に動かす ship は ${data.mode!.parallel} まで`), label);
    else assert.ok(modeLine!.startsWith('進め方：交互（flat）'), label);
  }
});

test('着手宣言：段階・session・own が出て、解除済みは null、段階・session の無い宣言でも鍵が null で残る', () => {
  const { data } = build(null, SESSION);
  assert.deepEqual(rowOf(data, 1).claim, { by: 'manual', stage: 'implement', session: SESSION, own: true });
  assert.equal(rowOf(data, 1).prClaim, null, 'PR の無い行の PR の宣言は null');
  assert.deepEqual(rowOf(data, 5).prClaim, { by: 'manual', stage: 'judge', session: SESSION, own: true });
  assert.equal(rowOf(data, 5).claim, null, 'Issue の宣言が無ければ null');
  assert.deepEqual(rowOf(data, 6).prClaim, { by: 'manual', stage: 'fix', session: OTHER, own: false });
  assert.deepEqual(rowOf(data, 8).claim, { by: 'manual', stage: 'plan', session: OTHER, own: false });
  assert.equal(rowOf(data, 9).claim, null, '解除済みの宣言は null');
  assert.equal(rowOf(data, 10).prClaim, null, 'Merge 済みの PR の宣言は出さない');

  const bare = rowOf(data, 7).claim!;
  assert.deepEqual(bare, { by: 'manual', stage: null, session: null, own: false });
  assert.ok('stage' in bare && 'session' in bare, '鍵を落とさない');
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(bare))).sort(), ['by', 'own', 'session', 'stage']);

  assert.deepEqual(rowOf(data, 11).claim, { by: 'routine', stage: null, session: OTHER, own: false });

  // currentSession が null なら、どの宣言も自分のものではない
  const anon = build(null, null).data;
  assert.equal(rowOf(anon, 1).claim!.own, false);
  assert.equal(rowOf(anon, 5).prClaim!.own, false);
});

test('JSON.stringify して JSON.parse し直しても同じ（Map などが入らない）', () => {
  for (const mode of [undefined, { nesting: 'orca' as const, maxParallelShips: 3 }]) {
    const { data } = build(2, SESSION, mode);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
  }
});

test('fleet-status は --json を受け付け、fleetStatusData で JSON を出す', () => {
  const agent = readFileSync(join(root, 'harness', 'scripts', 'agent.ts'), 'utf8');
  assert.match(agent, /fleet-status \[[^\n]*--json/, 'usage に --json がある');
  assert.match(agent, /fleetStatusData\(/, 'agent.ts が fleetStatusData を使う');
});
