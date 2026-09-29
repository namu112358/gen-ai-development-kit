// Issue #172：fleet の候補の選び方で、requireAssignee が有効なら Assignee が自分1人でない Issue を選ばず、理由を示す
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';

const base = loadConfig();
const on = { ...base, requireAssignee: true };
const off = { ...base, requireAssignee: undefined };
const ME = 'me';

const gatePass = { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' };
const planOk = (n: number, patch: Partial<IssueFacts> = {}): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: `2026-09-26T00:${String(n % 60).padStart(2, '0')}:00Z`, claim: null, openBlockers: [],
  gate: gatePass, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null, ...patch,
});
const prFacts = (n: number, issue: number): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0,
});
const openPr = (n: number, issue: number): FleetPr => ({ number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFacts(n, issue) });
const fi = (n: number, assignees: string[] | undefined, prs: FleetPr[] = []): FleetIssue => ({
  facts: planOk(n), closed: false, planFiles: [`docs/${n}.md`], prs, ...(assignees === undefined ? {} : { assignees }),
});
const facts = (issues: FleetIssue[]): FleetFacts => ({ issues, prConflicts: [] });
const rowOf = (table: string, n: number): string => table.split('\n').find((l) => l.startsWith(`| #${n} t${n} |`))!;

const mixed = () => facts([fi(1, ['me']), fi(2, []), fi(3, ['alice']), fi(4, ['me', 'alice']), fi(5, ['Me'])]);

test('有効：自分1人の Issue だけを選び、空・他人・2人以上は excluded に理由が入る', () => {
  const f = mixed();
  const s = selectFleet(on, f, fleetStatus(f), null, null, ME);
  assert.deepEqual(s.selected, [1, 5], '大文字小文字違いも自分');
  assert.equal(s.excluded.get(2), 'Assignee が自分1人ではない（誰もアサインされていない）');
  assert.equal(s.excluded.get(3), 'Assignee が自分1人ではない（ほかの人（@alice）がアサインされている）');
  assert.equal(s.excluded.get(4), 'Assignee が自分1人ではない（2人以上（@me, @alice）がアサインされている）');
  assert.equal(s.excluded.has(1), false);
});

test('有効：assignees が無い（未取得）Issue は空として外れる', () => {
  const f = facts([fi(1, undefined)]);
  const s = selectFleet(on, f, fleetStatus(f), null, null, ME);
  assert.deepEqual(s.selected, []);
  assert.equal(s.excluded.get(1), 'Assignee が自分1人ではない（誰もアサインされていない）');
});

test('有効：renderFleetStatus の「選択」の列に 待つ：<理由> が出る', () => {
  const f = mixed();
  const rows = fleetStatus(f);
  const table = renderFleetStatus(rows, selectFleet(on, f, rows, null, null, ME), null);
  assert.match(rowOf(table, 1), /\| 選ぶ \|/);
  assert.match(rowOf(table, 2), /\| 待つ：Assignee が自分1人ではない（誰もアサインされていない） \|/);
  assert.match(rowOf(table, 3), /\| 待つ：Assignee が自分1人ではない（ほかの人（@alice）がアサインされている） \|/);
  assert.match(rowOf(table, 4), /\| 待つ：Assignee が自分1人ではない（2人以上（@me, @alice）がアサインされている） \|/);
});

test('有効：me が null なら全部外れ、確かめられない理由が入る', () => {
  const f = mixed();
  const s = selectFleet(on, f, fleetStatus(f), null, null, null);
  assert.deepEqual(s.selected, []);
  for (const n of [1, 2, 3, 4, 5]) assert.equal(s.excluded.get(n), '今の GitHub のユーザーが分からないため、Assignee を確かめられない');
});

test('有効：PR 段階の行も Issue の assignees で判定する', () => {
  const f = facts([fi(1, ['me'], [openPr(10, 1)]), fi(2, ['alice'], [openPr(20, 2)])]);
  const rows = fleetStatus(f);
  assert.equal(rows.find((r) => r.issue === 1)!.pr, 10, '前提：PR 段階の行');
  const s = selectFleet(on, f, rows, null, null, ME);
  assert.deepEqual(s.selected, [1]);
  assert.equal(s.excluded.get(2), 'Assignee が自分1人ではない（ほかの人（@alice）がアサインされている）');
});

test('有効：Assignee の判定は着手宣言の判定より前（ほかのセッションの宣言があっても理由は Assignee）', () => {
  const other = { by: 'manual' as const, at: '2026-09-26T11:00:00Z', session: '9b8c7d6e-1111-2222-3333-444455556666', stage: 'plan' as const };
  const f = facts([{ ...fi(1, ['alice']), facts: planOk(1, { claim: other }) }]);
  const s = selectFleet(on, f, fleetStatus(f), null, null, ME);
  assert.match(s.excluded.get(1)!, /^Assignee が自分1人ではない/);
});

test('無効（未設定・false）：assignees に関わらず今と同じ選び方', () => {
  for (const config of [off, { ...base, requireAssignee: false }, base]) {
    const f = mixed();
    const rows = fleetStatus(f);
    const expected = selectFleet(config, f, rows, null, null);
    const s = selectFleet(config, f, rows, null, null, ME);
    assert.deepEqual(s.selected, [1, 2, 3, 4, 5]);
    assert.deepEqual(s.selected, expected.selected);
    for (const reason of s.excluded.values()) assert.doesNotMatch(reason, /Assignee/);
    assert.deepEqual(selectFleet(config, f, rows, null, null, null).selected, [1, 2, 3, 4, 5], 'me が null でも外さない');
  }
});
