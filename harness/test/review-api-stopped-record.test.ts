// review-api の投稿しなかった記録（review-api/src/record.ts の renderStoppedComment・parseApiReviewComment と pipeline.ts の post-stopped）を確かめる（Issue #1003。no-api-key は #1050）。
// 読み戻しで posted（renderShadowComment の本文）と止めた outcome（renderStoppedComment の本文）を見分け、parseShadowComment は止めた記録を読まないこと、
// outcome が語彙の外・止めた記録に verdict があると null になること、同じ head の止めた記録のコメント（レビュー用の App の名義）があると duplicate で投稿しないこと、
// 止めた記録の本文に API キー・token・diff の行・PR の題・Claude の出力が出ないこと、止めた記録の投稿が失敗しても outcome が変わらないことを見る。
// 止めたときに記録が1件付くこと（AC1）は review-api-pipeline.test.ts の outcome の表・NaN の上限・verdict-invalid のテストで見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runReview } from '../../review-api/src/pipeline.ts';
import { parseApiReviewComment, parseShadowComment, renderStoppedComment, type StoppedOutcome } from '../../review-api/src/record.ts';
import {
  answer,
  API_KEY,
  comment,
  COST_KEY,
  fakeGitHub,
  HEAD,
  msg,
  NOW,
  params,
  REVIEW_KEY,
  REVIEWER,
  RISK_OK,
  run,
  shadowComment,
  TOKEN,
} from './support/review-api-pipeline.ts';

// 目印とフェンスだけを手で組んだ本文（renderStoppedComment が受け付けない値を読み戻しに渡すため）
const handBody = (json: unknown): string =>
  [`<!-- api-review-shadow head=${HEAD} -->`, '', '```api-review-shadow', JSON.stringify(json, null, 2), '```', ''].join('\n');

test('読み戻しで posted と止めた outcome を見分け、parseShadowComment は止めた記録を読まない', () => {
  const posted = parseApiReviewComment(shadowComment(1, REVIEWER, HEAD).body);
  assert.equal(posted?.outcome, 'posted');
  assert.equal(posted?.headSha, HEAD);

  const outcomes: StoppedOutcome[] = ['budget-exceeded', 'too-large', 'verdict-invalid', 'no-api-key'];
  for (const outcome of outcomes) {
    const body = renderStoppedComment({ version: 1, pr: 5, headSha: HEAD, outcome, usd: null });
    const parsed = parseApiReviewComment(body);
    assert.equal(parsed?.outcome, outcome, outcome);
    assert.equal(parsed?.headSha, HEAD, `${outcome}: head`);
    assert.equal(parsed?.record.outcome, outcome, `${outcome}: record`);
    assert.equal(parseShadowComment(body), null, `${outcome}: parseShadowComment`);
  }

  // 止めた記録に混ぜる verdict は posted の記録から借りる
  const borrowed = parseShadowComment(shadowComment(1, REVIEWER, HEAD).body)!.record.verdict;
  const nulls: [string, unknown][] = [
    ['outcome が語彙の外', { version: 1, pr: 5, headSha: HEAD, outcome: 'exploded', usd: null }],
    ['止めた記録に verdict がある', { version: 1, pr: 5, headSha: HEAD, outcome: 'budget-exceeded', usd: null, verdict: borrowed }],
  ];
  for (const [name, json] of nulls) {
    assert.equal(parseApiReviewComment(handBody(json)), null, name);
  }
});

test('同じ head の止めた記録のコメントがレビュー用の App の名義であると duplicate で投稿しない', async () => {
  // コメントは初めからあるので、postStopped の中の取り直しではなく fetch-pr の段階の hasOwnRecord で duplicate になる（Claude も呼ばない）
  const stopped = comment(1, REVIEWER, renderStoppedComment({ version: 1, pr: 5, headSha: HEAD, outcome: 'budget-exceeded', usd: null }));
  const r = await run({ comments: [stopped] });
  assert.equal(r.result.outcome, 'duplicate');
  assert.equal(r.claudeCalls.length, 0);
  assert.equal(r.posted.length, 0);
});

test('止めた記録の本文に API キー・token・diff の行・PR の題・Claude の出力が出ない', async () => {
  // Claude の出力（JSON でない）に秘密と材料を混ぜ、verdict-invalid で止める
  const leaky = `not json ${API_KEY} +new PR の題 LEAK-SENTINEL`;
  const cases: [string, Parameters<typeof run>[0]][] = [
    ['budget-exceeded', { kv: { [COST_KEY]: '9.99' } }],
    ['verdict-invalid', { responses: [msg([{ type: 'text', text: leaky }], 'end_turn'), answer(RISK_OK)] }],
  ];
  for (const [name, opts] of cases) {
    const r = await run(opts);
    assert.equal(r.result.outcome, name, name);
    assert.equal(r.posted.length, 1, `${name}: 投稿`);
    const body = r.posted[0]!;
    for (const secret of [API_KEY, TOKEN, 'diff --git', '+new', '-old', 'PR の題', 'LEAK-SENTINEL']) {
      assert.equal(body.includes(secret), false, `${name}: ${secret}`);
    }
  }
});

test('止めた記録の投稿（createComment）が投げても outcome は budget-exceeded のまま', async () => {
  // run の偽の GitHub は投稿を失敗させられないので、reader は偽の GitHub、writer は投げるだけの依存を渡す
  const { gh } = fakeGitHub({ pr: { state: 'open', head: HEAD }, comments: [] });
  const kv = new Map<string, string>([[COST_KEY, '9.99']]);
  let attempts = 0;
  const writer = {
    async createComment(): Promise<never> {
      attempts++;
      throw new Error('投稿に失敗');
    },
  };
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => writer },
      claude: { create: async () => assert.fail('Claude は呼ばない') },
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => NOW,
      log: () => {},
      secrets: [API_KEY],
    },
    params(),
  );
  assert.equal(result.outcome, 'budget-exceeded');
  assert.ok(attempts >= 1, '止めた記録の投稿を試みる');
  assert.equal((JSON.parse(kv.get(REVIEW_KEY)!) as { outcome: string }).outcome, 'budget-exceeded', 'KV の記録');
});
