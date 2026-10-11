// 自動の経路（委任承認（計画＋Merge）・auto mode・bypass）があるときの、コメントの理由と計画の停止の1行目の書き換え（純粋関数。Issue #717）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoRouteReason, planStopLead, planStopRoute, type AutoRoute } from '../lib/merge-route.ts';

test('autoRouteReason：決まった書き出しだけを経路の呼び名と自動 Merge に置き換え、後ろのファイルの一覧は残す。経路が無い・ほかの理由は入力のまま', () => {
  const cases: [string, AutoRoute | null, string][] = [
    ['ガードレールに触れます（人が Merge する）: a.ts', 'bypass', 'ガードレールに触れます（bypass モードで App が自動 Merge する）: a.ts'],
    ['ガードレールに触れます（人が実装して Merge する）: a.ts', 'delegate', 'ガードレールに触れます（付き添いのセッションで実装する。委任承認（計画＋Merge）が有効なので、合格すれば App が自動 Merge する）: a.ts'],
    ['人が Merge するパスに触れます（humanMergePaths）: p/x.ts', 'autoMode', 'humanMergePaths に触れます（auto modeで App が自動 Merge する）: p/x.ts'],
    ['ガードレールに触れます（人が Merge する）: a.ts', null, 'ガードレールに触れます（人が Merge する）: a.ts'],
    ['Risk レベルが critical', 'bypass', 'Risk レベルが critical'],
  ];
  for (const [reason, route, want] of cases) assert.equal(autoRouteReason(reason, route), want, `${route}: ${reason}`);
});

test('planStopRoute：委任承認（計画＋Merge）で exclude に当たらなければ delegate、そうでなく bypass が有効なら bypass、どちらも無ければ null', () => {
  const cases: [Parameters<typeof planStopRoute>[0], ReturnType<typeof planStopRoute>][] = [
    [{ delegateMergeActive: true, delegateExcluded: false, bypassActive: false }, 'delegate'],
    [{ delegateMergeActive: true, delegateExcluded: true, bypassActive: true }, 'bypass'],
    [{ delegateMergeActive: false, delegateExcluded: false, bypassActive: false }, null],
  ];
  for (const [input, want] of cases) assert.equal(planStopRoute(input), want, JSON.stringify(input));
});

test('planStopLead：経路が無ければ null。経路があれば「人が手元でセッションを立てて」を書かず App が自動 Merge すると書き、planner の停止は人が進めると決めたときの文にする', () => {
  for (const origin of ['gate', 'planner'] as const) assert.equal(planStopLead(null, origin), null, origin);
  for (const origin of ['gate', 'planner'] as const) {
    const lead = planStopLead('bypass', origin);
    assert.ok(lead && !lead.includes('人が手元でセッションを立てて') && lead.includes('App が自動 Merge') && lead.includes('bypass モード'), `${origin}: ${lead}`);
    assert.equal(lead.startsWith('人が進めると決めれば'), origin === 'planner', `${origin}: ${lead}`);
  }
});
