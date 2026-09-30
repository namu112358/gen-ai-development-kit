import { readFileSync } from 'node:fs';
import { archReviewRange, archReviewRangeArgErrors, checkArchReviewRecord, checkIssueDrafts, renderArchReviewRecord } from '../../../lib/arch-review.ts';
import { GitHub } from '../../../lib/github.ts';
import { splitArgs } from '../../../lib/session-inputs.ts';
import { findDashboard } from '../../../lib/state.ts';
import { type AgentCommand, type CommandContext, config, currentSession, fail } from '../cli.ts';

/**
 * arch-review の範囲・Issue の下書きの検査・記録。
 *
 *   node harness/scripts/agent.ts arch-review-range [--since <sha>] [--until <sha>] [--last <n>]
 *                                                           arch-review が見る Merge 済みの PR の範囲（JSON。読むだけ）。--since（40桁の SHA）か、無ければダッシュボード Issue の
 *                                                           前回の arch-review の記録の headSha から、--until（既定は既定ブランチの先頭）までの compare のコミットを PR に対応させる。
 *                                                           前回の記録も --since も無いか --last なら、既定ブランチ宛ての Merge 済みの PR の新しい順に N 本（既定 10）
 *   node harness/scripts/agent.ts arch-review-drafts <file> arch-review の Issue の下書き（[{title, body, duplicateOf?}] の JSON）を検査し、人に示す一覧を出力
 *                                                           （GitHub は読まない。タイトル・Issue Form の必須の見出し・agent:ready を含む labels を誤りにする）
 *   node harness/scripts/agent.ts arch-review-record <file> [--dry-run]
 *                                                           arch-review の記録（見た範囲と要約の JSON）を検査し、ダッシュボード Issue にコメントする（次の実行の前回になる）。
 *                                                           --dry-run は本文を出すだけ。ダッシュボードが無ければ止まる
 */

/** arch-review-range：前回の記録か --since からの範囲（読むだけ） */
async function archReviewRangeText(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'arch-review-range [--since <sha>] [--until <sha>] [--last <n>]';
  const a = splitArgs(args, ['--since', '--until', '--last']);
  if (!a.ok) fail([...a.errors, usage]);
  const { '--since': since, '--until': until, '--last': last } = a.value.options;
  const errors = [
    ...(a.value.positional.length > 0 ? [`余分な引数：${a.value.positional.join(' ')}`] : []),
    ...archReviewRangeArgErrors({ since, until, last }),
  ];
  if (errors.length > 0) fail([...errors, usage]);
  const range = await archReviewRange(gh, config, { since, until, last: last === undefined ? undefined : Number(last) });
  return JSON.stringify(range, null, 2);
}

/** arch-review-record：記録を検査して本文を作る（--dry-run でなければダッシュボード Issue にコメントする） */
async function archReviewRecord(args: string[], ctx: CommandContext): Promise<void> {
  const file = args.find((x) => !x.startsWith('--'));
  if (!file) fail(['arch-review-record <file> [--dry-run]']);
  const r = checkArchReviewRecord(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.ok) fail(r.errors);
  const body = renderArchReviewRecord(r.record, currentSession());
  if (args.includes('--dry-run')) return void console.log(body);
  const gh = ctx.gh();
  const dashboard = await findDashboard(gh, config);
  if (!dashboard) fail([`ダッシュボード Issue（${config.dashboardIssueTitle}）がありません。App の publish-queue が作るまで記録できません`]);
  const posted = await gh.comment(dashboard.number, body);
  console.log(posted.html_url);
}

export const commands: AgentCommand[] = [
  { name: 'arch-review-range', run: async (args, ctx) => void console.log(await archReviewRangeText(ctx.gh(), args)) },
  {
    name: 'arch-review-drafts',
    run: (args) => {
      if (!args[0]) fail(['arch-review-drafts <file>']);
      const r = checkIssueDrafts(JSON.parse(readFileSync(args[0], 'utf8')));
      if (!r.ok) fail(r.errors);
      console.log(r.markdown);
    },
  },
  { name: 'arch-review-record', run: (args, ctx) => archReviewRecord(args, ctx) },
];
