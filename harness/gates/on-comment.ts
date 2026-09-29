import { createHash } from 'node:crypto';
import { extractBlock } from '../lib/blocks.ts';
import { answeredPlan } from '../lib/decision.ts';
import { appLogin, LABELS, reasonMark, type ReasonCode } from '../lib/config.ts';
import { delegateEligibility, delegateExcludeFiles, delegateModeName, delegatePlanGate, type DelegateState } from '../lib/delegate.ts';
import type { IssueComment } from '../lib/github.ts';
import { guardrailFiles, humanMergeFiles } from '../lib/guardrail.ts';
import { callJev } from '../lib/jev.ts';
import { eligibility, type Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { evaluatePlanGate, parsePlan, planReviewOrigin, priorPlanReviewReleased, type GateResult, type Plan } from '../lib/plan.ts';
import { checkScope } from '../lib/scope.ts';
import { classifyBase, type BaseKind } from '../lib/stack.ts';
import {
  changedFiles,
  fixRequestCount,
  hasLabel,
  isAgentPr,
  isSameRepoPr,
  isTrustedComment,
  lastLabeled,
  latestPlanGate,
  openPrsClosing,
  plannedFilesForDelegate,
  plannedFilesForPr,
  prDiff,
  type PlanGateRecord,
  type TimelineEvent,
} from '../lib/state.ts';
import { fixAllowed, hasCriticalBlocking, parseVerdict, riskAllowsAutoMerge, type Verdict } from '../lib/verdict.ts';
import { appComment, convertToDraft, getPr, type GateContext } from './context.ts';
import { inspectEpic, splitEpic, type EpicState } from './epic-split.ts';
import { writePlanLink } from './plan-link.ts';
import { applyAcceptance } from './apply.ts';
import { delegationFor } from './delegation.ts';
import { bypassEligibility } from './bypass.ts';
import { onDecision } from './plan-decision.ts';
import { planAreaLabels, riskLabelChanges } from './label-apply.ts';

/** issue_comment（created）：計画ゲートと判定の受け付け */
export async function onComment(ctx: GateContext): Promise<void> {
  if (ctx.event.action !== 'created') return;
  const comment = ctx.event.comment as IssueComment;
  const issue = ctx.event.issue as { number: number; pull_request?: unknown; labels: { name: string }[]; state: string };
  if (!isTrustedComment(comment)) {
    ctx.log(`作成者の関連が ${comment.author_association} のため無視します（Q60）`);
    return;
  }
  if (issue.pull_request) {
    const block = extractBlock(comment.body, 'agent-verdict');
    if (block.found) await onVerdict(ctx, issue.number, comment, block);
  } else {
    const block = extractBlock(comment.body, 'agent-plan');
    if (block.found) {
      await onPlan(ctx, issue, comment, block);
      await refreshPlanLinks(ctx, issue.number);
      return;
    }
    // 計画と同じコメントの決定の記録は見ない
    const decision = extractBlock(comment.body, 'agent-decision');
    if (!decision.found) return;
    const regate = await onDecision(ctx, issue, comment, decision);
    if (regate) {
      await onPlan(ctx, issue, regate.planComment, regate.block, { commentId: comment.id, url: comment.html_url });
      await refreshPlanLinks(ctx, issue.number);
    }
  }
}

async function onPlan(
  ctx: GateContext,
  issue: { number: number; labels: { name: string }[]; state: string },
  comment: IssueComment,
  block: ReturnType<typeof extractBlock>,
  /** 決定の記録で判定し直すとき（harness/gates/plan-decision.ts）。Planner の申告を答え済みとして判定する */
  decision?: { commentId: number; url: string },
  /** 委任承認の状態を読み終えているとき（reviewDelegatedPlans）。無ければ要るときだけ読む */
  known?: DelegateState,
): Promise<void> {
  if (issue.state !== 'open') return;
  const errors = !block.found ? [] : !block.ok ? [block.error] : [];
  const parsed = block.found && block.ok ? parsePlan(block.value) : null;
  if (parsed && !parsed.ok) errors.push(...parsed.errors);
  if (errors.length > 0 || !parsed?.ok) {
    await ctx.gh.removeLabel(issue.number, LABELS.planOk);
    await ctx.gh.addLabels(issue.number, [LABELS.blocked]);
    await appComment(ctx, issue.number, 'plan-gate', [reasonMark('plan-invalid'), `計画の構造化出力を読めませんでした（[コメント](${comment.html_url})）。\`agent:blocked\` にしました。`, '', ...errors.map((e) => `- ${e}`)].join('\n'), {
      version: 1, planCommentId: comment.id, pass: false, reasons: errors,
    } satisfies PlanGateRecord);
    return;
  }

  const plan = parsed.value;
  // 決定の記録で判定し直すときは、Planner の申告を答え済みにした計画で判定する（記録の plan は元の計画のまま）
  const judged = decision ? answeredPlan(plan) : plan;
  let gate = evaluatePlanGate(judged, issue.number, ctx.config);
  // 委任承認：止めた理由に飛ばせるもの（ガードレール・Risk）があるときだけ委任の状態を読む（ほかの停止では API を増やさない）。
  // 人が付けた agent:plan-review の検査はこの後なので、人の印があれば委任でも止まる
  if (!gate.pass && (gate.skippable?.length ?? 0) > 0) gate = delegatePlanGate(gate, judged, ctx.config, known ?? (await delegationFor(ctx, new Date())));
  const labelled = hasLabel(issue, LABELS.planReview);
  // 前の印が App のゲートの停止なら、それを理由に止めず新しい計画だけで判定する（Planner の申告・人の印は人が外すまで残す）
  // 決定の記録で判定し直すときは、印は答えた Planner の申告のもの（plan-decision.ts が確かめた）なので理由にしない
  const released = labelled && (decision ? true : await releasesPriorPlanReview(ctx, issue.number));
  if (labelled && !released && gate.pass) {
    gate.pass = false;
    gate.reasons.push('`agent:plan-review` が付いています（Planner の申告か人が付けた印です。人が外すまで止めます）');
  }
  // 別の計画で既に分けていれば分け直さない（同じ計画コメントの再実行は続きから作る）
  const epic: EpicState | null = gate.pass && plan.split ? await inspectEpic(ctx, issue.number, comment.id) : null;
  if (epic?.resplit) {
    gate.pass = false;
    gate.reasons.push(epic.resplit);
  }
  const record = { version: 1, planCommentId: comment.id, planBodySha256: sha256(comment.body), pass: gate.pass, reasons: gate.reasons, plan } as PlanGateRecord & { plan: typeof plan; planBodySha256: string };
  if (decision) record.decisionCommentId = decision.commentId;
  if (!gate.pass) record.planReviewOrigin = planReviewOrigin(judged, labelled && !released);
  const delegated = gate.pass ? gate.delegated : undefined;
  if (delegated) record.delegated = delegated;
  // 通るときは、前のゲートの停止の印を外してから今までの処理をする
  if (gate.pass && released) await ctx.gh.removeLabel(issue.number, LABELS.planReview);
  const releasedNote = !(gate.pass && released)
    ? ''
    : decision
      ? `人の決定の記録（[コメント](${decision.url})）を Jev が確かめ、Planner の申告による \`agent:plan-review\` を外しました。`
      : '前の計画ゲートの停止（`agent:plan-review`）を外しました。';
  if (gate.pass && plan.split && epic) {
    await splitEpic(ctx, issue, comment, { ...plan, split: plan.split }, record, epic);
  } else if (gate.pass) {
    await ctx.gh.addLabels(issue.number, [LABELS.planOk]);
    // 計画の files から決まる area:* を足す（人が付けたものは外さない）
    const areas = planAreaLabels(ctx.config, plan.files, issue.labels.map((l) => l.name));
    if (areas.length > 0) await ctx.gh.addLabels(issue.number, areas);
    const text = delegated
      ? renderDelegatedPass(comment.html_url, delegated, releasedNote)
      : `計画ゲートを通過しました（[計画](${comment.html_url})）。次の Routine の実行で実装します。${releasedNote}`;
    await appComment(ctx, issue.number, 'plan-gate', text, record);
  } else {
    await ctx.gh.removeLabel(issue.number, LABELS.planOk);
    await ctx.gh.addLabels(issue.number, [LABELS.planReview]);
    await appComment(
      ctx,
      issue.number,
      'plan-gate',
      [reasonMark(epic?.resplit ? 'resplit' : stopCode(judged, gate)), `計画ゲートで停止しました（[計画](${comment.html_url})）。人が手元でセッションを立てて実装してください。`, '', ...gate.reasons.map((r) => `- ${r}`)].join('\n'),
      record,
    );
  }
}

/** 最新の計画ゲートの記録がゲートの停止で、最後に agent:plan-review を付けたのが App か（印が付いているときだけ呼ぶ） */
async function releasesPriorPlanReview(ctx: GateContext, issueNumber: number): Promise<boolean> {
  const previous = latestPlanGate(ctx.config, await ctx.gh.listComments(issueNumber))?.value;
  if (previous?.pass !== false || previous.planReviewOrigin !== 'gate') return false;
  const events = await ctx.gh.paginate<TimelineEvent>(`/issues/${issueNumber}/events`);
  const byApp = lastLabeled(events, LABELS.planReview)?.actor?.login === appLogin(ctx.config);
  return priorPlanReviewReleased(true, previous, byApp);
}

function stopCode(plan: Plan, gate: GateResult): ReasonCode {
  if (gate.splitInvalid) return 'split-invalid';
  if (gate.guardrail) return 'high-risk';
  return !plan.split && (plan.risk === 'high' || plan.risk === 'critical') ? 'high-risk' : 'needs-decision';
}

/** 計画ゲートの記録を書いた後、その Issue を Closes する開いた PR の plan-link を書き直す */
async function refreshPlanLinks(ctx: GateContext, issue: number): Promise<void> {
  for (const pr of await openPrsClosing(ctx.gh, issue)) await writePlanLink(ctx, pr);
}

/** 委任承認で通したときの計画ゲートのコメント（段階・ラベル・付けた人・付けた時刻と、飛ばした理由） */
function renderDelegatedPass(planUrl: string, d: NonNullable<GateResult['delegated']>, releasedNote: string): string {
  const merge = d.mode === 'plan+merge' ? '' : 'Merge は委ねていません（自動 Merge の条件を満たさなければ人が Merge します）。';
  return [
    `委任承認（${delegateModeName(d.mode)}、\`${d.label}\`、@${d.by}、${d.since} から）で次の理由を飛ばして計画ゲートを通しました（[計画](${planUrl})）。${merge}${releasedNote}`,
    '',
    ...d.skipped.map((r) => `- ${r}`),
  ].join('\n');
}

type OpenIssue = { number: number; labels: { name: string }[]; state: string; pull_request?: unknown };

/**
 * 委任承認で、App のゲートの停止で止まっている Issue を判定し直す（ダッシュボードに委任のラベルを付けたときと定期実行）。
 * agent:plan-review の付いた開いた Issue のうち、最新の plan-gate の記録が pass:false・planReviewOrigin:gate で記録に計画があり、
 * 最後に agent:plan-review を付けたのが App で、記録の計画が委任承認で通り、計画コメントが信頼できる作成者のまま本文も変わっていない
 * （planBodySha256 が同じ）ものだけ、その計画コメントで計画ゲートを走らせ直す。それ以外の Issue には何も書かない。
 * 1件の失敗はログに残して次へ進む。
 */
export async function reviewDelegatedPlans(ctx: GateContext, now: Date, delegation?: DelegateState): Promise<void> {
  const state = delegation ?? (await delegationFor(ctx, now));
  if (!state.planActive) return;
  const items = await ctx.gh.paginate<OpenIssue>(`/issues?state=open&labels=${encodeURIComponent(LABELS.planReview)}`, 5);
  for (const item of items) {
    if (item.pull_request || item.state !== 'open' || !hasLabel(item, LABELS.planReview)) continue;
    try {
      await reviewDelegatedPlan(ctx, item, state);
    } catch (e) {
      ctx.log(`#${item.number} の委任承認での判定し直しに失敗しました: ${(e as Error).message}`);
    }
  }
}

async function reviewDelegatedPlan(ctx: GateContext, issue: OpenIssue, state: DelegateState): Promise<void> {
  const comments = await ctx.gh.listComments(issue.number);
  const record = latestPlanGate(ctx.config, comments)?.value as (PlanGateRecord & { plan?: Plan; planBodySha256?: string }) | undefined;
  if (!record || record.pass !== false || record.planReviewOrigin !== 'gate' || !record.plan || !record.planBodySha256) return;
  // 決定の記録で判定し直した停止なら、同じく Planner の申告を答え済みとして見る
  const decisionComment = record.decisionCommentId === undefined ? null : comments.find((c) => c.id === record.decisionCommentId);
  if (record.decisionCommentId !== undefined && !decisionComment) return;
  const judged = decisionComment ? answeredPlan(record.plan) : record.plan;
  if (!delegatePlanGate(evaluatePlanGate(judged, issue.number, ctx.config), judged, ctx.config, state).pass) return;
  const events = await ctx.gh.paginate<TimelineEvent>(`/issues/${issue.number}/events`);
  if (lastLabeled(events, LABELS.planReview)?.actor?.login !== appLogin(ctx.config)) return;
  const planComment = comments.find((c) => c.id === record.planCommentId);
  if (!planComment || !isTrustedComment(planComment) || sha256(planComment.body) !== record.planBodySha256) return;
  const block = extractBlock(planComment.body, 'agent-plan');
  await onPlan(ctx, issue, planComment, block, decisionComment ? { commentId: decisionComment.id, url: decisionComment.html_url } : undefined, state);
  await refreshPlanLinks(ctx, issue.number);
}

async function onVerdict(ctx: GateContext, prNumber: number, comment: IssueComment, block: ReturnType<typeof extractBlock>): Promise<void> {
  const pr = await getPr(ctx, prNumber);
  if (pr.state !== 'open') return;
  if (!isSameRepoPr(pr, ctx.repository)) {
    await appComment(ctx, prNumber, 'verdict-rejected', 'fork からの PR の判定は受け付けません（人が `review:exempt` で通します）。');
    return;
  }
  const errors = !block.found ? [] : !block.ok ? [block.error] : [];
  const parsed = block.found && block.ok ? parseVerdict(block.value) : null;
  if (parsed && !parsed.ok) errors.push(...parsed.errors);
  if (!parsed?.ok || errors.length > 0) {
    await appComment(ctx, prNumber, 'verdict-rejected', ['判定コメントの書式が不正なため受け付けません。次の Routine の実行で判定し直します。', '', ...errors.map((e) => `- ${e}`)].join('\n'));
    return;
  }
  const verdict = parsed.value;
  if (verdict.pr !== prNumber) {
    await appComment(ctx, prNumber, 'verdict-rejected', `判定の PR 番号（#${verdict.pr}）がこの PR と一致しません。`);
    return;
  }

  // 判定時の head と現在の head で、PR が base に加えた変更が同じときだけ受け付ける（Q48）
  const diff = await prDiff(ctx.gh, pr);
  const currentPatch = patchId(diff);
  const verdictPatch = verdict.headSha === pr.head.sha ? currentPatch : await prDiff(ctx.gh, pr, verdict.headSha).then(patchId, () => 'unavailable');
  if (currentPatch !== verdictPatch) {
    await appComment(ctx, prNumber, 'verdict-rejected', `判定は古い差分（${verdict.headSha.slice(0, 7)}）に対するものです。現在の head ${pr.head.sha.slice(0, 7)} で判定し直してください。`);
    return;
  }

  const acceptance = await buildAcceptance(ctx, pr.number, verdict, comment.id, currentPatch, diff, isAgentPr(ctx.config, pr, ctx.repository), classifyBase(pr, ctx.config.defaultBranch));
  // Jev の呼び出し中などに push されていたら、新しい head の差分でも同じときだけ続ける
  const current = await getPr(ctx, prNumber);
  if (current.head.sha !== pr.head.sha && patchId(await prDiff(ctx.gh, current)) !== currentPatch) {
    await appComment(ctx, prNumber, 'verdict-rejected', `受け付け中に push されました（${current.head.sha.slice(0, 7)}）。次の Routine の実行で判定し直します。`);
    return;
  }

  let limitExceeded = false;
  if (!acceptance.reviewPass) {
    const count = await fixRequestCount(ctx.gh, ctx.config, prNumber);
    await convertToDraft(ctx, current);
    if (fixAllowed(count, hasCriticalBlocking(verdict), ctx.config.fixLoop)) {
      await ctx.gh.request('POST', `/pulls/${prNumber}/reviews`, {
        body: { event: 'REQUEST_CHANGES', commit_id: current.head.sha, body: renderBlockingReview(verdict, count + 1) },
      });
    } else {
      limitExceeded = true;
      await ctx.gh.addLabels(prNumber, [LABELS.blocked]);
      acceptance.reasons.push('修正回数の上限に達しました（`agent:blocked`、人の対応が必要）');
    }
  }
  const posted = await appComment(ctx, prNumber, 'acceptance', renderAcceptance(acceptance, verdict, comment.html_url), acceptance);
  ctx.log(`acceptance comment ${posted.id}${limitExceeded ? ' (fix limit exceeded)' : ''}`);
  if (limitExceeded) {
    await appComment(ctx, prNumber, 'fix-limit', `${reasonMark('fix-limit')}\n修正回数の上限に達したため \`agent:blocked\` にしました。指摘を確認して人が直すか、Close してください。`);
  }
  await applyAcceptance(ctx, current, acceptance, { fresh: true, diff });
  // 受け付けた判定の Risk を PR の risk:* にする（ほかの risk:* は外す）。受け付けの書き込みの後に置く
  const risk = riskLabelChanges(current.labels.map((l) => l.name), verdict.risk.level);
  for (const l of risk.remove) await ctx.gh.removeLabel(prNumber, l);
  if (risk.add.length > 0) await ctx.gh.addLabels(prNumber, risk.add);
}

async function buildAcceptance(ctx: GateContext, prNumber: number, verdict: Verdict, verdictCommentId: number, currentPatch: string, diff: string, agent: boolean, base: BaseKind): Promise<Acceptance> {
  const files = await changedFiles(ctx.gh, prNumber);
  const planned = await plannedFilesForPr(ctx.gh, ctx.config, prNumber);
  let scope = 'files' in planned ? checkScope(planned.files, files) : { ok: false, outside: [`（${planned.missing}）`] };
  // 変更ファイルの一覧は API の上限（3000 件）で打ち切られ得る。全件を見られなければ範囲照合は不可とする
  const total = (await ctx.gh.get<{ changed_files: number }>(`/pulls/${prNumber}`)).changed_files;
  const partial = new Set(files).size < total ? [`（変更ファイル ${total} 件のうち ${new Set(files).size} 件しか取得できません）`] : null;
  if (partial) scope = { ok: false, outside: partial };
  // 委任承認（計画＋Merge）の範囲照合：ゲートを通った計画か、ゲートの停止で止まった計画と照らす（harness/lib/delegate.ts）
  const delegatePlanned = await plannedFilesForDelegate(ctx.gh, ctx.config, prNumber);
  let delegateScope = 'files' in delegatePlanned ? checkScope(delegatePlanned.files, files) : { ok: false, outside: [`（${delegatePlanned.missing}）`] };
  if (partial) delegateScope = { ok: false, outside: partial };
  const risk = riskAllowsAutoMerge(verdict.risk);
  const jev = await callJev(ctx.config, ctx.secrets.jevApiKey, diff, files, verdict.facts);
  const jevGate =
    ctx.config.jev.mode === 'enforce'
      ? { ok: jev.status === 'ok' && jev.allows === true, reason: `Jev が自動 Merge を許可していません（${jev.status}${jev.detail ? `: ${jev.detail}` : ''}）` }
      : undefined;
  const guardrail = guardrailFiles(ctx.config, files);
  const humanMerge = humanMergeFiles(ctx.config, files);
  const elig = eligibility({ reviewPass: verdict.review.pass, risk, scopeOk: scope.ok, outside: scope.outside, jevGate, guardrail, humanMerge });
  if (!agent) {
    elig.autoEligible = false;
    elig.reasons.unshift('Agent の PR ではない（人の PR は人が Merge する）');
  }
  // base が既定ブランチでない PR は自動の経路に乗せない（Stacked PR には auto-merge も Merge API も使えない）
  if (base === 'stacked') {
    elig.autoEligible = false;
    elig.reasons.unshift('Stacked PR のため Human Merge（GitHub の auto-merge と Merge API が使えない）');
  } else if (base === 'orphan-base') {
    elig.autoEligible = false;
    elig.reasons.unshift('スタックでないのに base が既定ブランチ以外（`orphan-base`。Draft に留めています）');
  }
  const exclude = delegateExcludeFiles(ctx.config, files);
  const delegate = delegateEligibility({
    reviewPass: verdict.review.pass,
    scopeOk: delegateScope.ok,
    outside: delegateScope.outside,
    humanMerge,
    exclude,
    jevGate,
    agent,
    base,
    guardrail,
    risk,
  });
  // bypass モード：委任と同じ計画と照らし、Risk・ガードレール・humanMergePaths・delegateMergeExclude・Jev を飛ばす理由として記録する（harness/gates/bypass.ts）
  const bypass = bypassEligibility({ reviewPass: verdict.review.pass, scopeOk: delegateScope.ok, outside: delegateScope.outside, humanMerge, exclude, jevGate, agent, base, guardrail, risk });
  return {
    version: 1,
    verdictCommentId,
    verdictHeadSha: verdict.headSha,
    patchId: currentPatch,
    reviewPass: verdict.review.pass,
    riskLevel: verdict.risk.level,
    riskOk: risk.ok,
    scopeOk: scope.ok,
    outside: scope.outside,
    guardrail,
    humanMerge,
    autoEligible: elig.autoEligible,
    reasons: elig.reasons,
    jev,
    humanNotes: verdict.review.humanNotes,
    riskRationale: verdict.risk.rationale,
    delegate,
    bypass,
  };
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function renderBlockingReview(verdict: Verdict, round: number): string {
  return [
    `<!-- agent-harness:app kind=fix-request -->`,
    `Reviewer のブロッキング指摘（修正 ${round} 回目）。修正して push してください。`,
    '',
    ...verdict.review.blocking.map((b) => `- **${b.kind}**${b.file ? ` \`${b.file}\`` : ''}: ${b.detail}`),
  ].join('\n');
}

/** 受け付けの表の「委任承認（計画＋Merge）」の欄：自動 Merge の対象なら要らない。委任なら乗せられるか（飛ばす理由）、乗せられない理由 */
function renderDelegate(a: Acceptance): string {
  if (a.autoEligible) return '不要（自動 Merge の対象）';
  const d = a.delegate;
  if (!d) return '-';
  const cell = (items: string[]) => items.join('／').replaceAll('|', '\\|');
  return d.eligible ? `可（飛ばす理由: ${cell(d.skipped)}）` : `不可: ${cell(d.reasons)}`;
}

/** 受け付けの表の「bypass」の欄：自動 Merge の対象なら要らない。bypass なら乗せられるか（飛ばす理由）、乗せられない理由 */
function renderBypass(a: Acceptance): string {
  if (a.autoEligible) return '不要（自動 Merge の対象）';
  const b = a.bypass;
  if (!b) return '-';
  const cell = (items: string[]) => items.join('／').replaceAll('|', '\\|');
  return b.eligible ? `可（飛ばす理由: ${cell(b.skipped)}）` : `不可: ${cell(b.reasons)}`;
}

function renderAcceptance(a: Acceptance, v: Verdict, verdictUrl: string): string {
  const route = !a.reviewPass ? '修正へ（Draft のまま）' : a.autoEligible ? '自動 Merge（auto-merge を設定）' : 'Human Merge（人のレビュー待ち）';
  return [
    `[判定](${verdictUrl})を受け付けました（head ${v.headSha.slice(0, 7)}、patch-id ${a.patchId.slice(0, 12)}）。`,
    '',
    `| 項目 | 結果 |`,
    `| --- | --- |`,
    `| 経路 | ${route} |`,
    `| Reviewer | ${a.reviewPass ? '合格' : `ブロッキング ${v.review.blocking.length} 件`} |`,
    `| Risk（Claude） | ${a.riskLevel}${a.riskOk ? '' : '（自動 Merge 不可）'} |`,
    `| 範囲照合 | ${a.scopeOk ? 'OK' : `範囲外: ${a.outside.join(', ')}`} |`,
    `| ガードレール | ${a.guardrail?.length ? `触れる（Human Merge）: ${a.guardrail.join(', ')}` : '触れない'} |`,
    `| 人が Merge するパス | ${a.humanMerge?.length ? `触れる（Human Merge）: ${a.humanMerge.join(', ')}` : '触れない'} |`,
    `| Jev | ${a.jev?.status ?? '-'}${a.jev?.allows === undefined ? '' : a.jev.allows ? '（可）' : '（不可）'} |`,
    `| 委任承認（計画＋Merge） | ${renderDelegate(a)} |`,
    `| bypass | ${renderBypass(a)} |`,
    ...(a.reasons.length > 0 ? ['', '自動 Merge しない理由:', ...a.reasons.map((r) => `- ${r}`)] : []),
  ].join('\n');
}
