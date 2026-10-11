// Issue #690：運用の健康 14 項目の判定・読めない欄・しきい値の上書き・GitHub を読む数の上限・前回との比べ（lib/ops-health.ts）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub } from '../lib/github.ts';
import {
  budgetedGitHub, GetBudgetError, increasedItems, judgeOpsHealth, OPS_HEALTH_DEFAULTS, OPS_ITEM_IDS, opsHealthThresholds,
  type OpsHealthInput, type OpsItem, type OpsItemId,
} from '../lib/ops-health.ts';
import type { Claim } from '../lib/queue.ts';
import type { PullRequest } from '../lib/state.ts';
import { config, FakeGitHub, pr } from './support/gate-fixtures.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const REF = { number: 5, title: 't', html_url: 'u' };
const run = (minutesAgo: number, patch: Record<string, unknown> = {}) => ({
  id: minutesAgo, event: 'pull_request', status: 'completed', conclusion: 'success', created_at: ago(minutesAgo), updated_at: ago(minutesAgo),
  display_title: 't', pull_requests: [{ number: 5 }], ...patch,
});
/** since（24 時間前）から now まで step 分ごとの schedule の実行 */
const every = (step: number) => Array.from({ length: 1440 / step + 1 }, (_, i) => run(i * step, { event: 'schedule', pull_requests: [] }));
const claim = (minutesAgo: number): Claim => ({ by: 'manual', at: ago(minutesAgo), session: '38ab2367-aaaa', stage: 'judge' });
const verdict = (association: string) => ({ body: '```agent-verdict\n{}\n```', author_association: association, created_at: ago(10) });
const areaConfig = { ...config, areaConcurrency: { harness: 1 } };
const draftAgentPr = pr({ number: 20, draft: true, labels: [{ name: 'area:harness' }], head: { ref: 'claude/issue-20-x', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } } }) as unknown as PullRequest;
const area = (waitedMinutes: number) => ({ config: areaConfig, repository: 'o/r', openPrs: [draftAgentPr], waiting: [{ issue: 9, files: ['harness/lib/queue.ts'], since: ago(waitedMinutes) }] });

/** すべての欄が空の材料（読めた・何も無い） */
function base(): OpsHealthInput {
  return {
    since: new Date(NOW.getTime() - 24 * 3_600_000), scheduleRuns: [], rateLimitLogs: { logs: [], unread: 0 }, gateRuns: [],
    ci: { runs: [], jobs: [] }, prs: [], requeue: [], claims: { stalled: [], unclaimed: [] }, planBacklog: { planReview: 0, unplanned: 0 },
    epicDrift: { closedEpics: [], orphanIssues: [] }, links: [], worktrees: [], area: { config: areaConfig, repository: 'o/r', openPrs: [], waiting: [] },
    reviewPanel: { records: [], verdicts: [] },
  } as unknown as OpsHealthInput;
}
const judge = (patch: Record<string, unknown>, t = OPS_HEALTH_DEFAULTS) => judgeOpsHealth({ ...base(), ...patch } as OpsHealthInput, t, NOW);
const item = (items: OpsItem[], id: OpsItemId) => items.find((i) => i.id === id)!;

test('項目 1〜14：既定のしきい値の境目を超える材料では exceeded が true、超えない材料では false', () => {
  const cases: { id: OpsItemId; name: string; hit: Record<string, unknown>; miss: Record<string, unknown> }[] = [
    { id: 'schedule-gap', name: '間隔 90 分・80 分', hit: { scheduleRuns: every(90) }, miss: { scheduleRuns: every(80) } },
    { id: 'rate-limit', name: 'ログに上限の文', hit: { rateLimitLogs: { logs: ['x API rate limit exceeded for installation'], unread: 0 } }, miss: { rateLimitLogs: { logs: ['ok'], unread: 0 } } },
    {
      id: 'failed-gate', name: '失敗のまま 60 分（別の対象の成功では消えない）・すぐ後に同じ対象が成功',
      hit: { gateRuns: [run(60, { conclusion: 'failure' }), run(30, { pull_requests: [{ number: 6 }] })] },
      miss: { gateRuns: [run(120, { conclusion: 'failure' }), run(119)] },
    },
    { id: 'gate-runs', name: '1 日 600 回・599 回', hit: { gateRuns: Array.from({ length: 600 }, () => run(10)) }, miss: { gateRuns: Array.from({ length: 599 }, () => run(10)) } },
    {
      id: 'ci-load', name: 'ジョブ 10 分・9 分',
      hit: { ci: { runs: [], jobs: [{ run_id: 1, name: 'test', started_at: ago(20), completed_at: ago(10) }] } },
      miss: { ci: { runs: [], jobs: [{ run_id: 1, name: 'test', started_at: ago(20), completed_at: ago(11) }, { run_id: 2, name: 'test', started_at: ago(60), completed_at: null }] } },
    },
    {
      id: 'ci-load', name: '同じ PR の ci の実行が重なる・重ならない',
      hit: { ci: { runs: [run(30, { updated_at: ago(20) }), run(25, { updated_at: ago(15) })], jobs: [] } },
      miss: { ci: { runs: [run(30, { updated_at: ago(20) }), run(19, { updated_at: ago(15) })], jobs: [] } },
    },
    {
      id: 'pr-stall', name: 'Ready のまま 2 時間・1 時間 59 分',
      hit: { prs: [{ pr: 5, draft: false, createdAt: ago(130), readyAt: ago(120) }] }, miss: { prs: [{ pr: 5, draft: false, createdAt: ago(130), readyAt: ago(119) }] },
    },
    {
      id: 'pr-stall', name: '開いてから 24 時間・23 時間 59 分（Draft のまま）',
      hit: { prs: [{ pr: 5, draft: true, createdAt: ago(1440), readyAt: null }] }, miss: { prs: [{ pr: 5, draft: true, createdAt: ago(1439), readyAt: null }] },
    },
    {
      id: 'requeue', name: 'Draft に戻す 2 回・1 回と判定 2 回（コラボレーター以外の判定は数えない）',
      hit: { requeue: [{ pr: 5, timeline: [{ event: 'convert_to_draft' }, { event: 'convert_to_draft' }], comments: [] }] },
      miss: { requeue: [{ pr: 5, timeline: [{ event: 'convert_to_draft' }], comments: [verdict('OWNER'), verdict('COLLABORATOR'), verdict('NONE')] }] },
    },
    {
      id: 'stalled-claim', name: 'judge の宣言から 61 分・59 分',
      hit: { claims: { stalled: [{ pr: REF, claim: claim(61), headCommitAt: ago(180) }], unclaimed: [] } },
      miss: { claims: { stalled: [{ pr: REF, claim: claim(59), headCommitAt: ago(180) }], unclaimed: [] } },
    },
    { id: 'plan-backlog', name: 'plan-review 5 件・4 件', hit: { planBacklog: { planReview: 5, unplanned: 0 } }, miss: { planBacklog: { planReview: 4, unplanned: 9 } } },
    { id: 'plan-backlog', name: '計画の無い Issue 10 件', hit: { planBacklog: { planReview: 0, unplanned: 10 } }, miss: { planBacklog: { planReview: 0, unplanned: 0 } } },
    { id: 'epic-drift', name: '子が全部 Close の Epic 1 件', hit: { epicDrift: { closedEpics: [417], orphanIssues: [] } }, miss: { epicDrift: { closedEpics: [], orphanIssues: [] } } },
    { id: 'epic-drift', name: 'Epic の子でない Agent PR の Issue 1 件', hit: { epicDrift: { closedEpics: [], orphanIssues: [8] } }, miss: {} },
    {
      id: 'link-mismatch', name: 'Closes が紐付けに無い・ある（紐付けを読めない PR は数えない）',
      hit: { links: [{ pr: 5, body: 'Closes #3', linked: [] }] },
      miss: { links: [{ pr: 5, body: 'Closes #3', linked: [3] }, { pr: 6, body: 'Closes #4', linked: null }] },
    },
    { id: 'stale-worktree', name: 'Close 済み', hit: { worktrees: [{ path: '/w/a', closed: true, dirty: false }] }, miss: { worktrees: [{ path: '/w/a', closed: false, dirty: false }] } },
    { id: 'stale-worktree', name: 'commit されていない変更', hit: { worktrees: [{ path: '/w/a', closed: false, dirty: true }] }, miss: {} },
    { id: 'area-full', name: '上限の領域で 60 分・59 分待つ', hit: { area: area(60) }, miss: { area: area(59) } },
    {
      id: 'review-panel', name: '記録の後に判定が無い・ある（記録より前の判定は当たらない）',
      hit: { reviewPanel: { records: [{ pr: 5, head: 'a', at: ago(30) }], verdicts: [{ pr: 5, head: 'a', at: ago(40) }, { pr: 5, head: 'b', at: ago(20) }] } },
      miss: { reviewPanel: { records: [{ pr: 5, head: 'a', at: ago(30) }], verdicts: [{ pr: 5, head: 'a', at: ago(20) }] } },
    },
  ];
  assert.deepEqual([...new Set(cases.map((c) => c.id))], [...OPS_ITEM_IDS]);
  for (const c of cases) {
    for (const [patch, want] of [[c.hit, true], [c.miss, false]] as const) {
      const got = item(judge(patch), c.id);
      assert.equal(got.available, true, `${c.id} ${c.name}`);
      assert.equal(got.available && got.exceeded, want, `${c.id} ${c.name}（${want ? '超える' : '超えない'}）`);
    }
  }
});

test('読めない欄は、その項目だけ available: false になり、ほかの項目は判定される', () => {
  const items = judge({ worktrees: { available: false, reason: '読めない' } });
  assert.deepEqual(items.map((i) => i.id), [...OPS_ITEM_IDS]);
  for (const i of items) assert.equal(i.available, i.id !== 'stale-worktree', i.id);
});

test('しきい値の上書き：undefined のキーは無視し、上書きしたキーの項目の threshold だけが変わる', () => {
  const t = opsHealthThresholds({ gateRunsPerDay: 5, ciJobMinutes: undefined });
  assert.deepEqual(t, { ...OPS_HEALTH_DEFAULTS, gateRunsPerDay: 5 });
  const before = judge({}), after = judge({}, t);
  for (const id of OPS_ITEM_IDS) {
    const [b, a] = [item(before, id), item(after, id)];
    assert.ok(a.available && b.available);
    assert.equal(a.threshold, id === 'gate-runs' ? 5 : b.threshold, id);
  }
});

test('budgetedGitHub：上限を超える GET は呼ばずに GetBudgetError、GET 以外は数えずに呼ばない', async () => {
  const fake = new FakeGitHub().on('GET', /^\/repos\/o\/r\/x/, () => ({ ok: true }));
  const { gh, used } = budgetedGitHub(new GitHub(fake, 'o/r'), 2);
  await gh.get('/x');
  await gh.get('/x');
  assert.equal(used(), 2);
  await assert.rejects(gh.get('/x'), (e: unknown) => e instanceof GetBudgetError && e.max === 2);
  assert.equal(fake.calls.length, 2);
  const fresh = budgetedGitHub(new GitHub(fake, 'o/r'), 2);
  await assert.rejects(fresh.gh.graphql('query { viewer { login } }'));
  await assert.rejects(fresh.gh.request('POST', '/issues/1/comments', { body: { body: 'x' } }));
  assert.equal(fresh.used(), 0);
  assert.deepEqual(fake.calls.map((c) => c.method), ['GET', 'GET']);
});

test('increasedItems：どちらも読めた同じ項目で値が増えたものだけを今回の順に返す', () => {
  const ok = (id: OpsItemId, value: number): OpsItem => ({ id, title: id, available: true, value, threshold: 1, exceeded: false, evidence: [] });
  const ng = (id: OpsItemId): OpsItem => ({ id, title: id, available: false, reason: 'x' });
  const previous = [ok('schedule-gap', 1), ok('rate-limit', 0), ok('gate-runs', 5), ng('ci-load'), ok('requeue', 3), ok('stale-worktree', 2)];
  const current = [ok('rate-limit', 2), ok('schedule-gap', 4), ok('gate-runs', 5), ok('ci-load', 9), ok('pr-stall', 9), ok('requeue', 1), ng('stale-worktree')];
  assert.deepEqual(increasedItems(previous, current), [
    { id: 'rate-limit', previous: 0, current: 2 },
    { id: 'schedule-gap', previous: 1, current: 4 },
  ]);
  assert.deepEqual(increasedItems(null, current), []);
  assert.deepEqual(increasedItems(undefined, current), []);
});
