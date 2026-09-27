import { CLAUDE_MARK, extractBlock, hasClaudeMark, renderBlock } from './blocks.ts';
import { CHECKS, type HarnessConfig } from './config.ts';
import type { IssueComment } from './github.ts';
import type { Parsed } from './plan.ts';
import { isTrustedComment, latestPlanGate } from './state.ts';
import { parseVerdict, RISK_QUESTIONS, type BlockingFinding } from './verdict.ts';

/**
 * 有人セッションで判定（Reviewer）・批評（plan-critic）に渡す入力と、判定コメントの組み立て。
 * API から読んだそのままの配列を受け取り、選別もここで行う（API 呼び出しは agent.ts）。
 */

export interface CheckRun {
  id: number;
  name: string;
  conclusion: string | null;
  app: { slug: string } | null;
  output?: { title?: string | null; summary?: string | null };
}

export interface JudgeFacts {
  pr: { number: number; headSha: string; body: string | null };
  /** PR が Closes する Issue。comments は Issue のコメント（App の計画ゲートの記録を含む） */
  issues: { number: number; title: string; body: string | null; comments: IssueComment[] }[];
  prComments: IssueComment[];
  /** head の check run */
  checkRuns: CheckRun[];
}

/** コラボレーターのコメント（着手宣言を除く） */
export function collaboratorComments(comments: IssueComment[]): IssueComment[] {
  return comments.filter((c) => isTrustedComment(c) && !extractBlock(c.body, 'agent-claim').found);
}

function renderComments(comments: IssueComment[]): string[] {
  const list = collaboratorComments(comments);
  if (list.length === 0) return ['(なし)'];
  return list.flatMap((c) => [`--- ${c.user?.login ?? '?'} ${c.created_at}`, c.body.trim()]);
}

/** 最新の信頼できる Claude の判定コメントの head とブロッキング指摘 */
export function previousVerdict(comments: IssueComment[]): { headSha: string; blocking: BlockingFinding[] } | null {
  for (const c of [...comments].reverse()) {
    if (!isTrustedComment(c) || !hasClaudeMark(c.body)) continue;
    const b = extractBlock(c.body, 'agent-verdict');
    if (!b.found) continue;
    if (!b.ok) return null;
    const v = b.value as { headSha?: unknown; review?: { blocking?: unknown } };
    return { headSha: String(v.headSha ?? ''), blocking: Array.isArray(v.review?.blocking) ? (v.review.blocking as BlockingFinding[]) : [] };
  }
  return null;
}

/** 判定入力の先頭行 `headSha: <sha>` から判定する head を読む */
export function judgedHeadOf(text: string): string | null {
  return text.match(/^headSha: ([0-9a-f]{40})$/m)?.[1] ?? null;
}

export function renderJudgeInput(config: HarnessConfig, facts: JudgeFacts): string {
  const out = [`headSha: ${facts.pr.headSha}`, `PR #${facts.pr.number} issues=${facts.issues.map((i) => `#${i.number}`).join(',') || '(なし)'}`];
  for (const issue of facts.issues) {
    out.push('', `=== Issue #${issue.number}`, issue.title, '', (issue.body ?? '').trim());
    out.push('', `=== Issue #${issue.number} のコラボレーターのコメント`, ...renderComments(issue.comments));
    const gate = latestPlanGate(config, issue.comments);
    const { pass, reasons, plan } = (gate?.value ?? {}) as { pass?: boolean; reasons?: string[]; plan?: unknown };
    out.push('', `=== 計画ゲートの記録の計画 (#${issue.number})`);
    out.push(gate ? JSON.stringify({ pass, reasons, plan: plan ?? null }, null, 2) : '(計画ゲートの記録がありません)');
  }
  out.push('', '=== PR 本文', (facts.pr.body ?? '').trim());
  const scope = facts.checkRuns.filter((c) => c.name === CHECKS.scope && c.app?.slug === config.appSlug).sort((a, b) => a.id - b.id).at(-1);
  out.push('', `=== 範囲照合（${CHECKS.scope}）`);
  out.push(scope ? [`結論: ${scope.conclusion ?? '(未完了)'}`, scope.output?.title ?? '', (scope.output?.summary ?? '').trim()].join('\n') : '(この head の結果がありません)');
  const prev = previousVerdict(facts.prComments);
  out.push('', '=== 前回の判定');
  out.push(prev ? [`headSha: ${prev.headSha}`, 'blocking:', JSON.stringify(prev.blocking, null, 2)].join('\n') : '(なし)');
  return `${out.join('\n')}\n`;
}

export function renderCriticInput(issue: { number: number; title: string; body: string | null }, comments: IssueComment[], planText: string): string {
  return [
    `=== Issue #${issue.number}`, issue.title, '', (issue.body ?? '').trim(),
    '', '=== コラボレーターのコメント', ...renderComments(comments),
    '', '=== 計画', planText.trim(),
  ].join('\n') + '\n';
}

const REVIEWER_KEYS = { required: ['pass', 'blocking'], optional: ['nonBlocking', 'humanNotes'] };
const RISK_KEYS = { required: ['level', 'answers', 'rationale', 'facts'], optional: ['probabilities'] };

/** 最上位のキーの照合。未知のキー（綴りの誤り）と必須のキーの欠けを拒否する */
function checkKeys(raw: unknown, name: string, keys: { required: string[]; optional: string[] }): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [`${name}: オブジェクトではありません`];
  const known = new Set([...keys.required, ...keys.optional]);
  return [
    ...Object.keys(raw).filter((k) => !known.has(k)).map((k) => `${name}.${k}: 未知のキーです`),
    ...keys.required.filter((k) => !(k in raw)).map((k) => `${name}.${k}: 必須のキーがありません`),
  ];
}

export interface ComposeInput {
  pr: number;
  /** 判定した head（判定入力の headSha） */
  judgedHead: string;
  /** 投稿直前に読んだ PR の head */
  currentHead: string;
  reviewer: unknown;
  risk: unknown;
  /** judgedBy は判定者の説明（「付き添いのセッション」やセッションの URL など） */
  meta: { model?: string; judgedBy: string };
}

/** Reviewer と Risk Agent の出力から判定コメントを作り、書式を検査する */
export function composeVerdict(input: ComposeInput): Parsed<string> {
  if (input.judgedHead !== input.currentHead) {
    return { ok: false, errors: [`判定した head（${input.judgedHead}）と現在の head（${input.currentHead}）が違う。判定し直す`] };
  }
  const keyErrors = [...checkKeys(input.reviewer, 'reviewer', REVIEWER_KEYS), ...checkKeys(input.risk, 'risk', RISK_KEYS)];
  if (keyErrors.length > 0) return { ok: false, errors: keyErrors };
  const { facts, ...risk } = input.risk as Record<string, unknown>;
  const metrics: Record<string, string> = { ...(input.meta.model ? { model: input.meta.model } : {}), stage: 'judge', judgedBy: input.meta.judgedBy };
  const parsed = parseVerdict({ version: 1, pr: input.pr, headSha: input.judgedHead, review: input.reviewer, risk, facts, metrics });
  if (!parsed.ok) return parsed;
  const v = parsed.value;
  const unsafe = RISK_QUESTIONS.filter((q) => v.risk.answers[q.key] !== q.safe).map((q) => `- ${q.text}：${v.risk.answers[q.key]}`);
  const body = [
    CLAUDE_MARK,
    '## 判定',
    '',
    `- Reviewer：${v.review.pass ? '合格' : '不合格'}（ブロッキング指摘 ${v.review.blocking.length} 件）`,
    `- Risk：${v.risk.level}${unsafe.length > 0 ? '。安全側でない答え：' : ''}`,
    ...unsafe.map((l) => `  ${l}`),
    '',
    renderBlock('agent-verdict', v),
  ].join('\n');
  return { ok: true, value: `${body}\n` };
}
