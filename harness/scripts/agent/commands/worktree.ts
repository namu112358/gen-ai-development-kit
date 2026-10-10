import { worktreeClaimIssue } from '../../../lib/queue.ts';
import { type PullRequest } from '../../../lib/state.ts';
import { addWorktree, ensureNodeModules, labelOrcaWorktree, parseWorktreeArgs, removeWorktree, worktreeOptions } from '../../../lib/worktree.ts';
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
 *
 * ref（ブランチか SHA）は先頭に書き、フラグはその後ろに書く。ref が無い・`-` で始まるときは、着手宣言の確かめより前に
 * 使い方を出して終了コード 1 で止まる（`worktree --detach` で `--detach` の worktree を作らないように）。
 * 消し残した空のディレクトリ：worktree は、登録されていない空のディレクトリがあれば消して作り直す（消せなければ、ほかの
 * プロセスが使っていると分かる文で止まる。空でなければ中身を消さずに止まる）。worktree-remove は、空のディレクトリだけが
 * 残っていればそれを消して成功とみなし、消せずに残れば警告を出す。
 *
 * 置き場所は worktreeOptions（環境変数 AGENT_HARNESS_WORKTREE_ROOT → 設定の worktreeRoot → ../<リポジトリ名>.worktrees）で決め、
 * リポジトリの中になる値なら終了コード 1 で止まる。worktree は、--detach でも --routine でもなければ、Orca があれば
 * 表示名「#番号 短い名前」と Issue を付ける（短い名前は GitHub から取った Issue のタイトルを短くしたもので、取れなければ
 * ブランチの後ろ。親子は付けない。Orca が無い・タイトルが取れない・失敗しても止めない）。
 */

/** worktree・worktree-remove。claude/issue-<番号>- のブランチなら、作る前にこのセッションの着手宣言を確かめる */
async function worktreeCommand(cmd: 'worktree' | 'worktree-remove', args: string[], ctx: CommandContext): Promise<void> {
  let parsed: ReturnType<typeof parseWorktreeArgs>;
  try {
    parsed = parseWorktreeArgs(cmd, args);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { ref, detach, routine } = parsed;
  let title: string | null = null;
  if (cmd === 'worktree') {
    const target = worktreeClaimIssue(ref, detach, args.includes('--routine'));
    if (target !== null) {
      const gh = ctx.gh();
      // fix・sync は PR 番号に宣言するので、そのブランチの開いた PR があれば PR の宣言を見る
      const open = await gh.get<PullRequest[]>(`/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${ref}`)}`);
      await ensureOwnClaim(gh, open[0]?.number ?? target);
      // Orca の表示名に使う Issue のタイトル。取れなければブランチの後ろを使うので、失敗しても止めない
      try {
        const issue = await gh.get<{ title?: unknown }>(`/issues/${target}`);
        if (typeof issue.title === 'string') title = issue.title;
      } catch {
        title = null;
      }
    }
  }
  try {
    const opts = worktreeOptions(config);
    if (cmd === 'worktree') {
      const path = addWorktree(ref, detach, opts);
      ensureNodeModules(path);
      if (!detach && !routine) labelOrcaWorktree(path, ref, { title });
      return void console.log(path);
    }
    return removeWorktree(ref, opts);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

export const commands: AgentCommand[] = [
  { name: 'worktree', run: (args, ctx) => worktreeCommand('worktree', args, ctx) },
  { name: 'worktree-remove', run: (args, ctx) => worktreeCommand('worktree-remove', args, ctx) },
];
