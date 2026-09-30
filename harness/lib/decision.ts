import type { HarnessConfig } from './config.ts';
import type { Plan } from './plan.ts';
import type { PlanGateRecord, TimelineEvent } from './state.ts';
import { Checker } from './validate.ts';

/**
 * 決定の記録（```agent-decision）：Planner の申告（needsHuman・openQuestions）への人の答えを、付き添いのセッションが記録する。
 * App はそれを Jev に確かめさせ、jev.decisionRelease が enforce でしきい値以上なら、答え済みの計画として計画ゲートで判定し直す（harness/gates/plan-decision.ts）。
 * 記録は人の名義で書かれ App は書き手を区別できないため、外すのは Planner の申告の停止だけにする（decisionEligibility）。書式は docs/formats.md。
 */

export interface DecisionAnswer {
  /** `reason:<添字>`（needsHumanReasons）か `question:<添字>`（openQuestions） */
  to: string;
  /** 選択肢で答えたときに選んだ項目 */
  choice?: string;
  /** 人の言葉そのまま */
  quote: string;
  at: string;
}

export interface Decision {
  version: 1;
  issue: number;
  planCommentId: number;
  answers: DecisionAnswer[];
}

export type DecisionParsed = { ok: true; value: Decision } | { ok: false; errors: string[] };

const TO_RE = /^(reason|question):(0|[1-9]\d*)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseDecision(raw: unknown): DecisionParsed {
  const c = new Checker();
  const o = c.object(raw, 'decision');
  if (!o) return { ok: false, errors: c.errors };
  if (o.version !== 1) c.errors.push('decision.version: 1 ではありません');
  const answers: DecisionAnswer[] = [];
  if (!Array.isArray(o.answers)) c.errors.push('decision.answers: 配列ではありません');
  else if (o.answers.length === 0) c.errors.push('decision.answers: 1件以上必要です');
  else {
    o.answers.forEach((a, i) => {
      const path = `decision.answers[${i}]`;
      const x = c.object(a, path);
      if (!x) return;
      const to = c.string(x.to, `${path}.to`);
      if (typeof x.to === 'string' && !TO_RE.test(to)) c.errors.push(`${path}.to: reason:<添字> か question:<添字> ではありません`);
      const quote = c.string(x.quote, `${path}.quote`, { nonEmpty: true });
      const at = c.string(x.at, `${path}.at`);
      if (typeof x.at === 'string' && (!ISO_RE.test(at) || Number.isNaN(Date.parse(at)))) c.errors.push(`${path}.at: ISO 8601 の日時ではありません`);
      const answer: DecisionAnswer = { to, quote, at };
      if (x.choice !== undefined) answer.choice = c.string(x.choice, `${path}.choice`, { nonEmpty: true });
      answers.push(answer);
    });
  }
  const decision: Decision = {
    version: 1,
    issue: c.integer(o.issue, 'decision.issue'),
    planCommentId: c.integer(o.planCommentId, 'decision.planCommentId'),
    answers,
  };
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: decision };
}

export interface DecisionTarget {
  id: string;
  kind: 'reason' | 'question';
  text: string;
}

/** 計画の申告を答える項目にする。needsHuman が true で理由が空なら reason:0 を1件とする */
export function decisionTargets(plan: Pick<Plan, 'needsHuman' | 'needsHumanReasons' | 'openQuestions'>): DecisionTarget[] {
  const reasons = plan.needsHumanReasons.length > 0 ? plan.needsHumanReasons : plan.needsHuman ? ['Planner が人の判断が必要と申告した'] : [];
  return [
    ...reasons.map((text, i) => ({ id: `reason:${i}`, kind: 'reason' as const, text })),
    ...plan.openQuestions.map((text, i) => ({ id: `question:${i}`, kind: 'question' as const, text })),
  ];
}

/** 答えの無い項目と、存在しない項目を指す答え（決定論的な検査。Jev に問う前に使う） */
export function uncoveredTargets(targets: DecisionTarget[], decision: Pick<Decision, 'answers'>): { missing: DecisionTarget[]; unknown: string[] } {
  const ids = new Set(targets.map((t) => t.id));
  const answered = new Set(decision.answers.map((a) => a.to));
  return {
    missing: targets.filter((t) => !answered.has(t.id)),
    unknown: [...new Set(decision.answers.map((a) => a.to).filter((to) => !ids.has(to)))],
  };
}

/** 申告を答え済みにした計画の写し（acChangeProposed と他の項目は変えない） */
export function answeredPlan<T extends Pick<Plan, 'needsHuman' | 'needsHumanReasons' | 'openQuestions'>>(plan: T): T {
  return { ...plan, needsHuman: false, needsHumanReasons: [], openQuestions: [] };
}

/** 計画の投稿の直前に post-plan が印を付ける分の猶予 */
export const LABEL_GRACE_MS = 60_000;
/** Jev に渡す項目の上限と、答えの文字数の上限の既定値（jev.decisionMaxTargets・decisionMaxAnswerChars が無いとき） */
export const DECISION_MAX_TARGETS = 20;
export const DECISION_MAX_ANSWER_CHARS = 20_000;
/** 問いの版（問いの文や criteria を変えたら上げる。記録の questionSet に残す） */
export const DECISION_QUESTION_SET = 1;

export type DecisionMode = 'off' | 'shadow' | 'enforce';
export const decisionMode = (config: HarnessConfig): DecisionMode => config.jev.decisionRelease ?? 'shadow';
export const decisionThreshold = (config: HarnessConfig): number => config.jev.thresholds.decisionProbability ?? 0.9;

export interface DecisionEligibilityInput {
  config: HarnessConfig;
  issue: { number: number; state: string; labels: { name: string }[] };
  decision: Decision;
  decisionCommentId: number;
  /** App の最新の計画ゲートの記録（コメントの作成時刻つき） */
  latest: { createdAt: string; value: PlanGateRecord & { plan?: Plan; planBodySha256?: string } } | null;
  /** 記録の計画コメント（無ければ null） */
  planComment: { id: number; createdAt: string; bodySha256: string } | null;
  /** Issue のイベント（古い順） */
  events: TimelineEvent[];
  /** これまでの plan-decision の記録の decisionCommentId */
  priorDecisionIds: number[];
}

/**
 * Planner の申告の停止で、この決定の記録で外してよいか。理由（外さない理由）が空なら対象。
 * 人が付けた印はラベルの時刻で見分ける：今の印の最後の labeled が「計画コメントの作成 − LABEL_GRACE_MS」から「計画ゲートの記録」の窓の中のときだけ対象。
 */
export function decisionEligibility(input: DecisionEligibilityInput): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const { config, issue, decision, latest, planComment } = input;
  if (decisionMode(config) === 'off') reasons.push('`jev.decisionRelease` が off です');
  if (issue.state !== 'open') reasons.push('Issue が開いていません');
  if (!issue.labels.some((l) => l.name === 'agent:plan-review')) reasons.push('`agent:plan-review` が付いていません');
  if (decision.issue !== issue.number) reasons.push(`決定の記録の issue 番号（#${decision.issue}）がこの Issue（#${issue.number}）と一致しません`);
  const record = latest?.value;
  const plan = record?.plan;
  if (!record) reasons.push('App の計画ゲートの記録がありません');
  else if (record.pass !== false || record.planReviewOrigin !== 'planner') reasons.push('最新の計画ゲートの記録が Planner の申告による停止ではありません（App のゲートの停止はこの経路で外しません）');
  else if (!plan) reasons.push('計画ゲートの記録に計画の写しがありません');
  if (plan && !(plan.needsHuman || plan.openQuestions.length > 0)) reasons.push('計画に人の判断が必要・未解決の質問の申告がありません');
  if (plan?.acChangeProposed) reasons.push('要件・AC の変更提案があります（Issue 本文の変更は人の役割のため、この経路では外しません）');
  if (record && decision.planCommentId !== record.planCommentId) reasons.push(`決定の記録の planCommentId（${decision.planCommentId}）が最新の計画ゲートの記録（${record.planCommentId}）と一致しません`);
  if (record && (!planComment || planComment.id !== record.planCommentId)) reasons.push('計画コメントが見つかりません');
  else if (record && planComment && planComment.bodySha256 !== record.planBodySha256) reasons.push('計画コメントがゲートの後に編集されています');
  if (latest && planComment && reasons.length === 0) {
    const labeled = lastLabeledAt(input.events, 'agent:plan-review');
    const from = Date.parse(planComment.createdAt) - LABEL_GRACE_MS;
    const to = Date.parse(latest.createdAt);
    if (labeled === null || labeled < from || labeled > to) reasons.push('`agent:plan-review` が計画の投稿か App の停止の外で付いています（人が付けた印は人が外します）');
  }
  if (input.priorDecisionIds.includes(input.decisionCommentId)) reasons.push('この決定の記録は確かめ済みです');
  return { eligible: reasons.length === 0, reasons };
}

/** 今付いている印の最後の labeled の時刻（外されていれば null） */
function lastLabeledAt(events: TimelineEvent[], label: string): number | null {
  let last: number | null = null;
  for (const e of events) {
    if (e.label?.name !== label) continue;
    if (e.event === 'labeled') last = e.created_at ? Date.parse(e.created_at) : null;
    if (e.event === 'unlabeled') last = null;
  }
  return last;
}

const questionKey = (t: DecisionTarget): string => `item_${t.id.replace(':', '_')}`;

/**
 * Jev への要求（英語）。state は項目と答え（to・choice・quote）だけで、日時と本文の要約は渡さない。
 * 全体の1問（all_answered）と項目ごとの1問（item_<kind>_<添字>）を1回で問う。大きすぎれば null。
 */
export function buildDecisionRequest(config: HarnessConfig, targets: DecisionTarget[], decision: Pick<Decision, 'answers'>) {
  const answers = decision.answers.map((a) => ({ to: a.to, ...(a.choice !== undefined ? { choice: a.choice } : {}), quote: a.quote }));
  const chars = answers.reduce((n, a) => n + a.quote.length + (a.choice?.length ?? 0), 0);
  if (targets.length > (config.jev.decisionMaxTargets ?? DECISION_MAX_TARGETS) || chars > (config.jev.decisionMaxAnswerChars ?? DECISION_MAX_ANSWER_CHARS)) return null;
  const questions: Record<string, unknown> = {
    all_answered: {
      type: 'noul',
      instructions: 'Does `answers` settle every entry of `items`?',
      criteria: {
        true: 'For each entry of `items`, there is an entry of `answers` whose `to` equals that entry\'s `id`, and that answer contains a decision, choice, or instruction that settles the reason or question.',
        false: 'Some entry of `items` has no answer, or its only answers restate the question, defer it, say the person does not know, or talk about something else.',
      },
    },
  };
  for (const t of targets) {
    questions[questionKey(t)] = {
      type: 'noul',
      instructions: `Do the entries of \`answers\` whose \`to\` is "${t.id}" settle the entry of \`items\` whose \`id\` is "${t.id}"?`,
      criteria: {
        true: `At least one entry of \`answers\` has \`to\` equal to "${t.id}" and contains a decision, choice, or instruction that settles that item.`,
        false: `No entry of \`answers\` has \`to\` equal to "${t.id}", or those answers only restate the item, defer it, say the person does not know, or talk about something else.`,
      },
    };
  }
  return { model: config.jev.model, state: { items: targets.map((t) => ({ id: t.id, kind: t.kind, text: t.text })), answers }, questions };
}

/** Jev の答え（flattenAnswers の形）を評価する。全体と各項目がしきい値以上なら pass。落ちたものを missing に返す */
export function evaluateDecisionAnswers(
  config: HarnessConfig,
  targets: DecisionTarget[],
  flat: Record<string, Record<string, number>>,
): { pass: boolean; missing: { id: string; text: string; probability: number | null }[] } {
  const threshold = decisionThreshold(config);
  const prob = (key: string): number | null => {
    const p = flat[key]?.yes;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  };
  const missing: { id: string; text: string; probability: number | null }[] = [];
  for (const t of targets) {
    const p = prob(questionKey(t));
    if (p === null || p < threshold) missing.push({ id: t.id, text: t.text, probability: p });
  }
  const all = prob('all_answered');
  // 項目がどれも落ちていないのに全体だけが未満のときは「全体」を入れる
  if ((all === null || all < threshold) && missing.length === 0) missing.push({ id: 'all', text: '全体（すべての理由・質問に答えているか）', probability: all });
  return { pass: missing.length === 0 && all !== null && all >= threshold, missing };
}

