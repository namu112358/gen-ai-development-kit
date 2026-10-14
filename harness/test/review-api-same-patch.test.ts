// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）が、PR 自身の差分が前回レビューした head と同じ（既定ブランチを取り込んだだけの）head では
// Claude を呼ばず、GitHub に投稿せず、月の累計を増やさずに、KV に outcome same-patch と前回の head（reusableHead）の記録を残すこと（Issue #1089 の AC1）、
// PR 自身の差分が変わった（取り込みで衝突を解消して変更行が違う）・前回の head の diff が取れない（404）・前回の記録の models が今の設定と違うときは
// 今どおり Claude が呼ばれて posted になること（AC2）、前回の記録の選び方 findReusableRecord（dryRun・diffTruncated が false でない・欄の無い古い記録・
// 編集済み・投稿しなかった記録だけ・同じ head・別の名義は選ばず、条件を満たす記録が複数なら id が最大のもの）と、
// diff の正規化 normalizePrDiff（行番号・index 行だけ違うものは同じ、変更行が違うものは別、空は ''）を確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findReusableRecord, normalizePrDiff, type ReviewOutcome } from '../../review-api/src/pipeline.ts';
import { renderStoppedComment } from '../../review-api/src/record.ts';
import {
  comment,
  COST_KEY,
  GATE,
  HEAD,
  MODEL,
  OTHER,
  OTHER2,
  RECORD_AT,
  REVIEWER,
  run,
  shadowComment,
  type ShadowCommentLike,
} from './support/review-api-pipeline.ts';

// 同じ変更（-old/+new）を、blob の sha（index 行）と行番号（@@）だけ変えた diff。前回の head（OTHER2）の diff は main...OTHER2 で取る
const diffOf = (opts: { index: string; hunk: string; added?: string }): string =>
  ['diff --git a/src/a.ts b/src/a.ts', `index ${opts.index} 100644`, '--- a/src/a.ts', '+++ b/src/a.ts', opts.hunk, '-old', `+${opts.added ?? 'new'}`, ''].join('\n');
const HEAD_DIFF = diffOf({ index: '1111111..2222222', hunk: '@@ -1 +1 @@' });
const PREV_DIFF = diffOf({ index: '3333333..4444444', hunk: '@@ -5 +5 @@' });
// 取り込みで衝突を解消して、PR 自身の変更行が変わった
const RESOLVED_DIFF = diffOf({ index: '1111111..5555555', hunk: '@@ -1 +1 @@', added: 'resolved' });
const OTHER_MODEL = 'claude-sonnet-5-5';

test('前回レビューした head に既定ブランチを取り込んだだけの head は、Claude を呼ばず投稿せず、same-patch の記録を KV に残す（AC1）', async () => {
  const r = await run({
    comments: [shadowComment(1, REVIEWER, OTHER2, { url: 'https://example.test/c/1' })],
    compareDiffs: { [HEAD]: HEAD_DIFF, [OTHER2]: PREV_DIFF },
    kv: { [COST_KEY]: '1' },
  });
  assert.equal(r.result.outcome, 'same-patch');
  assert.equal(r.result.pr, 5);
  assert.equal(r.result.headSha, HEAD);
  assert.equal(r.result.usd, null);
  assert.equal(r.claudeCalls.length, 0, 'Claude を呼ばない');
  assert.equal(r.posted.length, 0, 'GitHub に投稿しない');
  const record = r.record as { outcome: string; headSha?: string; reusableHead?: string; recordUrl?: string | null } | null;
  assert.equal(record?.outcome, 'same-patch', 'KV の記録の outcome');
  assert.equal(record?.headSha, HEAD, 'KV の記録の head は今の head');
  assert.equal(record?.reusableHead, OTHER2, 'KV の記録の reusableHead は前回の head');
  assert.equal(record?.recordUrl, 'https://example.test/c/1', 'KV の記録に前回の記録のコメントの URL');
  assert.equal(r.kv.get(COST_KEY), '1', '月の累計は変えない');
  assert.ok(r.logs.some((l) => l.includes(`same-patch skip ${OTHER2}`)), `ログ ${r.logs.join(' | ')}`);
});

test('PR 自身の差分が変わった・前回の diff が取れない・前回の記録の models が違う head は、今どおり Claude が呼ばれて posted になる（AC2）', async () => {
  const prev = (extra: Parameters<typeof shadowComment>[3] = {}) => shadowComment(1, REVIEWER, OTHER2, extra);
  const cases: [string, Parameters<typeof run>[0]][] = [
    ['取り込みで衝突を解消して変更行が違う', { comments: [prev()], compareDiffs: { [HEAD]: RESOLVED_DIFF, [OTHER2]: PREV_DIFF } }],
    ['前回の head の diff が 404', { comments: [prev()], compareDiffs: { [HEAD]: HEAD_DIFF } }],
    ['前回の記録の models が今の設定と違う', { comments: [prev({ models: { review: OTHER_MODEL, risk: OTHER_MODEL } })], compareDiffs: { [HEAD]: HEAD_DIFF, [OTHER2]: PREV_DIFF } }],
  ];
  const posted: ReviewOutcome = 'posted';
  for (const [name, opts] of cases) {
    const r = await run(opts);
    assert.equal(r.result.outcome, posted, name);
    assert.equal(r.claudeCalls.length, 2, `${name}: Claude の呼び出し`);
    assert.equal(r.posted.length, 1, `${name}: 投稿`);
    assert.equal(r.record?.outcome, posted, `${name}: KV の記録`);
    assert.ok(Number(r.kv.get(COST_KEY)) > 0, `${name}: 月の累計 ${r.kv.get(COST_KEY)}`);
  }
});

test('findReusableRecord は使える前回の posted の記録だけを選び、複数なら id が最大のもの', () => {
  const stopped = (id: number, headSha: string): ShadowCommentLike =>
    comment(id, REVIEWER, renderStoppedComment({ version: 1, pr: 5, headSha, outcome: 'too-large', usd: null }));
  const cases: [string, ShadowCommentLike[], string | null][] = [
    ['記録が無い', [], null],
    ['使える記録', [shadowComment(1, REVIEWER, OTHER2, {})], OTHER2],
    ['dryRun が true', [shadowComment(1, REVIEWER, OTHER2, { dryRun: true })], null],
    ['diffTruncated が true', [shadowComment(1, REVIEWER, OTHER2, { diffTruncated: true })], null],
    ['dryRun・diffTruncated の欄が無い古い記録', [shadowComment(1, REVIEWER, OTHER2)], null],
    ['created_at と updated_at が違う（編集済み）', [shadowComment(1, REVIEWER, OTHER2, { updatedAt: '2026-10-13T01:00:00Z' })], null],
    ['投稿しなかった記録だけ', [stopped(1, OTHER2)], null],
    ['headSha が今の head と同じ', [shadowComment(1, REVIEWER, HEAD, {})], null],
    ['別の名義の記録', [shadowComment(1, GATE, OTHER2, {}), shadowComment(2, 'someone', OTHER2, {})], null],
    [
      '条件を満たす記録が複数なら id が最大のもの（使えない記録の id は見ない）',
      [
        shadowComment(1, REVIEWER, OTHER, {}),
        shadowComment(3, REVIEWER, OTHER2, {}),
        shadowComment(2, REVIEWER, OTHER, {}),
        shadowComment(9, REVIEWER, OTHER, { dryRun: true }),
        stopped(8, OTHER),
      ],
      OTHER2,
    ],
  ];
  for (const [name, comments, expected] of cases) {
    assert.equal(findReusableRecord(comments, REVIEWER, HEAD)?.headSha ?? null, expected, name);
  }

  // 選んだ記録の models と URL が返る（URL の無いコメントは null）
  const withUrl = findReusableRecord([shadowComment(1, REVIEWER, OTHER2, { url: 'https://example.test/c/1', models: { review: OTHER_MODEL, risk: MODEL } })], REVIEWER, HEAD);
  assert.deepEqual(withUrl, { headSha: OTHER2, url: 'https://example.test/c/1', models: { review: OTHER_MODEL, risk: MODEL } });
  const noUrl = findReusableRecord([shadowComment(1, REVIEWER, OTHER2, { createdAt: RECORD_AT })], REVIEWER, HEAD);
  assert.equal(noUrl?.url, null);
});

test('normalizePrDiff は index 行と @@ の行番号を無視し、変更行・文脈の行は区別し、空は \'\'', () => {
  assert.equal(normalizePrDiff(HEAD_DIFF), normalizePrDiff(PREV_DIFF), '行番号・index 行だけ違うものは同じ');
  assert.notEqual(normalizePrDiff(HEAD_DIFF), normalizePrDiff(RESOLVED_DIFF), '変更行が違うものは別');
  assert.notEqual(normalizePrDiff(HEAD_DIFF), normalizePrDiff(HEAD_DIFF.replace('+new', '+new ')), '空白の違いは別');
  const lines = normalizePrDiff(HEAD_DIFF).split('\n');
  assert.equal(lines.some((l) => l.startsWith('index ')), false, 'index 行は残らない');
  assert.ok(lines.includes('@@'), '@@ の行は行番号の無い @@ になる');
  assert.ok(lines.includes('-old') && lines.includes('+new'), '変更行は残る');
  for (const empty of ['', ' \n\t\n']) assert.equal(normalizePrDiff(empty), '', JSON.stringify(empty));
});
