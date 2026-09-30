import { GitHub } from '../../../lib/github.ts';
import { type AuditIssue, issueRow, type LabelAuditRow, labelAuditRows, prRow, renderAuditLines } from '../../../lib/label-rules.ts';
import { type PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, config, fail } from '../cli.ts';

/**
 * 必須ラベルの不足と違反の検査。
 *
 *   node harness/scripts/agent.ts label-audit [番号..]      必須ラベルの不足と違反の一覧（ダッシュボードの「ラベルが足りない Issue・PR」と同じ検査）。
 *                                                           番号を渡せばその Issue・PR だけ、渡さなければダッシュボードと同じ範囲（agent:* か epic の開いた Issue と Agent PR）
 */

/** 必須ラベルの不足と違反を、ダッシュボードと同じ関数（harness/lib/label-rules.ts）で検査する */
async function labelAudit(gh: GitHub, args: string[]): Promise<string> {
  if (args.some((a) => !/^\d+$/.test(a))) fail(['label-audit [番号..]']);
  let rows: LabelAuditRow[];
  if (args.length === 0) {
    const issues = await gh.paginate<AuditIssue>('/issues?state=open', 10);
    const prs = await gh.paginate<PullRequest>('/pulls?state=open', 5);
    rows = labelAuditRows(config, `${gh.owner}/${gh.repo}`, issues, prs);
  } else {
    rows = [];
    for (const n of args.map(Number)) {
      const issue = await gh.get<AuditIssue>(`/issues/${n}`);
      rows.push(issue.pull_request ? prRow(config, await gh.get<PullRequest>(`/pulls/${n}`)) : issueRow(config, issue));
    }
  }
  const lines = renderAuditLines(rows);
  return lines.length > 0 ? lines.join('\n') : `ラベルの不足・違反はありません（${rows.length} 件を検査）`;
}

export const commands: AgentCommand[] = [
  { name: 'label-audit', run: async (args, ctx) => void console.log(await labelAudit(ctx.gh(), args)) },
];
