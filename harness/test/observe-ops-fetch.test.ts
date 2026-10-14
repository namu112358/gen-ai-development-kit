// Issue #701：運用の健康 14 項目の材料を GitHub の GET と git から読む（lib/observe-ops.ts の collectOpsHealth・readWorktrees）。偽の GitHub で 14 項目の順・1経路の失敗・worktree を読めないとき・GET の上限、git の砂場で worktree の読みを確かめる。GitHub には GET しか呼ばないことも見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitHub, HttpError } from '../lib/github.ts';
import { collectOpsHealth, readWorktrees, type WorktreeEntry } from '../lib/observe-ops.ts';
import { OPS_HEALTH_DEFAULTS, OPS_ITEM_IDS, type OpsItemId } from '../lib/ops-health.ts';
import { config, FakeGitHub, HEAD, planGateComment, pr, verdictComment } from './support/gate-fixtures.ts';
import { sandbox } from './support/git-sandbox.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const GATE = '.github/workflows/gate.yml';
const CI = '.github/workflows/ci.yml';

const run = (id: number, minutesAgo: number, patch: Record<string, unknown> = {}) => ({
  id, event: 'pull_request', status: 'completed', conclusion: 'success', path: GATE, created_at: ago(minutesAgo), updated_at: ago(minutesAgo - 1),
  display_title: 't', pull_requests: [{ number: 5 }], ...patch,
});

/** 14 項目の材料：schedule・失敗したゲート（ログを読む）・完了した ci（ジョブを読む）・開いた Agent PR・開いた Issue（plan-ok で待つ・Epic・計画の無いもの）・Close 済みの Issue の worktree */
function world(): FakeGitHub {
  const agentPr = pr({ number: 5, draft: false, created_at: ago(300), body: 'Closes #3', head: { ref: 'claude/issue-3-x', sha: HEAD, repo: { full_name: 'o/r' } } });
  return new FakeGitHub()
    .on('GET', /\/actions\/runs\?/, () => ({
      workflow_runs: [
        run(1, 600, { event: 'schedule', pull_requests: [] }),
        run(2, 60, { event: 'schedule', pull_requests: [] }),
        run(11, 120, { conclusion: 'failure' }),
        run(21, 90, { path: CI }),
      ],
    }))
    .on('GET', /\/actions\/runs\/(\d+)\/jobs/, (m) => ({
      jobs: [{ id: Number(m[1]) * 10, run_id: Number(m[1]), name: 'test', status: 'completed', conclusion: m[1] === '11' ? 'failure' : 'success', started_at: ago(90), completed_at: ago(85) }],
    }))
    .on('GET', /\/actions\/jobs\/\d+\/logs/, () => 'Error: API rate limit exceeded for installation')
    .on('GET', /\/pulls\?.*state=open/, () => [agentPr])
    .on('GET', /\/issues\/\d+\/comments/, (m) => (m[0].includes('/issues/9/') ? [planGateComment] : [verdictComment({ pr: 5 })]))
    .on('GET', /\/issues\/\d+\/timeline/, () => [{ event: 'ready_for_review', created_at: ago(200) }])
    .on('GET', /\/commits\/[0-9a-f]+$/, () => ({ commit: { committer: { date: ago(600) } } }))
    .on('GET', /\/compare\//, () => 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n')
    .on('GET', /\/issues\?.*state=open/, () => [
      { number: 1, title: config.dashboardIssueTitle, labels: [], user: { login: 'app' } },
      { number: 3, title: 'feat: 3', labels: [{ name: 'agent:plan-ok' }] },
      { number: 5, title: 'docs: t', labels: [], pull_request: {} },
      { number: 9, title: 'feat: 9', labels: [{ name: 'agent:plan-ok' }] },
      { number: 10, title: 'Epic', labels: [{ name: 'epic' }], sub_issues_summary: { total: 2, completed: 2, percent_completed: 100 } },
      { number: 12, title: 'feat: 12', labels: [] },
      { number: 13, title: 'feat: 13', labels: [{ name: 'agent:plan-review' }] },
    ])
    .on('GET', /\/issues\/\d+\/parent$/, () => ({ number: 691, title: 'Epic' }))
    .on('GET', /\/issues\/(\d+)$/, (m) => ({ number: Number(m[1]), title: 'old', state: 'closed', labels: [] }));
}

const WORKTREES: WorktreeEntry[] = [
  { path: '/w/issue-3', branch: 'claude/issue-3-x', dirty: false },
  { path: '/w/issue-40', branch: 'claude/issue-40-old', dirty: true },
  { path: '/w/detached', branch: null, dirty: false },
];

const collect = (fake: FakeGitHub, opts: { worktrees?: WorktreeEntry[] | null; maxGets?: number } = {}) =>
  collectOpsHealth(new GitHub(fake, 'o/r'), {
    config, now: NOW, thresholds: opts.maxGets === undefined ? OPS_HEALTH_DEFAULTS : { ...OPS_HEALTH_DEFAULTS, maxGets: opts.maxGets },
    worktrees: opts.worktrees === undefined ? WORKTREES : opts.worktrees,
  });

const unavailable = (items: { id: OpsItemId; available: boolean }[]) => items.filter((i) => !i.available).map((i) => i.id);
const onlyGets = (fake: FakeGitHub) => assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET'), [], 'GitHub には GET しか呼ばない');

test('14 項目が OPS_ITEM_IDS の順で出て、実行の一覧の失敗は項目 1〜5 だけ、worktrees が null なら項目 12 だけが読めない', async () => {
  const ok = world();
  const all = await collect(ok);
  assert.deepEqual(all.items.map((i) => i.id), [...OPS_ITEM_IDS]);
  assert.deepEqual(unavailable(all.items), []);
  assert.equal(all.gets, ok.calls.length);
  assert.equal(all.maxGets, OPS_HEALTH_DEFAULTS.maxGets);
  assert.equal(all.since, new Date(NOW.getTime() - 24 * 3_600_000).toISOString());
  onlyGets(ok);

  const runsFail = world().on('GET', /\/actions\/runs\?/, () => { throw new HttpError(500, 'GET /actions/runs -> 500: boom'); });
  const failed = await collect(runsFail);
  assert.deepEqual(failed.items.map((i) => i.id), [...OPS_ITEM_IDS]);
  assert.deepEqual(unavailable(failed.items), ['schedule-gap', 'rate-limit', 'failed-gate', 'gate-runs', 'ci-load']);
  onlyGets(runsFail);

  const noWt = world();
  const withoutWorktrees = await collect(noWt, { worktrees: null });
  assert.deepEqual(unavailable(withoutWorktrees.items), ['stale-worktree']);
  onlyGets(noWt);
});

test('maxGets を 3 にすると GET は 3 回で止まり、4 回目以後の読みに頼る項目だけが読めない', async () => {
  const fake = world();
  const r = await collect(fake, { maxGets: 3 });
  // 読む順：実行の一覧 → 開いた PR → 開いた Issue（ここまでの 3 回）→ PR ごとのコメント・timeline・ログ・ジョブ・plan-ok の Issue のコメント・parent・Issue
  assert.equal(fake.calls.length, 3);
  assert.equal(r.gets, 3);
  assert.equal(r.maxGets, 3);
  assert.deepEqual(r.items.map((i) => i.id), [...OPS_ITEM_IDS]);
  assert.deepEqual(unavailable(r.items), ['rate-limit', 'ci-load', 'pr-stall', 'requeue', 'stalled-claim', 'epic-drift', 'stale-worktree', 'area-full', 'review-panel']);
  onlyGets(fake);
});

test('readWorktrees は本体を除いた worktree と、commit されていない変更の有無とブランチを返す', (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const clean = join(s.dir, 'wt-clean');
  const dirty = join(s.dir, 'wt-dirty');
  s.git(s.root, 'worktree', 'add', '-q', '-b', 'claude/issue-1-clean', clean);
  s.git(s.root, 'worktree', 'add', '-q', '-b', 'claude/issue-2-dirty', dirty);
  writeFileSync(join(dirty, 'a.txt'), 'changed\n');
  const runGit = (args: string[], cwd?: string): string => {
    const r = spawnSync('git', args, { cwd: cwd ?? s.root, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };

  const found = readWorktrees(runGit);
  assert.equal(found.length, 2);
  const byBranch = new Map(found.map((w) => [w.branch, w]));
  assert.equal(byBranch.get('claude/issue-1-clean')?.dirty, false);
  assert.equal(byBranch.get('claude/issue-2-dirty')?.dirty, true);
  assert.ok(byBranch.get('claude/issue-1-clean')?.path.endsWith('wt-clean'));
  assert.ok(byBranch.get('claude/issue-2-dirty')?.path.endsWith('wt-dirty'));
});
