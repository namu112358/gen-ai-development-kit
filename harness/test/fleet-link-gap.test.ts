// Issue #398：fleet-status（collectFleetIssues → fleetStatus → selectFleet）が、GitHub の紐付け（closedByPullRequestsReferences・closingIssuesReferences）が空でも、
// 開いた PR の本文の `Closes #N` で Issue と PR を結び、メモに「紐付けの抜け」を出す。本文の番号が PR の番号・存在しない番号なら結ばない。スタックの層（本文の Refs #N）も結ばない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { type FleetIssue, fleetStatus, fleetStatusData, renderFleetStatus, selectFleet } from '../lib/fleet.ts';
import { collectFleetIssues, type FleetIssueItem, prefetchedGitHub, readFleetSnapshot } from '../lib/fleet-reads.ts';
import { GitHub } from '../lib/github.ts';
import { Snapshot } from '../lib/graphql-prefetch.ts';
import { config } from './support/gate-fixtures.ts';
import { APP_SLUG, dashboardFake, REPO, type WComment, type WPr, type World } from './support/dashboard-fixtures.ts';
import { FEATURE_BASE, STACK } from './support/stack-fixtures.ts';

const sha = (c: string) => c.repeat(40);
const APP_ACTOR = { login: APP_SLUG, bot: true };

function planC(id: number): WComment {
  return { id, body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') };
}
function planGateC(id: number, planCommentId: number): WComment {
  return {
    id, author: APP_ACTOR, association: 'NONE',
    body: [appMark('plan-gate'), 'App です。', renderBlock('agent-app', { version: 1, planCommentId, pass: true, reasons: [], plan: { files: ['docs/**'], critique: { verdict: 'go', rounds: 1 } } })].join('\n'),
  };
}

/** 計画ゲートを通った Issue #20（GitHub の紐付けは空）と、与えた PR */
function world(prs: WPr[]): World {
  return {
    issues: [{
      number: 20, title: 'feat: twenty', labels: [LABELS.planOk],
      comments: [planC(200), planGateC(201, 200)],
      events: [{ event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T01:00:00Z', actor: APP_ACTOR }],
      closedBy: [],
    }],
    prs,
  };
}

/** 本文に Closes #20 があり、GitHub の紐付けが空の開いた PR #21 */
const gapPr: WPr = { number: 21, title: 'feat: pr21', body: 'Closes #20', closing: [], headRef: 'claude/issue-20-x', headSha: sha('a') };

/** 事実を集める。prefetch なら readFleetSnapshot の先読み（fleet-status の読み方）、そうでなければ空の Snapshot（REST の読み方） */
async function collect(w: World, numbers: number[], prefetch: boolean, items?: FleetIssueItem[]): Promise<FleetIssue[]> {
  const gh = new GitHub(dashboardFake(w), REPO);
  const list = items ?? await Promise.all(numbers.map((n) => gh.get<FleetIssueItem>(`/issues/${n}`)));
  const snap = prefetch ? await readFleetSnapshot(gh, config, numbers) : new Snapshot();
  return (await collectFleetIssues(prefetchedGitHub(gh, config, snap), config, list, snap)).issues;
}

function view(issues: FleetIssue[]) {
  const facts = { issues, prConflicts: [] };
  const rows = fleetStatus(facts);
  const sel = selectFleet(config, facts, rows, null, null, null);
  return { rows, text: renderFleetStatus(rows, sel, null), json: fleetStatusData(facts, rows, sel, null, null) };
}

test('紐付けが空で本文に Closes #N がある開いた PR は、Issue #N の PR として出て、段階が implement でなくなり、メモに「紐付けの抜け」が出る', async () => {
  for (const prefetch of [false, true]) {
    const label = prefetch ? '先読み' : '空の Snapshot';
    const issues = await collect(world([gapPr]), [20], prefetch);
    const i20 = issues.find((i) => i.facts.number === 20)!;
    assert.deepEqual(i20.prs.map((p) => [p.number, p.merged]), [[21, false]], label);
    assert.equal(i20.facts.openPr, 21, label);
    assert.deepEqual((i20 as FleetIssue & { linkGapPrs?: number[] }).linkGapPrs, [21], label);

    const { rows, text, json } = view(issues);
    const row = rows.find((r) => r.issue === 20)!;
    assert.equal(row.pr, 21, label);
    assert.notEqual(row.stage, 'implement', label);
    const note = json.rows.find((r) => r.issue === 20)!.note ?? '';
    assert.match(note, /#21/, label);
    assert.match(note, /紐付けの抜け/, label);
    assert.ok(text.includes(note), `表のメモと --json の note が同じ文（${label}）`);
  }
});

test('本文の番号が PR の番号か存在しない番号なら、その番号に PR を結ばない', async () => {
  const cases: { name: string; prs: WPr[]; item: number }[] = [
    { name: 'PR 自身の番号', prs: [{ number: 23, body: 'Closes #23', closing: [], headRef: 'claude/issue-23-x', headSha: sha('b') }], item: 23 },
    { name: 'ほかの PR の番号', prs: [{ number: 24, body: 'no link', headRef: 'claude/issue-24-x', headSha: sha('c') }, { number: 25, body: 'Closes #24', closing: [], headRef: 'claude/issue-25-x', headSha: sha('d') }], item: 24 },
    { name: '存在しない番号', prs: [{ number: 27, body: 'Closes #99', closing: [], headRef: 'claude/issue-99-x', headSha: sha('e') }], item: 99 },
  ];
  for (const c of cases) {
    // 対象の一覧に、本文の番号を Issue として渡す（番号が一致するだけで結んでいないかを見る）
    const item: FleetIssueItem = { number: c.item, title: `t${c.item}`, state: 'open', labels: [{ name: LABELS.ready }] };
    const issues = await collect(world(c.prs), [c.item], false, [item]);
    const got = issues.find((i) => i.facts.number === c.item)!;
    assert.deepEqual(got.prs, [], c.name);
    assert.equal(got.facts.openPr, null, c.name);
    assert.ok(((got as FleetIssue & { linkGapPrs?: number[] }).linkGapPrs ?? []).length === 0, c.name);
    const note = view(issues).json.rows.find((r) => r.issue === c.item)!.note ?? '';
    assert.doesNotMatch(note, /紐付けの抜け/, c.name);
  }
});

test('スタックの上の層（本文の Refs #N）は、紐付けの抜けとして結ばない', async () => {
  const layer: WPr = { number: 31, body: 'Refs #20', closing: [], headRef: 'claude/issue-20-top', headSha: sha('f'), baseRef: FEATURE_BASE.ref, stack: STACK };
  const issues = await collect(world([layer]), [20], false);
  const i20 = issues.find((i) => i.facts.number === 20)!;
  assert.deepEqual(i20.prs, []);
  assert.ok(((i20 as FleetIssue & { linkGapPrs?: number[] }).linkGapPrs ?? []).length === 0);
  assert.doesNotMatch(view(issues).json.rows.find((r) => r.issue === 20)!.note ?? '', /紐付けの抜け/);
});
