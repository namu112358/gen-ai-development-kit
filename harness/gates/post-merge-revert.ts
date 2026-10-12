/**
 * 定期実行：既定ブランチの先頭の必須チェックが失敗していたら、停止スイッチを入れる。先頭が App の自動 Merge した Agent PR の Merge の commit で、
 * 親の必須チェックが成功していたなら、戻す commit・ブランチ（agent-revert/pr-N）・Draft の PR も出す（Issue #802）。判断は harness/lib/post-merge-revert.ts の純粋な関数。
 * main には push せず、Merge・auto-merge・Draft の解除・停止ラベルを外す処理は持たない。同じ sha はダッシュボードの記録 auto-merge-stopped で1回だけ扱う。
 */
import { appLogin, projectChecks } from '../lib/config.ts';
import { HttpError } from '../lib/github.ts';
import { decidePostMergeRevert, renderRevertPr, renderStopReason, requiredChecksState, revertBranchName, revertCommitMessage, type ChecksState, type MergedPrFacts, type PostMergeStopRecord } from '../lib/post-merge-revert.ts';
import { appRecords, findDashboard, isAgentPr, type PullRequest } from '../lib/state.ts';
import { stackOf } from '../lib/stack.ts';
import type { GateContext } from './context.ts';
import type { StackLinkRecord } from './plan-link.ts';
import { stopAutoMerge } from './on-main-push.ts';

interface RestCommit {
  sha: string;
  commit: { tree: { sha: string } };
  parents: { sha: string }[];
}

type MergedPr = PullRequest & { merged_by: { login: string } | null; merge_commit_sha: string | null };

export async function postMergeRevert(ctx: GateContext): Promise<void> {
  let required: ReturnType<typeof projectChecks>;
  try {
    required = projectChecks(ctx.config);
  } catch (e) {
    ctx.log(`post-merge-revert: projectChecks の設定が不正なため飛ばします: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const head = await ctx.gh.get<RestCommit>(`/commits/${ctx.config.defaultBranch}`);
  const headChecks = await readChecks(ctx, head.sha, required);
  if (headChecks.state === 'pending') {
    ctx.log(`post-merge-revert: ${head.sha.slice(0, 7)} の必須チェックは無いか終わっていません（何もしません）`);
    return;
  }
  if (headChecks.state === 'success') return;
  if (await alreadyHandled(ctx, head.sha)) return;

  const parentSha = head.parents[0]?.sha ?? null;
  let parent: ChecksState | null = null;
  if (parentSha) parent = (await readChecks(ctx, parentSha, required)).state;
  const pr = await findMergedPr(ctx, head.sha);
  const decision = decidePostMergeRevert({ head: 'failure', parent, pr: pr?.facts ?? null, handled: false, mergeMethod: ctx.config.mergeMethod });
  if (decision.action === 'none') return;

  let revertPr: number | null = null;
  let revertNote: string | null = null;
  if (decision.action === 'revert' && pr && parentSha) {
    try {
      revertPr = await createRevertPr(ctx, pr.facts, head.sha, parentSha, headChecks.failed);
    } catch (e) {
      revertNote = e instanceof HttpError && e.status === 422 ? 'revert のブランチが既にあるか、作れませんでした' : `revert の PR を作れませんでした: ${e instanceof Error ? e.message : String(e)}`;
      ctx.log(`post-merge-revert: ${revertNote}`);
    }
  } else {
    revertNote = decision.reason;
  }
  const record: PostMergeStopRecord = {
    version: 1,
    cause: 'main-ci-failed',
    sha: head.sha,
    pr: pr?.facts.number ?? null,
    revertPr,
    reason: revertNote ?? decision.reason,
  };
  const text = renderStopReason({ sha: head.sha, failed: headChecks.failed, pr: record.pr, decision, revertPr, revertNote, stopLabel: ctx.config.autoMergeStopLabel });
  await stopAutoMerge(ctx, pr ? [pr.facts.number] : [], { text, record });
  ctx.log(`post-merge-revert: ${head.sha.slice(0, 7)} の必須チェックの失敗で停止スイッチを入れました（PR=${record.pr ?? 'なし'} revert=${revertPr ?? 'なし'}）`);
}

async function readChecks(ctx: GateContext, sha: string, required: ReturnType<typeof projectChecks>) {
  const runs = await ctx.gh.get<{ check_runs: { name: string; status: string; conclusion: string | null; app: { id: number } | null }[] }>(`/commits/${sha}/check-runs?per_page=100`);
  const status = await ctx.gh.get<{ statuses: { context: string; state: string }[] }>(`/commits/${sha}/status?per_page=100`);
  return requiredChecksState(required, runs.check_runs ?? [], status.statuses ?? []);
}

async function alreadyHandled(ctx: GateContext, sha: string): Promise<boolean> {
  const dashboard = await findDashboard(ctx.gh, ctx.config);
  if (!dashboard) return false;
  const records = appRecords<Partial<PostMergeStopRecord>>(ctx.config, await ctx.gh.listComments(dashboard.number), 'auto-merge-stopped');
  return records.some((r) => r.value.cause === 'main-ci-failed' && r.value.sha === sha);
}

/** 先頭の commit を Merge の commit に持つ、Merge 済みの PR。引けなければ null */
async function findMergedPr(ctx: GateContext, sha: string): Promise<{ facts: MergedPrFacts } | null> {
  let listed: PullRequest[];
  try {
    listed = await ctx.gh.get<PullRequest[]>(`/commits/${sha}/pulls`);
  } catch (e) {
    ctx.log(`post-merge-revert: ${sha.slice(0, 7)} の PR を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const found = listed.find((p) => p.merged_at && (p as Partial<MergedPr>).merge_commit_sha === sha);
  if (!found) return null;
  try {
    // 一覧には merged_by が無いので読み直す
    const pr = await ctx.gh.get<MergedPr>(`/pulls/${found.number}`);
    const linked = appRecords<StackLinkRecord>(ctx.config, await ctx.gh.listComments(pr.number), 'stack-link').length > 0;
    return {
      facts: {
        number: pr.number,
        title: pr.title,
        mergedByApp: pr.merged_by?.login === appLogin(ctx.config),
        agentPr: isAgentPr(ctx.config, pr, ctx.repository),
        stacked: stackOf(pr) !== null || linked,
      },
    };
  } catch (e) {
    ctx.log(`post-merge-revert: #${found.number} を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** 木を第1親の木、親を先頭にした commit を作り、ブランチと Draft の PR を出す。PR の番号を返す */
async function createRevertPr(ctx: GateContext, pr: MergedPrFacts, sha: string, parentSha: string, failed: string[]): Promise<number> {
  const parent = await ctx.gh.get<RestCommit>(`/commits/${parentSha}`);
  const commit = await ctx.gh.request<{ sha: string }>('POST', '/git/commits', {
    body: { message: revertCommitMessage(ctx.repository, pr, sha), tree: parent.commit.tree.sha, parents: [sha] },
  });
  const branch = revertBranchName(pr.number);
  await ctx.gh.request('POST', '/git/refs', { body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  const text = renderRevertPr({ repository: ctx.repository, pr, sha, failed, stopLabel: ctx.config.autoMergeStopLabel });
  const created = await ctx.gh.request<{ number: number }>('POST', '/pulls', {
    body: { title: text.title, head: branch, base: ctx.config.defaultBranch, body: text.body, draft: true },
  });
  return created.number;
}
