import type { AgentCommand } from '../cli.ts';
import { orcaCliInfo } from '../../orca-cli.ts';

/**
 * hq・fleet が env・printenv を使わずに Orca の CLI を得る入口（Issue #773。許可済みの agent.ts から呼ぶ）。
 *
 *   node harness/scripts/agent.ts orca-cli   harness/scripts/orca-cli.ts の orcaCliInfo の結果（command・found）を1行の JSON で出す。
 *                                            決め方は harness/lib/worktree.ts の orcaCliCommand（ORCA_CLI_COMMAND → ORCA_DEV_REPO_ROOT なら orca-dev →
 *                                            Linux は orca-ide、それ以外は orca）。出すのは command・found だけで、ほかの環境変数の値・PATH・
 *                                            見つかったパスは出さない。CLI は実行しない。GitHub は呼ばない。引数を渡されたら使い方を標準エラーに出して終了コード 2
 */
export const commands: AgentCommand[] = [
  {
    name: 'orca-cli',
    run: (args) => {
      if (args.length > 0) {
        console.error('使い方: node harness/scripts/agent.ts orca-cli（引数は取らない）');
        process.exit(2);
      }
      console.log(JSON.stringify(orcaCliInfo(process.platform, process.env)));
    },
  },
];
