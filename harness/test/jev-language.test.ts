import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { redact } from '../lib/jev.ts';
import {
  agreementRate,
  askJevWithUsage,
  brierScore,
  buildJevRequest,
  buildTriageRequest,
  cjkRatio,
  estimateCost,
  pairedDifferences,
  renderSummary,
  runToRunSpread,
  stratifyByTokens,
  tokenRatio,
  translationProblems,
  type ItemResult,
  type ItemUsage,
  type ManifestItem,
} from '../scripts/jev-language.ts';

const config = loadConfig();

/**
 * このファイルは harness/scripts/jev-language.ts（未実装）を対象にした先行テスト。
 * 以下、テストする関数のシグネチャ（実装時の合わせ先）：
 *
 * - pairedDifferences(items: ItemResult[]): { byQuestion: Record<string, PairedDiffStat>; excluded: Record<string, number> }
 * - brierScore(items: ItemResult[], lang: 'ja' | 'en', run: 'run1' | 'run2'):
 *     { byQuestion: Record<string, { mean: number; count: number }>; excluded: number }
 * - agreementRate(items: ItemResult[], lang: 'ja' | 'en', run: 'run1' | 'run2'):
 *     { byQuestion: Record<string, { rate: number; count: number }>; excluded: number }
 * - runToRunSpread(items: ItemResult[], lang: 'ja' | 'en'):
 *     { byQuestion: Record<string, { meanAbsDiff: number; count: number }> }
 * - tokenRatio(items: ItemUsage[]): { totalRatio: number; medianItemRatio: number }
 * - stratifyByTokens(values: number[], k: number): { boundaries: number[]; sizes: number[] }
 * - cjkRatio(text: string): number
 * - translationProblems(items: ManifestItem[], cjkThreshold: number): { id: string; reasons: string[] }[]
 * - estimateCost(input: { lang: 'ja' | 'en'; charCount: number; pricePerInputToken?: number }): { tokens: number; costUsd: number }
 * - askJevWithUsage(apiKey: string, request: { model: string; state: unknown; questions: Record<string, unknown> }, fetchImpl?: typeof fetch):
 *     Promise<{ status: 'ok'; model: string; answers: JevAnswers; usage?: { input_tokens: number; output_tokens: number } } | { status: 'error'; detail: string }>
 * - renderSummary(input: unknown): string
 * - buildJevRequestForLanguage / buildTriageRequestForLanguage: harness/lib/jev.ts の buildJevRequest、
 *   harness/lib/issue-triage.ts の buildTriageRequest をそのまま re-export したもの（名前を変えずに使ってもよい）。
 */

// ---- フィクスチャ ----

const nounQuestions: ItemResult['questionKinds'] = { q_noul_a: 'noul', q_noul_b: 'noul' };
const choiceQuestions: ItemResult['questionKinds'] = { q_choice: 'choice' };

test('pairedDifferences: Noul 2問×2回ずつの平均の差が合う', () => {
  const items: ItemResult[] = [
    {
      id: 'item1',
      questionKinds: nounQuestions,
      ja: { run1: { q_noul_a: { yes: 0.8 }, q_noul_b: { yes: 0.6 } }, run2: { q_noul_a: { yes: 0.9 }, q_noul_b: { yes: 0.7 } } },
      en: { run1: { q_noul_a: { yes: 0.5 }, q_noul_b: { yes: 0.4 } }, run2: { q_noul_a: { yes: 0.6 }, q_noul_b: { yes: 0.5 } } },
    },
  ];
  const result = pairedDifferences(items);
  // ja平均 q_noul_a = (0.8+0.9)/2 = 0.85, en平均 = (0.5+0.6)/2 = 0.55, 差 = 0.30
  assert.equal(result.byQuestion.q_noul_a!.count, 1);
  assert.ok(Math.abs(result.byQuestion.q_noul_a!.mean - 0.3) < 1e-9);
  assert.ok(Math.abs(result.byQuestion.q_noul_a!.meanAbs - 0.3) < 1e-9);
  // ja平均 q_noul_b = (0.6+0.7)/2 = 0.65, en平均 = (0.4+0.5)/2 = 0.45, 差 = 0.20
  assert.ok(Math.abs(result.byQuestion.q_noul_b!.mean - 0.2) < 1e-9);
  assert.equal(result.byQuestion.q_noul_a!.jaHigher, 1);
  assert.equal(result.byQuestion.q_noul_a!.enHigher, 0);
});

test('pairedDifferences: Choice で正解ありの項目は正解選択肢の確率差になる', () => {
  const items: ItemResult[] = [
    {
      id: 'item2',
      questionKinds: choiceQuestions,
      truth: { q_choice: 'a' },
      ja: { run1: { q_choice: { a: 0.7, b: 0.2, c: 0.1 } }, run2: { q_choice: { a: 0.9, b: 0.05, c: 0.05 } } },
      en: { run1: { q_choice: { a: 0.4, b: 0.4, c: 0.2 } }, run2: { q_choice: { a: 0.6, b: 0.3, c: 0.1 } } },
    },
  ];
  const result = pairedDifferences(items);
  // ja平均(a) = (0.7+0.9)/2 = 0.8, en平均(a) = (0.4+0.6)/2 = 0.5, 差 = 0.3
  assert.equal(result.byQuestion.q_choice!.count, 1);
  assert.ok(Math.abs(result.byQuestion.q_choice!.mean - 0.3) < 1e-9);
});

test('pairedDifferences: Choice で正解なしの項目は総変動距離（非負）になる', () => {
  const items: ItemResult[] = [
    {
      id: 'item3',
      questionKinds: choiceQuestions,
      // truth なし
      ja: { run1: { q_choice: { a: 0.5, b: 0.3, c: 0.2 } }, run2: { q_choice: { a: 0.5, b: 0.3, c: 0.2 } } },
      en: { run1: { q_choice: { a: 0.2, b: 0.5, c: 0.3 } }, run2: { q_choice: { a: 0.2, b: 0.5, c: 0.3 } } },
    },
  ];
  const result = pairedDifferences(items);
  // ja平均 = {a:0.5,b:0.3,c:0.2}, en平均 = {a:0.2,b:0.5,c:0.3}
  // 総変動距離 = (|0.3|+|0.2|+|0.1|)/2 = 0.6/2 = 0.3
  assert.equal(result.byQuestion.q_choice!.count, 1);
  assert.ok(result.byQuestion.q_choice!.mean >= 0, '正解なしは非負の乖離量');
  assert.ok(Math.abs(result.byQuestion.q_choice!.mean - 0.3) < 1e-9);
});

test('pairedDifferences: 片方の言語が欠けた項目は対から除かれ、除外件数に出る', () => {
  const items: ItemResult[] = [
    {
      id: 'complete',
      questionKinds: nounQuestions,
      ja: { run1: { q_noul_a: { yes: 0.8 }, q_noul_b: { yes: 0.6 } }, run2: { q_noul_a: { yes: 0.8 }, q_noul_b: { yes: 0.6 } } },
      en: { run1: { q_noul_a: { yes: 0.5 }, q_noul_b: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.5 }, q_noul_b: { yes: 0.5 } } },
    },
    {
      id: 'missing-en',
      questionKinds: nounQuestions,
      ja: { run1: { q_noul_a: { yes: 0.8 }, q_noul_b: { yes: 0.6 } }, run2: { q_noul_a: { yes: 0.8 }, q_noul_b: { yes: 0.6 } } },
      en: {},
    },
  ];
  const result = pairedDifferences(items);
  assert.equal(result.byQuestion.q_noul_a!.count, 1, '欠けている項目は対から除く');
  assert.equal(result.excluded.q_noul_a, 1, '除外件数が分かる');
});

test('pairedDifferences: 上回り・下回りの件数が合う', () => {
  const items: ItemResult[] = [
    {
      id: 'ja-wins',
      questionKinds: nounQuestions,
      ja: { run1: { q_noul_a: { yes: 0.9 }, q_noul_b: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.9 }, q_noul_b: { yes: 0.5 } } },
      en: { run1: { q_noul_a: { yes: 0.1 }, q_noul_b: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.1 }, q_noul_b: { yes: 0.5 } } },
    },
    {
      id: 'en-wins',
      questionKinds: nounQuestions,
      ja: { run1: { q_noul_a: { yes: 0.1 }, q_noul_b: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.1 }, q_noul_b: { yes: 0.5 } } },
      en: { run1: { q_noul_a: { yes: 0.9 }, q_noul_b: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.9 }, q_noul_b: { yes: 0.5 } } },
    },
  ];
  const result = pairedDifferences(items);
  assert.equal(result.byQuestion.q_noul_a!.jaHigher, 1);
  assert.equal(result.byQuestion.q_noul_a!.enHigher, 1);
  assert.equal(result.byQuestion.q_noul_b!.jaHigher, 0);
  assert.equal(result.byQuestion.q_noul_b!.enHigher, 0, '差が0のときはどちらの勝ちにも数えない');
});

test('brierScore: Noul p=0.8, y=1 のとき 0.04', () => {
  const items: ItemResult[] = [
    {
      id: 'noul-item',
      questionKinds: { q_noul_a: 'noul' },
      truth: { q_noul_a: 'yes' },
      ja: { run1: { q_noul_a: { yes: 0.8 } } },
      en: {},
    },
  ];
  const result = brierScore(items, 'ja', 'run1');
  assert.equal(result.byQuestion.q_noul_a!.count, 1);
  assert.ok(Math.abs(result.byQuestion.q_noul_a!.mean - 0.04) < 1e-9);
});

test('brierScore: Choice {a:0.7,b:0.2,c:0.1} 正解a のとき 0.14', () => {
  const items: ItemResult[] = [
    {
      id: 'choice-item',
      questionKinds: { q_choice: 'choice' },
      truth: { q_choice: 'a' },
      ja: { run1: { q_choice: { a: 0.7, b: 0.2, c: 0.1 } } },
      en: {},
    },
  ];
  const result = brierScore(items, 'ja', 'run1');
  assert.equal(result.byQuestion.q_choice!.count, 1);
  assert.ok(Math.abs(result.byQuestion.q_choice!.mean - 0.14) < 1e-9);
});

test('brierScore: 正解の無い項目・問いは計算から除き、除外件数を返す', () => {
  const items: ItemResult[] = [
    {
      id: 'no-truth',
      questionKinds: { q_choice: 'choice' },
      // truth なし
      ja: { run1: { q_choice: { a: 0.7, b: 0.2, c: 0.1 } } },
      en: {},
    },
    {
      id: 'with-truth',
      questionKinds: { q_choice: 'choice' },
      truth: { q_choice: 'a' },
      ja: { run1: { q_choice: { a: 1, b: 0, c: 0 } } },
      en: {},
    },
  ];
  const result = brierScore(items, 'ja', 'run1');
  assert.equal(result.byQuestion.q_choice!.count, 1);
  assert.equal(result.excluded, 1);
});

test('agreementRate: Noul は p>=0.5 と正解の一致率（境界を含む）', () => {
  const items: ItemResult[] = [
    {
      id: 'boundary-yes',
      questionKinds: { q_noul_a: 'noul' },
      truth: { q_noul_a: 'yes' },
      ja: { run1: { q_noul_a: { yes: 0.5 } } },
      en: {},
    },
    {
      id: 'boundary-no',
      questionKinds: { q_noul_a: 'noul' },
      truth: { q_noul_a: 'no' },
      ja: { run1: { q_noul_a: { yes: 0.5 } } },
      en: {},
    },
  ];
  const result = agreementRate(items, 'ja', 'run1');
  // p=0.5 は yes 扱い。1件目は truth=yes で一致、2件目は truth=no で不一致
  assert.equal(result.byQuestion.q_noul_a!.count, 2);
  assert.ok(Math.abs(result.byQuestion.q_noul_a!.rate - 0.5) < 1e-9);
});

test('agreementRate: Choice は確率最大の選択肢と正解の一致率', () => {
  const items: ItemResult[] = [
    {
      id: 'agree',
      questionKinds: { q_choice: 'choice' },
      truth: { q_choice: 'a' },
      ja: { run1: { q_choice: { a: 0.6, b: 0.4 } } },
      en: {},
    },
    {
      id: 'disagree',
      questionKinds: { q_choice: 'choice' },
      truth: { q_choice: 'a' },
      ja: { run1: { q_choice: { a: 0.3, b: 0.7 } } },
      en: {},
    },
  ];
  const result = agreementRate(items, 'ja', 'run1');
  assert.equal(result.byQuestion.q_choice!.count, 2);
  assert.ok(Math.abs(result.byQuestion.q_choice!.rate - 0.5) < 1e-9);
});

test('runToRunSpread: 同じ言語の1回目と2回目の差の絶対値の平均', () => {
  const items: ItemResult[] = [
    {
      id: 'spread-item',
      questionKinds: { q_noul_a: 'noul' },
      ja: { run1: { q_noul_a: { yes: 0.8 } }, run2: { q_noul_a: { yes: 0.6 } } },
      en: {},
    },
    {
      id: 'spread-item-2',
      questionKinds: { q_noul_a: 'noul' },
      ja: { run1: { q_noul_a: { yes: 0.5 } }, run2: { q_noul_a: { yes: 0.5 } } },
      en: {},
    },
  ];
  const result = runToRunSpread(items, 'ja');
  // |0.8-0.6| = 0.2, |0.5-0.5| = 0, 平均 = 0.1
  assert.equal(result.byQuestion.q_noul_a!.count, 2);
  assert.ok(Math.abs(result.byQuestion.q_noul_a!.meanAbsDiff - 0.1) < 1e-9);
});

test('tokenRatio: 合計比と項目ごとの比の中央値', () => {
  const items: ItemUsage[] = [
    { id: 'a', ja: { run1: 200 }, en: { run1: 100 } },
    { id: 'b', ja: { run1: 300 }, en: { run1: 100 } },
    { id: 'c', ja: { run1: 500 }, en: { run1: 100 } },
  ];
  const result = tokenRatio(items);
  // 合計: ja=1000, en=300, ratio=1000/300
  assert.ok(Math.abs(result.totalRatio - 1000 / 300) < 1e-9);
  // 項目ごとの比: 2, 3, 5 の中央値は 3
  assert.ok(Math.abs(result.medianItemRatio - 3) < 1e-9);
});

test('stratifyByTokens: 3層に分けたときの境界・項目数が妥当', () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const result = stratifyByTokens(values, 3);
  assert.equal(result.boundaries.length, 2, 'k層はk-1個の境界を持つ');
  assert.equal(result.sizes.reduce((a, b) => a + b, 0), values.length, '層のサイズ合計は元の件数と一致');
  assert.equal(result.sizes.length, 3);
  for (const size of result.sizes) assert.ok(size > 0, '各層に少なくとも1件は入る');
});

test('cjkRatio: 日本語文字列は高い比率、英語文字列はほぼ0', () => {
  const ja = cjkRatio('これは日本語のテキストです');
  const en = cjkRatio('This is an English text.');
  assert.ok(ja > 0.8, `日本語は比率が高いはず: ${ja}`);
  assert.ok(en < 0.05, `英語は比率がほぼ0のはず: ${en}`);
});

test('translationProblems: translationReviewed=false の項目を検出する', () => {
  const items: ManifestItem[] = [
    {
      id: 'unreviewed',
      translationReviewed: false,
      jaText: '日本語のテキスト',
      enText: 'English text',
      jaDiff: '+line1\n+line2',
      enDiff: '+line1\n+line2',
    },
  ];
  const problems = translationProblems(items, 0.1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.id, 'unreviewed');
  assert.ok(problems[0]!.reasons.some((r) => r.includes('未確認') || r.toLowerCase().includes('review')));
});

test('translationProblems: 英訳版に CJK 文字が閾値以上残っている項目を検出する', () => {
  const items: ManifestItem[] = [
    {
      id: 'leftover-cjk',
      translationReviewed: true,
      jaText: '日本語のテキストです',
      enText: 'This text has 日本語 left in it',
      jaDiff: '+line1',
      enDiff: '+line1',
    },
  ];
  const problems = translationProblems(items, 0.05);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.id, 'leftover-cjk');
});

test('translationProblems: diff の行数・+/- の並びが食い違う項目を検出する', () => {
  const items: ManifestItem[] = [
    {
      id: 'diff-mismatch',
      translationReviewed: true,
      jaText: '日本語のテキストです',
      enText: 'English text here',
      jaDiff: '+line1\n+line2\n-line3',
      enDiff: '+line1\n-line3',
    },
  ];
  const problems = translationProblems(items, 0.1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.id, 'diff-mismatch');
});

test('translationProblems: 問題のない項目は検出されない', () => {
  const items: ManifestItem[] = [
    {
      id: 'clean',
      translationReviewed: true,
      jaText: '日本語のテキストです',
      enText: 'English text here',
      jaDiff: '+line1\n-line2',
      enDiff: '+line1\n-line2',
    },
  ];
  const problems = translationProblems(items, 0.1);
  assert.equal(problems.length, 0);
});

test('estimateCost: 文字数を増やすと見積もりトークン数・費用が単調に増える', () => {
  const small = estimateCost({ lang: 'ja', charCount: 100 });
  const large = estimateCost({ lang: 'ja', charCount: 1000 });
  assert.ok(large.tokens > small.tokens);
  assert.ok(large.costUsd > small.costUsd);
  const smallEn = estimateCost({ lang: 'en', charCount: 100 });
  const largeEn = estimateCost({ lang: 'en', charCount: 1000 });
  assert.ok(largeEn.tokens > smallEn.tokens);
});

test('estimateCost: 文字数0のときトークン数・費用は0', () => {
  const zero = estimateCost({ lang: 'ja', charCount: 0 });
  assert.equal(zero.tokens, 0);
  assert.equal(zero.costUsd, 0);
});

test('estimateCost: 単価を渡すと費用がその比率で変わる', () => {
  const cheap = estimateCost({ lang: 'ja', charCount: 1000, pricePerInputToken: 0.001 });
  const expensive = estimateCost({ lang: 'ja', charCount: 1000, pricePerInputToken: 0.002 });
  assert.ok(Math.abs(expensive.costUsd - cheap.costUsd * 2) < 1e-9);
});

test('askJevWithUsage: 偽の fetch の応答から answers と usage を返す', async () => {
  const request = { model: 'jev-1', state: {}, questions: {} };
  const result = await askJevWithUsage('secret-key', request, async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer secret-key');
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: { q_noul_a: { type: 'noul', noul: 0.7 } },
        usage: { input_tokens: 123, output_tokens: 45 },
      }),
    );
  });
  assert.equal(result.status, 'ok');
  if (result.status === 'ok') {
    assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 45 });
    assert.ok(result.answers.q_noul_a);
  }
});

test('askJevWithUsage: エラー時のレスポンス本文に含まれる API キーが伏せ字になる', async () => {
  const request = { model: 'jev-1', state: {}, questions: {} };
  const result = await askJevWithUsage(
    'secret-key',
    request,
    async () => new Response('unauthorized, bad key secret-key', { status: 401 }),
  );
  assert.equal(result.status, 'error');
  if (result.status === 'error') {
    assert.ok(!result.detail.includes('secret-key'));
    assert.equal(redact('secret-key', 'secret-key'), '***');
  }
});

test('renderSummary: 言語ごとの Brier score・一致率・トークン比が表の文字列に含まれる', () => {
  const md = renderSummary({
    brier: { ja: 0.05, en: 0.12 },
    agreement: { ja: 0.9, en: 0.75 },
    tokenRatio: 2.4,
  });
  assert.ok(md.includes('0.05'), 'ja の Brier score が含まれる');
  assert.ok(md.includes('0.12'), 'en の Brier score が含まれる');
  assert.ok(md.includes('0.9'), 'ja の一致率が含まれる');
  assert.ok(md.includes('0.75'), 'en の一致率が含まれる');
  assert.ok(md.includes('2.4'), 'トークン比が含まれる');
  assert.ok(md.includes('|'), 'Markdown の表になっている');
});

test('buildJevRequest の re-export: harness/lib/jev.ts のものをそのまま import して使う（8問）', () => {
  const facts = { references: 'FACT-REF', tests: 'FACT-TESTS', fileKinds: 'FACT-KINDS' };
  const req = buildJevRequest(config, 'diff --git a/x b/x', ['x'], facts);
  assert.equal(Object.keys(req.questions).length, 8);
});

test('buildTriageRequest の re-export: harness/lib/issue-triage.ts のものをそのまま import して使う（5問）', () => {
  const req = buildTriageRequest(config, 'タイトル', {
    goal: 'g',
    background: 'b',
    requirements: 'r',
    nonGoals: 'n',
    acceptanceCriteria: 'a',
  } as never);
  assert.equal(Object.keys(req.questions).length, 5);
});
