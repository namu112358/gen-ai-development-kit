import { worktreeClaimIssue } from '../../../lib/queue.ts';
import { type PullRequest } from '../../../lib/state.ts';
import { addWorktree, ensureNodeModules, mainRepoRoot, removeWorktree } from '../../../lib/worktree.ts';
import { type AgentCommand, type CommandContext, config, ensureOwnClaim } from '../cli.ts';

/**
 * 作業用の worktree の作成と削除。
 *
 *   node harness/scripts/agent.ts worktree <ブランチ|SHA> [--detach] [--routine]  作業用の worktree を作り、パスを出力（既にあればそのパス）。
 *                                                           node_modules が無ければ npm ci も行う（npm の出力は標準エラー。標準出力の最終行がパス）。
 *                                                           claude/issue-<番号>- のブランチなら、先にこのセッションの着手宣言
 *                                                           （そのブランチの開いた PR があれば PR の宣言、無ければ Issue の宣言）を確かめる。
 *                                                           定期 Routine は --routine を付けて確かめない（Routine の環境には gh が無い）
 *   node harness/scripts/agent.ts worktree-remove <ブランチ|SHA>           worktree を削除
 */

/** worktree・worktree-remove。claude/issue-<番号>- のブランチなら、作る前にこのセッションの着手宣言を確かめる */
async function worktreeCommand(cmd: 'worktree' | 'worktree-remove', args: string[], ctx: CommandContext): Promise<void> {
  if (cmd === 'worktree') {
    const detach = args.includes('--detach');
    const target = worktreeClaimIssue(args[0] ?? '', detach, args.includes('--routine'));
    if (target !== null) {
      const gh = ctx.gh();
      // fix・sync は PR 番号に宣言するので、そのブランチの開いた PR があれば PR の宣言を見る
      const open = await gh.get<PullRequest[]>(`/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${args[0]}`)}`);
      await ensureOwnClaim(gh, open[0]?.number ?? target);
    }
  }
  try {
    const opts = { root: mainRepoRoot(), defaultBranch: config.defaultBranch };
    if (cmd === 'worktree') {
      const path = addWorktree(args[0]!, args.includes('--detach'), opts);
      ensureNodeModules(path);
      return void console.log(path);
    }
    return removeWorktree(args[0]!, opts);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

export const commands: AgentCommand[] = [
  { name: 'worktree', run: (args, ctx) => worktreeCommand('worktree', args, ctx) },
  { name: 'worktree-remove', run: (args, ctx) => worktreeCommand('worktree-remove', args, ctx) },
];
