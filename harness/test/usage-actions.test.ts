// Actions の使用分の集計（harness/scripts/actions-usage.ts）のテスト。切り上げ・ワークフロー×ジョブ・ci のきっかけ・期間の分割（Issue #624）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appLogin, loadConfig } from '../lib/config.ts';
import {
  billedMinutes,
  ciTrigger,
  listRunsIn,
  renderActionsUsage,
  summarizeActionsUsage,
  type CiTrigger,
  type UsageJob,
  type UsageRun,
} from '../scripts/actions-usage.ts';

const config = loadConfig();
const APP = appLogin(config);
const BRANCH = `${config.agentBranchPrefix}issue-1-x`;
const START = '2026-10-10T01:00:00Z';
const period = { since: new Date('2026-10-10T00:00:00Z'), until: new Date('2026-10-11T00:00:00Z') };

let nextId = 1;
const run = (p: Partial<UsageRun>): UsageRun => ({
  id: nextId++,
  name: 'ci',
  workflow_id: 1,
  event: 'pull_request',
  head_branch: BRANCH,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  created_at: START,
  actor: { login: 'someone' },
  ...p,
});
const job = (p: Partial<UsageJob> & { seconds?: number }): UsageJob => {
  const { seconds = 60, ...rest } = p;
  return {
    id: nextId++,
    name: 'ci',
    run_id: 0,
    run_attempt: 1,
    conclusion: 'success',
    started_at: START,
    completed_at: new Date(new Date(START).getTime() + seconds * 1000).toISOString(),
    ...rest,
  };
};

test('billedMinutes：ジョブごとに分単位で切り上げ、skipped は 0、未完了は null', () => {
  const cases: [UsageJob, number | null][] = [
    [job({ seconds: 60 }), 1],
    [job({ seconds: 61 }), 2],
    [job({ seconds: 17 }), 1],
    [job({ seconds: 60, conclusion: 'skipped' }), 0],
    [job({ completed_at: null, conclusion: null }), null],
  ];
  for (const [j, want] of cases) assert.equal(billedMinutes(j), want, JSON.stringify(j));
});

test('summarizeActionsUsage：ワークフロー×ジョブごとの分（再実行の前の回を含む）と小計・合計。表にも出る', () => {
  const ci = run({ name: 'ci', run_attempt: 2, actor: { login: 'someone' } });
  const gate = run({ name: 'gate', workflow_id: 2, event: 'pull_request_target' });
  const usage = summarizeActionsUsage(
    config,
    [
      {
        run: ci,
        jobs: [
          job({ name: 'ci', run_id: ci.id, run_attempt: 1, seconds: 30 }),
          job({ name: 'ci', run_id: ci.id, run_attempt: 2, seconds: 61 }),
          job({ name: 'mutation', run_id: ci.id, run_attempt: 2, seconds: 125 }),
          job({ name: 'mutation', run_id: ci.id, run_attempt: 2, completed_at: null, conclusion: null }),
        ],
      },
      {
        run: gate,
        jobs: [job({ name: 'gate', run_id: gate.id, seconds: 17 }), job({ name: 'gate', run_id: gate.id, conclusion: 'skipped' })],
      },
    ],
    period,
  );
  assert.deepEqual(usage.byJob, [
    { workflow: 'ci', job: 'ci', jobs: 2, minutes: 3 },
    { workflow: 'ci', job: 'mutation', jobs: 1, minutes: 3 },
    { workflow: 'gate', job: 'gate', jobs: 1, minutes: 1 },
  ]);
  assert.deepEqual(usage.byWorkflow, [
    { workflow: 'ci', jobs: 3, minutes: 6 },
    { workflow: 'gate', jobs: 1, minutes: 1 },
  ]);
  assert.deepEqual(usage.total, { jobs: 4, minutes: 7 });
  assert.equal(usage.incomplete, 1);

  const md = renderActionsUsage(usage);
  assert.match(md, /\|\s*ci\s*\|\s*mutation\s*\|\s*1\s*\|\s*3\s*\|/);
  assert.match(md, /合計[^\n]*7/);
});

test('ci のきっかけ：ciTrigger の4分類と、summarizeActionsUsage の ciByTrigger（pull_request の実行だけ）', () => {
  const cases: [Partial<UsageRun>, number, CiTrigger][] = [
    [{ actor: { login: APP } }, 1, 'app-main-merge'],
    [{ actor: { login: 'human' } }, 1, 'session-push'],
    [{ actor: { login: 'human' }, head_branch: 'feature/x' }, 1, 'other'],
    [{ actor: { login: 'dependabot[bot]' } }, 1, 'other'],
    [{ actor: null, head_branch: null }, 1, 'other'],
    [{ actor: { login: APP }, run_attempt: 2 }, 2, 'rerun'],
    [{ actor: { login: 'human' }, run_attempt: 2 }, 2, 'rerun'],
  ];
  for (const [r, attempt, want] of cases) assert.equal(ciTrigger(config, run(r), job({ run_attempt: attempt })), want, JSON.stringify(r));

  const app = run({ actor: { login: APP } });
  const session = run({ actor: { login: 'human' } });
  const rerun = run({ actor: { login: 'human' }, head_branch: 'feature/y', run_attempt: 2 });
  const gate = run({ name: 'gate', workflow_id: 2, event: 'pull_request_target', actor: { login: APP } });
  const push = run({ name: 'ci', event: 'push', head_branch: 'main', actor: { login: 'human' } });
  const usage = summarizeActionsUsage(
    config,
    [
      { run: app, jobs: [job({ name: 'ci', run_id: app.id, seconds: 61 }), job({ name: 'mutation', run_id: app.id, seconds: 125 })] },
      { run: session, jobs: [job({ name: 'ci', run_id: session.id, seconds: 30 })] },
      { run: rerun, jobs: [job({ name: 'ci', run_id: rerun.id, run_attempt: 2, seconds: 100 })] },
      { run: gate, jobs: [job({ name: 'gate', run_id: gate.id, seconds: 600 })] },
      { run: push, jobs: [job({ name: 'ci', run_id: push.id, seconds: 600 })] },
    ],
    period,
  );
  assert.equal(usage.ciByTrigger.length, 4);
  const by = Object.fromEntries(usage.ciByTrigger.map(({ trigger, ...rest }) => [trigger, rest]));
  assert.deepEqual(by, {
    'app-main-merge': { runs: 1, jobs: 2, minutes: 5 },
    'session-push': { runs: 1, jobs: 1, minutes: 1 },
    rerun: { runs: 1, jobs: 1, minutes: 2 },
    other: { runs: 0, jobs: 0, minutes: 0 },
  });
});

test('listRunsIn：total_count が 1000 を超える窓は半分に分けて全件を集める', async () => {
  const full = period.until.getTime() - period.since.getTime();
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    const m = /created=([^&]+)/.exec(decodeURIComponent(path));
    assert.ok(m, path);
    const [from, to] = m[1]!.split('..').map((s) => new Date(s).getTime()) as [number, number];
    const total = to - from > full * 0.75 ? 1500 : 750;
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? '1');
    const count = Math.max(0, Math.min(100, total - (page - 1) * 100));
    return {
      total_count: total,
      workflow_runs: Array.from({ length: count }, (_, i) => run({ id: from / 1000 + (page - 1) * 100 + i })),
    };
  };
  const { runs, truncated } = await listRunsIn(get, 1, period.since, period.until);
  assert.equal(truncated, false);
  assert.equal(runs.length, 1500);
  assert.equal(new Set(runs.map((r) => r.id)).size, 1500);
  assert.ok(paths.every((p) => p.includes('/actions/workflows/1/runs')), paths.join('\n'));
});
