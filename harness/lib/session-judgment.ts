import { claudeMark, extractBlock, hasClaudeMark, renderBlock } from './blocks.ts';
import { LABELS, type HarnessConfig } from './config.ts';
import { delegatePlanExclude } from './delegate.ts';
import { guardrailPatterns } from './guardrail.ts';
import type { IssueComment } from './github.ts';
import { evaluatePlanGate, parsePlan, recordedOrigin, type Parsed, type Plan, type PlanReviewOrigin } from './plan.ts';
import { parseQaRetroArgs } from './qa-retro.ts';
import { isTrustedComment, type PlanGateRecord } from './state.ts';
import { Checker } from './validate.ts';

/**
 * セッションの判定（```agent-session-judgment、Issue #340）：付き添いのセッションが、人に聞かずに決めたことの記録。
 * 決めたこと・当たった基準・理由・覆し方を Issue か PR のコメントに残し、ship・fleet の最後の一覧に「決めたこと（覆すなら）」で載せる。
 * 書式は harness/docs/formats.md。agent:plan-review を「進める」と決めてよいか（planReviewRiskOnly）と、投稿してよいか（judgmentPostable）もここで決める。
 * どれも純粋な関数で、GitHub を読まない（読む側は harness/scripts/agent/commands/session-judgment.ts）。
 */

export const SESSION_JUDGMENT_STAGES = ['plan-review', 'plan-critique', 'scope', 'area-limit', 'other'] as const;
export type SessionJudgmentStage = (typeof SESSION_JUDGMENT_STAGES)[number];

export const SESSION_JUDGMENT_BASES = ['risk-only', 'fixable', 'recorded', 'wait'] as const;
export type SessionJudgmentBasis = (typeof SESSION_JUDGMENT_BASES)[number];

export interface SessionJudgment {
  version: 1;
  /** Issue か PR の番号 */
  target: number;
  stage: SessionJudgmentStage;
  basis: SessionJudgmentBasis;
  /** 決めたこと */
  decision: string;
  /** 理由 */
  reason: string;
  /** 根拠の URL か記録（任意） */
  evidence?: string[];
}

/** 基準を人が読む言葉に */
export const SESSION_JUDGMENT_BASIS_LABELS: Record<SessionJudgmentBasis, string> = {
  'risk-only': '止めた理由が想定 Risk だけで、files がガードレール・delegateMergeExclude・harness.config.json に触れない',
  fixable: '計画か指摘を直して出し直せる',
  recorded: '規則・既定・記録済みの人の決定で決まる',
  wait: '領域の上限などで待つ',
};

/** 基準ごとの「覆すなら」 */
const OVERRIDE: Record<SessionJudgmentBasis, string> = {
  'risk-only': `Issue に \`${LABELS.hold}\` を付けるか、コメントで止める理由を書く。PR は判定の後も人の Merge か App の経路で止められる`,
  fixable: '出し直した計画・修正は App のゲートと判定がもう一度見る。違うと思えば Issue か PR にコメントで直し方を書く',
  recorded: '根拠に挙げた規則・記録を変えるか、Issue か PR にコメントで違う決定を書く',
  wait: '急ぐなら、人が「急ぐ」とコメントする（セッションは `--force` で領域の上限を飛ばして進める）',
};

export function parseSessionJudgment(raw: unknown): Parsed<SessionJudgment> {
  const c = new Checker();
  const o = c.object(raw, 'judgment');
  if (!o) return { ok: false, errors: c.errors };
  if (o.version !== 1) c.errors.push('judgment.version: 1 ではありません');
  const target = c.integer(o.target, 'judgment.target');
  if (Number.isInteger(o.target) && target <= 0) c.errors.push('judgment.target: 正の整数ではありません');
  const stage = c.oneOf(o.stage, SESSION_JUDGMENT_STAGES, 'judgment.stage');
  const basis = c.oneOf(o.basis, SESSION_JUDGMENT_BASES, 'judgment.basis');
  const decision = c.string(o.decision, 'judgment.decision', { nonEmpty: true });
  const reason = c.string(o.reason, 'judgment.reason', { nonEmpty: true });
  const value: SessionJudgment = { version: 1, target, stage, basis, decision, reason };
  if (o.evidence !== undefined) value.evidence = c.stringArray(o.evidence, 'judgment.evidence');
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value };
}

/** コメントの本文（先頭に Claude の目印） */
export function renderSessionJudgment(j: SessionJudgment, session: string | null): string {
  return [
    claudeMark(session),
    '## セッションの判定',
    '',
    `- 決めたこと: ${j.decision}`,
    `- 当たった基準: ${SESSION_JUDGMENT_BASIS_LABELS[j.basis]}`,
    `- 理由: ${j.reason}`,
    ...(j.evidence && j.evidence.length > 0 ? [`- 根拠: ${j.evidence.join(' / ')}`] : []),
    `- 覆すなら: ${OVERRIDE[j.basis]}`,
    '',
    renderBlock('agent-session-judgment', j),
  ].join('\n');
}

export interface PlanReviewRiskOnly {
  riskOnly: boolean;
  /** 記録の理由のうち、想定 Risk の理由を除いた残り */
  remaining: string[];
  /** 計画の files のうち、ガードレール・delegateMergeExclude・harness.config.json に当たりうるもの */
  touches: string[];
  origin: PlanReviewOrigin | null;
  critique: Plan['critique'] | null;
  notes: string[];
}

export interface PlanReviewRiskOnlyOpts {
  issue: number;
  /** Issue の今のラベル */
  labels: string[];
  /** 最新の計画コメントの ID */
  latestPlanCommentId: number | null;
}

const RISK_REASON_PREFIX = '想定 Risk が ';

/**
 * agent:plan-review を、セッションが聞かずに「進める」と決めてよいか。
 * 止めた理由が想定 Risk だけで、files がガードレール・delegateMergeExclude・harness.config.json に触れず、出どころが App のゲートで、
 * 批評が go か（必須の指摘が残らない）revise で、要件・AC の変更の提案が無く、agent:hold が無く、最新の計画コメントが記録と同じときだけ真。
 * remaining は記録の reasons から作る（App が足した理由を落とさない）。Risk の理由は、記録と今の設定でのかけ直しの両方にある文字列だけを除く。
 */
export function planReviewRiskOnly(record: (PlanGateRecord & { plan?: unknown }) | null, config: HarnessConfig, opts: PlanReviewRiskOnlyOpts): PlanReviewRiskOnly {
  const notes: string[] = [];
  if (!record) return { riskOnly: false, remaining: [], touches: [], origin: null, critique: null, notes: ['App の計画ゲートの記録がありません'] };
  const origin = recordedOrigin(record);
  const parsed = parsePlan(record.plan);
  if (!parsed.ok) {
    notes.push(`記録の計画の写しを読めません: ${parsed.errors.join('; ')}`);
    return { riskOnly: false, remaining: [...record.reasons], touches: [], origin, critique: null, notes };
  }
  const plan = parsed.value;
  const touches = [...new Set([...guardrailPatterns(config, plan.files), ...delegatePlanExclude(config, plan.files)])].sort();
  const critique = plan.critique ?? null;
  if (record.pass) {
    notes.push('記録は通過済みです（止まっていません）');
    return { riskOnly: false, remaining: [], touches, origin, critique, notes };
  }
  const skippable = new Set((evaluatePlanGate(plan, opts.issue, config).skippable ?? []).filter((r) => r.startsWith(RISK_REASON_PREFIX)));
  const remaining = record.reasons.filter((r) => !skippable.has(r));
  if (remaining.length > 0) notes.push(`想定 Risk の理由のほかに止めた理由があります: ${remaining.join(' / ')}`);
  if (touches.length > 0) notes.push(`files がガードレール・delegateMergeExclude・harness.config.json に触れます: ${touches.join(', ')}`);
  if (origin !== 'gate') notes.push('出どころが App のゲートではありません（Planner の申告か人が付けた印）');
  if (plan.acChangeProposed) notes.push('要件・AC の変更の提案があります');
  if (!critique) notes.push('批評の記録がありません');
  else if (critique.verdict !== 'go' && critique.verdict !== 'revise') notes.push(`批評が ${critique.verdict} です`);
  else if ((critique.mustRemaining ?? 0) >= 1) notes.push(`批評の必須の指摘が ${critique.mustRemaining} 件残っています`);
  if (opts.labels.includes(LABELS.hold)) notes.push(`${LABELS.hold} が付いています`);
  if (opts.latestPlanCommentId !== record.planCommentId) notes.push(`最新の計画コメント（${opts.latestPlanCommentId ?? 'なし'}）が記録の計画コメント（${record.planCommentId}）と違います`);
  return { riskOnly: notes.length === 0, remaining, touches, origin, critique, notes };
}

/** post-judgment が投稿してよいか。basis が risk-only のときは、planReviewRiskOnly の結果が真のときだけ（ガードレールに触れる計画に「進める」の判定を残さない） */
export function judgmentPostable(judgment: SessionJudgment, check: PlanReviewRiskOnly | null): { ok: boolean; reasons: string[] } {
  if (judgment.basis !== 'risk-only') return { ok: true, reasons: [] };
  if (!check) return { ok: false, reasons: ['basis が risk-only の判定は、plan-review-check の結果が要ります'] };
  if (check.riskOnly) return { ok: true, reasons: [] };
  return { ok: false, reasons: ['plan-review-check の riskOnly が偽です。risk-only の判定は投稿しません（人に上げる）', ...check.notes] };
}

// --- 期間の集計（session-judgment-digest、Issue #805） ---

const DAY = 86400_000;
const WEEK = 7 * DAY;

export interface SessionJudgmentSample {
  target: number;
  stage: SessionJudgmentStage;
  decision: string;
  /** コメントの html_url（Issue にも PR にも当たる） */
  url: string;
  createdAt: string;
}

export interface SessionJudgmentDigest {
  since: string;
  until: string;
  total: number;
  counts: Record<SessionJudgmentBasis, number>;
  samples: Record<SessionJudgmentBasis, SessionJudgmentSample[]>;
  /** ブロックを持つが書式の誤りで読めなかったコメントの数（基準には振らない） */
  unreadable: number;
  lines: string[];
}

/**
 * 作成時刻が [since, until) の、コラボレーターの、目印のあるコメントから agent-session-judgment を集め、基準ごとに数えて抜き取る。
 * 抜き取りは基準ごとに新しい順（同じ時刻は ID の大きい順）で sample 件。GitHub は読まない。
 */
export function digestSessionJudgments(comments: (IssueComment & { issue_url?: string })[], period: { since: Date; until: Date }, opts: { sample: number }): SessionJudgmentDigest {
  const counts = Object.fromEntries(SESSION_JUDGMENT_BASES.map((b) => [b, 0])) as Record<SessionJudgmentBasis, number>;
  const found = Object.fromEntries(SESSION_JUDGMENT_BASES.map((b) => [b, [] as { id: number; time: number; sample: SessionJudgmentSample }[]])) as Record<SessionJudgmentBasis, { id: number; time: number; sample: SessionJudgmentSample }[]>;
  let unreadable = 0;
  for (const c of comments) {
    const time = Date.parse(c.created_at);
    if (Number.isNaN(time) || time < period.since.getTime() || time >= period.until.getTime()) continue;
    if (!isTrustedComment(c) || !hasClaudeMark(c.body)) continue;
    const block = extractBlock(c.body, 'agent-session-judgment');
    if (!block.found) continue;
    const parsed = block.ok ? parseSessionJudgment(block.value) : null;
    if (!parsed || !parsed.ok) {
      unreadable++;
      continue;
    }
    const j = parsed.value;
    counts[j.basis]++;
    found[j.basis].push({ id: c.id, time, sample: { target: j.target, stage: j.stage, decision: j.decision, url: c.html_url, createdAt: c.created_at } });
  }
  const samples = {} as Record<SessionJudgmentBasis, SessionJudgmentSample[]>;
  const lines: string[] = [];
  for (const b of SESSION_JUDGMENT_BASES) {
    samples[b] = found[b]
      .sort((x, y) => y.time - x.time || y.id - x.id)
      .slice(0, opts.sample)
      .map((f) => f.sample);
    lines.push(`${b}: ${counts[b]} 件（抜き取り ${samples[b].length} 件）`);
    for (const s of samples[b]) lines.push(`- #${s.target} ${s.stage}: ${s.decision}（${s.url}）`);
  }
  const total = SESSION_JUDGMENT_BASES.reduce((n, b) => n + counts[b], 0);
  return { since: period.since.toISOString(), until: period.until.toISOString(), total, counts, samples, unreadable, lines };
}

export interface DigestArgs {
  since: Date;
  until: Date;
  sample: number;
  weekly: boolean;
  state: string | null;
}

/** `--days`・`--since`・`--until`（parseQaRetroArgs と同じ読み方。既定は直近 7 日）・`--sample <n>`（既定 3）・`--weekly`・`--state <path>` を読む */
export function parseDigestArgs(args: string[], now: Date): { ok: true; value: DigestArgs } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const rest: string[] = [];
  let sample = 3;
  let weekly = false;
  let state: string | null = null;
  let sampleSeen = false;
  let stateSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--weekly') weekly = true;
    else if (a === '--sample') {
      if (sampleSeen) errors.push('--sample が2回あります');
      sampleSeen = true;
      const v = args[++i];
      if (v === undefined || !/^[1-9]\d*$/.test(v)) errors.push('--sample は正の整数で書いてください');
      else sample = Number(v);
    } else if (a === '--state') {
      if (stateSeen) errors.push('--state が2回あります');
      stateSeen = true;
      const v = args[++i];
      if (v === undefined || v === '' || v.startsWith('--')) errors.push('--state はパスで書いてください');
      else state = v;
    } else rest.push(a);
  }
  if (weekly && rest.some((a) => a === '--days' || a === '--since' || a === '--until')) errors.push('--weekly は --days・--since・--until と同時に渡せません');
  const hasRange = rest.some((a) => a === '--days' || a === '--since');
  const period = parseQaRetroArgs(hasRange ? rest : ['--days', '7', ...rest], now);
  if (!period.ok) errors.push(...period.errors);
  if (errors.length > 0 || !period.ok) return { ok: false, errors };
  return { ok: true, value: { since: period.value.since, until: period.value.until, sample, weekly, state } };
}

export interface DigestState {
  version: 1;
  lastUntil: string;
}

/** 週1回の手元の状態のファイル。無い・空なら null、書式が違えば誤り */
export function parseDigestState(text: string | null): { ok: true; state: DigestState | null } | { ok: false; errors: string[] } {
  if (text === null || text.trim() === '') return { ok: true, state: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`状態のファイルの JSON が壊れています: ${(e as Error).message}`] };
  }
  const o = raw as { version?: unknown; lastUntil?: unknown } | null;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, errors: ['状態のファイルがオブジェクトではありません'] };
  if (o.version !== 1) return { ok: false, errors: ['状態の version: 1 ではありません'] };
  if (typeof o.lastUntil !== 'string' || Number.isNaN(Date.parse(o.lastUntil))) return { ok: false, errors: ['状態の lastUntil が日時ではありません'] };
  return { ok: true, state: { version: 1, lastUntil: o.lastUntil } };
}

/** 前回の終わりから 7 日たっていれば前回の終わりから今まで（抜けも重なりも出ない）、まだなら次の時刻 */
export function weeklyPeriod(state: DigestState | null, now: Date): { due: true; since: Date; until: Date } | { due: false; nextAt: string } {
  if (!state) return { due: true, since: new Date(now.getTime() - WEEK), until: now };
  const last = new Date(state.lastUntil);
  if (now.getTime() - last.getTime() < WEEK) return { due: false, nextAt: new Date(last.getTime() + WEEK).toISOString() };
  return { due: true, since: last, until: now };
}
