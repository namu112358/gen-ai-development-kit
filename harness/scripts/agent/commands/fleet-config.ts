import { hqConfig, implementModelConfig, panesConfig, shipModeConfig } from '../../../lib/config.ts';
import { type AgentCommand, config } from '../cli.ts';

/**
 * fleet・ship が読む設定（Issue #1034。panes.ts config の置き換え。panes.ts config は Epic #1033 の (C) で消す）。
 *
 *   node harness/scripts/agent.ts fleet-config     fleet.shipMode・fleet.implementModel・hq・panes の設定を panes.ts config と同じ JSON で出す。
 *                                                  shipModeConfig が止める理由（stopReason）を返したときだけ、理由を標準エラーに出して終了コード 1
 */

export const commands: AgentCommand[] = [
  {
    name: 'fleet-config',
    run: () => {
      const ship = shipModeConfig(config);
      console.log(JSON.stringify({ ...ship, ...implementModelConfig(config), ...hqConfig(config), ...panesConfig(config) }, null, 2));
      if (ship.stopReason) {
        console.error(ship.stopReason);
        process.exit(1);
      }
    },
  },
];
