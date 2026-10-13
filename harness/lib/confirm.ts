import { claudeMarkSession, extractBlock, hasClaudeMark } from './blocks.ts';
import { TRUSTED_ASSOCIATIONS } from './config.ts';
import { DECISION_MAX_ANSWER_CHARS } from './decision.ts';
import type { ClaimTimelineItem } from './facts.ts';
import type { IssueComment } from './github.ts';
import { CLAIM_STAGES } from './queue.ts';
import { Checker } from './validate.ts';

/**
 * 確認事項（```agent-confirm）と、それへの人の答え（Issue #949・#953）。
 * 付き添いのセッションは、人の判断が要る場面で止まって待たずに、確認事項を対象の Issue か PR にコメントで書き（`agent.ts post-confirm`）、ほかの作業を続ける。
 * 人はコメントで答え、そのコメントがそのまま人の名義の決定の記録になる。step・fleet-status の待つ・再開は #954、書式の説明（harness/docs/formats.md）も #954 で入る。
 *
 * 確認事項の値：{ version: 1, target, stage, resume, questions: [{ text, why, choices? }], holds }
 * - target はコメント先の Issue か PR の番号。stage は止めた段階、resume は答えの後に再開する段階（CONFIRM_STAGES。resume は stage と同じか手前）
 * - questions は1〜10件。text・why（なぜ人が要るか）は空でなく 2000 文字まで、choices は 2〜4 個の空でない重複の無い文字列。holds（答えが無い間に止める範囲）は空でなく 2000 文字まで
 *
 * 答えの形は2つ。どちらも、確認事項のある Issue / PR へのコメント：
 * - ```agent-confirm-answer：{ version: 1, target, confirmCommentId, answers: [{ to: "question:<添字>", choice?, quote, at }] }（手元のダッシュボードが書く）
 * - 短い形：最初の空でない行が `/answer <確認事項のコメントID>`、続く空でない行が `<質問の番号（1から）>: <答え>`（人が GitHub で書く）。
 *   答えが選択肢とちょうど同じなら choice にも入れ、at はコメントの created_at
 *
 * 答えとして読むのは、コラボレーター（OWNER・MEMBER・COLLABORATOR）のコメントで、セッションの ID のある Claude の目印が無く（セッションは答えを書かない）、
 * confirmCommentId が確認事項のコメントと同じで、確認事項より後に書かれ、すべての質問に答えがあり、存在しない添字・同じ添字の重複が無いものだけ。
 * 「後」はコメントの ID の大小で見る（同じ秒のコメントでも順序が決まるため、created_at では比べない）。
 * 答えは人の名義で書かれ、目印を付けずにセッションが書けば見分けられない（agent-decision と同じ限界）。
 */

export const CONFIRM_STAGES = ['plan', 'plan-critique', 'implement', 'judge', 'fix', 'sync'] as const;
export type ConfirmStage = (typeof CONFIRM_STAGES)[number];

export interface ConfirmQuestion {
  text: string;
  why: string;
  choices?: string[];
}

export interface Confirm {
  version: 1;
  target: number;
  stage: ConfirmStage;
  resume: ConfirmStage;
  questions: ConfirmQuestion[];
  holds: string;
}

export interface ConfirmAnswerItem {
  /** `question:<添字>` */
  to: string;
  /** 選択肢で答えたときに選んだ項目 */
  choice?: string;
  /** 人の言葉そのまま */
  quote: string;
  at: string;
}

export interface ConfirmAnswer {
  version: 1;
  target: number;
  confirmCommentId: number;
  answers: ConfirmAnswerItem[];
}

export interface ConfirmFact {
  confirm: Confirm;
  commentId: number;
  url: string;
  createdAt: string;
  /** 最初に条件を満たした答えのコメント。無ければ null */
  answer: { commentId: number; url: string; createdAt: string; answers: ConfirmAnswerItem[] } | null;
  /** 答えの後に、段階が resume と同じか先の着手宣言がある（どのセッションでも） */
  resumed: boolean;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const MAX_QUESTIONS = 10;
const MAX_TEXT = 2000;
const CONFIRM_KEYS = ['version', 'target', 'stage', 'resume', 'questions', 'holds'];
const QUESTION_KEYS = ['text', 'why', 'choices'];
const ANSWER_KEYS = ['version', 'target', 'confirmCommentId', 'answers'];
const ITEM_KEYS = ['to', 'choice', 'quote', 'at'];
const TO_RE = /^question:(0|[1-9]\d*)$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function unknownKeys(c: Checker, o: Record<string, unknown>, keys: string[], path: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) c.errors.push(`${path}.${k}: 未知のキーです`);
}

function boundedText(c: Checker, value: unknown, path: string, max = MAX_TEXT): string {
  const s = c.string(value, path, { nonEmpty: true });
  if (s.length > max) c.errors.push(`${path}: ${max} 文字を超えています`);
  return s;
}

function positiveInteger(c: Checker, value: unknown, path: string): number {
  const n = c.integer(value, path);
  if (Number.isInteger(value) && n <= 0) c.errors.push(`${path}: 正の整数ではありません`);
  return n;
}

export function parseConfirm(raw: unknown): Parsed<Confirm> {
  const c = new Checker();
  const o = c.object(raw, 'confirm');
  if (!o) return { ok: false, errors: c.errors };
  unknownKeys(c, o, CONFIRM_KEYS, 'confirm');
  if (o.version !== 1) c.errors.push('confirm.version: 1 ではありません');
  const target = positiveInteger(c, o.target, 'confirm.target');
  const stage = c.oneOf(o.stage, CONFIRM_STAGES, 'confirm.stage');
  const resume = c.oneOf(o.resume, CONFIRM_STAGES, 'confirm.resume');
  if (CONFIRM_STAGES.indexOf(resume) > CONFIRM_STAGES.indexOf(stage)) c.errors.push('confirm.resume: stage より先の段階です（同じか手前の段階だけ）');
  const questions: ConfirmQuestion[] = [];
  const list = c.array(o.questions, 'confirm.questions');
  if (Array.isArray(o.questions) && (list.length === 0 || list.length > MAX_QUESTIONS)) c.errors.push(`confirm.questions: 1〜${MAX_QUESTIONS} 件ではありません`);
  list.forEach((q, i) => {
    const path = `confirm.questions[${i}]`;
    const x = c.object(q, path);
    if (!x) return;
    unknownKeys(c, x, QUESTION_KEYS, path);
    const question: ConfirmQuestion = { text: boundedText(c, x.text, `${path}.text`), why: boundedText(c, x.why, `${path}.why`) };
    if (x.choices !== undefined) {
      const choices = c.stringArray(x.choices, `${path}.choices`);
      if (Array.isArray(x.choices) && (choices.length < 2 || choices.length > 4)) c.errors.push(`${path}.choices: 2〜4 個ではありません`);
      if (choices.some((s) => typeof s === 'string' && s.trim() === '')) c.errors.push(`${path}.choices: 空の選択肢があります`);
      if (new Set(choices).size !== choices.length) c.errors.push(`${path}.choices: 重複があります`);
      question.choices = choices;
    }
    questions.push(question);
  });
  const holds = boundedText(c, o.holds, 'confirm.holds');
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: { version: 1, target, stage, resume, questions, holds } };
}

export function parseConfirmAnswer(raw: unknown): Parsed<ConfirmAnswer> {
  const c = new Checker();
  const o = c.object(raw, 'confirmAnswer');
  if (!o) return { ok: false, errors: c.errors };
  unknownKeys(c, o, ANSWER_KEYS, 'confirmAnswer');
  if (o.version !== 1) c.errors.push('confirmAnswer.version: 1 ではありません');
  const target = positiveInteger(c, o.target, 'confirmAnswer.target');
  const confirmCommentId = positiveInteger(c, o.confirmCommentId, 'confirmAnswer.confirmCommentId');
  const answers: ConfirmAnswerItem[] = [];
  const list = c.array(o.answers, 'confirmAnswer.answers');
  if (Array.isArray(o.answers) && list.length === 0) c.errors.push('confirmAnswer.answers: 1件以上必要です');
  list.forEach((a, i) => {
    const path = `confirmAnswer.answers[${i}]`;
    const x = c.object(a, path);
    if (!x) return;
    unknownKeys(c, x, ITEM_KEYS, path);
    const to = c.string(x.to, `${path}.to`);
    if (typeof x.to === 'string' && !TO_RE.test(to)) c.errors.push(`${path}.to: question:<添字> ではありません`);
    const quote = boundedText(c, x.quote, `${path}.quote`, DECISION_MAX_ANSWER_CHARS);
    const at = c.string(x.at, `${path}.at`);
    if (typeof x.at === 'string' && (!ISO_RE.test(at) || Number.isNaN(Date.parse(at)))) c.errors.push(`${path}.at: ISO 8601 の日時ではありません`);
    const item: ConfirmAnswerItem = { to, quote, at };
    if (x.choice !== undefined) item.choice = c.string(x.choice, `${path}.choice`, { nonEmpty: true });
    answers.push(item);
  });
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: { version: 1, target, confirmCommentId, answers } };
}

/** 短い答えの形。形に合わなければ null */
export function parseShortAnswer(body: string): { confirmCommentId: number; answers: { index: number; text: string }[] } | null {
  const lines = body.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const head = lines[0]?.match(/^\/answer\s+([1-9]\d*)$/);
  if (!head) return null;
  const answers: { index: number; text: string }[] = [];
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\d+)\s*[:：]\s*(.*)$/);
    if (!m) return null;
    const index = Number(m[1]);
    if (!Number.isSafeInteger(index) || index < 1) return null;
    answers.push({ index, text: m[2]! });
  }
  return { confirmCommentId: Number(head[1]), answers };
}

/** コメントを確認事項への答えとして読むか。読まないときは理由を返す */
export function confirmAnswerOf(confirm: { commentId: number; value: Confirm }, comment: IssueComment): { ok: true; value: ConfirmAnswer } | { ok: false; reason: string } {
  if (!TRUSTED_ASSOCIATIONS.has(comment.author_association)) return { ok: false, reason: 'コラボレーター以外のコメントです' };
  if (claudeMarkSession(comment.body) !== null) return { ok: false, reason: 'セッションが書いたコメント（セッションの ID のある目印）です' };
  let answer: ConfirmAnswer;
  const block = extractBlock(comment.body, 'agent-confirm-answer');
  if (block.found) {
    if (!block.ok) return { ok: false, reason: block.error };
    const parsed = parseConfirmAnswer(block.value);
    if (!parsed.ok) return { ok: false, reason: parsed.errors.join('、') };
    answer = parsed.value;
  } else {
    const short = parseShortAnswer(comment.body);
    if (short === null) return { ok: false, reason: '答えの形（agent-confirm-answer か /answer）がありません' };
    answer = {
      version: 1,
      target: confirm.value.target,
      confirmCommentId: short.confirmCommentId,
      answers: short.answers.map((a) => {
        const choices = confirm.value.questions[a.index - 1]?.choices ?? [];
        const item: ConfirmAnswerItem = { to: `question:${a.index - 1}`, quote: a.text, at: comment.created_at };
        if (choices.includes(a.text)) item.choice = a.text;
        return item;
      }),
    };
    if (answer.answers.some((a) => a.quote.trim() === '')) return { ok: false, reason: '空の答えがあります' };
  }
  if (answer.confirmCommentId !== confirm.commentId) return { ok: false, reason: '別の確認事項への答えです' };
  if (answer.target !== confirm.value.target) return { ok: false, reason: 'target が確認事項と違います' };
  if (comment.id <= confirm.commentId) return { ok: false, reason: '確認事項より前のコメントです' };
  const seen = new Set<number>();
  for (const a of answer.answers) {
    const index = Number(a.to.slice('question:'.length));
    if (index >= confirm.value.questions.length) return { ok: false, reason: `確認事項に無い質問への答えです: ${a.to}` };
    if (seen.has(index)) return { ok: false, reason: `同じ質問への答えが重なっています: ${a.to}` };
    seen.add(index);
  }
  if (seen.size !== confirm.value.questions.length) return { ok: false, reason: '答えの無い質問があります' };
  return { ok: true, value: answer };
}

/** コメントの URL の Issue か PR の番号（読めなければ null） */
function commentTarget(comment: IssueComment): number | null {
  const m = comment.html_url.match(/\/(?:issues|pull)\/(\d+)(?:#|$)/);
  return m ? Number(m[1]) : null;
}

const stageIndex = (stage: string | undefined): number => (stage === undefined ? -1 : (CLAIM_STAGES as readonly string[]).indexOf(stage));

/**
 * コメント（Issue と PR のものを合わせてよい）から確認事項と答えの組を古い順に作る。
 * resumed は、答えのコメントの created_at より後の claim.at を持ち、段階が resume と同じか先（CLAIM_STAGES の順）の宣言があるか（どのセッションでも、解除も含む）。
 * 比べるのは claims の要素の claim.at（history の段階は段階の at）で、要素の at（先頭の段階と history の無い宣言はコメントの created_at）ではない。段階の無い要素は数えない
 */
export function confirmFacts(comments: IssueComment[], claims: ClaimTimelineItem[]): ConfirmFact[] {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const facts: ConfirmFact[] = [];
  for (const c of sorted) {
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association) || !hasClaudeMark(c.body)) continue;
    const block = extractBlock(c.body, 'agent-confirm');
    if (!block.found || !block.ok) continue;
    const parsed = parseConfirm(block.value);
    if (!parsed.ok || commentTarget(c) !== parsed.value.target) continue;
    const confirm = { commentId: c.id, value: parsed.value };
    let answer: ConfirmFact['answer'] = null;
    for (const r of sorted) {
      if (r.id <= c.id) continue;
      const a = confirmAnswerOf(confirm, r);
      if (a.ok) {
        answer = { commentId: r.id, url: r.html_url, createdAt: r.created_at, answers: a.value.answers };
        break;
      }
    }
    const resumed = answer !== null && claims.some((item) => {
      if (item.kind !== 'claim' || item.claim === null) return false;
      const at = Date.parse(item.claim.at);
      if (Number.isNaN(at) || !(at > Date.parse(answer!.createdAt))) return false;
      const i = stageIndex(item.claim.stage);
      return i >= 0 && i >= stageIndex(parsed.value.resume);
    });
    facts.push({ confirm: parsed.value, commentId: c.id, url: c.html_url, createdAt: c.created_at, answer, resumed });
  }
  return facts;
}
