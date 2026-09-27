import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import {
  checkJudgeInput, judgedHeadOf, judgedPrOf, PAST_PR_FILE_LIMIT, PAST_PR_ITEM_CHARS, PAST_PR_LIMIT, PAST_PR_SECTION_CHARS,
  renderJudgeInput, renderPastPrs, renderPrState, selectPastPrs,
  type JudgeFacts, type PastPr, type PastPrReview, type PastPrReviewComment, type PastPrs,
} from '../lib/session-inputs.ts';
import { APP, config, HEAD } from './support/gate-fixtures.ts';

// judge-input に「PR の状態」と「過去の PR のコメント」を入れる（Issue #148）

let nextId = 1;
const at = (sec: number): string => `2026-09-20T00:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}Z`;

/** 過去の PR の会話のコメント */
function comment(body: string, sec: number, association = 'COLLABORATOR', login = 'me'): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `c${id}`, created_at: at(sec), updated_at: '', author_association: association, user: { login, type: 'User' } };
}

/** 過去の PR のレビュー（/pulls/{n}/reviews の形） */
function review(body: string | null, sec: number, state = 'COMMENTED', association = 'COLLABORATOR', login = 'me'): PastPrReview {
  const id = nextId++;
  return { id, body, state, submitted_at: at(sec), html_url: `r${id}`, author_association: association, user: { login, type: 'User' } };
}

/** 過去の PR のレビューコメント（/pulls/{n}/comments の形） */
function reviewComment(body: string, sec: number, path: string, line: number | null, originalLine: number | null = null, association = 'COLLABORATOR', login = 'me'): PastPrReviewComment {
  const id = nextId++;
  return { id, body, path, line, original_line: originalLine, created_at: at(sec), html_url: `rc${id}`, author_association: association, user: { login, type: 'User' } };
}

/** App の名義のコメント */
function appComment(sec: number): IssueComment {
  const c = comment(`${appMark('verdict-accepted')}\nApp の記録本文\n${renderBlock('agent-app', { version: 1 })}`, sec, 'NONE', APP);
  return { ...c, user: { login: APP, type: 'Bot' } };
}

function pastPr(number: number, patch: Partial<PastPr> = {}): PastPr {
  return { number, title: `feat: 過去${number}`, mergedAt: `2026-09-${String(number % 28 + 1).padStart(2, '0')}T00:00:00Z`, files: ['harness/lib/a.ts'], comments: [], reviews: [], reviewComments: [], ...patch };
}

function facts(patch: Partial<JudgeFacts> = {}): JudgeFacts {
  return { pr: { number: 5, headSha: HEAD, body: 'Closes #3' }, issues: [], prComments: [], checkRuns: [], ...patch };
}

/** 見出し（前方一致）の次の行から、次の `=== ` 見出しの手前までの行 */
function section(text: string, headingPrefix: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(headingPrefix));
  assert.ok(start >= 0, `見出し ${headingPrefix} がある`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('=== '));
  return (end < 0 ? rest : rest.slice(0, end)).filter((l, i, a) => !(l === '' && i === a.length - 1));
}

const lineIndex = (text: string, prefix: string): number => text.split('\n').findIndex((l) => l.startsWith(prefix));

// ---- selectPastPrs ----

type HistoryPr = { number: number; title: string; merged: boolean; mergedAt: string | null; baseRefName: string };
const hp = (number: number, mergedAt: string | null, patch: Partial<HistoryPr> = {}): HistoryPr => ({
  number, title: `t${number}`, merged: mergedAt !== null, mergedAt, baseRefName: 'main', ...patch,
});

test('selectPastPrs：この PR・未 Merge・既定のブランチ以外への PR を除く', () => {
  const r = selectPastPrs([{
    path: 'a.ts',
    prs: [
      hp(5, '2026-09-10T00:00:00Z'), // この PR 自身
      hp(11, null), // 未 Merge（閉じただけ・開いている）
      hp(12, '2026-09-09T00:00:00Z', { merged: false }), // merged が偽
      hp(13, null, { merged: true }), // mergedAt が無い
      hp(14, '2026-09-08T00:00:00Z', { baseRefName: 'develop' }), // 既定のブランチ以外
      hp(15, '2026-09-07T00:00:00Z'),
    ],
  }], 5, 'main');
  assert.deepEqual(r.map((p) => p.number), [15]);
  assert.deepEqual(r[0], { number: 15, title: 't15', mergedAt: '2026-09-07T00:00:00Z', baseRefName: 'main', merged: true, files: ['a.ts'] });
});

test('selectPastPrs：既定のブランチの名前は引数に従う', () => {
  const histories = [{ path: 'a.ts', prs: [hp(1, '2026-09-01T00:00:00Z'), hp(2, '2026-09-02T00:00:00Z', { baseRefName: 'trunk' })] }];
  assert.deepEqual(selectPastPrs(histories, 99, 'trunk').map((p) => p.number), [2]);
  assert.deepEqual(selectPastPrs(histories, 99, 'main').map((p) => p.number), [1]);
});

test('selectPastPrs：同じ PR を複数のファイルでまとめ、触ったファイルを入力の順の和集合にする', () => {
  const r = selectPastPrs([
    { path: 'a.ts', prs: [hp(10, '2026-09-01T00:00:00Z'), hp(10, '2026-09-01T00:00:00Z')] },
    { path: 'b.ts', prs: [hp(20, '2026-09-02T00:00:00Z'), hp(10, '2026-09-01T00:00:00Z')] },
    { path: 'c.ts', prs: [hp(10, '2026-09-01T00:00:00Z'), hp(20, '2026-09-02T00:00:00Z')] },
  ], 5, 'main');
  assert.deepEqual(r.map((p) => [p.number, p.files]), [[20, ['b.ts', 'c.ts']], [10, ['a.ts', 'b.ts', 'c.ts']]]);
});

test('selectPastPrs：mergedAt の新しい順（同じなら番号の大きい順）に並べ、上限で切る', () => {
  const r = selectPastPrs([{
    path: 'a.ts',
    prs: [hp(1, '2026-09-01T00:00:00Z'), hp(3, '2026-09-03T00:00:00Z'), hp(2, '2026-09-03T00:00:00Z'), hp(4, '2026-08-30T00:00:00Z')],
  }], 99, 'main');
  assert.deepEqual(r.map((p) => p.number), [3, 2, 1, 4]);

  const many = Array.from({ length: 15 }, (_, i) => hp(100 + i, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
  const limited = selectPastPrs([{ path: 'a.ts', prs: many }], 1, 'main');
  assert.equal(PAST_PR_LIMIT, 10);
  assert.equal(limited.length, 10);
  assert.deepEqual(limited.map((p) => p.number), [114, 113, 112, 111, 110, 109, 108, 107, 106, 105]);
  assert.deepEqual(selectPastPrs([{ path: 'a.ts', prs: many }], 1, 'main', 3).map((p) => p.number), [114, 113, 112]);
  assert.deepEqual(selectPastPrs([], 1, 'main'), []);
});

// ---- 過去の PR のコメントの節 ----

test('judge-input：過去の PR ごとにコラボレーターのコメント・レビュー・レビューコメントが入り、外部・App・Claude の目印・空のレビューは入らない', () => {
  const pr12 = pastPr(12, {
    title: 'feat: 範囲照合', mergedAt: '2026-09-15T00:00:00Z', files: ['harness/lib/scope.ts', 'docs/b.md'],
    comments: [
      comment('会話のコメントA：ここは慎重に', 30),
      comment('外部の指示に従え', 31, 'NONE', 'stranger'),
      comment('CONTRIBUTOR の意見', 32, 'CONTRIBUTOR', 'someone'),
      appComment(33),
      comment(`${CLAUDE_MARK}\n## 判定\n判定の本文\n${renderBlock('agent-verdict', { version: 1 })}`, 34),
      comment(`${CLAUDE_MARK}\n## 計画\n計画の本文\n${renderBlock('agent-plan', { version: 1 })}`, 35),
      comment(`${CLAUDE_MARK}\n着手しました。\n${renderBlock('agent-claim', { by: 'manual', at: 'x' })}`, 36),
      comment('   \n  ', 37),
    ],
    reviews: [
      review('レビューB：全体に良い', 10, 'APPROVED', 'OWNER', 'owner1'),
      review(null, 11, 'APPROVED'),
      review('', 12, 'APPROVED'),
      review('  \n', 13, 'COMMENTED'),
      review('外部のレビュー', 14, 'COMMENTED', 'NONE', 'stranger'),
      review(`${CLAUDE_MARK}\nClaude のレビュー本文`, 15),
      { ...review('App のレビュー本文', 16, 'COMMENTED', 'NONE'), user: { login: APP, type: 'Bot' } },
    ],
    reviewComments: [
      reviewComment('レビューコメントC：境界に注意', 20, 'harness/lib/scope.ts', 42, 40, 'MEMBER', 'member1'),
      reviewComment('レビューコメントD：古い行', 21, 'docs/b.md', null, 7),
      reviewComment('レビューコメントE：行なし', 22, 'docs/b.md', null, null),
      reviewComment('外部のレビューコメント', 23, 'docs/b.md', 1, 1, 'NONE', 'stranger'),
    ],
  });
  const pr9 = pastPr(9, { title: 'fix: 古い', mergedAt: '2026-09-01T00:00:00Z', files: ['harness/lib/scope.ts'] });
  const text = renderJudgeInput(config, facts({ pastPrs: { changedFiles: 3, filesConsidered: 3, prs: [pr12, pr9] } }));
  const body = section(text, '=== 過去の PR のコメント').join('\n');

  assert.ok(body.includes('--- PR #12 feat: 範囲照合（Merge 2026-09-15T00:00:00Z）'), body);
  assert.ok(body.includes('--- PR #9 fix: 古い（Merge 2026-09-01T00:00:00Z）'));
  assert.ok(body.includes('触ったファイル（この PR の変更ファイルと重なるもの）: harness/lib/scope.ts, docs/b.md'));

  assert.ok(body.includes('会話のコメントA：ここは慎重に'));
  assert.ok(body.includes(`- コメント me ${at(30)}`));
  assert.ok(body.includes('レビューB：全体に良い'));
  assert.ok(body.includes(`- レビュー owner1 APPROVED ${at(10)}`));
  assert.ok(body.includes('レビューコメントC：境界に注意'));
  assert.ok(body.includes(`- レビューコメント member1 harness/lib/scope.ts:42 ${at(20)}`), 'line を優先する');
  assert.ok(body.includes(`- レビューコメント me docs/b.md:7 ${at(21)}`), 'line が無ければ original_line');
  assert.ok(body.includes(`- レビューコメント me docs/b.md:? ${at(22)}`), 'どちらも無ければ ?');

  for (const excluded of ['外部の指示に従え', 'CONTRIBUTOR の意見', 'App の記録本文', '判定の本文', '計画の本文', '着手しました', '外部のレビュー', 'Claude のレビュー本文', 'App のレビュー本文', '外部のレビューコメント', 'agent-verdict', 'agent-plan', 'agent-claim', 'agent-app']) {
    assert.ok(!body.includes(excluded), `${excluded} は入らない`);
  }
  // 空のレビュー本文（null・空・空白だけ）は見出しも出さない
  assert.ok(!body.includes(at(11)) && !body.includes(at(12)) && !body.includes(at(13)) && !body.includes(at(37)));

  // 時刻順：レビュー(10) → レビューコメント(20..22) → コメント(30)
  const order = [`- レビュー owner1 APPROVED ${at(10)}`, `- レビューコメント member1 harness/lib/scope.ts:42 ${at(20)}`, `- レビューコメント me docs/b.md:7 ${at(21)}`, `- コメント me ${at(30)}`];
  const positions = order.map((h) => body.indexOf(h));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '時刻順に並ぶ');

  // PR の順は入力の順（新しい順）。残るものが無い PR はそう書く
  const pr9At = body.indexOf('--- PR #9 ');
  assert.ok(body.indexOf('--- PR #12 ') < pr9At);
  assert.ok(body.slice(pr9At).includes('(コラボレーターのコメントなし)'));
  assert.ok(!body.slice(0, pr9At).includes('(コラボレーターのコメントなし)'));
});

test('renderPastPrs：1件の本文は 1500 字で切り、切ったことと元の字数を書く', () => {
  assert.equal(PAST_PR_ITEM_CHARS, 1500);
  const long = `始${'あ'.repeat(1998)}終`; // 2000 字
  const exact = `丁${'い'.repeat(1499)}`; // ちょうど 1500 字
  const text = renderPastPrs(config, { changedFiles: 1, filesConsidered: 1, prs: [pastPr(7, { comments: [comment(long, 1), comment(exact, 2)] })] }).join('\n');
  assert.ok(text.includes(long.slice(0, 1500)));
  assert.ok(!text.includes(long.slice(0, 1501)) && !text.includes('終'));
  assert.ok(text.includes('…（1500 字で切りました。元は 2000 字）'), text.slice(-200));
  assert.ok(text.includes(exact), 'ちょうど 1500 字は切らない');
  assert.equal(text.split('字で切りました').length - 1, 1, '注記は切ったものだけ');
});

test('renderPastPrs：節全体が 20000 字を超えると古い PR から PR 単位で省き、省いた番号を書く', () => {
  assert.equal(PAST_PR_SECTION_CHARS, 20000);
  // 1つの PR に 1500 字の本文が3件。10件で 45000 字を超える
  const prs = Array.from({ length: 10 }, (_, i) => {
    const n = 200 - i; // 先頭ほど新しい
    const item = (k: number) => `P${n}-${k}:${'x'.repeat(1480)}`;
    return pastPr(n, {
      mergedAt: `2026-09-${String(28 - i).padStart(2, '0')}T00:00:00Z`,
      comments: [comment(item(1), 1)],
      reviews: [review(item(2), 2)],
      reviewComments: [reviewComment(item(3), 3, 'harness/lib/a.ts', 1)],
    });
  });
  const lines = renderPastPrs(config, { changedFiles: 1, filesConsidered: 1, prs });
  const text = lines.join('\n');

  const noteLine = lines.find((l) => l.includes('字を超えるため'));
  assert.ok(noteLine, '省いた注記がある');
  assert.ok(noteLine.includes('20000'));
  const omitted = [...noteLine.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const kept = prs.filter((p) => text.includes(`--- PR #${p.number} `)).map((p) => p.number);

  assert.ok(kept.length >= 1 && omitted.length >= 1);
  assert.deepEqual([...kept, ...omitted].sort((a, b) => b - a), prs.map((p) => p.number), '残したものと省いたもので全部');
  assert.deepEqual(kept, prs.slice(0, kept.length).map((p) => p.number), '新しい PR（先頭）から残す');
  for (const n of kept) {
    for (const k of [1, 2, 3]) assert.ok(text.includes(`P${n}-${k}:`), `残した PR #${n} は丸ごと入る`);
  }
  for (const n of omitted) assert.ok(!text.includes(`P${n}-`), `省いた PR #${n} は何も入らない`);

  const withoutNote = lines.filter((l) => l !== noteLine).join('\n');
  assert.ok(withoutNote.length <= PAST_PR_SECTION_CHARS, `節全体は 20000 字以内（${withoutNote.length}）`);
  // 次の PR を足せば超える手前で止めている（1 PR ≒ 4500 字余り）
  assert.ok(withoutNote.length > PAST_PR_SECTION_CHARS - 6000, `手前まで入れる（${withoutNote.length}）`);
});

test('renderPastPrs：超えなければ省かない', () => {
  const text = renderPastPrs(config, { changedFiles: 1, filesConsidered: 1, prs: [pastPr(3, { comments: [comment('短い', 1)] }), pastPr(2)] }).join('\n');
  assert.ok(!text.includes('字を超えるため'));
  assert.ok(text.includes('--- PR #3 ') && text.includes('--- PR #2 '));
});

test('renderPastPrs：調べた変更ファイルの数を書き、上限を超えたらそう添える', () => {
  assert.equal(PAST_PR_FILE_LIMIT, 30);
  const over = renderPastPrs(config, { changedFiles: 45, filesConsidered: 30, prs: [pastPr(3)] }).join('\n');
  assert.ok(over.includes('調べた変更ファイル: 30 / 45'), over);
  assert.ok(over.includes('先頭 30 件だけ調べました'));
  const under = renderPastPrs(config, { changedFiles: 4, filesConsidered: 4, prs: [pastPr(3)] }).join('\n');
  assert.ok(under.includes('調べた変更ファイル: 4 / 4'));
  assert.ok(!under.includes('だけ調べました'));
});

test('renderPastPrs：集めていなければ「(集めていません)」、0 件なら「(なし)」', () => {
  assert.ok(renderPastPrs(config, undefined).join('\n').includes('(集めていません)'));
  const none = renderPastPrs(config, { changedFiles: 2, filesConsidered: 2, prs: [] }).join('\n');
  assert.ok(none.includes('(なし)'));
  assert.ok(!none.includes('(集めていません)'));

  assert.deepEqual(section(renderJudgeInput(config, facts()), '=== 過去の PR のコメント'), ['(集めていません)']);
  assert.ok(section(renderJudgeInput(config, facts({ pastPrs: { changedFiles: 2, filesConsidered: 2, prs: [] } })), '=== 過去の PR のコメント').includes('(なし)'));
});

// ---- PR の状態の節 ----

test('renderPrState：state・draft・merged を1行で書き、無ければ「(集めていません)」', () => {
  assert.equal(renderPrState({ state: 'open', draft: false }), 'state: open / draft: false / merged: false');
  assert.equal(renderPrState({ state: 'open', draft: true, merged: false }), 'state: open / draft: true / merged: false');
  assert.equal(renderPrState({ state: 'closed', draft: false, merged: true }), 'state: closed / draft: false / merged: true');
  assert.equal(renderPrState(undefined), '(集めていません)');
});

test('judge-input：「=== PR の状態」の節に PR の状態の行が入る', () => {
  assert.deepEqual(section(renderJudgeInput(config, facts({ prState: { state: 'open', draft: true } })), '=== PR の状態'), ['state: open / draft: true / merged: false']);
  assert.deepEqual(section(renderJudgeInput(config, facts({ prState: { state: 'closed', draft: false, merged: false } })), '=== PR の状態'), ['state: closed / draft: false / merged: false']);
  assert.deepEqual(section(renderJudgeInput(config, facts()), '=== PR の状態'), ['(集めていません)']);
});

// ---- 先頭2行と節の位置 ----

test('judge-input：先頭2行はこれまでどおり読め、新しい2節は「PR のコメント」の後・「範囲照合」の前にある', () => {
  const pastPrs: PastPrs = { changedFiles: 1, filesConsidered: 1, prs: [pastPr(12, { comments: [comment('過去の指摘', 1)] })] };
  const text = renderJudgeInput(config, facts({ prComments: [comment('PR のコメント本文', 2)], prState: { state: 'open', draft: true }, pastPrs }));
  const lines = text.split('\n');
  assert.equal(lines[0], `headSha: ${HEAD}`);
  assert.ok(lines[1]!.startsWith('PR #5 '));
  assert.equal(judgedHeadOf(text), HEAD);
  assert.equal(judgedPrOf(text), 5);
  assert.deepEqual(checkJudgeInput(text, 5), { ok: true, value: HEAD });

  const prComments = lineIndex(text, '=== PR のコメント');
  const state = lineIndex(text, '=== PR の状態');
  const past = lineIndex(text, '=== 過去の PR のコメント');
  const scope = lineIndex(text, '=== 範囲照合');
  assert.ok(prComments >= 0 && state >= 0 && past >= 0 && scope >= 0);
  assert.ok(prComments < state && state < past && past < scope, `${prComments} < ${state} < ${past} < ${scope}`);
  assert.ok(section(text, '=== PR のコメント').join('\n').includes('PR のコメント本文'));
  assert.ok(section(text, '=== 過去の PR のコメント').join('\n').includes('過去の指摘'));
});
