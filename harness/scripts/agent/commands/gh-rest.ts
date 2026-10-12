import { restIssueSearch, restIssueView, restOpenPrsReferencing, restPrList, restPrView } from '../../../lib/gh-rest.ts';
import { type AgentCommand, fail } from '../cli.ts';

/**
 * Issue・PR を GraphQL を使わず REST だけで読む（Issue #712）。出力は JSON で、欄の名前は `gh … --json` にそろえる。読むだけ。
 *
 *   node harness/scripts/agent.ts rest issue-view <番号>        Issue の本文・ラベル・コメント
 *   node harness/scripts/agent.ts rest issue-search <語>...     開いた Issue を検索（/search/issues）
 *   node harness/scripts/agent.ts rest pr-view <PR番号>         PR の Draft・チェックの状態・コメント・review
 *   node harness/scripts/agent.ts rest pr-list                  開いた PR の一覧
 *   node harness/scripts/agent.ts rest closing-prs <Issue番号>  その Issue を Closes / Refs する開いた PR
 */

const USAGE = 'rest issue-view <番号> | issue-search <語>... | pr-view <PR番号> | pr-list | closing-prs <Issue番号>';

function numberArg(args: string[]): number {
  if (args.length !== 1 || !/^\d+$/.test(args[0]!)) fail([USAGE]);
  return Number(args[0]);
}

export const commands: AgentCommand[] = [
  {
    name: 'rest',
    run: async (args, ctx) => {
      const [sub, ...rest] = args;
      const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
      switch (sub) {
        case 'issue-view': return print(await restIssueView(ctx.gh(), numberArg(rest)));
        case 'issue-search':
          if (rest.length === 0 || rest.some((a) => a.startsWith('--'))) fail([USAGE]);
          return print(await restIssueSearch(ctx.gh(), rest));
        case 'pr-view': return print(await restPrView(ctx.gh(), numberArg(rest)));
        case 'pr-list':
          if (rest.length > 0) fail([USAGE]);
          return print(await restPrList(ctx.gh()));
        case 'closing-prs': return print(await restOpenPrsReferencing(ctx.gh(), numberArg(rest)));
        default: fail([sub === undefined ? 'サブコマンドがありません' : `知らないサブコマンドです: ${sub}`, USAGE]);
      }
    },
  },
];
