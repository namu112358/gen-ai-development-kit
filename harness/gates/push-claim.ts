import { shortSession } from '../lib/blocks.ts';
import { appLogin } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import { claimAt, commitSessions, UNCLAIMED_PUSH_KIND, unclaimedPushNotified, unclaimedPushReason, type UnclaimedPushRecord } from '../lib/push-claim.ts';
import { isAgentPr, linkedIssues, type PullRequest } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';

/**
 * 着手宣言の無いセッションが Agent PR に push したことを、PR に App のコメント（kind=unclaimed-push）で知らせる（止めない）。
 * push（synchronize）のたびに on-pr.ts から呼ぶ。チェック・Draft・判定の引き継ぎは変えず、失敗はログに書いて返る。
 */

interface CommitItem {
  sha: string;
  commit: { message: string };
}

/**
 * push された commit のうち PR 自身のもの。compare（before...after）の commits を、PR の commit の一覧に入っているものに絞る
 * （main を取り込む push で compare に入る main 側の commit は見ない）。before や commits が無ければ after の1件だけ。
 */
async function pushedCommits(ctx: GateContext, pr: PullRequest, after: string): Promise<CommitItem[]> {
  const before = ctx.event.before as string | undefined;
  if (before && !/^0+$/.test(before)) {
    const cmp = await ctx.gh.get<{ commits?: CommitItem[] }>(`/compare/${before}...${after}`);
    if (Array.isArray(cmp.commits)) {
      const own = new Set((await ctx.gh.paginate<CommitItem>(`/pulls/${pr.number}/commits`)).map((c) => c.sha));
      return cmp.commits.filter((c) => own.has(c.sha));
    }
  }
  return [await ctx.gh.get<CommitItem>(`/commits/${after}`)];
}

export async function notifyUnclaimedPush(ctx: GateContext, pr: PullRequest, getComments: () => Promise<IssueComment[]>): Promise<void> {
  try {
    if (!isAgentPr(ctx.config, pr, ctx.repository) || ctx.event.sender?.login === appLogin(ctx.config)) return;
    const head = (ctx.event.after as string | undefined) ?? pr.head.sha;
    const comments = await getComments();
    if (unclaimedPushNotified(ctx.config, comments, head)) return;
    const commits = commitSessions((await pushedCommits(ctx, pr, head)).map((c) => c.commit.message));
    if (!commits.claude) return;
    // 宣言は push した時点で見る（ゲートが動く前の解除・判定コメントで誤って知らせない）
    const pushedAt = (ctx.event.pull_request?.updated_at as string | undefined) ?? new Date().toISOString();
    const claims = [claimAt(comments, pushedAt)];
    for (const n of await linkedIssues(ctx.gh, ctx.config, pr)) claims.push(claimAt(await ctx.gh.listComments(n), pushedAt));
    const reason = unclaimedPushReason({ claims, commits });
    if (!reason) return;
    const commitShort = commits.sessions.map(shortSession);
    const claimShort = claims.flatMap((c) => (c && !c.released && c.session ? [shortSession(c.session)] : []));
    const what = reason === 'no-claim'
      ? `この push（${head.slice(0, 7)}）には、push の時点で有効な着手宣言がありません。`
      : `この push（${head.slice(0, 7)}）の commit の \`Claude-Session\`（${commitShort.join(', ')}）が、着手宣言のセッション（${claimShort.join(', ')}）と食い違います。`;
    await appComment(ctx, pr.number, UNCLAIMED_PUSH_KIND, `${what}別のセッションが同じ PR を進めていないか確かめてください。判定の経路は変えていません（止めていません）。`, {
      version: 1, headSha: head, reason, commitSessions: commitShort, claimSessions: claimShort,
    } satisfies UnclaimedPushRecord);
  } catch (e) {
    ctx.log(`着手宣言の無い push の確かめに失敗しました: ${(e as Error).message}`);
  }
}
