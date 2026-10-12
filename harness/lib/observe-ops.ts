import { extractBlock, hasClaudeMark } from './blocks.ts';
import { LABELS, type HarnessConfig } from './config.ts';
import { claimActivityAt, claimOf } from './facts.ts';
import type { GitHub, IssueComment } from './github.ts';
import { patchId } from './patch-id.ts';
import { jobsOf } from './qa-retro.ts';
import { stalledCandidate, type StalledClaimInput } from './stalled-claim.ts';
import {
  acceptanceForPatch, hasLabel, isAgentPr, isHarnessIssueTitle, isSameRepoPr, isTrustedComment, latestPlanGate, prDiff, timeline,
  type PullRequest, type TimelineEvent,
} from './state.ts';
import type { Unavailable } from './test-health.ts';
import { unclaimedJudgeCandidate, type UnclaimedJudgeInput } from './unclaimed-judge.ts';
import {
  budgetedGitHub, GetBudgetError, judgeOpsHealth, type AreaWaitInput, type CiJob, type LinkInput, type OpsHealthInput, type OpsHealthThresholds,
  type OpsItem, type OpsPr, type OpsRun, type PanelRun, type RequeueInput, type WorktreeInput,
} from './ops-health.ts';

/**
 * 運用の健康 14 項目の材料を GitHub の GET と git から読み、judgeOpsHealth に渡して判定を返す（Epic #691、Issue #701）。
 * GitHub は budgetedGitHub を通した GET だけで、上限（thresholds.maxGets）に達したら以後の読みを呼ばず、その読みに頼る項目を読めない扱いにする。
 * 読みの誤りは、その読みに頼る項目だけを読めない扱いにする（一部だけの材料で「超えていない」と出さない）。観測の入口（observe.ts）は兄弟の子課題。
 */

/** 本体を除いた worktree 1つ。dirty は commit されていない変更がある */
export interface WorktreeEntry { path: string; branch: string | null; dirty: boolean }

export interface OpsHealthCollection { since: string; gets: number; maxGets: number; items: OpsItem[]; notes: string[] }

const MAX_RUN_PAGES = 10;
const MAX_LOG_RUNS = 10;
const GATE_PATH = '.github/workflows/gate.yml';
const BRANCH_ISSUE = /^claude\/issue-(\d+)-/;

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);
const isUnavailable = (x: unknown): x is Unavailable => typeof x === 'object' && x !== null && !Array.isArray(x) && (x as { available?: unknown }).available === false;
const newest = <T extends { created_at: string }>(xs: T[]): T[] => [...xs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, MAX_LOG_RUNS);
const issueOfBranch = (ref: string): number | null => { const m = ref.match(BRANCH_ISSUE); return m ? Number(m[1]) : null; };

/** git の引数だけを受ける run で、本体を除いた worktree と commit されていない変更の有無を読む */
export function readWorktrees(run: (args: string[], cwd?: string) => string): WorktreeEntry[] {
  const blocks = run(['worktree', 'list', '--porcelain']).replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b !== '');
  return blocks.slice(1).flatMap((block) => {
    const lines = block.split('\n');
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (path === undefined) return [];
    const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length) ?? null;
    return [{ path, branch: ref === null ? null : ref.replace(/^refs\/heads\//, ''), dirty: run(['status', '--porcelain'], path).trim() !== '' }];
  });
}

type OpenPr = PullRequest & { created_at: string };
type RunRow = OpsRun & { path?: string };
type OpenIssue = { number: number; title: string; labels: { name: string }[]; pull_request?: unknown; sub_issues_summary?: { total: number; completed: number } };
type PerPr = { pr: OpenPr; comments: IssueComment[]; events: TimelineEvent[] };

export async function collectOpsHealth(
  gh: GitHub,
  opts: { config: HarnessConfig; now: Date; thresholds: OpsHealthThresholds; worktrees: WorktreeEntry[] | null },
): Promise<OpsHealthCollection> {
  const { config, now, thresholds, worktrees } = opts;
  const budget = budgetedGitHub(gh, thresholds.maxGets);
  const g = budget.gh;
  const repository = `${gh.owner}/${gh.repo}`;
  const since = new Date(now.getTime() - 24 * 3_600_000);
  const notes: string[] = [];
  let stop: Unavailable | null = null;

  /** 上限に達した後は呼ばずに上限の理由を返す。誤りは Unavailable にする */
  async function attempt<T>(read: () => Promise<T>): Promise<T | Unavailable> {
    if (stop !== null) return stop;
    try {
      return await read();
    } catch (e) {
      const u: Unavailable = { available: false, reason: e instanceof GetBudgetError ? e.message : `GitHub を読めません：${reasonOf(e)}` };
      if (e instanceof GetBudgetError) stop = u;
      return u;
    }
  }
  /** 前提の読みが Unavailable ならそれを返し、そうでなければ read する */
  const after = async <A, T>(dep: A | Unavailable, read: (a: A) => Promise<T>): Promise<T | Unavailable> => (isUnavailable(dep) ? dep : attempt(() => read(dep)));
  const firstUnavailable = (...xs: unknown[]): Unavailable | null => xs.find(isUnavailable) ?? null;

  // 1. 実行の一覧
  const runs = await attempt(async () => {
    const out: RunRow[] = [];
    for (let page = 1; page <= MAX_RUN_PAGES; page++) {
      const res = await g.get<{ workflow_runs?: RunRow[] }>(`/actions/runs?created=${encodeURIComponent(`>=${since.toISOString()}`)}&per_page=100&page=${page}`);
      const list = res?.workflow_runs ?? [];
      out.push(...list);
      if (list.length < 100) return out;
    }
    notes.push(`実行の一覧は ${MAX_RUN_PAGES} ページ（${out.length} 件）で打ち切りました`);
    return out;
  });
  const isGate = (r: RunRow): boolean => (r.path ?? '').startsWith(GATE_PATH);
  const gateRuns = isUnavailable(runs) ? runs : runs.filter(isGate);
  const ciRuns = isUnavailable(runs) ? runs : runs.filter((r) => !isGate(r));
  const scheduleRuns = isUnavailable(gateRuns) ? gateRuns : gateRuns.filter((r) => r.event === 'schedule');

  // 2. 開いた PR・開いた Issue
  const prs = await attempt(async () => (await g.paginate<OpenPr>('/pulls?state=open')).filter((p) => isSameRepoPr(p, repository)));
  const issuesAll = await attempt(() => g.paginate<OpenIssue>('/issues?state=open'));
  const issues = isUnavailable(issuesAll) ? issuesAll : issuesAll.filter((i) => !i.pull_request && !isHarnessIssueTitle(config, i.title));
  const agentPrs = isUnavailable(prs) ? prs : prs.filter((p) => isAgentPr(config, p, repository));

  // 3. PR ごとのコメントと timeline（1件でも失敗したら、その材料に頼る項目はすべて読めない扱い）
  const perPr = await after(prs, async (list): Promise<PerPr[]> => {
    const out: PerPr[] = [];
    for (const pr of list) out.push({ pr, comments: await g.listComments(pr.number), events: await timeline(g, pr.number) });
    return out;
  });

  // 4. 項目 8：宣言・ラベルを先に見て、候補だけ head の commit と差分を読む（harness/gates/stale.ts と同じ順）
  const claims = await after(perPr, async (rows) => {
    const stalled: StalledClaimInput[] = [];
    const unclaimed: UnclaimedJudgeInput[] = [];
    const commitAt = async (sha: string): Promise<string | null> =>
      (await g.get<{ commit?: { committer?: { date?: string | null } | null } }>(`/commits/${sha}`)).commit?.committer?.date ?? null;
    for (const { pr, comments } of rows) {
      if (!isAgentPr(config, pr, repository)) continue;
      const ref = { number: pr.number, title: pr.title, html_url: pr.html_url };
      const claim = claimOf(comments);
      if (stalledCandidate(claim, now, thresholds.claimIdleMinutes)) stalled.push({ pr: ref, claim, headCommitAt: await commitAt(pr.head.sha) });
      const labels = pr.labels.map((l) => l.name);
      const conflicted = pr.mergeable_state === 'dirty';
      if (claim !== null || conflicted || labels.includes(LABELS.hold) || labels.includes(LABELS.blocked)) continue;
      const headCommitAt = await commitAt(pr.head.sha);
      const times = [...comments.filter((c) => hasClaudeMark(c.body) && isTrustedComment(c)).map((c) => c.created_at), claimActivityAt(comments)]
        .flatMap((t) => (t === null ? [] : [Date.parse(t)])).filter((t) => !Number.isNaN(t));
      const lastClaudeAt = times.length > 0 ? new Date(Math.max(...times)).toISOString() : null;
      const timed: UnclaimedJudgeInput = { pr: ref, claim, labels, conflicted, headCommitAt, lastClaudeAt, accepted: null };
      if (!unclaimedJudgeCandidate(timed, now, thresholds.claimIdleMinutes)) continue;
      unclaimed.push({ ...timed, accepted: acceptanceForPatch(config, comments, patchId(await prDiff(g, pr))) !== null });
    }
    return { stalled, unclaimed };
  });

  // 5. 項目 2 のログ・項目 5 のジョブ
  const rateLimitLogs = await after(gateRuns, async (list) => {
    const failed = newest(list.filter((r) => r.conclusion === 'failure'));
    const logs: string[] = [];
    for (const r of failed) {
      const job = (await jobsOf(g, `/actions/runs/${r.id}/jobs`)).find((j) => j.conclusion === 'failure');
      if (job) logs.push(await g.get<string>(`/actions/jobs/${job.id}/logs`, { raw: true }));
    }
    return { logs, unread: list.filter((r) => r.conclusion === 'failure').length - logs.length };
  });
  const ci = await after(ciRuns, async (list) => {
    const jobs: CiJob[] = [];
    for (const r of newest(list.filter((x) => x.status === 'completed'))) {
      for (const j of await jobsOf(g, `/actions/runs/${r.id}/jobs`) as { name: string; started_at?: string | null; completed_at?: string | null }[]) {
        jobs.push({ run_id: r.id, name: j.name, started_at: j.started_at ?? null, completed_at: j.completed_at ?? null });
      }
    }
    return { runs: list, jobs };
  });

  const issuesAndPrs = firstUnavailable(issues, agentPrs) ?? { issues: issues as OpenIssue[], agentPrs: agentPrs as OpenPr[] };

  // 6. 項目 13：agent:plan-ok で待ち、開いた Agent PR の無い Issue の計画の files
  const waiting = await after(issuesAndPrs, async ({ issues: open, agentPrs: agents }) => {
    const withPr = new Set(agents.flatMap((p) => issueOfBranch(p.head.ref) ?? []));
    const out: AreaWaitInput[] = [];
    for (const i of open.filter((x) => hasLabel(x, LABELS.planOk) && !withPr.has(x.number))) {
      const gate = latestPlanGate(config, await g.listComments(i.number)) as { comment: IssueComment; value: { pass: boolean; plan?: { files: string[] } } } | null;
      if (gate?.value.pass && gate.value.plan) out.push({ issue: i.number, files: gate.value.plan.files, since: gate.comment.created_at });
    }
    return out;
  });

  // 7. 項目 10：Epic の子でない Agent PR のある Issue（親を読む）と、子が全部 Close の開いた Epic
  const epicDrift = await after(issuesAndPrs, async ({ issues: open, agentPrs: agents }) => {
    const orphanIssues: number[] = [];
    for (const n of new Set(agents.flatMap((p) => issueOfBranch(p.head.ref) ?? []))) {
      if ((await g.get(`/issues/${n}/parent`, { allow404: true })) == null) orphanIssues.push(n);
    }
    const closedEpics = open.filter((i) => hasLabel(i, LABELS.epic) && (i.sub_issues_summary?.total ?? 0) > 0 && i.sub_issues_summary!.completed === i.sub_issues_summary!.total).map((i) => i.number);
    return { closedEpics, orphanIssues };
  });

  // 8. 項目 12：worktree のブランチの Issue が開いた Issue に無いときだけ、その Issue の状態を読む
  const worktreeInputs: Unavailable | WorktreeInput[] = worktrees === null
    ? { available: false, reason: 'worktree を読めません' }
    : await after(issuesAll, async (open) => {
      const openNumbers = new Set(open.map((i) => i.number));
      const out: WorktreeInput[] = [];
      for (const w of worktrees) {
        const n = w.branch === null ? null : issueOfBranch(w.branch);
        const closed = n === null || openNumbers.has(n) ? false : (await g.get<{ state?: string }>(`/issues/${n}`)).state === 'closed';
        out.push({ path: w.path, closed, dirty: w.dirty });
      }
      return out;
    });

  const input: OpsHealthInput = {
    since,
    scheduleRuns,
    rateLimitLogs,
    gateRuns,
    ci,
    prs: firstUnavailable(prs, perPr) ?? (prs as OpenPr[]).map((pr): OpsPr => {
      const events = (perPr as PerPr[]).find((p) => p.pr.number === pr.number)!.events;
      const ready = events.filter((e) => e.event === 'ready_for_review').at(-1)?.created_at ?? pr.created_at;
      return { pr: pr.number, draft: pr.draft, createdAt: pr.created_at, readyAt: pr.draft ? null : ready };
    }),
    requeue: isUnavailable(perPr) ? perPr : perPr.map((p): RequeueInput => ({ pr: p.pr.number, timeline: p.events, comments: p.comments })),
    claims,
    planBacklog: isUnavailable(issues)
      ? issues
      : { planReview: issues.filter((i) => hasLabel(i, LABELS.planReview)).length, unplanned: issues.filter((i) => ![LABELS.planOk, LABELS.planReview, LABELS.epic].some((l) => hasLabel(i, l))).length },
    epicDrift,
    links: isUnavailable(prs) ? prs : prs.map((p): LinkInput => ({ pr: p.number, body: p.body, linked: null })),
    worktrees: worktreeInputs,
    area: firstUnavailable(prs, waiting) ?? { config, repository, openPrs: prs as PullRequest[], waiting: waiting as AreaWaitInput[] },
    reviewPanel: isUnavailable(perPr) ? perPr : panelRuns(perPr),
  };
  return { since: since.toISOString(), gets: budget.used(), maxGets: thresholds.maxGets, items: judgeOpsHealth(input, thresholds, now), notes };
}

/** 記録（agent-review-panel）と判定（agent-verdict）の headSha と時刻。読めないブロックは数えない */
function panelRuns(rows: PerPr[]): { records: PanelRun[]; verdicts: PanelRun[] } {
  const out = { records: [] as PanelRun[], verdicts: [] as PanelRun[] };
  for (const { pr, comments } of rows) {
    for (const c of comments.filter(isTrustedComment)) {
      for (const [kind, list] of [['agent-review-panel', out.records], ['agent-verdict', out.verdicts]] as const) {
        const b = extractBlock(c.body, kind);
        const head = b.found && b.ok ? (b.value as { headSha?: unknown })?.headSha : undefined;
        if (typeof head === 'string') list.push({ pr: pr.number, head, at: c.created_at });
      }
    }
  }
  return out;
}
