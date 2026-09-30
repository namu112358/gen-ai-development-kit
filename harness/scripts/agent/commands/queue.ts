import { claudeMark } from '../../../lib/blocks.ts';
import { LABELS } from '../../../lib/config.ts';
import { computeQueue } from '../../../lib/facts.ts';
import { type AgentCommand, blockBody, config, currentSession } from '../cli.ts';

/**
 * 次にやることと、依存待ち・人に返すときのラベルとコメント。
 *
 *   node harness/scripts/agent.ts queue                     次にやること（JSON）
 *   node harness/scripts/agent.ts wait <issue> <blockers..> 依存待ち（agent:waiting）
 *   node harness/scripts/agent.ts block <n> <reason-code> <text>  agent:blocked＋理由コード
 */

export const commands: AgentCommand[] = [
  { name: 'queue', run: async (_args, ctx) => void console.log(JSON.stringify(await computeQueue(ctx.gh(), config, currentSession()), null, 2)) },
  {
    name: 'wait',
    run: async (args, ctx) => {
      const gh = ctx.gh();
      const n = Number(args[0]);
      await gh.addLabels(n, [LABELS.waiting]);
      await gh.comment(n, `${claudeMark(currentSession())}\n未解決の blocker（${args.slice(1).map((b) => `#${b}`).join(', ')}）があるため \`agent:waiting\` にしました。blocker が閉じると App が外します。`);
    },
  },
  {
    name: 'block',
    run: async (args, ctx) => {
      const gh = ctx.gh();
      const n = Number(args[0]);
      const body = blockBody(args[1]!, args.slice(2).join(' '));
      await gh.addLabels(n, [LABELS.blocked]);
      await gh.comment(n, body);
    },
  },
];
