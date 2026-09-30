import { readFileSync } from 'node:fs';
import {
  adoptArchReviewDraft,
  ARCH_REVIEW_LOOP_MAX_DRAFTS,
  archReviewAdoption,
  archReviewBodyErrors,
  archReviewRange,
  archReviewRangeArgErrors,
  checkArchReviewRecord,
  checkIssueDrafts,
  renderArchReviewRecord,
} from '../../../lib/arch-review.ts';
import { GitHub, type IssueComment } from '../../../lib/github.ts';
import { splitArgs } from '../../../lib/session-inputs.ts';
import { findDashboard } from '../../../lib/state.ts';
import { type AgentCommand, type CommandContext, config, currentSession, fail } from '../cli.ts';

/**
 * arch-review の範囲・Issue の下書きの検査・記録・採用の書き戻し。
 *
 *   node harness/scripts/agent.ts arch-review-range [--since <sha>] [--until <sha>] [--last <n>]
 *                                                           arch-review が見る Merge 済みの PR の範囲（JSON。読むだけ）。--since（40桁の SHA）か、無ければダッシュボード Issue の
 *                                                           前回の arch-review の記録の headSha から、--until（既定は既定ブランチの先頭）までの compare のコミットを PR に対応させる。
 *                                                           前回の記録も --since も無いか --last なら、既定ブランチ宛ての Merge 済みの PR の新しい順に N 本（既定 10）
 *   node harness/scripts/agent.ts arch-review-drafts <file> [--loop]
 *                                                           arch-review の Issue の下書き（[{title, body, duplicateOf?}] の JSON）を検査し、人に示す一覧を出力
 *                                                           （GitHub は読まない。タイトル・Issue Form の必須の見出し・agent:ready を含む labels を誤りにする）。
 *                                                           --loop は /loop の1回分として、下書きが上限（3件）を超えたら誤りにする
 *   node harness/scripts/agent.ts arch-review-record <file> [--dry-run]
 *                                                           arch-review の記録（見た範囲と要約の JSON）を検査し、ダッシュボード Issue にコメントする（次の実行の前回になる）。
 *                                                           --dry-run は本文を出すだけ。ダッシュボードが無ければ止まる。本文がコメントの上限を超えたら止まる
 *   node harness/scripts/agent.ts arch-review-pending       ダッシュボード Issue の arch-review の記録すべてから、下書きの数・採用の数・未採用の下書き
 *                                                           （記録のコメント ID・番号・タイトル・本文・duplicateOf）を出す（JSON。読むだけ）
 *   node harness/scripts/agent.ts arch-review-adopt <コメントID> <下書きの番号> <Issue 番号> [--comment]
 *                                                           人が選んで作った Issue の番号を、その記録（ダッシュボード Issue のコメント）の下書きの created に書き戻す（コメントを編集）。
 *                                                           --comment は、開いた Issue（duplicateOf）へコメントを投稿したものとして commented に書く。下書きの番号は1始まり
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

/** ダッシュボード Issue（無ければ止まる） */
async function dashboardOrFail(gh: GitHub): Promise<{ number: number }> {
  const dashboard = await findDashboard(gh, config);
  if (!dashboard) fail([`ダッシュボード Issue（${config.dashboardIssueTitle}）がありません。App の publish-queue が作るまで記録できません`]);
  return dashboard;
}

/** arch-review-record：記録を検査して本文を作る（--dry-run でなければダッシュボード Issue にコメントする） */
async function archReviewRecord(args: string[], ctx: CommandContext): Promise<void> {
  const file = args.find((x) => !x.startsWith('--'));
  if (!file) fail(['arch-review-record <file> [--dry-run]']);
  const r = checkArchReviewRecord(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.ok) fail(r.errors);
  const body = renderArchReviewRecord(r.record, currentSession());
  const tooLong = archReviewBodyErrors(body);
  if (tooLong.length > 0) fail(tooLong);
  if (args.includes('--dry-run')) return void console.log(body);
  const gh = ctx.gh();
  const dashboard = await dashboardOrFail(gh);
  const posted = await gh.comment(dashboard.number, body);
  console.log(posted.html_url);
}

/** arch-review-adopt：記録のコメントを読み直し、下書きの created（--comment なら commented）を書き戻す */
async function archReviewAdopt(args: string[], ctx: CommandContext): Promise<void> {
  const usage = 'arch-review-adopt <コメントID> <下書きの番号> <Issue 番号> [--comment]';
  const asComment = args.includes('--comment');
  const positional = args.filter((x) => x !== '--comment');
  const unknown = positional.filter((x) => x.startsWith('--'));
  if (unknown.length > 0) fail([`知らないオプション：${unknown.join(' ')}`, usage]);
  if (positional.length !== 3 || !positional.every((x) => /^[1-9]\d*$/.test(x))) fail(['コメントID・下書きの番号・Issue 番号は1以上の整数', usage]);
  const [commentId, index, issue] = positional.map(Number) as [number, number, number];
  const gh = ctx.gh();
  const dashboard = await dashboardOrFail(gh);
  const comment = await gh.get<IssueComment & { issue_url?: string }>(`/issues/comments/${commentId}`);
  if (!comment.issue_url?.endsWith(`/issues/${dashboard.number}`)) fail([`コメント ${commentId} はダッシュボード Issue（#${dashboard.number}）のものではありません`]);
  const r = adoptArchReviewDraft(comment, index, issue, { comment: asComment }, config);
  if (!r.ok) fail(r.errors);
  let edited: { html_url: string };
  try {
    edited = await gh.request<{ html_url: string }>('PATCH', `/issues/comments/${commentId}`, { body: { body: r.body } });
  } catch (e) {
    fail([
      `記録のコメント ${commentId} を編集できませんでした（書いた本人か権限のある人だけが編集できます）：${e instanceof Error ? e.message : String(e)}`,
      `${asComment ? 'コメントした' : '作った'} Issue は #${issue} です。記録には書き戻せていません`,
    ]);
  }
  console.log(edited.html_url);
}

export const commands: AgentCommand[] = [
  { name: 'arch-review-range', run: async (args, ctx) => void console.log(await archReviewRangeText(ctx.gh(), args)) },
  {
    name: 'arch-review-drafts',
    run: (args) => {
      const file = args.find((x) => !x.startsWith('--'));
      if (!file) fail(['arch-review-drafts <file> [--loop]']);
      const r = checkIssueDrafts(JSON.parse(readFileSync(file, 'utf8')), args.includes('--loop') ? ARCH_REVIEW_LOOP_MAX_DRAFTS : undefined);
      if (!r.ok) fail(r.errors);
      console.log(r.markdown);
    },
  },
  { name: 'arch-review-record', run: (args, ctx) => archReviewRecord(args, ctx) },
  {
    name: 'arch-review-pending',
    run: async (args, ctx) => {
      if (args.length > 0) fail([`余分な引数：${args.join(' ')}`, 'arch-review-pending']);
      const gh = ctx.gh();
      const dashboard = await dashboardOrFail(gh);
      const adoption = archReviewAdoption(await gh.listComments(dashboard.number), config);
      console.log(JSON.stringify({ dashboard: dashboard.number, ...adoption }, null, 2));
    },
  },
  { name: 'arch-review-adopt', run: (args, ctx) => archReviewAdopt(args, ctx) },
];
