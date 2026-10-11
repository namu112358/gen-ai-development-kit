/**
 * Actions の使用分（ジョブごとに分単位で切り上げた分）を、ワークフロー・ジョブ・ci のきっかけごとに数える（読むだけ、Issue #624）。
 *
 *   node harness/scripts/actions-usage.ts <owner/repo> [days=1]
 *
 * 数え方：ジョブごとに completed_at − started_at を分単位で切り上げる（private のリポジトリの課金と同じ）。
 * skipped のジョブ・走った時間が 0 秒以下のジョブは数えず、終わっていないジョブは件数だけ「未完了」として出す。
 * 再実行の前の回（run_attempt が前のもの）のジョブも数える（前の回も課金されるため）。
 * pull_request の実行（ci）は、きっかけ（App の main の取り込み・セッションの push・再実行・そのほか）ごとにも分ける。
 * ジョブの時刻からの見積もりで、請求額ではない（料金は出さない。請求は GitHub の Billing を見る）。
 * GitHub は gh の認証で読むだけで、GitHub にもリポジトリにも書かない。実行1件ごとにジョブの一覧を読むので、長い期間は API を多く使う。
 * 関数は export し、CLI は `import.meta.main` の中だけで動く（テストは関数を import する）。
 */
import { appLogin, loadConfig, type HarnessConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';

export interface UsageRun {
  id: number;
  name: string;
  workflow_id: number;
  event: string;
  head_branch: string | null;
  run_attempt: number;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  actor?: { login: string } | null;
}

export interface UsageJob {
  id: number;
  name: string;
  run_id: number;
  run_attempt: number;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export type CiTrigger = 'app-main-merge' | 'session-push' | 'rerun' | 'other';
const CI_TRIGGERS: CiTrigger[] = ['app-main-merge', 'session-push', 'rerun', 'other'];
const CI_TRIGGER_LABEL: Record<CiTrigger, string> = {
  'app-main-merge': 'App の main の取り込み',
  'session-push': 'セッションの push',
  rerun: '再実行',
  other: 'そのほか',
};

export interface UsageRecord {
  run: UsageRun;
  jobs: UsageJob[];
}

export interface ActionsUsage {
  period: { since: string; until: string };
  byJob: { workflow: string; job: string; jobs: number; minutes: number }[];
  byWorkflow: { workflow: string; jobs: number; minutes: number }[];
  total: { jobs: number; minutes: number };
  ciByTrigger: { trigger: CiTrigger; runs: number; jobs: number; minutes: number }[];
  incomplete: number;
  truncated: string[];
}

/** ジョブの課金の分。skipped・0 秒以下は 0、未完了は null、それ以外は分単位で切り上げ */
export function billedMinutes(job: UsageJob): number | null {
  if (job.conclusion === 'skipped') return 0;
  if (!job.completed_at) return null;
  if (!job.started_at) return 0;
  const ms = new Date(job.completed_at).getTime() - new Date(job.started_at).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 60_000);
}

/** pull_request の実行のジョブのきっかけ。上から順に当てる：再実行 → App の取り込み → セッションの push → そのほか */
export function ciTrigger(config: HarnessConfig, run: UsageRun, job: UsageJob): CiTrigger {
  if ((job.run_attempt ?? 1) >= 2) return 'rerun';
  const login = run.actor?.login ?? '';
  if (login && login === appLogin(config)) return 'app-main-merge';
  if (login && !login.endsWith('[bot]') && (run.head_branch ?? '').startsWith(config.agentBranchPrefix)) return 'session-push';
  return 'other';
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function summarizeActionsUsage(config: HarnessConfig, records: UsageRecord[], period: { since: Date; until: Date }, truncated: string[] = []): ActionsUsage {
  const jobs = new Map<string, { workflow: string; job: string; jobs: number; minutes: number }>();
  const workflows = new Map<string, { workflow: string; jobs: number; minutes: number }>();
  const ci = new Map<CiTrigger, { runs: Set<number>; jobs: number; minutes: number }>(CI_TRIGGERS.map((t) => [t, { runs: new Set(), jobs: 0, minutes: 0 }]));
  const total = { jobs: 0, minutes: 0 };
  let incomplete = 0;
  for (const { run, jobs: list } of records) {
    for (const j of list) {
      const minutes = billedMinutes(j);
      if (minutes === null) {
        incomplete++;
        continue;
      }
      if (minutes <= 0) continue;
      const key = JSON.stringify([run.name, j.name]);
      const row = jobs.get(key) ?? { workflow: run.name, job: j.name, jobs: 0, minutes: 0 };
      row.jobs++;
      row.minutes += minutes;
      jobs.set(key, row);
      const wf = workflows.get(run.name) ?? { workflow: run.name, jobs: 0, minutes: 0 };
      wf.jobs++;
      wf.minutes += minutes;
      workflows.set(run.name, wf);
      total.jobs++;
      total.minutes += minutes;
      if (run.event === 'pull_request') {
        const t = ci.get(ciTrigger(config, run, j))!;
        t.runs.add(run.id);
        t.jobs++;
        t.minutes += minutes;
      }
    }
  }
  return {
    period: { since: period.since.toISOString(), until: period.until.toISOString() },
    byJob: [...jobs.values()].sort((a, b) => byName(a.workflow, b.workflow) || byName(a.job, b.job)),
    byWorkflow: [...workflows.values()].sort((a, b) => byName(a.workflow, b.workflow)),
    total,
    ciByTrigger: CI_TRIGGERS.map((trigger) => {
      const t = ci.get(trigger)!;
      return { trigger, runs: t.runs.size, jobs: t.jobs, minutes: t.minutes };
    }),
    incomplete,
    truncated,
  };
}

const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
/** GitHub が絞り込みで返す上限 */
const SEARCH_LIMIT = 1000;
const MAX_PAGES = 10;
const MIN_SPLIT_MS = 2 * 60_000;

type RunsPage = { total_count?: number; workflow_runs?: UsageRun[] } | null;

/**
 * ワークフローの、created が期間内の実行を集める。1ページ目の total_count が 1000 を超え、窓が 2 分以上なら、
 * 窓を中点で半分に分けて（後ろの窓は中点 +1 秒から）読み直す（分ける前の窓の1ページ目は結果に入れない）。
 * 分けられない窓で 1000 を超えたら、読める分だけ集めて truncated を true にする。
 */
export async function listRunsIn(get: (path: string) => Promise<RunsPage>, workflowId: number, since: Date, until: Date): Promise<{ runs: UsageRun[]; truncated: boolean }> {
  const base = `/actions/workflows/${workflowId}/runs?created=${isoSeconds(since)}..${isoSeconds(until)}&per_page=100`;
  const first = await get(`${base}&page=1`);
  const width = until.getTime() - since.getTime();
  if ((first?.total_count ?? 0) > SEARCH_LIMIT && width >= MIN_SPLIT_MS) {
    const mid = new Date(Math.floor((since.getTime() + width / 2) / 1000) * 1000);
    const a = await listRunsIn(get, workflowId, since, mid);
    const b = await listRunsIn(get, workflowId, new Date(mid.getTime() + 1000), until);
    return { runs: [...a.runs, ...b.runs], truncated: a.truncated || b.truncated };
  }
  const runs: UsageRun[] = [];
  let list = first?.workflow_runs ?? [];
  runs.push(...list);
  let page = 1;
  while (list.length >= 100 && page < MAX_PAGES) {
    page++;
    list = (await get(`${base}&page=${page}`))?.workflow_runs ?? [];
    runs.push(...list);
  }
  return { runs, truncated: (first?.total_count ?? 0) > SEARCH_LIMIT || list.length >= 100 };
}

async function jobsOfRun(gh: GitHub, runId: number): Promise<UsageJob[]> {
  const out: UsageJob[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await gh.get<{ jobs?: UsageJob[] }>(`/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`);
    const list = res?.jobs ?? [];
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** 期間の実行とジョブを GitHub から読んで数える（読むだけ） */
export async function collectActionsUsage(gh: GitHub, config: HarnessConfig, period: { since: Date; until: Date }): Promise<ActionsUsage> {
  const truncated: string[] = [];
  const records: UsageRecord[] = [];
  let unreadable = 0;
  const workflows = (await gh.get<{ workflows?: { id: number; name: string }[] }>('/actions/workflows?per_page=100'))?.workflows ?? [];
  for (const wf of workflows) {
    const { runs, truncated: cut } = await listRunsIn((p) => gh.get<RunsPage>(p), wf.id, period.since, period.until);
    if (cut) truncated.push(`${wf.name}（実行 ${runs.length} 件で打ち切り）`);
    for (const r of runs) {
      // 実行ごと skipped（ジョブがすべて skipped）は、ジョブを読まない（API を節約する）
      if (r.conclusion === 'skipped') continue;
      try {
        records.push({ run: { ...r, name: wf.name }, jobs: await jobsOfRun(gh, r.id) });
      } catch {
        unreadable++;
      }
    }
  }
  if (unreadable > 0) truncated.push(`ジョブを読めなかった実行 ${unreadable} 件`);
  return summarizeActionsUsage(config, records, period, truncated);
}

export function renderActionsUsage(usage: ActionsUsage): string {
  const lines: string[] = [
    '## Actions の使用分',
    '',
    `期間：${usage.period.since} 〜 ${usage.period.until}`,
    '',
    `合計：${usage.total.minutes} 分（ジョブ ${usage.total.jobs} 件）`,
    '',
    '### ワークフロー×ジョブ',
    '',
    '| ワークフロー | ジョブ | ジョブ数 | 分 |',
    '| --- | --- | ---: | ---: |',
    ...usage.byJob.map((r) => `| ${r.workflow} | ${r.job} | ${r.jobs} | ${r.minutes} |`),
    '',
    '### ワークフローの小計',
    '',
    '| ワークフロー | ジョブ数 | 分 |',
    '| --- | ---: | ---: |',
    ...usage.byWorkflow.map((r) => `| ${r.workflow} | ${r.jobs} | ${r.minutes} |`),
    `| 合計 | ${usage.total.jobs} | ${usage.total.minutes} |`,
    '',
    '### ci（pull_request の実行）のきっかけ',
    '',
    '| きっかけ | 実行数 | ジョブ数 | 分 |',
    '| --- | ---: | ---: | ---: |',
    ...usage.ciByTrigger.map((r) => `| ${CI_TRIGGER_LABEL[r.trigger]} | ${r.runs} | ${r.jobs} | ${r.minutes} |`),
    '',
  ];
  if (usage.incomplete > 0) lines.push(`未完了のジョブ：${usage.incomplete} 件（数えていない）`, '');
  if (usage.truncated.length > 0) lines.push(`打ち切り：${usage.truncated.join('、')}`, '');
  lines.push('ジョブの時刻からの見積もり。請求額は GitHub の Billing を見る。');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const [repository, daysArg] = process.argv.slice(2);
  if (!repository) {
    console.error('usage: node harness/scripts/actions-usage.ts <owner/repo> [days=1]');
    process.exit(1);
  }
  const days = Number(daysArg ?? 1);
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`days は正の数にしてください: ${daysArg}`);
    process.exit(1);
  }
  const config = loadConfig();
  const until = new Date();
  const since = new Date(until.getTime() - days * 86400_000);
  const usage = await collectActionsUsage(new GitHub(transportFromEnv(), repository), config, { since, until });
  console.log(renderActionsUsage(usage));
}

if (import.meta.main) await main();
