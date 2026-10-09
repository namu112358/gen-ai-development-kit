import { areaLabels, classificationChanges, sizeLabel, type ChangedFile } from '../lib/classify.ts';
import { CHECKS, LABELS, PLAN_EXEMPT_LABEL, REVIEW_EXEMPT_LABEL, TEST_EXEMPT_LABEL } from '../lib/config.ts';
import { writePlanLink } from './plan-link.ts';
import { parseTitle } from '../lib/title.ts';
import { patchId } from '../lib/patch-id.ts';
import { classifyBase } from '../lib/stack.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';
import { EXEMPT_KINDS, EXEMPT_STALE_KIND, exemptRecords, exemptState, staleNotified, type ExemptRecord, type ExemptStaleRecord, type ExemptState } from '../lib/exempt.ts';
import type { IssueComment } from '../lib/github.ts';
import { acceptanceForPatch, hasLabel, isAgentPr, isSameRepoPr, prDiff, type PullRequest } from '../lib/state.ts';
import { applyAcceptance, enforceBase, refreshMergeRoute, resumeFromOrphan, writeScopeCheck } from './apply.ts';
import { appComment, convertToDraft, disableAutoMerge, getPr, writeCheck, type GateContext } from './context.ts';
import { autoModeFor, autoModeRoute } from './auto-mode.ts';
import { bypassFor, bypassRoute } from './bypass.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';
import { applyAppLabels } from './label-apply.ts';
import { notifyUnclaimedPush } from './push-claim.ts';
import { testsHumanMerge, testsJevSidePasses, testsOutcome } from './tests-check.ts';
import { testMoveJevFor } from './tests-move.ts';
import { tamperJevFor } from './tests-jev.ts';
import { autoModeTestsFor } from './auto-mode-tests.ts';
import type { Acceptance } from '../lib/merge-route.ts';

/**
 * PR の出来事（作成・push・編集・ラベル）ごとの処理。
 * pull_request_target：PR の head は checkout せず、中身は API で読むだけ。
 * - push（synchronize）：まず auto-merge を解除し、差分が同じなら過去の判定を引き継ぐ
 * - 作成とタイトルの編集で type:* を付ける（App が前に付けたものだけ付け替える。label-apply.ts）
 * - push（synchronize）で、着手宣言の無いセッションの push を知らせる（止めない。push-claim.ts）
 * - 範囲照合（agent/scope、情報表示用）
 * - テストの改ざん検査（agent/tests、必須。fork の PR も）
 * - 例外ラベル（review:exempt・test:exempt）は付けた時点の差分（patch-id）にだけ効かせる
 * - hold・auto-merge の変化で merge-route を書き直す
 * - base の見分け（stack.ts）：スタックでないのに base が既定ブランチ以外（orphan-base）なら Draft に留め、
 *   スタックに組み込まれたら（stacked・base の付け替え）通常の流れに戻す
 * - 人が Ready にしたとき（ready_for_review）は、判定前なら Draft に戻す
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

  // base の見分け。スタックに入るのは PR を作った後なので、作成・push・Ready・stacked・base の付け替えのたびに見る
  const baseChanged = action === 'edited' && Boolean(ctx.event.changes?.base);
  if (['opened', 'reopened', 'synchronize', 'ready_for_review', 'stacked'].includes(action) || baseChanged) {
    const kind = classifyBase(pr, ctx.config.defaultBranch);
    if (kind === 'orphan-base') {
      // 先に Draft にしておくので、この後の draft-until-judged のコメントは重ならない
      await enforceBase(ctx, pr);
    } else if (action === 'stacked' || baseChanged) {
      if (await resumeFromOrphan(ctx, pr, kind)) return;
      if (action === 'stacked') {
        // 最初から問題の無かった PR：スタックでない PR として書かれた plan-link と scope を書き直す
        await writePlanLink(ctx, pr);
        await writeScopeCheck(ctx, number, pr.head.sha);
        await refreshMergeRoute(ctx, pr);
        return;
      }
    }
    if (action === 'stacked') return;
    if (action === 'ready_for_review') {
      if (kind !== 'orphan-base') await draftUntilJudged(ctx, pr);
      await refreshMergeRoute(ctx, pr);
      return;
    }
  }

  const label = ctx.event.label?.name as string | undefined;
  if (['opened', 'reopened', 'synchronize', 'edited'].includes(action)) await writeTitleCheck(ctx, pr);
  if (['opened', 'reopened', 'synchronize', 'edited'].includes(action) || label === PLAN_EXEMPT_LABEL) await writePlanLink(ctx, pr);
  if (action === 'opened' || (action === 'edited' && ctx.event.changes?.title)) {
    await applyAppLabels(ctx, number, { kind: 'pr', title: pr.title, labels: pr.labels.map((l) => l.name) }, () => ctx.gh.listComments(number));
  }
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
  if (action === 'synchronize') await notifyUnclaimedPush(ctx, pr, getComments);
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
    await writeTestsCheck(ctx, pr, getDiff, testExempt === 'valid', getComments, getPatch);
    if (testExempt === 'stale' || testExempt === 'unrecorded') await notifyExemptNotApplied(ctx, pr, TEST_EXEMPT_LABEL, testExempt, CHECKS.tests, getComments, getPatch);
  }

  // fork からの PR は判定しない（例外ラベルでのみ通る）。自動経路にも乗らない
  if (!isSameRepoPr(pr, ctx.repository)) {
    await refreshMergeRoute(ctx, pr);
    return;
  }

  if (action === 'unlabeled' && ctx.event.label?.name === LABELS.hold) {
    await appComment(ctx, number, 'hold-removed', `\`agent:hold\` が @${ctx.event.sender?.login} により外されました（記録）。`);
    // 自動 Merge の条件を満たす判定（委任が有効なら委任で乗る判定、auto mode が有効なら auto mode で乗る判定、bypass が有効なら bypass で乗る判定も）があれば、
    // auto-merge を付け直す（hold 中は付けていないため）。順番は 委任 → auto mode → bypass
    const acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(number), patchId(await getDiff()));
    const now = new Date();
    const delegation = acceptance?.reviewPass && !acceptance.autoEligible && acceptance.delegate?.eligible ? await delegationFor(ctx, now) : undefined;
    const delegated = Boolean(acceptance && delegation && delegatedRoute(delegation, acceptance).ok);
    const autoMode = !delegated && acceptance?.reviewPass && !acceptance.autoEligible && acceptance.autoMode?.eligible ? await autoModeFor(ctx) : undefined;
    const autoModed = Boolean(autoMode && autoModeRoute(autoMode, acceptance).ok);
    const bypass = !delegated && !autoModed && acceptance?.reviewPass && !acceptance.autoEligible && acceptance.bypass?.eligible ? await bypassFor(ctx) : undefined;
    const bypassed = Boolean(bypass && bypassRoute(bypass, acceptance).ok);
    if (acceptance && (acceptance.autoEligible || delegated || autoModed || bypassed)) {
      await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff: await getDiff(), ...(delegation ? { delegation } : {}), ...(autoMode ? { autoMode } : {}), ...(bypass ? { bypass } : {}) });
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
      await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff: await getDiff() });
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

/**
 * 必須チェック agent/tests：テストの削除・skip の追加・アサーションの変更を差分から検出する。
 * 検出があっても、人が Merge する PR（Human Merge）なら止めずに neutral にする（tests-check.ts）。auto-merge が付いていれば緩めない。
 * 委任承認（計画＋Merge）で自動経路に乗る PR は止める（testsHumanMerge が委任の状態を読んで決める）。
 * 検出があれば Jev に問い（tests-jev.ts）、jev.testTamper が enforce で Jev が通せば、緩めないときでも success にする（Q95）。
 * auto mode の経路の PR は、今の差分の受け付けがあれば妥当かを Jev に問い（auto-mode-tests.ts）、妥当と答えれば success にする（Issue #349）。
 * テストファイルの削除は、本文に対応表があれば移し先を Jev に問い（tests-move.ts）、通れば削除では止めない。削除以外の検出は削除を除いて jev.testTamper に問う（Issue #514）。
 * PR の作成・push の直後は受け付けが無いので問わない（判定の受け付けの apply.ts の rewriteTestsCheck で問う）。
 */
async function writeTestsCheck(ctx: GateContext, pr: PullRequest, getDiff: () => Promise<string>, exempt: boolean, getComments: () => Promise<IssueComment[]>, getPatch: () => Promise<string>): Promise<void> {
  if (exempt) {
    await writeCheck(ctx, pr.head.sha, CHECKS.tests, { conclusion: 'success', title: `例外（${TEST_EXEMPT_LABEL}）`, summary: '人がテストを弱める変更を例外として通しました。' });
    return;
  }
  const findings = detectTestTampering(await getDiff(), ctx.config.testPatterns ?? DEFAULT_TEST_PATTERNS);
  let reasons: string[] = [];
  let acceptance: Acceptance | null = null;
  if (findings.length > 0 && isAgentPr(ctx.config, pr, ctx.repository)) {
    acceptance = acceptanceForPatch(ctx.config, await getComments(), await getPatch());
    reasons = await testsHumanMerge(ctx, pr, acceptance);
    // 書く直前に取り直し、auto-merge が付いていれば緩めない
    if (reasons.length > 0 && (await getPr(ctx, pr.number)).auto_merge) reasons = [];
  }
  // Agent PR でない同じリポジトリの PR でも問って記録する（fork・off・鍵なし・問えない検出は tamperJevFor が問わない）
  const rest = findings.filter((f) => f.kind !== 'deleted-file');
  const hasDeletion = rest.length < findings.length;
  const jev = findings.length === 0 ? undefined : hasDeletion ? (rest.length > 0 ? await tamperJevFor(ctx, pr, rest, getPatch, getComments) : undefined) : await tamperJevFor(ctx, pr, findings, getPatch, getComments);
  const move = hasDeletion ? await testMoveJevFor(ctx, pr, findings, getDiff, getPatch, getComments) : undefined;
  // auto mode の経路の PR（今の差分の受け付けがあるときだけ）は、妥当かを Jev に問う。jev.testTamper の enforce で先に通るなら問わない
  const jevSidePasses = testsJevSidePasses(findings, jev, move);
  const autoMode = findings.length > 0 && reasons.length === 0 && !jevSidePasses && acceptance ? await autoModeTestsFor(ctx, pr, findings, acceptance, getDiff, getPatch, getComments) : undefined;
  await writeCheck(ctx, pr.head.sha, CHECKS.tests, testsOutcome(findings, reasons, jev, autoMode, move));
}

/**
 * 人が Ready にした PR（ready_for_review）：判定前なら Draft に戻す（opened などと同じ条件）。
 * 同じリポジトリの PR で、現在の差分に受け付けが無く、review:exempt が効いていないとき。fork の PR は判定しないので戻さない。
 */
async function draftUntilJudged(ctx: GateContext, pr: PullRequest): Promise<void> {
  if (pr.draft || !isSameRepoPr(pr, ctx.repository)) return;
  const patch = patchId(await prDiff(ctx.gh, pr));
  const comments = await ctx.gh.listComments(pr.number);
  if (acceptanceForPatch(ctx.config, comments, patch)) return;
  if (exemptState(exemptRecords(ctx.config, comments, REVIEW_EXEMPT_LABEL), hasLabel(pr, REVIEW_EXEMPT_LABEL), patch) === 'valid') return;
  await convertToDraft(ctx, pr);
  await appComment(ctx, pr.number, 'draft-until-judged', '判定がまだ無いため Draft に戻しました。Reviewer と Risk Agent の判定に合格すると、App が Ready にします。');
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
