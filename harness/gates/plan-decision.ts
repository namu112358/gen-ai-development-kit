import { extractBlock } from '../lib/blocks.ts';
import {
  buildDecisionRequest,
  DECISION_QUESTION_SET,
  decisionEligibility,
  decisionMode,
  decisionTargets,
  decisionThreshold,
  evaluateDecisionAnswers,
  parseDecision,
  proceedEligibility,
  uncoveredTargets,
  type Decision,
  type DecisionTarget,
} from '../lib/decision.ts';
import type { IssueComment } from '../lib/github.ts';
import { askJev, flattenAnswers } from '../lib/jev.ts';
import type { Plan } from '../lib/plan.ts';
import { appRecords, latestPlanGate, type PlanGateRecord, type TimelineEvent } from '../lib/state.ts';
import { appComment, type GateContext } from './context.ts';
import { sha256 } from './on-comment.ts';

/**
 * 決定の記録（```agent-decision）の受け付け。Planner の申告で止まった計画への人の答えを Jev に確かめさせ、
 * shadow なら記録だけ、enforce でしきい値以上なら、判定し直す計画コメントを返す（判定し直しは on-comment.ts の onPlan）。
 * 外すのは Planner の申告の停止だけ（harness/lib/decision.ts の decisionEligibility）。ラベルはここでは変えない。
 * proceed のある記録（人が「この計画で進める」と決めた）は Jev に問わず、jev.decisionRelease にも依らずに proceedEligibility で確かめ、
 * plan-proceed の記録を付ける（onProceed。ラベルも計画ゲートの結果も変えない。範囲照合は harness/lib/state.ts の issueDelegateFiles。Issue #365）。
 */

/** 進める決定（proceed）を App が確かめた結果（kind=plan-proceed）。status が ok なら、planBodySha256 の計画を委任・bypass の範囲照合に使う */
export interface PlanProceedRecord {
  version: 1;
  decisionCommentId: number;
  planCommentId: number;
  /** 確かめた時点の計画コメントの本文の sha256（ok のとき。対象外なら null） */
  planBodySha256: string | null;
  status: 'ok' | 'ineligible';
  reasons?: string[];
}

export interface PlanDecisionRecord {
  version: 1;
  decisionCommentId: number;
  planCommentId: number | null;
  mode: 'off' | 'shadow' | 'enforce';
  questionSet: number;
  threshold: number;
  status: 'ok' | 'invalid' | 'ineligible' | 'skipped' | 'error';
  model?: string;
  answers?: Record<string, Record<string, number>>;
  pass: boolean | null;
  missing: { id: string; text: string; probability: number | null }[];
  reasons?: string[];
  regate: boolean;
}

export async function onDecision(
  ctx: GateContext,
  issue: { number: number; state: string; labels: { name: string }[] },
  comment: IssueComment,
  block: ReturnType<typeof extractBlock>,
): Promise<{ planComment: IssueComment; block: ReturnType<typeof extractBlock> } | null> {
  const mode = decisionMode(ctx.config);
  const base = { version: 1 as const, decisionCommentId: comment.id, mode, questionSet: DECISION_QUESTION_SET, threshold: decisionThreshold(ctx.config) };
  const record = (r: Omit<PlanDecisionRecord, keyof typeof base | 'regate'> & { regate?: boolean }): PlanDecisionRecord => ({ ...base, regate: false, ...r });
  const errors = !block.found ? [] : !block.ok ? [block.error] : [];
  const parsed = block.found && block.ok ? parseDecision(block.value) : null;
  if (parsed && !parsed.ok) errors.push(...parsed.errors);
  if (errors.length > 0 || !parsed?.ok) {
    await appComment(ctx, issue.number, 'plan-decision', [`決定の記録（[コメント](${comment.html_url})）を読めませんでした。`, '', ...errors.map((e) => `- ${e}`)].join('\n'), record({
      planCommentId: null, status: 'invalid', pass: null, missing: [], reasons: errors,
    }));
    return null;
  }
  const decision = parsed.value;
  if (decision.proceed) {
    await onProceed(ctx, issue, comment, decision);
    return null;
  }
  const comments = await ctx.gh.listComments(issue.number);
  const latest = latestPlanGate(ctx.config, comments) as { comment: IssueComment; value: PlanGateRecord & { plan?: Plan; planBodySha256?: string } } | null;
  const planComment = latest ? comments.find((c) => c.id === latest.value.planCommentId) ?? null : null;
  const plan = latest?.value.plan;

  // 答えの無い項目・存在しない項目があれば Jev に問わない
  const targets: DecisionTarget[] = plan ? decisionTargets(plan) : [];
  if (plan) {
    const { missing, unknown } = uncoveredTargets(targets, decision);
    if (missing.length > 0 || unknown.length > 0) {
      const reasons = [...missing.map((t) => `答えがありません: ${t.id}（${t.text}）`), ...unknown.map((u) => `計画に無い項目への答えです: ${u}`)];
      await appComment(ctx, issue.number, 'plan-decision', [`決定の記録（[コメント](${comment.html_url})）が計画の申告のすべてに答えていません。`, '', ...reasons.map((r) => `- ${r}`)].join('\n'), record({
        planCommentId: decision.planCommentId, status: 'invalid', pass: null, missing: missing.map((t) => ({ id: t.id, text: t.text, probability: null })), reasons,
      }));
      return null;
    }
  }

  const events = mode === 'off' ? [] : await ctx.gh.paginate<TimelineEvent>(`/issues/${issue.number}/events`);
  const elig = decisionEligibility({
    config: ctx.config,
    issue,
    decision,
    decisionCommentId: comment.id,
    latest: latest ? { createdAt: latest.comment.created_at, value: latest.value } : null,
    planComment: planComment ? { id: planComment.id, createdAt: planComment.created_at, bodySha256: sha256(planComment.body) } : null,
    events,
    priorDecisionIds: appRecords<PlanDecisionRecord>(ctx.config, comments, 'plan-decision').map((r) => r.value.decisionCommentId),
  });
  if (!elig.eligible) {
    // 同じ決定の記録への二度目は何も書かない（再実行）
    if (elig.reasons.length === 1 && elig.reasons[0] === 'この決定の記録は確かめ済みです') return null;
    await appComment(ctx, issue.number, 'plan-decision', [`決定の記録（[コメント](${comment.html_url})）はこの経路の対象外です。\`agent:plan-review\` は変えません。`, '', ...elig.reasons.map((r) => `- ${r}`)].join('\n'), record({
      planCommentId: decision.planCommentId, status: 'ineligible', pass: null, missing: [], reasons: elig.reasons,
    }));
    return null;
  }

  const request = buildDecisionRequest(ctx.config, targets, decision);
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey || !request) {
    const reason = !apiKey ? 'JEV_API_KEY が未設定' : '項目か答えが大きすぎます';
    await appComment(ctx, issue.number, 'plan-decision', `決定の記録（[コメント](${comment.html_url})）を Jev に問いませんでした（${reason}）。\`agent:plan-review\` は変えません。`, record({
      planCommentId: decision.planCommentId, status: 'skipped', pass: null, missing: [], reasons: [reason],
    }));
    return null;
  }
  const r = await (ctx.askJev ?? askJev)(apiKey, request);
  if (r.status !== 'ok') {
    await appComment(ctx, issue.number, 'plan-decision', `決定の記録（[コメント](${comment.html_url})）を Jev に問えませんでした。\`agent:plan-review\` は変えません。`, record({
      planCommentId: decision.planCommentId, status: 'error', pass: null, missing: [], reasons: [r.detail],
    }));
    return null;
  }
  const answers = flattenAnswers(r.answers);
  const result = evaluateDecisionAnswers(ctx.config, targets, answers);
  const regate = mode === 'enforce' && result.pass;
  const fmt = (p: number | null) => (p === null ? '-' : p.toFixed(3));
  const missingLines = result.missing.map((m) => `- ${m.id}：${m.text}（${fmt(m.probability)}）`);
  const text =
    mode === 'shadow'
      ? [`決定の記録（[コメント](${comment.html_url})）を Jev が確かめました（shadow：記録だけで \`agent:plan-review\` は変えません）。enforce なら${result.pass ? '外して判定し直します' : '外しません'}。`, ...(missingLines.length > 0 ? ['', '足りない項目:', ...missingLines] : [])]
      : regate
        ? [`決定の記録（[コメント](${comment.html_url})）を Jev が確かめ、すべてに答えていると判断しました。答え済みの計画として計画ゲートで判定し直します。`]
        : [`決定の記録（[コメント](${comment.html_url})）が、次の項目に答えていないと Jev が判断しました。\`agent:plan-review\` は変えません。答えを足して記録し直してください。`, '', ...missingLines];
  await appComment(ctx, issue.number, 'plan-decision', text.join('\n'), record({
    planCommentId: decision.planCommentId, status: 'ok', model: r.model, answers, pass: result.pass, missing: result.missing, regate,
  }));
  if (!regate || !planComment) return null;
  return { planComment, block: extractBlock(planComment.body, 'agent-plan') };
}


/** 進める決定（proceed）の受け付け。Jev に問わず、対象なら ok、対象外なら ineligible の plan-proceed の記録を付ける。同じ決定の記録への二度目は何も書かない */
async function onProceed(
  ctx: GateContext,
  issue: { number: number; state: string; labels: { name: string }[] },
  comment: IssueComment,
  decision: Decision,
): Promise<void> {
  const comments = await ctx.gh.listComments(issue.number);
  const gates = appRecords<PlanGateRecord & { plan?: Plan; planBodySha256?: string }>(ctx.config, comments, 'plan-gate');
  const latest = gates.at(-1) ?? null;
  const planComment = latest ? comments.find((c) => c.id === latest.value.planCommentId) ?? null : null;
  // 印の窓：App の計画ゲートの記録ごとに、その計画コメントの作成から記録の作成まで（前の計画の申告で付いた印も見分ける）
  const windows = gates.flatMap((g) => {
    const p = comments.find((c) => c.id === g.value.planCommentId);
    return p ? [{ planCreatedAt: p.created_at, gateCreatedAt: g.comment.created_at }] : [];
  });
  const elig = proceedEligibility({
    issue,
    decision,
    decisionCommentId: comment.id,
    latest: latest ? { commentId: latest.comment.id, createdAt: latest.comment.created_at, value: latest.value } : null,
    planComment: planComment ? { id: planComment.id, createdAt: planComment.created_at, bodySha256: sha256(planComment.body) } : null,
    windows,
    events: await ctx.gh.paginate<TimelineEvent>(`/issues/${issue.number}/events`),
    priorProceedIds: appRecords<PlanProceedRecord>(ctx.config, comments, 'plan-proceed').map((r) => r.value.decisionCommentId),
  });
  if (elig.reasons.includes(PROCEED_SEEN)) return;
  if (!elig.eligible || !planComment) {
    const text = [`進める決定の記録（[コメント](${comment.html_url})）は、委任・bypass の範囲照合に使えません。\`agent:plan-review\` は変えません。`, '', ...elig.reasons.map((r) => `- ${r}`)].join('\n');
    await appComment(ctx, issue.number, 'plan-proceed', text, {
      version: 1, decisionCommentId: comment.id, planCommentId: decision.planCommentId, planBodySha256: null, status: 'ineligible', reasons: elig.reasons,
    } satisfies PlanProceedRecord);
    return;
  }
  const text = `人がこの計画（[計画](${planComment.html_url})）で進めると決めた記録（[コメント](${comment.html_url})）を確かめました。計画コメントの本文が変わらない間、委任承認の Merge と bypass の範囲照合にこの計画を使います。\`agent:plan-review\` と計画ゲートの結果は変えません。`;
  await appComment(ctx, issue.number, 'plan-proceed', text, {
    version: 1, decisionCommentId: comment.id, planCommentId: decision.planCommentId, planBodySha256: sha256(planComment.body), status: 'ok',
  } satisfies PlanProceedRecord);
}

const PROCEED_SEEN = 'この決定の記録は確かめ済みです';
