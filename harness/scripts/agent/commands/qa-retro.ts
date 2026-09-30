import { collectQaRetro, parseQaRetroArgs } from '../../../lib/qa-retro.ts';
import { type AgentCommand, config, fail, writeTemp } from '../cli.ts';

/**
 * Merge 済みの PR の振り返り（qa-retro の skill）の集計。
 *
 *   node harness/scripts/agent.ts qa-retro-data [--days <n>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]
 *                                                           Merge 済みの PR の振り返り（qa-retro の skill）の集計（既定は直近 14 日。until はその日を含む）。
 *                                                           PR ごとの risk・Merge の経路・判定の回数・メトリクス、後追いの修正と revert の組、risk ごとの割合、
 *                                                           同じ head で失敗の後に成功した CI の実行とテスト名（harness/lib/qa-retro.ts）を JSON でファイルに書き、パスを出力（読むだけ）
 */

export const commands: AgentCommand[] = [
  {
    name: 'qa-retro-data',
    run: async (args, ctx) => {
      const period = parseQaRetroArgs(args, new Date());
      if (!period.ok) fail(period.errors);
      console.log(writeTemp('qa-retro.json', JSON.stringify(await collectQaRetro(ctx.gh(), config, period.value), null, 2)));
    },
  },
];
