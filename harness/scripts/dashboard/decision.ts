/**
 * ダッシュボードから人の決定の記録（```agent-decision）を投稿する部品（POST /decisions。Issue #855）。
 * decisionInfo は答える欄の材料、buildDecisionComment は記録の組み立て、checkBeforePost は投稿の前の読み直し（`post-decision` と同じ条件）、
 * CommentOnlyTransport は書く経路を Issue のコメントの POST 1種類だけに絞る Transport、createDecisionSink は読み直しから投稿までを1回で行う受け皿。
 * 記録の書式は harness/docs/formats.md の「決定の記録」。ダッシュボードにはセッションが無いので、目印は ID の無い CLAUDE_MARK。
 */
import { CLAUDE_MARK, extractBlock, renderBlock } from '../../lib/blocks.ts';
import { TRUSTED_ASSOCIATIONS, type HarnessConfig } from '../../lib/config.ts';
import { DECISION_MAX_ANSWER_CHARS, decisionTargets, parseDecision, uncoveredTargets, type Decision } from '../../lib/decision.ts';
import type { GitHub, IssueComment, RequestOptions, Transport } from '../../lib/github.ts';
import { recordedOrigin, type Plan } from '../../lib/plan.ts';
import { latestPlanGate, type PlanGateRecord } from '../../lib/state.ts';

export interface DecisionItem {
  id: string;
  kind: 'reason' | 'question';
  text: string;
  choices: string[];
}

export interface DecisionInfo {
  issue: number;
  planCommentId: number;
  mode: 'proceed' | 'answers' | 'none';
  items: DecisionItem[];
  note?: string;
}

export interface DecisionRequest {
  issue: number;
  planCommentId: number;
  proceed?: { text?: string };
  answers?: { to: string; choice?: string; text?: string }[];
}

type GateValue = PlanGateRecord & { plan?: unknown };

const PROCEED_CHOICE = '進める';

function isPlanCopy(plan: unknown): plan is Plan {
  return typeof plan === 'object' && plan !== null && !Array.isArray(plan);
}

/** 計画の写しの項目（reason・question）への答えを、計画ゲートの記録より後のコラボレーターの決定の記録が全部そろえているか */
function answeredAfter(comments: IssueComment[], gateCommentId: number, planCommentId: number, plan: Plan): boolean {
  const targets = decisionTargets(plan);
  return comments.some((c) => {
    if (c.id <= gateCommentId || !TRUSTED_ASSOCIATIONS.has(c.author_association)) return false;
    const block = extractBlock(c.body, 'agent-decision');
    if (!block.found || !block.ok) return false;
    const parsed = parseDecision(block.value);
    if (!parsed.ok || parsed.value.answers.length === 0 || parsed.value.planCommentId !== planCommentId) return false;
    const { missing, unknown } = uncoveredTargets(targets, parsed.value);
    return missing.length === 0 && unknown.length === 0;
  });
}

/** 答える欄の材料。最新の計画ゲートの記録が止まった記録のときだけ返す（それ以外は null） */
export function decisionInfo(config: HarnessConfig, issue: { number: number; state: string; labels: string[] }, comments: IssueComment[]): DecisionInfo | null {
  const gate = latestPlanGate(config, comments);
  if (!gate || gate.value.pass !== false) return null;
  const value = gate.value as GateValue;
  const base = { issue: issue.number, planCommentId: value.planCommentId, items: [] as DecisionItem[] };
  const none = (note: string): DecisionInfo => ({ ...base, mode: 'none', note });
  if (!isPlanCopy(value.plan)) return none('App の記録に計画の写しがありません');
  const plan = value.plan;
  if (plan.acChangeProposed) return none('要件・AC の変更の提案があります。人が Issue の本文を直して計画を出し直します');
  if (recordedOrigin(value) !== 'planner') return { ...base, mode: 'proceed' };
  const targets = decisionTargets(plan);
  if (targets.length === 0) return none('人が付けた印です。人が印を外して計画を出し直します');
  if (answeredAfter(comments, gate.comment.id, value.planCommentId, plan)) return { ...base, mode: 'proceed' };
  const rawChoices = (plan as { openQuestionChoices?: unknown }).openQuestionChoices;
  const choicesOf = (i: number): string[] => {
    const c = Array.isArray(rawChoices) ? rawChoices[i] : undefined;
    return Array.isArray(c) && c.every((x) => typeof x === 'string') ? (c as string[]) : [];
  };
  const items = targets.map((t) => ({ ...t, choices: t.kind === 'question' ? choicesOf(Number(t.id.split(':')[1])) : [] }));
  return { ...base, mode: 'answers', items };
}

/** 人の文の前後の空白を除く（無ければ空） */
const trimmed = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
/** 要約に書く人の文：空白の並びを1つにまとめる（行の頭にフェンスが来ない） */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ');

/** 画面から来た答えを決定の記録のコメントにする。誤りがあれば何も組み立てない */
export function buildDecisionComment(info: DecisionInfo, request: DecisionRequest, now: Date): { ok: true; body: string; decision: Decision } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (request.issue !== info.issue) errors.push(`issue（${request.issue}）が #${info.issue} と一致しません`);
  if (request.planCommentId !== info.planCommentId) errors.push(`planCommentId（${request.planCommentId}）が最新の計画ゲートの記録（${info.planCommentId}）と一致しません`);
  if ((request.proceed === undefined) === (request.answers === undefined)) errors.push('proceed と answers はどちらか片方だけ書きます');
  if (errors.length > 0) return { ok: false, errors };
  const at = now.toISOString();
  const lines: string[] = [];
  let value: Record<string, unknown>;
  if (request.proceed !== undefined) {
    const text = trimmed(request.proceed.text);
    if (text.length > DECISION_MAX_ANSWER_CHARS) return { ok: false, errors: [`文は ${DECISION_MAX_ANSWER_CHARS} 文字までです`] };
    const quote = text === '' ? PROCEED_CHOICE : text;
    value = { version: 1, issue: request.issue, planCommentId: request.planCommentId, proceed: { choice: PROCEED_CHOICE, quote, at } };
    lines.push(`- 進める：${oneLine(quote)}`);
  } else {
    const answers = request.answers!;
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    if (!Array.isArray(answers) || answers.length === 0) return { ok: false, errors: ['answers が空です'] };
    for (const a of answers) {
      const item = info.items.find((i) => i.id === a?.to);
      if (!item) {
        errors.push(`存在しない項目への答えです: ${String(a?.to)}`);
        continue;
      }
      if (seen.has(item.id)) {
        errors.push(`同じ項目への答えが重複しています: ${item.id}`);
        continue;
      }
      seen.add(item.id);
      const choice = a.choice === undefined || a.choice === '' ? undefined : a.choice;
      if (choice !== undefined && !item.choices.includes(choice)) {
        errors.push(`${item.id}: 選択肢にない choice です`);
        continue;
      }
      const quote = trimmed(a.text) || choice || '';
      if (quote === '') {
        errors.push(`${item.id}: 答えの文も選択肢もありません`);
        continue;
      }
      if (quote.length > DECISION_MAX_ANSWER_CHARS) {
        errors.push(`${item.id}: 文は ${DECISION_MAX_ANSWER_CHARS} 文字までです`);
        continue;
      }
      out.push(choice === undefined ? { to: item.id, quote, at } : { to: item.id, choice, quote, at });
      lines.push(`- ${item.id}：${choice !== undefined ? `${oneLine(choice)} ／ ` : ''}${oneLine(quote)}`);
    }
    if (errors.length > 0) return { ok: false, errors };
    value = { version: 1, issue: request.issue, planCommentId: request.planCommentId, answers: out };
  }
  const parsed = parseDecision(value);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const body = [CLAUDE_MARK, '## 人の決定', '', 'ダッシュボードから記録しました。', '', ...lines, '', renderBlock('agent-decision', value)].join('\n');
  const block = extractBlock(body, 'agent-decision');
  if (!block.found || !block.ok) return { ok: false, errors: ['agent-decision ブロックが1つだけ読めません'] };
  const reread = parseDecision(block.value);
  if (!reread.ok || JSON.stringify(block.value) !== JSON.stringify(value)) return { ok: false, errors: ['組み立てた記録を読み直すと値が違います'] };
  return { ok: true, body, decision: parsed.value };
}

/** 投稿の前の読み直し。409 は状態の食い違い、400 は答えの形の誤り */
export function checkBeforePost(
  config: HarnessConfig,
  issue: { number: number; state: string; labels: string[] },
  comments: IssueComment[],
  decision: Decision,
): { ok: true } | { ok: false; status: 400 | 409; errors: string[] } {
  const conflicts: string[] = [];
  const n = issue.number;
  if (issue.state !== 'open') conflicts.push(`#${n} は開いていません`);
  if (!issue.labels.includes('agent:plan-review')) conflicts.push(`#${n} に agent:plan-review が付いていません`);
  const gate = latestPlanGate(config, comments);
  const value = gate?.value as GateValue | undefined;
  if (!gate || !value || value.pass === true || !isPlanCopy(value.plan)) {
    conflicts.push(`#${n} に、止まった App の計画ゲートの記録（計画の写し）がありません`);
    return { ok: false, status: 409, errors: conflicts };
  }
  if (value.planCommentId !== decision.planCommentId) conflicts.push(`planCommentId（${decision.planCommentId}）が最新の計画ゲートの記録（${value.planCommentId}）と一致しません`);
  if (value.plan.acChangeProposed) conflicts.push('計画に要件・AC の変更提案があります（Issue 本文の変更は人の役割です）');
  if (!decision.proceed && recordedOrigin(value) !== 'planner') conflicts.push('最新の記録が Planner の申告による停止ではありません（答えの記録は使えません）');
  if (conflicts.length > 0) return { ok: false, status: 409, errors: conflicts };
  if (!decision.proceed) {
    const { missing, unknown } = uncoveredTargets(decisionTargets(value.plan), decision);
    const errors = [...missing.map((t) => `答えがありません: ${t.id}（${t.text}）`), ...unknown.map((u) => `計画に無い項目への答えです: ${u}`)];
    if (errors.length > 0) return { ok: false, status: 400, errors };
  }
  return { ok: true };
}

const COMMENT_PATH = /^\/repos\/([^/]+\/[^/]+)\/issues\/[1-9]\d*\/comments$/;

/** 書く経路を POST /repos/{repo}/issues/{n}/comments だけにする Transport。ほかは送らずに reject する（GET も送らない） */
export class CommentOnlyTransport implements Transport {
  private readonly inner: Transport;
  private readonly repository: string;
  constructor(inner: Transport, repository: string) {
    this.inner = inner;
    this.repository = repository;
  }

  request(method: string, path: string, opts?: RequestOptions): Promise<unknown> {
    const m = COMMENT_PATH.exec(path);
    if (method.toUpperCase() === 'POST' && m && m[1] === this.repository) return this.inner.request(method, path, opts);
    return Promise.reject(new Error(`ダッシュボードが書くのは Issue のコメントだけです（${method} ${path} は送りません）`));
  }
}

/** POST /decisions の受け皿。token はページの合言葉、submit は読み直しから投稿まで（結果は HTTP の番号と本文） */
export interface DecisionSink {
  token: string;
  submit(raw: unknown): Promise<{ status: number; body: unknown }>;
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function createDecisionSink(opts: { config: HarnessConfig; read: GitHub; write: GitHub; token: string; now?: () => Date }): DecisionSink {
  const { config, read, write } = opts;
  const now = opts.now ?? (() => new Date());
  const fail = (status: number, ...errors: string[]) => ({ status, body: { errors } });
  return {
    token: opts.token,
    async submit(raw) {
      const r = raw as Partial<DecisionRequest> | null;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !posInt(r?.issue) || !posInt(r?.planCommentId)) {
        return fail(400, 'issue と planCommentId は正の整数で渡します');
      }
      const request = raw as DecisionRequest;
      const n = request.issue;
      let issue: { number: number; state: string; labels: string[] };
      let comments: IssueComment[];
      try {
        const got = await read.get<{ number: number; state: string; labels: ({ name: string } | string)[]; pull_request?: unknown }>(`/issues/${n}`);
        if (got.pull_request) return fail(409, `#${n} は PR です`);
        issue = { number: got.number, state: got.state, labels: (got.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)) };
        comments = await read.listComments(n);
      } catch {
        return fail(502, 'GitHub から読めませんでした');
      }
      const info = decisionInfo(config, issue, comments);
      if (!info) return fail(409, `#${n} の最新の計画ゲートの記録は止まった記録ではありません`);
      const built = buildDecisionComment(info, request, now());
      if (!built.ok) return { status: request.planCommentId !== info.planCommentId ? 409 : 400, body: { errors: built.errors } };
      const checked = checkBeforePost(config, issue, comments, built.decision);
      if (!checked.ok) return { status: checked.status, body: { errors: checked.errors } };
      try {
        const posted = await write.comment(n, built.body);
        return { status: 201, body: { url: posted.html_url } };
      } catch {
        return fail(502, 'GitHub に投稿できませんでした');
      }
    },
  };
}
