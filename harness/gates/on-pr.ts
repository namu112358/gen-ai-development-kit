import { areaLabels, classificationChanges, sizeLabel, type ChangedFile } from '../lib/classify.ts';
import { CHECKS, LABELS, PLAN_EXEMPT_LABEL, REVIEW_EXEMPT_LABEL } from '../lib/config.ts';
import { writePlanLink } from './plan-link.ts';
import { parseTitle } from '../lib/title.ts';
import { patchId } from '../lib/patch-id.ts';
import { checkScope } from '../lib/scope.ts';
import { acceptanceForPatch, changedFiles, hasLabel, isSameRepoPr, plannedFilesForPr, prDiff } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute } from './apply.ts';
import { appComment, convertToDraft, disableAutoMerge, getPr, writeCheck, type GateContext } from './context.ts';

/**
 * pull_request_target：PR の head は checkout せず、中身は API で読むだけ。
 * - push（synchronize）：まず auto-merge を解除し、差分が同じなら過去の判定を引き継ぐ
 * - 範囲照合（agent/scope、情報表示用）
 * - hold・auto-merge の変化で merge-route を書き直す
 */
export async function onPullRequest(ctx: GateContext): Promise<void> {
  const action = ctx.event.action as string;
  const number = ctx.event.pull_request.number as number;

  if (action === 'synchronize') {
    // 最初に auto-merge を解除する（順序制御）。イベントの内容ではなく API の最新状態を使う
    await disableAutoMerge(ctx, await getPr(ctx, number));
  }
  const pr = await getPr(ctx, number);
  if (pr.state !== 'open') return;
  const label = ctx.event.label?.name as string | undefined;
  if (['opened', 'reopened', 'synchronize', 'edited'].includes(action)) await writeTitleCheck(ctx, pr);
  if (['opened', 'reopened', 'synchronize', 'edited'].includes(action) || label === PLAN_EXEMPT_LABEL) await writePlanLink(ctx, pr);
  if ((action === 'labeled' || action === 'unlabeled') && label === PLAN_EXEMPT_LABEL) {
    await appComment(ctx, number, 'plan-exempt', `\`${PLAN_EXEMPT_LABEL}\` が @${ctx.event.sender?.login} により${action === 'labeled' ? '付けられました' : '外されました'}（記録）。`);
    return;
  }
  if (action === 'edited') return;
  if (['opened', 'reopened', 'synchronize'].includes(action)) await classifyPr(ctx, pr);

  // 判定を待たずに通す例外（人だけが付ける）。付け外しを記録し、外されたら判定待ちに戻す
  if ((action === 'labeled' || action === 'unlabeled') && label === REVIEW_EXEMPT_LABEL) {
    await appComment(ctx, number, 'review-exempt', `\`${REVIEW_EXEMPT_LABEL}\` が @${ctx.event.sender?.login} により${action === 'labeled' ? '付けられました' : '外されました'}（記録）。`);
    if (action === 'unlabeled') {
      await writeCheck(ctx, pr.head.sha, CHECKS.review, { conclusion: 'failure', title: '判定待ち（例外が外されました）', summary: 'Reviewer と Risk Agent の判定を受け付けると書き直されます。' });
    }
  }
  if (hasLabel(pr, REVIEW_EXEMPT_LABEL) && (['opened', 'reopened', 'synchronize'].includes(action) || label === REVIEW_EXEMPT_LABEL)) {
    await writeCheck(ctx, pr.head.sha, CHECKS.review, { conclusion: 'success', title: '例外（review:exempt）', summary: '人が判定を待たずに通しました。自動 Merge の経路には乗りません。' });
  }

  // fork からの PR は判定しない（例外ラベルでのみ通る）。自動経路にも乗らない
  if (!isSameRepoPr(pr, ctx.repository)) {
    await refreshMergeRoute(ctx, pr);
    return;
  }

  if (action === 'unlabeled' && ctx.event.label?.name === LABELS.hold) {
    await appComment(ctx, number, 'hold-removed', `\`agent:hold\` が @${ctx.event.sender?.login} により外されました（記録）。`);
    // 自動 Merge の条件を満たす判定があれば、auto-merge を付け直す（hold 中は付けていないため）
    const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(number), patchId(await prDiff(ctx.gh, pr)));
    if (acceptance?.autoEligible) {
      await applyAcceptance(ctx, pr, acceptance, { fresh: false });
      return;
    }
  }

  if (['opened', 'reopened', 'synchronize'].includes(action)) {
    const diff = await prDiff(ctx.gh, pr);
    const patch = patchId(diff);
    await writeScopeCheck(ctx, number, pr.head.sha);
    const comments = await ctx.gh.listComments(number);
    const acceptance = acceptanceForPatch(ctx.config, comments, patch);
    if (acceptance && action === 'synchronize') {
      ctx.log(`patch-id ${patch} は受け付け済みの判定と同じ。判定を引き継ぎます`);
      await applyAcceptance(ctx, pr, acceptance, { fresh: false });
      return;
    }
    // 判定前の PR は Draft にする（Draft＝判定前、Ready＝判定に合格して人のレビュー待ち）。出し方にかかわらずそろえる
    if (!acceptance && !pr.draft && !hasLabel(pr, REVIEW_EXEMPT_LABEL)) {
      await convertToDraft(ctx, pr);
      await appComment(ctx, number, 'draft-until-judged', '判定がまだ無いため Draft に戻しました。Reviewer と Risk Agent の判定に合格すると、App が Ready にします。');
    }
    await refreshMergeRoute(ctx, pr, { patch });
    return;
  }

  await refreshMergeRoute(ctx, pr);
}

async function writeScopeCheck(ctx: GateContext, number: number, headSha: string): Promise<void> {
  const planned = await plannedFilesForPr(ctx.gh, ctx.config, number);
  if ('missing' in planned) {
    await writeCheck(ctx, headSha, CHECKS.scope, { conclusion: 'neutral', title: '範囲照合できません', summary: `${planned.missing}。自動 Merge の対象外です。` });
    return;
  }
  const result = checkScope(planned.files, await changedFiles(ctx.gh, number));
  await writeCheck(ctx, headSha, CHECKS.scope, result.ok
    ? { conclusion: 'success', title: '計画の範囲内です', summary: planned.files.map((p) => `- \`${p}\``).join('\n') }
    : { conclusion: 'neutral', title: `計画の範囲外のファイルが ${result.outside.length} 件`, summary: ['自動 Merge の対象外です（Human Merge は可）。', '', ...result.outside.map((f) => `- \`${f}\``)].join('\n') });
}

/** 表示用の size:* と area:* を差分から付ける（Agent 以外の PR にも付ける） */
async function classifyPr(ctx: GateContext, pr: { number: number; labels: { name: string }[] }): Promise<void> {
  const files = await ctx.gh.paginate<ChangedFile & { previous_filename?: string }>(`/pulls/${pr.number}/files`, 30);
  const names = files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  const change = classificationChanges(pr.labels.map((l) => l.name), sizeLabel(ctx.config, files), areaLabels(ctx.config, names));
  for (const l of change.remove) await ctx.gh.removeLabel(pr.number, l);
  if (change.add.length > 0) await ctx.gh.addLabels(pr.number, change.add);
}

/** 必須チェック agent/title：PR のタイトルが Conventional Commits の形式か（squash Merge のコミットのタイトルになる） */
async function writeTitleCheck(ctx: GateContext, pr: { title: string; head: { sha: string } }): Promise<void> {
  const r = parseTitle(pr.title);
  await writeCheck(ctx, pr.head.sha, CHECKS.title, r.ok
    ? { conclusion: 'success', title: `${r.type}${r.scope ? `(${r.scope})` : ''}${r.breaking ? '!' : ''}`, summary: '' }
    : { conclusion: 'failure', title: 'タイトルが Conventional Commits の形式ではありません', summary: `${r.error}\n\n例：\`fix(harness): queue の更新漏れを直す\`` });
}
