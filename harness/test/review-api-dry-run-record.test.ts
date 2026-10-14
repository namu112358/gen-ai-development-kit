// review-api の shadow の記録に入る印（review-api/src/pipeline.ts の dryRun・diffTruncated と record.ts の parseApiReviewComment）を確かめる（Issue #1068）。
// runReview を偽の GitHub・偽の Claude で回し、投稿した記録を読み戻して、deps.dryRun が true なら dryRun が true・渡さなければ false になること、
// diffTruncated が材料（collect.ts の fullDiff.length > maxDiffChars）と同じ値で入ることを1つの表で見る。
// あわせて、dryRun・diffTruncated に boolean でない値を書いた記録を parseApiReviewComment が null にすることを見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseApiReviewComment, parseShadowComment } from '../../review-api/src/record.ts';
import { baseConfig, DIFF, run } from './support/review-api-pipeline.ts';

// diff より短い maxDiffChars（材料の diff が切れる）
const truncatingConfig = () => {
  const config = baseConfig();
  config.claude.maxDiffChars = 20;
  assert.ok(DIFF.length > config.claude.maxDiffChars);
  return config;
};

const cases: { name: string; dryRun?: boolean; config?: ReturnType<typeof baseConfig>; want: { dryRun: boolean; diffTruncated: boolean } }[] = [
  { name: 'dryRun: true・既定の maxDiffChars', dryRun: true, want: { dryRun: true, diffTruncated: false } },
  { name: 'dryRun を渡さない・既定の maxDiffChars', want: { dryRun: false, diffTruncated: false } },
  { name: 'dryRun: true・diff より短い maxDiffChars', dryRun: true, config: truncatingConfig(), want: { dryRun: true, diffTruncated: true } },
  { name: 'dryRun を渡さない・diff より短い maxDiffChars', config: truncatingConfig(), want: { dryRun: false, diffTruncated: true } },
];

for (const c of cases) {
  test(`記録の dryRun・diffTruncated：${c.name}`, async () => {
    const { result, posted } = await run({
      ...(c.dryRun === undefined ? {} : { dryRun: c.dryRun }),
      ...(c.config === undefined ? {} : { config: c.config }),
    });
    assert.equal(result.outcome, 'posted');
    assert.equal(posted.length, 1);
    const parsed = parseShadowComment(posted[0]!);
    assert.ok(parsed !== null, '投稿した記録が読み戻せる');
    assert.equal(parsed.record.dryRun, c.want.dryRun);
    assert.equal(parsed.record.diffTruncated, c.want.diffTruncated);
  });
}

test('dryRun・diffTruncated に boolean でない値を書いた記録は null になる', async () => {
  const { posted } = await run({ dryRun: true });
  const body = posted[0]!;
  assert.ok(parseApiReviewComment(body) !== null, '書き換える前は読める');
  for (const [from, to] of [
    ['"dryRun": true', '"dryRun": "true"'],
    ['"diffTruncated": false', '"diffTruncated": "true"'],
  ] as const) {
    assert.ok(body.includes(from), `本文に ${from} がある`);
    assert.equal(parseApiReviewComment(body.replace(from, to)), null, `${to} の記録は読まない`);
  }
});
