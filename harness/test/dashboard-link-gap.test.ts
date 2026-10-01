// Issue #398：ダッシュボード（DashboardData.loadAll → buildGraph）が、GitHub の紐付け（closingIssuesReferences）が空でも、開いた PR の本文の `Closes #N` で Issue #N と結び、
// PR のカードの warnings に「紐付けの抜け」を出す。本文の番号が PR の番号・存在しない番号なら結ばない。GitHub が紐付けた PR には出さない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABELS } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { DashboardData, ReadOnlyTransport } from '../scripts/dashboard/github.ts';
import { buildGraph, type DashPr } from '../scripts/dashboard/graph.ts';
import { config } from './support/gate-fixtures.ts';
import { dashboardFake, REPO, type World } from './support/dashboard-fixtures.ts';

const sha = (c: string) => c.repeat(40);
const opts = { now: new Date('2026-09-29T00:00:00Z'), humanClaimStaleHours: 6 };

/**
 * #20 の Agent の Issue と、GitHub の紐付けが空で本文に Closes #20 がある PR #21。
 * #3 と、GitHub が紐付けた PR #5（比べる相手）。本文の番号が PR 自身（#23）・ほかの PR（#25 → #24）・存在しない番号（#27 → #99）の PR
 */
function world(): World {
  return {
    issues: [
      { number: 20, title: 'feat: twenty', labels: [LABELS.planOk], closedBy: [] },
      { number: 3, title: 'feat: three', labels: [LABELS.planOk], closedBy: [{ number: 5, state: 'OPEN' }] },
    ],
    prs: [
      { number: 21, title: 'feat: pr21', body: 'Closes #20', closing: [], headRef: 'claude/issue-20-x', headSha: sha('a') },
      { number: 5, title: 'feat: pr5', body: 'Closes #3', closing: [3], headRef: 'claude/issue-3-x', headSha: sha('b') },
      { number: 23, title: 'feat: pr23', body: 'Closes #23', closing: [], headRef: 'claude/issue-23-x', headSha: sha('c') },
      { number: 24, title: 'feat: pr24', body: 'no link', closing: [], headRef: 'claude/issue-24-x', headSha: sha('d') },
      { number: 25, title: 'feat: pr25', body: 'Closes #24', closing: [], headRef: 'claude/issue-25-x', headSha: sha('e') },
      { number: 27, title: 'feat: pr27', body: 'Closes #99', closing: [], headRef: 'claude/issue-99-x', headSha: sha('f') },
    ],
  };
}

async function load() {
  const data = new DashboardData(new GitHub(new ReadOnlyTransport(dashboardFake(world())), REPO), config);
  await data.loadAll();
  const prs = data.prs();
  const graph = buildGraph(data.issues(), prs, [], opts);
  const pr = (n: number) => {
    const p = prs.find((x) => x.number === n);
    assert.ok(p, `PR #${n} がありません`);
    return p as DashPr & { linkGap?: true };
  };
  const warnings = (n: number) => graph.tasks.find((t) => t.id === `pr-${n}`)?.warnings ?? [];
  return { data, graph, pr, warnings };
}

test('紐付けが空で本文に Closes #N がある開いた PR は、Issue #N と結ばれ、PR のカードに「紐付けの抜け」が出る', async () => {
  const { data, graph, pr, warnings } = await load();
  assert.equal(pr(21).issue, 20);
  assert.equal(pr(21).linkGap, true);
  assert.deepEqual(data.issues().find((i) => i.fleet.facts.number === 20)?.fleet.prs.map((p) => p.number), [21]);
  assert.ok(graph.edges.some((e) => e.kind === 'closes' && e.from === 'issue-20' && e.to === 'pr-21'), 'Issue #20 から PR #21 への線');
  assert.ok(warnings(21).some((w) => /紐付けの抜け/.test(w)), warnings(21).join(','));
});

test('GitHub が紐付けた PR には「紐付けの抜け」を出さない', async () => {
  const { pr, warnings } = await load();
  assert.equal(pr(5).issue, 3);
  assert.equal(pr(5).linkGap, undefined);
  assert.ok(!warnings(5).some((w) => /紐付けの抜け/.test(w)), warnings(5).join(','));
});

test('本文の番号が PR の番号か存在しない番号なら結ばず、「紐付けの抜け」も出さない', async () => {
  const { pr, warnings } = await load();
  for (const [n, name] of [[23, 'PR 自身の番号'], [25, 'ほかの PR の番号'], [27, '存在しない番号']] as const) {
    assert.equal(pr(n).issue, null, name);
    assert.equal(pr(n).linkGap, undefined, name);
    assert.ok(!warnings(n).some((w) => /紐付けの抜け/.test(w)), name);
  }
});
