import { fillLabels } from '../../../lib/label-fill.ts';
import { type AgentCommand, config, currentSession, fail } from '../cli.ts';

/**
 * Jev の提案のラベルを付ける（Issue #538）。App の最新の label-triage の記録の notApplied にある priority:*・area:* だけを、
 * 同じ種類のラベルが無いときに付け、理由のコメントを Issue に残す。記録が無ければ何もしない。
 *
 *   node harness/scripts/agent.ts label-fill <番号> --label <ラベル> [--label ..] --reason <根拠>
 *                                                           付けたラベル・飛ばしたラベル・コメントの URL を JSON で出す
 */

const USAGE = 'label-fill <番号> --label <ラベル> [--label ..] --reason <根拠>';

function parseArgs(args: string[]): { n: number; labels: string[]; reason: string } {
  const labels: string[] = [];
  let reason: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--label' || a === '--reason') {
      const v = args[++i];
      if (v === undefined) fail([`${a} に値がありません`, USAGE]);
      if (a === '--label') labels.push(v);
      else if (reason !== undefined) fail(['--reason は1つだけです', USAGE]);
      else reason = v;
    } else if (a.startsWith('--')) fail([`知らないオプションです: ${a}`, USAGE]);
    else positional.push(a);
  }
  if (positional.length !== 1 || !/^\d+$/.test(positional[0]!)) fail([USAGE]);
  if (labels.length === 0) fail(['--label が要ります', USAGE]);
  if (reason === undefined || reason.trim() === '') fail(['--reason が要ります', USAGE]);
  return { n: Number(positional[0]), labels, reason };
}

export const commands: AgentCommand[] = [
  {
    name: 'label-fill',
    run: async (args, ctx) => {
      const { n, labels, reason } = parseArgs(args);
      const r = await fillLabels(ctx.gh(), config, n, labels, reason, currentSession());
      if (r.kind === 'no-record') console.log(`#${n} に label-triage の記録が無いので何もしません`);
      else if (r.kind === 'rejected') fail(r.errors);
      else console.log(JSON.stringify({ added: r.added, skipped: r.skipped, comment: r.comment }, null, 2));
    },
  },
];
