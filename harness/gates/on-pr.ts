import { areaLabels, classificationChanges, sizeLabel, type ChangedFile } from '../lib/classify.ts';
import { CHECKS, LABELS, PLAN_EXEMPT_LABEL, REVIEW_EXEMPT_LABEL, TEST_EXEMPT_LABEL } from '../lib/config.ts';
import { writePlanLink } from './plan-link.ts';
import { parseTitle } from '../lib/title.ts';
import { patchId } from '../lib/patch-id.ts';
import { checkScope } from '../lib/scope.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering, renderTamperSummary } from '../lib/test-tamper.ts';
import { EXEMPT_KINDS, EXEMPT_STALE_KIND, exemptRecords, exemptState, staleNotified, type ExemptRecord, type ExemptStaleRecord, type ExemptState } from '../lib/exempt.ts';
import type { IssueComment } from '../lib/github.ts';
import { acceptanceForPatch, changedFiles, hasLabel, isSameRepoPr, plannedFilesForPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, refreshMergeRoute } from './apply.ts';
import { appComment, convertToDraft, disableAutoMerge, getPr, writeCheck, type GateContext } from './context.ts';

/**
 * pull_request_target：PR の head は checkout せず、中身は API で読むだけ。
 * - push（synchronize）：まず auto-merge を解除し、差分が同じなら過去の判定を引き継ぐ
 * - 範囲照合（agent/scope、情報表示用）
 * - テストの改ざん検査（agent/tests、必須。fork の PR も）
 * - 例外ラベル（review:exempt・test:exempt）は付けた時点の差分（patch-id）にだけ効かせる
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

  // 例外ラベル（人だけが付ける）は付けた時点の差分にだけ効く。付け外しをその時点の patch-id とともに App が記録する
  const triggers = ['opened', 'reopened', 'synchronize'].includes(action);
  let diff: Promise<string> | undefined;
  const getDiff = () => (diff ??= prDiff(ctx.gh, pr));
  let currentPatch: Promise<string> | undefined;
  const getPatch = () => (currentPatch ??= getDiff().then(patchId));
  let prComments: Promise<IssueComment[]> | undefined;
  const getComments = () => (prComments ??= ctx.gh.listComments(number));
  const recorded = new Map<string, ExemptRecord>();
  if ((action === 'labeled' || action === 'unlabeled') && label !== undefined && Object.hasOwn(EXEMPT_KINDS, label)) {
    recorded.set(label, await recordExempt(ctx, pr, action, label, getDiff));
  }
  const stateOf = async (l: string): Promise<ExemptState> => {
    const present = hasLabel(pr, l) && !(action === 'unlabeled' && label === l);
    if (!present) return 'off';
    const just = recorded.get(l);
    return exemptState(just ? [just] : exemptRecords(ctx.config, await getComments(), l), true, await getPatch());
  };

  // 判定を待たずに通す例外（review:exempt）。外されたら判定待ちに戻す
  let reviewExempt: ExemptState = 'off';
  if (triggers || label === REVIEW_EXEMPT_LABEL) {
    reviewExempt = await stateOf(REVIEW_EXEMPT_LABEL);
    if (action === 'unlabeled' && label === REVIEW_EXEMPT_LABEL) {
      await writeCheck(ctx, pr.head.sha, CHECKS.review, { conclusion: 'failure', title: '判定待ち（例外が外されました）', summary: 'Reviewer と Risk Agent の判定を受け付けると書き直されます。' });
    }
    if (reviewExempt === 'valid') {
      await writeCheck(ctx, pr.head.sha, CHECKS.review, { conclusion: 'success', title: '例外（review:exempt）', summary: '人が判定を待たずに通しました。自動 Merge の経路には乗りません。' });
    } else if (reviewExempt !== 'off') {
      // 受け付け済みの判定が同じ差分にあれば、その結果を後で書く（push の判定の引き継ぎ）。無ければ判定待ち
      if (!acceptanceForPatch(ctx.config, await getComments(), await getPatch())) {
        await writeCheck(ctx, pr.head.sha, CHECKS.review, { conclusion: 'failure', title: `判定待ち（${REVIEW_EXEMPT_LABEL} は効いていません）`, summary: `例外は付けた時点の差分にだけ効きます。差分を確認して通すなら、\`${REVIEW_EXEMPT_LABEL}\` を外して付け直してください。` });
      }
      await notifyExemptNotApplied(ctx, pr, REVIEW_EXEMPT_LABEL, reviewExempt, CHECKS.review, getComments, getPatch);
    }
  }

  // テストの改ざん検査（fork の PR にも書く）。例外は人が付ける test:exempt
  if (triggers || label === TEST_EXEMPT_LABEL) {
    const testExempt = await stateOf(TEST_EXEMPT_LABEL);
    await writeTestsCheck(ctx, pr, getDiff, testExempt === 'valid');
    if (testExempt === 'stale' || testExempt === 'unrecorded') await notifyExemptNotApplied(ctx, pr, TEST_EXEMPT_LABEL, testExempt, CHECKS.tests, getComments, getPatch);
  }

  // fork からの PR は判定しない（例外ラベルでのみ通る）。自動経路にも乗らない
  if (!isSameRepoPr(pr, ctx.repository)) {
    await refreshMergeRoute(ctx, pr);
    return;
  }

  if (action === 'unlabeled' && ctx.event.label?.name === LABELS.hold) {
    await appComment(ctx, number, 'hold-removed', `\`agent:hold\` が @${ctx.event.sender?.login} により外されました（記録）。`);
    // 自動 Merge の条件を満たす判定があれば、auto-merge を付け直す（hold 中は付けていないため）
    const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(number), patchId(await getDiff()));
    if (acceptance?.autoEligible) {
      await applyAcceptance(ctx, pr, acceptance, { fresh: false });
      return;
    }
  }

  if (triggers) {
    const patch = await getPatch();
    await writeScopeCheck(ctx, number, pr.head.sha);
    const comments = await ctx.gh.listComments(number);
    const acceptance = acceptanceForPatch(ctx.config, comments, patch);
    if (acceptance && action === 'synchronize') {
      ctx.log(`patch-id ${patch} は受け付け済みの判定と同じ。判定を引き継ぎます`);
      await applyAcceptance(ctx, pr, acceptance, { fresh: false });
      return;
    }
    // 判定前の PR は Draft にする（Draft＝判定前、Ready＝判定に合格して人のレビュー待ち）。出し方にかかわらずそろえる
    if (!acceptance && !pr.draft && reviewExempt !== 'valid') {
      await convertToDraft(ctx, pr);
      await appComment(ctx, number, 'draft-until-judged', '判定がまだ無いため Draft に戻しました。Reviewer と Risk Agent の判定に合格すると、App が Ready にします。');
    }
    await refreshMergeRoute(ctx, pr, { patch });
    return;
  }

  await refreshMergeRoute(ctx, pr);
}

/**
 * 例外ラベルの付け外しを記録する。patch-id は人がラベルを付けた時点の head（イベントの中身）の差分で取る
 * （ゲートが動くまでに push されていても、人が見ていない差分を記録しない）。
 */
async function recordExempt(ctx: GateContext, pr: PullRequest, action: 'labeled' | 'unlabeled', label: string, getDiff: () => Promise<string>): Promise<ExemptRecord> {
  const eventHead = ctx.event.pull_request?.head?.sha as string | undefined;
  const headSha = eventHead ?? pr.head.sha;
  const diff = headSha === pr.head.sha ? await getDiff() : await prDiff(ctx.gh, pr, headSha);
  const by = (ctx.event.sender?.login as string | undefined) ?? '';
  const record: ExemptRecord = { version: 1, label, action, by, patchId: patchId(diff), headSha };
  await appComment(ctx, pr.number, EXEMPT_KINDS[label]!, `\`${label}\` が @${by} により${action === 'labeled' ? '付けられました' : '外されました'}（記録）。例外は付けた時点の差分にだけ効きます。`, record);
  return record;
}

/** ラベルは付いているが例外が効いていないことを知らせる（同じ head には二重に書かない） */
async function notifyExemptNotApplied(ctx: GateContext, pr: PullRequest, label: string, reason: 'stale' | 'unrecorded', check: string, getComments: () => Promise<IssueComment[]>, getPatch: () => Promise<string>): Promise<void> {
  if (staleNotified(ctx.config, await getComments(), label, pr.head.sha)) return;
  const why = reason === 'stale' ? 'ラベルを付けた後に差分が変わったため' : 'ラベルを付けた時点の差分の記録が無いため';
  const record: ExemptStaleRecord = { version: 1, label, headSha: pr.head.sha, patchId: await getPatch(), reason };
  await appComment(ctx, pr.number, EXEMPT_STALE_KIND, [
    `\`${label}\` は付いていますが、${why}、この head（${pr.head.sha.slice(0, 7)}）では効きません。\`${check}\` は通常どおり評価しました。`,
    `例外は付けた時点の差分にだけ効きます。差分を確認して通すなら、ラベルを外して付け直してください。`,
  ].join('\n'), record);
}

/** 必須チェック agent/tests：テストの削除・skip の追加・アサーションの変更を差分から検出する */
async function writeTestsCheck(ctx: GateContext, pr: PullRequest, getDiff: () => Promise<string>, exempt: boolean): Promise<void> {
  if (exempt) {
    await writeCheck(ctx, pr.head.sha, CHECKS.tests, { conclusion: 'success', title: `例外（${TEST_EXEMPT_LABEL}）`, summary: '人がテストを弱める変更を例外として通しました。' });
    return;
  }
  const findings = detectTestTampering(await getDiff(), ctx.config.testPatterns ?? DEFAULT_TEST_PATTERNS);
  await writeCheck(ctx, pr.head.sha, CHECKS.tests, findings.length === 0
    ? { conclusion: 'success', title: 'テストを弱める変更はありません', summary: '' }
    : { conclusion: 'failure', title: `テストを弱める変更が ${findings.length} 件`, summary: [`Issue 本文にテストを変える理由があれば、人が \`${TEST_EXEMPT_LABEL}\` を付けて通します。`, '', renderTamperSummary(findings)].join('\n') });
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
