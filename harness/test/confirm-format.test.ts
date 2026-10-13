/**
 * 確認事項（```agent-confirm）と答え（```agent-confirm-answer・短い答えの /answer）の純粋関数のテスト（Issue #953）。
 * (1) 受け入れ：確認事項の検査が通り、フェンスの答えと短い答えが同じ答えの値になる（選択肢とちょうど同じ答えは choice にも入る）。
 * (2) 書式の誤り（stage より先の resume を含む）を parseConfirm・parseConfirmAnswer・parseShortAnswer が拒む。
 * (3)〜(6) 答えとして読まないもの（守り）：コラボレーター以外の答え、セッションの目印のある答え、答えの無い質問、
 *     存在しない添字・同じ添字の重複・別の確認事項への答え・確認事項より前のコメント。
 * (7) confirmFacts の resumed が、答えより後の宣言の値の at（claim.at）で決まる（要素の at ＝コメントの created_at は使わない）。
 * 文言は固定せず、ok・件数・値で確かめる。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MARK, claudeMark, renderBlock } from '../lib/blocks.ts';
import { claimTimeline } from '../lib/facts.ts';
import type { IssueComment } from '../lib/github.ts';
import type { ClaimEntry, ClaimStage, StoredClaim } from '../lib/queue.ts';
import {
  confirmAnswerOf,
  confirmFacts,
  parseConfirm,
  parseConfirmAnswer,
  parseShortAnswer,
  type Confirm,
} from '../lib/confirm.ts';

const SESSION = 'https://claude.ai/code/session_01ABCDEFGHxyz';
const CONFIRM_ID = 100;
const ANSWER_AT = '2026-10-01T10:00:00Z';

/** BlockKind に依らずにフェンスを書く（renderBlock と同じ形） */
const fence = (kind: string, value: unknown): string => ['```' + kind, JSON.stringify(value, null, 2), '```'].join('\n');

/** 質問2件（1件目は選択肢あり、2件目は選択肢なし）の確認事項 */
const confirmRaw = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  target: 7,
  stage: 'judge',
  resume: 'implement',
  questions: [
    { text: '既定を shadow にするか', why: '設定の既定は人の決定', choices: ['はい', 'いいえ'] },
    { text: 'いつまで待つか', why: '期限は Issue から決まらない' },
  ],
  holds: '答えがそろうまで実装を止める',
  ...patch,
});

const parsedConfirm = (): Confirm => {
  const r = parseConfirm(confirmRaw());
  assert.ok(r.ok, `確認事項の検査が通らない: ${JSON.stringify(r)}`);
  return r.value;
};

const confirmRef = () => ({ commentId: CONFIRM_ID, value: parsedConfirm() });

let nextId = 1000;
const comment = (body: string, patch: Partial<IssueComment> = {}): IssueComment => {
  const id = patch.id ?? nextId++;
  return {
    id, body, html_url: `https://github.com/o/r/issues/7#issuecomment-${id}`, created_at: ANSWER_AT, updated_at: '',
    author_association: 'OWNER', user: { login: 'human', type: 'User' }, ...patch,
  };
};

/** 短い答え（/answer <ID> と「番号: 答え」の行） */
const shortBody = (lines: string[], confirmId = CONFIRM_ID): string => [`/answer ${confirmId}`, ...lines].join('\n');

const answerRaw = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  target: 7,
  confirmCommentId: CONFIRM_ID,
  answers: [
    { to: 'question:0', choice: 'はい', quote: 'はい', at: ANSWER_AT },
    { to: 'question:1', quote: '来週まで待つ', at: ANSWER_AT },
  ],
  ...patch,
});

/** undefined のキーを落として比べる */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

// --- (1) 受け入れ ---

test('確認事項の検査が通り、agent-confirm-answer のフェンスと短い答えの形が同じ答えの値になる', () => {
  const confirm = parsedConfirm();
  assert.equal(confirm.target, 7);
  assert.equal(confirm.questions.length, 2);
  // resume が stage と同じでも通る（境界）
  assert.equal(parseConfirm(confirmRaw({ stage: 'implement', resume: 'implement' })).ok, true);

  const parsedAnswer = parseConfirmAnswer(answerRaw());
  assert.equal(parsedAnswer.ok, true);

  assert.deepEqual(parseShortAnswer(shortBody(['1: はい', '2: 来週まで待つ'])), {
    confirmCommentId: CONFIRM_ID,
    answers: [{ index: 1, text: 'はい' }, { index: 2, text: '来週まで待つ' }],
  });

  const viaFence = confirmAnswerOf(confirmRef(), comment(fence('agent-confirm-answer', answerRaw()), { id: 110 }));
  const viaShort = confirmAnswerOf(confirmRef(), comment(shortBody(['1: はい', '2: 来週まで待つ']), { id: 111 }));
  assert.ok(viaFence.ok, `フェンスの答えが読めない: ${JSON.stringify(viaFence)}`);
  assert.ok(viaShort.ok, `短い答えが読めない: ${JSON.stringify(viaShort)}`);
  const expected = plain(answerRaw());
  assert.deepEqual(plain(viaFence.value), expected);
  assert.deepEqual(plain(viaShort.value), expected);
});

// --- (2) 書式の誤り ---

test('書式の誤り（stage より先の resume を含む）を parseConfirm・parseConfirmAnswer・parseShortAnswer が拒む', () => {
  const q = (patch: Record<string, unknown> = {}) => ({ text: '質問', why: '理由', ...patch });
  const badConfirms: [string, Record<string, unknown>][] = [
    ['resume が stage より先', confirmRaw({ stage: 'plan', resume: 'implement' })],
    ['resume が stage より先（隣）', confirmRaw({ stage: 'judge', resume: 'fix' })],
    ['stage が未知', confirmRaw({ stage: 'plan-gate', resume: 'plan' })],
    ['version が 1 でない', confirmRaw({ version: 2 })],
    ['target が正の整数でない', confirmRaw({ target: 0 })],
    ['target が小数', confirmRaw({ target: 1.5 })],
    ['未知のキー', confirmRaw({ extra: true })],
    ['questions が空', confirmRaw({ questions: [] })],
    ['questions が 11 件', confirmRaw({ questions: Array.from({ length: 11 }, () => q()) })],
    ['text が空', confirmRaw({ questions: [q({ text: '' })] })],
    ['why が 2001 文字', confirmRaw({ questions: [q({ why: 'あ'.repeat(2001) })] })],
    ['choices が 1 個', confirmRaw({ questions: [q({ choices: ['はい'] })] })],
    ['choices が 5 個', confirmRaw({ questions: [q({ choices: ['a', 'b', 'c', 'd', 'e'] })] })],
    ['choices が重複', confirmRaw({ questions: [q({ choices: ['はい', 'はい'] })] })],
    ['choices に空文字', confirmRaw({ questions: [q({ choices: ['はい', ''] })] })],
    ['質問に未知のキー', confirmRaw({ questions: [q({ note: 'x' })] })],
    ['holds が空', confirmRaw({ holds: '' })],
    ['holds が 2001 文字', confirmRaw({ holds: 'あ'.repeat(2001) })],
  ];
  for (const [name, raw] of badConfirms) {
    const r = parseConfirm(raw);
    assert.equal(r.ok, false, `parseConfirm が通した: ${name}`);
    if (!r.ok) assert.ok(r.errors.length > 0, `誤りが空: ${name}`);
  }
  // 境界の内側（questions 10 件・2000 文字・choices 4 個）は通る
  assert.equal(parseConfirm(confirmRaw({ questions: Array.from({ length: 10 }, () => q({ why: 'あ'.repeat(2000), choices: ['a', 'b', 'c', 'd'] })), holds: 'あ'.repeat(2000) })).ok, true);

  const item = (patch: Record<string, unknown>) => ({ to: 'question:0', quote: 'はい', at: ANSWER_AT, ...patch });
  const badAnswers: [string, Record<string, unknown>][] = [
    ['to の形が違う', answerRaw({ answers: [item({ to: 'reason:0' })] })],
    ['to の添字が負', answerRaw({ answers: [item({ to: 'question:-1' })] })],
    ['quote が空', answerRaw({ answers: [item({ quote: '' })] })],
    ['quote が 20001 文字', answerRaw({ answers: [item({ quote: 'あ'.repeat(20_001) })] })],
    ['at が ISO 8601 でない', answerRaw({ answers: [item({ at: '昨日' })] })],
    ['confirmCommentId が無い', answerRaw({ confirmCommentId: undefined })],
    ['未知のキー', answerRaw({ extra: 1 })],
    ['version が 1 でない', answerRaw({ version: 2 })],
  ];
  for (const [name, raw] of badAnswers) {
    assert.equal(parseConfirmAnswer(plain(raw)).ok, false, `parseConfirmAnswer が通した: ${name}`);
  }

  const badShorts: [string, string][] = [
    ['/answer で始まらない', ['よろしく', '/answer 100', '1: はい'].join('\n')],
    ['/answer の ID が数字でない', ['/answer abc', '1: はい'].join('\n')],
    ['番号が 0', shortBody(['0: はい'])],
    ['番号が数字でない', shortBody(['一: はい'])],
    ['番号: 答え の形でない行', shortBody(['1: はい', 'ありがとう'])],
  ];
  for (const [name, body] of badShorts) {
    assert.equal(parseShortAnswer(body), null, `parseShortAnswer が読んだ: ${name}`);
  }
});

// --- (3) コラボレーター以外 ---

test('コラボレーター以外の答えは読まない（OWNER・MEMBER・COLLABORATOR だけ読む）', () => {
  const cases: [string, boolean][] = [
    ['OWNER', true], ['MEMBER', true], ['COLLABORATOR', true],
    ['CONTRIBUTOR', false], ['FIRST_TIME_CONTRIBUTOR', false], ['FIRST_TIMER', false], ['NONE', false], ['', false],
  ];
  for (const [association, ok] of cases) {
    for (const body of [shortBody(['1: はい', '2: 来週']), fence('agent-confirm-answer', answerRaw())]) {
      const r = confirmAnswerOf(confirmRef(), comment(body, { id: 120, author_association: association }));
      assert.equal(r.ok, ok, `${association || '(空)'}: ${body.slice(0, 20)}`);
    }
  }
});

// --- (4) セッションの目印 ---

test('セッションの目印のある答えは読まない（ID の無い目印・目印なしは読む）', () => {
  const answer = shortBody(['1: はい', '2: 来週']);
  const cases: [string, string, boolean][] = [
    ['セッションの目印', `${claudeMark(SESSION)}\n${answer}`, false],
    ['エンティティになったセッションの目印', `&lt;!-- agent-harness:claude session=${SESSION} --&gt;\n${answer}`, false],
    ['セッションの目印（フェンス）', `${claudeMark(SESSION)}\n${fence('agent-confirm-answer', answerRaw())}`, false],
    // 短い答えは最初の空でない行が /answer でなければならないので、目印つきはフェンスで書く
    ['ID の無い目印（フェンス）', `${CLAUDE_MARK}\n${fence('agent-confirm-answer', answerRaw())}`, true],
    ['目印なし', answer, true],
  ];
  for (const [name, body, ok] of cases) {
    assert.equal(confirmAnswerOf(confirmRef(), comment(body, { id: 130 })).ok, ok, name);
  }
});

// --- (5) 答えの無い質問 ---

test('答えの無い質問がある答えは読まない', () => {
  const cases: [string, string][] = [
    ['短い答えで2番が無い', shortBody(['1: はい'])],
    ['短い答えで1番が無い', shortBody(['2: 来週'])],
    ['/answer だけ', shortBody([])],
    ['フェンスで question:1 が無い', fence('agent-confirm-answer', answerRaw({ answers: [{ to: 'question:0', quote: 'はい', at: ANSWER_AT }] }))],
    ['フェンスの answers が空', fence('agent-confirm-answer', answerRaw({ answers: [] }))],
    ['答えの形が無い', 'はい、それで'],
  ];
  for (const [name, body] of cases) {
    assert.equal(confirmAnswerOf(confirmRef(), comment(body, { id: 140 })).ok, false, name);
  }
});

// --- (6) 存在しない添字・重複・対象違い ---

test('存在しない添字・同じ添字の重複・別の確認事項への答え・確認事項より前のコメントは読まない', () => {
  const cases: [string, string, number][] = [
    ['短い答えの番号が質問の数より大きい', shortBody(['1: はい', '2: 来週', '3: 余分']), 150],
    ['フェンスの添字が質問の数以上', fence('agent-confirm-answer', answerRaw({ answers: [...(answerRaw().answers as unknown[]), { to: 'question:2', quote: '余分', at: ANSWER_AT }] })), 150],
    ['短い答えで同じ番号が2回', shortBody(['1: はい', '1: いいえ', '2: 来週']), 150],
    ['フェンスで同じ添字が2回', fence('agent-confirm-answer', answerRaw({ answers: [...(answerRaw().answers as unknown[]), { to: 'question:0', quote: 'いいえ', at: ANSWER_AT }] })), 150],
    ['短い答えの /answer が別の確認事項', shortBody(['1: はい', '2: 来週'], CONFIRM_ID + 1), 150],
    ['フェンスの confirmCommentId が別の確認事項', fence('agent-confirm-answer', answerRaw({ confirmCommentId: CONFIRM_ID + 1 })), 150],
    ['確認事項より前のコメント', shortBody(['1: はい', '2: 来週']), CONFIRM_ID - 1],
    ['確認事項そのもの（同じ ID）', shortBody(['1: はい', '2: 来週']), CONFIRM_ID],
  ];
  for (const [name, body, id] of cases) {
    assert.equal(confirmAnswerOf(confirmRef(), comment(body, { id })).ok, false, name);
  }
});

// --- (7) confirmFacts の resumed ---

/** Claude が投稿した確認事項のコメント（セッションの目印つき）。番号 issue の Issue に置く */
const confirmComment = (id: number, raw: Record<string, unknown>, issue = 7): IssueComment => ({
  id, body: `${claudeMark(SESSION)}\n確認させてください。\n\n${fence('agent-confirm', raw)}`,
  html_url: `https://github.com/o/r/issues/${issue}#issuecomment-${id}`, created_at: '2026-10-01T09:00:00Z', updated_at: '',
  author_association: 'OWNER', user: { login: 'me', type: 'User' },
});

/** 着手宣言のコメント。createdAt（コメントの時刻）と値の at を別々に決める */
const claimAt = (id: number, createdAt: string, value: StoredClaim): IssueComment => ({
  id, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', value)].join('\n'),
  html_url: `https://github.com/o/r/issues/7#issuecomment-${id}`, created_at: createdAt, updated_at: '',
  author_association: 'OWNER', user: { login: 'me', type: 'User' },
});

const BEFORE = '2026-10-01T09:30:00Z';
const AFTER = '2026-10-01T11:00:00Z';
const LATER = '2026-10-01T12:00:00Z';

const manual = (at: string, stage?: ClaimStage, released = false): StoredClaim =>
  ({ by: 'manual', session: SESSION, at, ...(stage ? { stage } : {}), ...(released ? { released: true } : {}) }) as StoredClaim;

const withHistory = (history: ClaimEntry[], released = false): StoredClaim => {
  const last = history.at(-1)!;
  return { ...manual(last.at, last.stage, released), history } as StoredClaim;
};

test('confirmFacts の resumed は、答えより後の宣言の値の at（claim.at）と段階で決まる', () => {
  // 確認事項 #100（stage judge・resume implement）、答え #110（ANSWER_AT）
  const confirm = confirmComment(CONFIRM_ID, confirmRaw());
  const answer = comment(shortBody(['1: はい', '2: 来週']), { id: 110, created_at: ANSWER_AT });

  const cases: [string, IssueComment[], boolean][] = [
    ['宣言が無い', [], false],
    ['答えより後に implement（値の at もコメントの時刻も後）', [claimAt(120, AFTER, manual(AFTER, 'implement'))], true],
    ['コメントの時刻は後でも値の at が答えより前', [claimAt(120, AFTER, manual(BEFORE, 'implement'))], false],
    ['コメントの時刻は前でも値の at が答えより後', [claimAt(120, BEFORE, manual(AFTER, 'implement'))], true],
    ['答えより後でも段階が resume より手前（plan-gate）', [claimAt(120, AFTER, manual(AFTER, 'plan-gate'))], false],
    ['答えより後でも段階が resume より手前（plan）', [claimAt(120, AFTER, manual(AFTER, 'plan'))], false],
    ['答えより後で段階が resume より先（judge）', [claimAt(120, AFTER, manual(AFTER, 'judge'))], true],
    ['答えより後の解除（段階 implement）も数える', [claimAt(120, AFTER, manual(AFTER, 'implement', true))], true],
    ['答えより後でも段階の無い宣言は数えない', [claimAt(120, AFTER, manual(AFTER))], false],
    [
      'history の2件目の段階 implement の at が答えより後',
      [claimAt(105, BEFORE, withHistory([{ stage: 'plan', at: BEFORE }, { stage: 'implement', at: AFTER, after: 110 }]))],
      true,
    ],
    [
      'history の先頭（implement）の at は答えより前で、答えより後の段階は plan だけ（コメントの時刻は後）',
      [claimAt(120, LATER, withHistory([{ stage: 'implement', at: BEFORE }, { stage: 'plan', at: AFTER, after: 120 }]))],
      false,
    ],
  ];
  for (const [name, claims, resumed] of cases) {
    const comments = [confirm, answer, ...claims].sort((a, b) => a.id - b.id);
    const facts = confirmFacts(comments, claimTimeline(comments));
    assert.equal(facts.length, 1, name);
    assert.equal(facts[0]!.commentId, CONFIRM_ID, name);
    assert.equal(facts[0]!.answer?.commentId, 110, name);
    assert.equal(facts[0]!.resumed, resumed, name);
  }

  // 答えが無ければ answer は null で、後の宣言があっても resumed は偽
  {
    const comments = [confirm, claimAt(120, AFTER, manual(AFTER, 'implement'))];
    const facts = confirmFacts(comments, claimTimeline(comments));
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.answer, null);
    assert.equal(facts[0]!.resumed, false);
  }

  // 答えは最初に条件を満たすもの（コラボレーター以外の答えは飛ばす）
  {
    const outsider = comment(shortBody(['1: いいえ', '2: 今すぐ']), { id: 105, author_association: 'NONE' });
    const second = comment(shortBody(['1: いいえ', '2: 今すぐ']), { id: 115 });
    const comments = [confirm, outsider, answer, second];
    const facts = confirmFacts(comments, claimTimeline(comments));
    assert.equal(facts[0]!.answer?.commentId, 110);
  }

  // target がコメント先の番号と違う確認事項は読まない
  {
    const comments = [confirmComment(CONFIRM_ID, confirmRaw({ target: 8 }), 7), answer];
    assert.equal(confirmFacts(comments, claimTimeline(comments)).length, 0);
  }
});
