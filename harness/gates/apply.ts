import { appLogin, CHECKS, LABELS, reasonMark, reasonOf, TEST_EXEMPT_LABEL } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import { exemptRecords, exemptState } from '../lib/exempt.ts';
import type { IssueComment } from '../lib/github.ts';
import { evaluateMergeRoute, type Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { checkScope } from '../lib/scope.ts';
import { classifyBase, type BaseKind } from '../lib/stack.ts';
import {
  acceptanceForPatch,
  appRecords,
  autoMergeMode,
  changedFiles,
  hasLabel,
  isAgentPr,
  isAppComment,
  isSameRepoPr,
  lastLabeled,
  plannedFilesForPr,
  prDiff,
  type PullRequest,
  type Review,
  type TimelineEvent,
} from '../lib/state.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering, renderTamperForHumanMerge, renderTamperSummary, type TamperFinding } from '../lib/test-tamper.ts';
import { appComment, convertToDraft, disableAutoMerge, enableAutoMerge, getPr, markReady, updateBranchIfBehind, writeCheck, type GateContext } from './context.ts';
import {
  DELEGATED_MERGE_END_KIND,
  DELEGATED_MERGE_END_TEXT,
  DELEGATED_MERGE_KIND,
  delegatedArm,
  delegatedRoute,
  delegationFor,
  latestDelegationRecord,
  type DelegatedMergeEndReason,
  type DelegatedMergeEndRecord,
  type DelegatedMergeRecord,
} from './delegation.ts';
import { writePlanLink } from './plan-link.ts';
import { testsHumanMerge, testsOutcome } from './tests-check.ts';

/**
 * 受け付けた判定を PR に反映する。順序が安全性の要：
 * 0. テストの改ざん検査で検出があれば agent/tests を、受け付けた判定で決まる経路に合わせて書き直す
 *    （Human Merge なら neutral、自動 Merge の対象なら failure。auto-merge を付けた後にも failure を書き直す）
 * 1. Ready 化と auto-merge の設定
 * 2. merge-route（直前に PR を取り直し、auto-merge の有無を見て書く）
 * 3. agent/risk（常に success、結果はサマリー）
 * 4. agent/review（必須チェック。これが書かれるまで Merge されない）
 * 5. 書き込み中に auto-merge の状態が変わっていたら merge-route を書き直す（別のゲート実行との競合対策）
 * チェックはすべて、判定を検証した head（pr.head.sha）に書く。
 * base が既定ブランチでない PR（Stacked PR・orphan-base）は自動の経路に乗せない（auto-merge も直接の Merge もしない）。
 * orphan-base の間は合格しても Ready にしない。pr は API で取り直したもの（stack を読む）を渡す。
 * 委任 Merge（delegation.ts）：自動 Merge の対象外でも委任で乗る（delegatedRoute）なら、delegated-merge を記録して auto-merge を付ける。
 * 乗らないのに前に委任で付けた記録が残っていれば、auto-merge を外し、delegated-merge-end と human-review を出す（fresh でなくても）。
 * delegation を渡したときは委任の状態を読み直さない（ラベルを付けたときに PR ごとに timeline を読まない）。
 */
export async function applyAcceptance(ctx: GateContext, pr: PullRequest, acceptance: Acceptance, opts: { fresh: boolean; diff: string; delegation?: DelegateState }): Promise<void> {
  const now = new Date();
  // 委任の状態は、要るとき（自動 Merge の対象外・テストの検出・merge-route）だけ1回読む
  let delegationP: Promise<DelegateState> | undefined;
  const getDelegation = () => (delegationP ??= opts.delegation ? Promise.resolve(opts.delegation) : delegationFor(ctx, now));
  const mayDelegate = acceptance.reviewPass && !acceptance.autoEligible && acceptance.delegate !== undefined;
  const tests = await rewriteTestsCheck(ctx, pr, acceptance, opts.diff, mayDelegate && acceptance.delegate?.eligible ? await getDelegation() : undefined);
  const hold = hasLabel(pr, LABELS.hold);
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  const base = classifyBase(pr, ctx.config.defaultBranch);
  const delegation = mayDelegate ? await getDelegation() : null;
  const route = delegation ? delegatedRoute(delegation, acceptance, ctx.config, now) : null;
  const delegated = route?.ok === true;
  // スタックに入る前に受け付けた古い記録（autoEligible が真）が残っていても、既定ブランチ宛てでなければ自動の経路に乗せない
  const wantAuto = acceptance.reviewPass && (acceptance.autoEligible || delegated) && mode && !hold && base === 'default';
  let armed = false;
  if (acceptance.reviewPass) {
    await dismissFixRequests(ctx, pr.number);
    if (base === 'orphan-base') ctx.log(`#${pr.number} は orphan-base のため Ready にしません`);
    else await markReady(ctx, pr);
    if (wantAuto) {
      if (!acceptance.autoEligible && delegation) await recordDelegatedMerge(ctx, pr, acceptance, delegation);
      armed = await enableAutoMerge(ctx, pr);
    } else {
      // 前に委任で付けた auto-merge が残っていれば（update-branch の push で判定を引き継いだが残りが短い など）、黙って Human Merge に戻さない
      const arm = delegatedArm(ctx.config, await ctx.gh.listComments(pr.number));
      if (opts.fresh || arm) {
        const why = [
          ...acceptance.reasons,
          ...(hold ? ['`agent:hold` が付いています'] : []),
          ...(!mode ? ['自動 Merge モードが無効です'] : []),
          ...(delegation?.active && route && !route.ok ? [route.reason] : []),
        ];
        if (arm) {
          const reason: DelegatedMergeEndReason = route && !route.ok && route.short ? 'short' : 'ineligible';
          await disableAutoMerge(ctx, await getPr(ctx, pr.number));
          await writeDelegationEnd(ctx, pr, reason);
          why.unshift(`委任 Merge が終わりました（${DELEGATED_MERGE_END_TEXT[reason]}）`);
        }
        await appComment(ctx, pr.number, 'human-review', renderHumanReview(ctx.gh.owner, acceptance, why, tests ?? undefined));
      }
    }
  }
  // auto-merge を付けた後にも止める側を書き直す（古い受け付けの記録で neutral を書いた別のゲート実行との競合対策）
  if (armed && tests) await writeCheck(ctx, pr.head.sha, CHECKS.tests, testsOutcome(tests.findings, []));
  const before = await getPr(ctx, pr.number);
  if (before.head.sha !== pr.head.sha) {
    ctx.log(`head が ${before.head.sha.slice(0, 7)} に進んだため反映を中止します（synchronize のゲートが処理する）`);
    return;
  }
  await writeMergeRoute(ctx, before, acceptance, mode, pr.head.sha, getDelegation);
  await writeCheck(ctx, pr.head.sha, CHECKS.risk, {
    conclusion: 'success',
    title: `Risk: ${acceptance.riskLevel}${acceptance.riskOk ? '' : '（自動 Merge 不可）'}`,
    summary: [
      `Claude の判定: ${acceptance.riskLevel}`,
      `Jev: ${acceptance.jev?.status ?? '-'} ${acceptance.jev?.detail ?? ''}`,
      '',
      '```json',
      JSON.stringify(acceptance.jev?.answers ?? {}, null, 2),
      '```',
    ].join('\n'),
  });
  await writeCheck(ctx, pr.head.sha, CHECKS.review, acceptance.reviewPass
    ? { conclusion: 'success', title: 'Reviewer 合格', summary: `判定コメント ${acceptance.verdictCommentId} を patch-id ${acceptance.patchId} で受け付けました。` }
    : { conclusion: 'failure', title: 'ブロッキング指摘あり', summary: '変更要求レビューを参照してください。' });

  const after = await getPr(ctx, pr.number);
  if (after.head.sha === pr.head.sha && Boolean(after.auto_merge) !== Boolean(before.auto_merge)) {
    ctx.log('書き込み中に auto-merge の状態が変わったため merge-route を書き直します');
    await writeMergeRoute(ctx, after, acceptance, mode, pr.head.sha, getDelegation);
  }
  if (wantAuto && !armed) await mergeDirectly(ctx, after, pr.head.sha);
  // auto-merge を付けた時点で main より遅れていると、追従のきっかけ（main への push）が来るまで止まるため、その場で追従させる
  if (armed) await updateBranchIfBehind(ctx, after);
}

/** 委任で auto-merge を付ける記録。同じ patchId・期限の記録が最新なら書かない（判定の引き継ぎやラベルの付け直しで二重に書かない） */
async function recordDelegatedMerge(ctx: GateContext, pr: PullRequest, acceptance: Acceptance, delegation: DelegateState): Promise<void> {
  const last = latestDelegationRecord(ctx.config, await ctx.gh.listComments(pr.number));
  if (last?.kind === 'delegated-merge' && last.value.patchId === acceptance.patchId && last.value.until === delegation.until) return;
  const skipped = acceptance.delegate?.skipped ?? [];
  await appComment(ctx, pr.number, DELEGATED_MERGE_KIND, [
    `委任 Merge で自動経路に乗せました（期限 ${delegation.until}、@${delegation.by}）。次の理由を飛ばしています。`,
    '',
    ...(skipped.length > 0 ? skipped.map((r) => `- ${r}`) : ['- （なし）']),
  ].join('\n'), {
    version: 1,
    headSha: pr.head.sha,
    patchId: acceptance.patchId,
    since: delegation.since,
    until: delegation.until,
    by: delegation.by,
    skipped,
  } satisfies DelegatedMergeRecord);
}

/** 委任で付けた auto-merge を外した記録（kind=delegated-merge-end）。auto-merge を外すのは呼ぶ側 */
export async function writeDelegationEnd(ctx: GateContext, pr: PullRequest, reason: DelegatedMergeEndReason): Promise<void> {
  await appComment(ctx, pr.number, DELEGATED_MERGE_END_KIND, `委任 Merge が終わりました（${DELEGATED_MERGE_END_TEXT[reason]}）。委任で付けた auto-merge を外し、Human Merge に戻しました。`, {
    version: 1,
    headSha: pr.head.sha,
    reason,
  } satisfies DelegatedMergeEndRecord);
}

/**
 * 受け付けた判定で agent/tests を書き直す。検出が0件なら何もしない（API を呼ばない）。
 * test:exempt が効いていれば書かない（on-pr.ts の結果のまま）。書いたときは検出と、緩めたか（Human Merge か）を返す。
 * delegation は委任の状態（委任で自動経路に乗るなら止める。tests-check.ts の testsHumanMerge）。
 */
export async function rewriteTestsCheck(ctx: GateContext, pr: PullRequest, acceptance: Acceptance, diff: string, delegation?: DelegateState): Promise<{ findings: TamperFinding[]; relaxed: boolean } | null> {
  const findings = detectTestTampering(diff, ctx.config.testPatterns ?? DEFAULT_TEST_PATTERNS);
  if (findings.length === 0) return null;
  const exempt = exemptState(exemptRecords(ctx.config, await ctx.gh.listComments(pr.number), TEST_EXEMPT_LABEL), hasLabel(pr, TEST_EXEMPT_LABEL), patchId(diff));
  if (exempt === 'valid') return null;
  const reasons = await testsHumanMerge(ctx, pr, acceptance, delegation);
  await writeCheck(ctx, pr.head.sha, CHECKS.tests, testsOutcome(findings, reasons));
  return { findings, relaxed: reasons.length > 0 };
}

/**
 * auto-merge を付けられなかったとき（必須チェックがすでに揃っている PR など）。条件は確認済みなので、
 * 判定を検証した head を指定して App が直接 Merge する。失敗したら人に知らせる。
 */
async function mergeDirectly(ctx: GateContext, pr: PullRequest, headSha: string): Promise<void> {
  if (pr.state !== 'open' || pr.head.sha !== headSha) return;
  try {
    await ctx.gh.request('PUT', `/pulls/${pr.number}/merge`, { body: { sha: headSha, merge_method: ctx.config.mergeMethod.toLowerCase() } });
    ctx.log(`#${pr.number} を直接 Merge しました`);
  } catch (e) {
    await appComment(ctx, pr.number, 'human-review', `@${ctx.gh.owner} 自動 Merge の条件を満たしていますが、auto-merge の設定も直接の Merge もできませんでした。確認してください。\n\n\`${(e as Error).message.slice(0, 300)}\``);
  }
}

/**
 * merge-route を書く。委任 Merge の状態（delegateMode）は書くたびに今の状態から求める（期限切れ・ラベル無し・停止スイッチなら偽）。
 * 委任が効きうるとき（auto-merge が付いていて、受け付けが自動 Merge の対象外で委任の可否の記録がある）だけ状態を読む。
 */
async function writeMergeRoute(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, mode: boolean, headSha: string, getDelegation: () => Promise<DelegateState>): Promise<void> {
  const autoMergeEnabled = pr.auto_merge !== null && pr.auto_merge !== undefined;
  const delegateMode = autoMergeEnabled && acceptance !== null && !acceptance.autoEligible && acceptance.delegate !== undefined
    ? (await getDelegation()).active
    : false;
  const outcome = evaluateMergeRoute({
    autoMergeEnabled: pr.auto_merge !== null && pr.auto_merge !== undefined,
    isAgentPr: isAgentPr(ctx.config, pr, ctx.repository),
    hold: hasLabel(pr, LABELS.hold),
    autoMergeMode: mode,
    acceptance,
    stacked: classifyBase(pr, ctx.config.defaultBranch) !== 'default',
    delegateMode,
  });
  await writeCheck(ctx, headSha, CHECKS.mergeRoute, outcome);
}

/**
 * 現在の差分に対する受け付け記録を探して merge-route を書き直す（PR は最新を取り直す）。
 * delegation を渡したときは委任の状態を読み直さない（委任を終えたときは無効の状態を渡す）。
 */
export async function refreshMergeRoute(ctx: GateContext, stale: PullRequest, known?: { patch: string }, delegation?: DelegateState): Promise<Acceptance | null> {
  const pr = await getPr(ctx, stale.number);
  const judged = isSameRepoPr(pr, ctx.repository);
  let acceptance: Acceptance | null = null;
  if (judged) {
    const patch = known && pr.head.sha === stale.head.sha ? known.patch : patchId(await prDiff(ctx.gh, pr));
    acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patch);
  }
  await writeMergeRoute(ctx, pr, acceptance, await autoMergeMode(ctx.gh, ctx.config), pr.head.sha, () => (delegation ? Promise.resolve(delegation) : delegationFor(ctx, new Date())));
  return acceptance;
}

/**
 * agent/scope（情報表示用）：計画の files と変更ファイルの照合。
 * on-pr.ts と stale.ts（スタックに入った PR の書き直し）から呼ぶため、ここに置く（on-pr.ts に置くと import が循環する）。
 */
export async function writeScopeCheck(ctx: GateContext, number: number, headSha: string): Promise<void> {
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

/** App が PR に残す orphan-base の記録（kind=orphan-base） */
export interface OrphanBaseRecord {
  version: 1;
  base: string;
  headSha: string;
}

/** orphan-base が解消した記録（kind=base-resolved） */
export interface BaseResolvedRecord {
  version: 1;
  base: string;
  kind: Exclude<BaseKind, 'orphan-base'>;
}

/** App の orphan-base／base-resolved の記録のうち最新のもの */
function latestBaseRecord(ctx: GateContext, comments: IssueComment[]): { kind: 'orphan-base'; value: OrphanBaseRecord } | { kind: 'base-resolved'; value: BaseResolvedRecord } | null {
  const all = [
    ...appRecords<OrphanBaseRecord>(ctx.config, comments, 'orphan-base').map((r) => ({ kind: 'orphan-base' as const, ...r })),
    ...appRecords<BaseResolvedRecord>(ctx.config, comments, 'base-resolved').map((r) => ({ kind: 'base-resolved' as const, ...r })),
  ];
  const order = new Map(comments.map((c, i) => [c, i]));
  const last = all.sort((a, b) => order.get(a.comment)! - order.get(b.comment)!).at(-1);
  if (!last) return null;
  return last.kind === 'orphan-base' ? { kind: last.kind, value: last.value as OrphanBaseRecord } : { kind: last.kind, value: last.value as BaseResolvedRecord };
}

/** App の orphan-base の記録が最新で、まだ解消の記録が無いか */
export async function orphanRecorded(ctx: GateContext, number: number): Promise<boolean> {
  return latestBaseRecord(ctx, await ctx.gh.listComments(number))?.kind === 'orphan-base';
}

/**
 * スタックでないのに base が既定ブランチ以外の PR（orphan-base）を Merge できない状態に留める：
 * auto-merge を外し、Draft に戻し、理由コード orphan-base 付きの記録と agent:blocked を付ける。
 * 同じ base の orphan-base の記録が最新なら、記録とラベルは付け直さない（人が agent:blocked を外した判断を尊重する）。
 * pr は API で取り直したもの。
 */
export async function enforceBase(ctx: GateContext, pr: PullRequest): Promise<void> {
  await disableAutoMerge(ctx, pr);
  await convertToDraft(ctx, pr);
  const latest = latestBaseRecord(ctx, await ctx.gh.listComments(pr.number));
  if (latest?.kind === 'orphan-base' && latest.value.base === pr.base.ref) {
    ctx.log(`#${pr.number} は orphan-base の記録があるため Draft に戻すだけにします`);
    return;
  }
  await appComment(ctx, pr.number, 'orphan-base', [
    reasonMark('orphan-base'),
    `この PR の base（\`${pr.base.ref}\`）は既定ブランチ（\`${ctx.config.defaultBranch}\`）ではなく、GitHub のスタックにも入っていません。Merge できないよう Draft に留め、\`${LABELS.blocked}\` にしました。`,
    '',
    `base を \`${ctx.config.defaultBranch}\` に変えるか、スタックに組み込んでください（組み込まれると App が通常の流れに戻します）。`,
  ].join('\n'), { version: 1, base: pr.base.ref, headSha: pr.head.sha } satisfies OrphanBaseRecord);
  await ctx.gh.addLabels(pr.number, [LABELS.blocked]);
}

/**
 * orphan-base でなくなった PR を通常の流れに戻す。App の最新の記録が orphan-base のときだけ行い、行ったら true を返す。
 * 1. App が orphan-base の理由で付けた agent:blocked を外す（人が付けたもの・別の理由のものは外さない）
 * 2. base-resolved を記録する
 * 3. agent/plan-link と agent/scope を書き直す（スタックに入る前の PR として書かれたまま残っているため）
 * 4. 現在の差分に受け付けがあれば applyAcceptance で Ready 化と merge-route をやり直し、無ければ merge-route だけ書き直す
 * pr は API で取り直したもの。
 */
export async function resumeFromOrphan(ctx: GateContext, pr: PullRequest, kind: Exclude<BaseKind, 'orphan-base'>): Promise<boolean> {
  const comments = await ctx.gh.listComments(pr.number);
  if (latestBaseRecord(ctx, comments)?.kind !== 'orphan-base') return false;
  if (hasLabel(pr, LABELS.blocked)) {
    const events = await ctx.gh.paginate<TimelineEvent>(`/issues/${pr.number}/events`);
    const byApp = lastLabeled(events, LABELS.blocked)?.actor?.login === appLogin(ctx.config);
    const reason = [...comments].reverse().filter((c) => isAppComment(ctx.config, c)).map((c) => reasonOf(c.body)).find((r) => r !== null) ?? null;
    if (byApp && reason === 'orphan-base') {
      await ctx.gh.removeLabel(pr.number, LABELS.blocked);
      pr.labels = pr.labels.filter((l) => l.name !== LABELS.blocked);
    }
  }
  await appComment(ctx, pr.number, 'base-resolved', `base の問題が解消しました（${kind === 'stacked' ? 'スタックに組み込まれました' : `base が \`${ctx.config.defaultBranch}\` になりました`}）。通常の流れに戻します。`, { version: 1, base: pr.base.ref, kind } satisfies BaseResolvedRecord);
  await writePlanLink(ctx, pr);
  await writeScopeCheck(ctx, pr.number, pr.head.sha);
  const diff = isSameRepoPr(pr, ctx.repository) ? await prDiff(ctx.gh, pr) : null;
  const acceptance = diff === null ? null : acceptanceForPatch(ctx.config, comments, patchId(diff));
  if (acceptance && diff !== null) await applyAcceptance(ctx, pr, acceptance, { fresh: false, diff });
  else await refreshMergeRoute(ctx, pr);
  return true;
}

/** 合格した判定を受け付けたら、App が以前に出した変更要求レビューを解除する（回数は解除済みも数える） */
async function dismissFixRequests(ctx: GateContext, number: number): Promise<void> {
  const reviews = await ctx.gh.paginate<Review>(`/pulls/${number}/reviews`);
  for (const r of reviews) {
    if (r.state !== 'CHANGES_REQUESTED' || r.user?.login !== appLogin(ctx.config)) continue;
    await ctx.gh.request('PUT', `/pulls/${number}/reviews/${r.id}/dismissals`, {
      body: { message: '修正後の判定で Reviewer が合格としたため解除します。', event: 'DISMISS' },
    });
  }
}

/** 人へのレビュー依頼。何が懸念で、どこを見てほしいかを先に書く */
export function renderHumanReview(owner: string, a: Acceptance, why: string[], tests?: { findings: TamperFinding[]; relaxed: boolean }): string {
  const list = (items: string[] | undefined, empty: string) => (items && items.length > 0 ? items.map((x) => `- ${x}`) : [`- ${empty}`]);
  // テストの行を変える変更は、懸念点より前に目立つ形で載せる（人は Merge の前にこれを読む）
  const testLines = tests && tests.findings.length > 0
    ? [
        '> [!IMPORTANT]',
        `> テストの行を変える変更が ${tests.findings.length} 件あります。`,
        tests.relaxed
          ? `> \`${CHECKS.tests}\` は Human Merge のため止めていません。Merge の前に下の行を確かめてください（\`${TEST_EXEMPT_LABEL}\` は要りません）。`
          : `> \`${CHECKS.tests}\` は止めています（自動 Merge に戻りうるため）。確かめて問題が無ければ \`${TEST_EXEMPT_LABEL}\` を付けてください。`,
        '',
        '### テストの変更（Merge の前に確かめる）',
        '',
        // 止めているとき（hold・自動 Merge モードの停止だけが理由）は、例外ラベルでの通し方も含む説明にする
        tests.relaxed ? renderTamperForHumanMerge(tests.findings, 30) : renderTamperSummary(tests.findings, 30, TEST_EXEMPT_LABEL),
        '',
      ]
    : [];
  return [
    `@${owner} レビューをお願いします（Human Merge）。Reviewer は合格、Risk は ${a.riskLevel} です。`,
    '',
    ...testLines,
    '### 懸念点',
    ...list(a.humanNotes?.concerns, '（Reviewer から特になし）'),
    '',
    '### 見てほしい箇所',
    ...list(a.humanNotes?.checkPoints, '（Reviewer から特になし）'),
    '',
    '### Risk の根拠',
    a.riskRationale ?? '（記録なし）',
    '',
    '<details><summary>自動 Merge しない理由</summary>',
    '',
    ...why.map((r) => `- ${r}`),
    '',
    '</details>',
  ].join('\n');
}
