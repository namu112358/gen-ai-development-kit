/**
 * 手元のダッシュボードの確認事項（```agent-confirm）の答える欄の材料と、POST /confirm-answers の受け皿（Issue #964）。
 * unansweredConfirms は答えの無い確認事項を古い順に並べる材料、buildConfirmAnswerComment は答え（```agent-confirm-answer）のコメントの組み立て、createConfirmSink は読み直しから投稿までを1回で行う受け皿。
 * 判定は harness/lib/confirm.ts の confirmFacts・confirmAnswerOf を呼ぶだけ。ダッシュボードにはセッションが無いので目印は ID の無い CLAUDE_MARK。書く経路は decision.ts の CommentOnlyTransport（Issue のコメントの POST だけ）。
 */
import { CLAUDE_MARK, renderBlock } from '../../lib/blocks.ts';
import { confirmAnswerOf, confirmFacts, type Confirm } from '../../lib/confirm.ts';
import { DECISION_MAX_ANSWER_CHARS } from '../../lib/decision.ts';
import type { GitHub, IssueComment } from '../../lib/github.ts';

export interface ConfirmInfo {
  target: number;
  kind: 'issue' | 'pr';
  confirmCommentId: number;
  url: string;
  createdAt: string;
  stage: string;
  resume: string;
  questions: { text: string; why: string; choices: string[] }[];
}

export interface ConfirmAnswerRequest {
  target: number;
  confirmCommentId: number;
  answers: { to: string; choice?: string; text?: string }[];
}

/** 答えの無い確認事項を古い順（作った時刻、同じならコメントの ID）に返す。target はコメントを読んだ Issue か PR の番号 */
export function unansweredConfirms(comments: IssueComment[], target: number, kind: 'issue' | 'pr'): ConfirmInfo[] {
  return confirmFacts(comments, [], () => target)
    .filter((f) => f.answer === null)
    .map((f) => ({
      target,
      kind,
      confirmCommentId: f.commentId,
      url: f.url,
      createdAt: f.createdAt,
      stage: f.confirm.stage,
      resume: f.confirm.resume,
      questions: f.confirm.questions.map((q) => ({ text: q.text, why: q.why, choices: q.choices ?? [] })),
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.confirmCommentId - b.confirmCommentId);
}

const trimmed = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');
const oneLine = (s: string): string => s.replace(/\s+/g, ' ');
const TO_RE = /^question:(0|[1-9]\d*)$/;

/** 画面から来た答えを確認事項への答えのコメントにする。誤りがあれば何も組み立てない */
export function buildConfirmAnswerComment(
  confirm: { commentId: number; value: Confirm },
  request: ConfirmAnswerRequest,
  now: Date,
): { ok: true; body: string } | { ok: false; errors: string[] } {
  const answers = request.answers;
  if (!Array.isArray(answers) || answers.length === 0) return { ok: false, errors: ['answers が空です'] };
  const questions = confirm.value.questions;
  const errors: string[] = [];
  const at = now.toISOString();
  const byIndex = new Map<number, { to: string; choice?: string; quote: string; at: string }>();
  for (const a of answers) {
    const m = typeof a?.to === 'string' ? TO_RE.exec(a.to) : null;
    const index = m ? Number(m[1]) : -1;
    const question = questions[index];
    if (!m || !question) {
      errors.push(`存在しない質問への答えです: ${String(a?.to)}`);
      continue;
    }
    if (byIndex.has(index)) {
      errors.push(`同じ質問への答えが重複しています: ${a.to}`);
      continue;
    }
    const choice = a.choice === undefined || a.choice === '' ? undefined : a.choice;
    if (choice !== undefined && !(question.choices ?? []).includes(choice)) {
      errors.push(`${a.to}: 選択肢にない choice です`);
      continue;
    }
    const quote = trimmed(a.text) || choice || '';
    if (quote === '') {
      errors.push(`${a.to}: 答えの文も選択肢もありません`);
      continue;
    }
    if (quote.length > DECISION_MAX_ANSWER_CHARS) {
      errors.push(`${a.to}: 文は ${DECISION_MAX_ANSWER_CHARS} 文字までです`);
      continue;
    }
    byIndex.set(index, choice === undefined ? { to: a.to, quote, at } : { to: a.to, choice, quote, at });
  }
  if (errors.length > 0) return { ok: false, errors };
  const missing = questions.map((_, i) => i).filter((i) => !byIndex.has(i));
  if (missing.length > 0) return { ok: false, errors: missing.map((i) => `答えがありません: question:${i}（${oneLine(questions[i]!.text)}）`) };
  const ordered = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const value = { version: 1, target: confirm.value.target, confirmCommentId: confirm.commentId, answers: ordered };
  const lines = ordered.map((v) => `- ${v.to}：${v.choice !== undefined ? `${oneLine(v.choice)} ／ ` : ''}${oneLine(v.quote)}`);
  const body = [CLAUDE_MARK, '## 確認事項への答え', '', '手元のダッシュボードから答えました。', '', ...lines, '', renderBlock('agent-confirm-answer', value)].join('\n');
  // 組み立てた本文が答えとして読めるかを、仮のコメントで確かめる（書式と突き合わせだけ）
  const probe: IssueComment = { id: confirm.commentId + 1, body, html_url: '', created_at: at, updated_at: at, author_association: 'OWNER', user: { login: 'me', type: 'User' } };
  const read = confirmAnswerOf(confirm, probe);
  if (!read.ok) return { ok: false, errors: [`組み立てた答えが読めません: ${read.reason}`] };
  return { ok: true, body };
}

/** POST /confirm-answers の受け皿。token はページの合言葉、submit は読み直しから投稿まで（結果は HTTP の番号と本文） */
export interface ConfirmSink {
  token: string;
  submit(raw: unknown): Promise<{ status: number; body: unknown }>;
}

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function createConfirmSink(opts: { read: GitHub; write: GitHub; token: string; now?: () => Date }): ConfirmSink {
  const { read, write } = opts;
  const now = opts.now ?? (() => new Date());
  const fail = (status: number, ...errors: string[]) => ({ status, body: { errors } });
  return {
    token: opts.token,
    async submit(raw) {
      const r = raw as Partial<ConfirmAnswerRequest> | null;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !posInt(r?.target) || !posInt(r?.confirmCommentId)) {
        return fail(400, 'target と confirmCommentId は正の整数で渡します');
      }
      if (!Array.isArray(r.answers) || r.answers.length === 0) return fail(400, 'answers が空です');
      const request = raw as ConfirmAnswerRequest;
      const n = request.target;
      let state: string;
      let comments: IssueComment[];
      try {
        state = (await read.get<{ state: string }>(`/issues/${n}`)).state;
        comments = await read.listComments(n);
      } catch {
        return fail(502, 'GitHub から読めませんでした');
      }
      if (state !== 'open') return fail(409, `#${n} は開いていません`);
      const fact = confirmFacts(comments, [], () => n).find((f) => f.commentId === request.confirmCommentId);
      if (!fact) return fail(409, `#${n} に確認事項（コメント ${request.confirmCommentId}）がありません`);
      if (fact.answer !== null) return fail(409, `確認事項（コメント ${request.confirmCommentId}）にはもう答えがあります`);
      const built = buildConfirmAnswerComment({ commentId: fact.commentId, value: fact.confirm }, request, now());
      if (!built.ok) return { status: 400, body: { errors: built.errors } };
      try {
        const posted = await write.comment(n, built.body);
        return { status: 201, body: { url: posted.html_url } };
      } catch {
        return fail(502, 'GitHub に投稿できませんでした');
      }
    },
  };
}
