import { type IssueSignal, backlogScan, backlogTargets, issueSignals, renderBacklogScan } from '../../../lib/backlog.ts';
import type { GitHub } from '../../../lib/github.ts';
import { latestPlanGate } from '../../../lib/state.ts';
import { type AgentCommand, config, fail } from '../cli.ts';

/**
 * 開いた Issue をまとめて見る backlog の skill の、決まる部分（読むだけ。Issue #183。判断は .claude/skills/backlog/SKILL.md）。
 *
 *   node harness/scripts/agent.ts backlog-scan [--json] [<Issue 番号>...]
 *                                                           対象の Issue（番号なしなら harness/lib/backlog.ts の backlogTargets）の、触りそうなファイルの重なる組と、
 *                                                           似た Issue の組を出す。触りそうなファイルは計画ゲートの記録の計画の files があればそれ、無ければ本文のパス。
 *                                                           既定はテキストの表、--json なら targets・overlaps・similar の JSON。番号は開いた Issue だけ（PR・閉じた Issue は止まる）。書き込みはしない
 */

type BacklogItem = { number: number; title: string; body: string | null; state: string; labels: { name: string }[]; pull_request?: unknown; user?: { login: string } | null; author_association?: string };

async function backlogScanText(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'backlog-scan [--json] [<Issue 番号>...]';
  const json = args.includes('--json');
  const rest = args.filter((x) => x !== '--json');
  if (rest.some((x) => !/^\d+$/.test(x))) fail([usage]);
  const items: BacklogItem[] = rest.length > 0
    ? await Promise.all(rest.map((n) => gh.get<BacklogItem>(`/issues/${n}`)))
    : backlogTargets(await gh.paginate<BacklogItem>('/issues?state=open', 10), config);
  const bad = items.find((i) => i.pull_request || i.state !== 'open');
  if (bad) fail([`#${bad.number} は${bad.pull_request ? ' PR' : '閉じた Issue'}です。開いた Issue の番号を渡してください`]);
  const signals: IssueSignal[] = await Promise.all(items.map(async (item) => {
    const gate = latestPlanGate(config, await gh.listComments(item.number)) as { value: { plan?: { files?: unknown } } } | null;
    const files = gate?.value.plan?.files;
    return issueSignals(item, Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : null);
  }));
  const scan = backlogScan(signals);
  return json ? JSON.stringify(scan, null, 2) : renderBacklogScan(scan);
}

export const commands: AgentCommand[] = [
  { name: 'backlog-scan', run: async (args, ctx) => void console.log(await backlogScanText(ctx.gh(), args)) },
];
