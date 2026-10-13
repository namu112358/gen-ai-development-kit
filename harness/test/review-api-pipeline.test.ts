// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）が、偽の GitHub・偽の Claude・偽の KV で外部 API を呼ばずに、
// head のずれ・closed・merged・同じ head の記録（KV とレビュー用の App の名義のコメント）・月の上限・単価の無いモデル・材料の大きさ・投稿の直前の取り直しで
// Claude を呼ばない（か投稿しない）こと、App 以外の名義の目印では duplicate にならないこと、JSON の取り出しと検査で落ちた出力が verdict-invalid になり
// 使った分が月の累計に足されること、budget-exceeded・too-large・verdict-invalid で止めたときは投稿しなかった記録が1件で
// parseApiReviewComment で outcome と head が読めること（Issue #1003）、投稿が1件で目印を含むこと、鍵と token が戻り値・ログ・コメント・KV に出ないこと、
// ツール（createToolRunner）が秘密の恐れがあるパスと外に出るパスを GitHub に問わず一覧からも除くこと、
// 1 レビューの見積もり（estimateLoopUsd）がツールのループと prompt caching を織り込んだ式で、budget の段階がそれで too-large を決めること（Issue #960）、
// pipeline.ts が @anthropic-ai/sdk・cloudflare:workers・node:・harness/lib を import しないことを確かめる（Issue #911）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, MessagesParams } from '../../review-api/src/claude.ts';
import type { ReviewConfig } from '../../review-api/src/config.ts';
import { createToolRunner, estimateLoopUsd, type ReviewOutcome } from '../../review-api/src/pipeline.ts';
import { parseApiReviewComment, parseShadowComment } from '../../review-api/src/record.ts';
import {
  answer,
  API_KEY,
  baseConfig,
  CALL_USD,
  COST_KEY,
  fakeGitHub,
  GATE,
  HEAD,
  MODEL,
  msg,
  OTHER,
  REVIEW_KEY,
  REVIEW_OK,
  REVIEWER,
  RISK_OK,
  run,
  shadowComment,
  TOKEN,
} from './support/review-api-pipeline.ts';

// 投稿しなかった記録のコメント：parseApiReviewComment で止めた outcome と HEAD が読める（posted との見分けは review-api-stopped-record.test.ts）
const assertStoppedRecord = (body: string, outcome: ReviewOutcome, name: string): void => {
  const parsed = parseApiReviewComment(body);
  assert.equal(parsed?.outcome, outcome, `${name}: 止めた記録の outcome`);
  assert.equal(parsed?.headSha, HEAD, `${name}: 止めた記録の head`);
};

test('estimateLoopUsd はツールのループと prompt caching を織り込んだ式で見積もり、単価の無いモデルは null', () => {
  // JSON.stringify({ system, tools, messages }) は 68 文字 → m = 34。maxFileChars 100 → t = 50、output は毎回 2000
  const params: MessagesParams = { model: 'm', system: 'S', tools: [], messages: [{ role: 'user', content: 'x' }] };
  const pricing = { m: { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 } };
  const cases: [string, MessagesParams, { maxToolCalls: number; maxFileChars: number }, number | null][] = [
    // 1 回目だけ：cacheWrite5m 34・output 2000 → (34*3 + 2000*2) / 1e6
    ['maxToolCalls 0', params, { maxToolCalls: 0, maxFileChars: 100 }, 0.004102],
    // 1 回目 + k=1（cacheRead 34・cacheWrite5m 50・output 2000）+ k=2（cacheRead 84・cacheWrite5m 50・output 2000）
    // → cacheWrite5m 134*3 + cacheRead 118*5 + output 6000*2 = 402 + 590 + 12000
    ['maxToolCalls 2', params, { maxToolCalls: 2, maxFileChars: 100 }, 0.012992],
    // t は 4000 で頭打ち：1 回目 + k=1（cacheRead 34・cacheWrite5m 4000）→ 4034*3 + 34*5 + 4000*2 = 12102 + 170 + 8000
    ['maxFileChars が大きくても t は 4000', params, { maxToolCalls: 1, maxFileChars: 100000 }, 0.020272],
    ['単価の無いモデル', { ...params, model: 'unknown' }, { maxToolCalls: 2, maxFileChars: 100 }, null],
    ['model が文字列でない', { ...params, model: 1 }, { maxToolCalls: 2, maxFileChars: 100 }, null],
  ];
  for (const [name, p, limits, expected] of cases) {
    assert.equal(estimateLoopUsd(p, limits, pricing), expected, name);
  }
  // input の単価は使わない（input は 0）
  assert.equal(estimateLoopUsd(params, { maxToolCalls: 2, maxFileChars: 100 }, { m: { ...pricing.m, input: 1000 } }), 0.012992);
});

test('outcome ごとに Claude の呼び出しの数・投稿・KV の review: の記録が決まる', async () => {
  const withConfig = (f: (c: ReviewConfig) => void) => {
    const c = baseConfig();
    f(c);
    return c;
  };
  // budget の段階がループを含む見積もりを使うことを、run() が組む材料の大きさに依らずに確かめる。
  // 見積もりは材料の大きさ m に単調なので、Reviewer＋Risk の和は「maxToolCalls 0 で m を大きめに取った値の 2 倍」以下、
  // 「ループを含み m を最小に取った値の 2 倍」以上になる。perReviewUsd をその間に置けば、maxToolCalls 0 の式なら通り、ループの式なら too-large になる
  const loopBounds = () => {
    const { claude, pricing } = baseConfig();
    const big: MessagesParams = { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(100_000) }] };
    const small: MessagesParams = { model: MODEL, messages: [] };
    const zeroUpper = 2 * estimateLoopUsd(big, { maxToolCalls: 0, maxFileChars: claude.maxFileChars }, pricing)!;
    const loopLower = 2 * estimateLoopUsd(small, { maxToolCalls: claude.maxToolCalls, maxFileChars: claude.maxFileChars }, pricing)!;
    assert.ok(zeroUpper < loopLower, `境が逆: ${zeroUpper} ${loopLower}`);
    return (zeroUpper + loopLower) / 2;
  };
  const cases: [string, Parameters<typeof run>[0], ReviewOutcome, number][] = [
    ['head のずれ', { pr: { state: 'open', head: OTHER } }, 'superseded', 0],
    ['closed', { pr: { state: 'closed', head: HEAD } }, 'closed', 0],
    ['merged', { pr: { state: 'closed', merged: true, head: HEAD } }, 'closed', 0],
    ['KV に同じ head の記録', { kv: { [REVIEW_KEY]: '{"version":1,"outcome":"posted"}' } }, 'duplicate', 0],
    ['レビュー用の App の名義の同じ head の記録のコメント', { comments: [shadowComment(1, REVIEWER, HEAD)] }, 'duplicate', 0],
    ['月の上限を超える', { kv: { [COST_KEY]: '9.99' } }, 'budget-exceeded', 0],
    ['月の累計が数として読めない', { kv: { [COST_KEY]: 'abc' } }, 'budget-exceeded', 0],
    ['単価の無いモデル', { config: withConfig((c) => (c.claude.riskModel = 'unknown-model')) }, 'budget-exceeded', 0],
    ['1レビューの上限を超える（材料の大きさ）', { config: withConfig((c) => (c.budget.perReviewUsd = 0.001)) }, 'too-large', 0],
    ['1レビューの上限を超える（ツールのループの見積もり）', { config: withConfig((c) => (c.budget.perReviewUsd = loopBounds())) }, 'too-large', 0],
    ['投稿の直前に head がずれた', { afterClaude: (s) => (s.pr = { state: 'open', head: OTHER }) }, 'superseded', 2],
    ['投稿の直前に closed', { afterClaude: (s) => (s.pr = { state: 'closed', head: HEAD }) }, 'closed', 2],
    ['投稿の直前に同じ head の自分の記録', { afterClaude: (s) => s.comments.push(shadowComment(2, REVIEWER, HEAD)) }, 'duplicate', 2],
    ['App 以外の名義の同じ head の目印', { comments: [shadowComment(1, GATE, HEAD), shadowComment(2, 'someone', HEAD)] }, 'posted', 2],
  ];
  // 止めた outcome は投稿しなかった記録が1件、posted はレビューの記録が1件、それ以外（superseded・closed・duplicate）は投稿しない（Issue #1003）
  const stopped: ReviewOutcome[] = ['budget-exceeded', 'too-large', 'verdict-invalid'];
  for (const [name, opts, outcome, claudeCount] of cases) {
    const r = await run(opts);
    assert.equal(r.result.outcome, outcome, name);
    assert.equal(r.claudeCalls.length, claudeCount, `${name}: Claude の呼び出し`);
    assert.equal(r.posted.length, outcome === 'posted' || stopped.includes(outcome) ? 1 : 0, `${name}: 投稿`);
    if (stopped.includes(outcome)) assertStoppedRecord(r.posted[0]!, outcome, name);
    if (name.startsWith('KV に')) assert.equal(r.kv.get(REVIEW_KEY), opts!.kv![REVIEW_KEY], `${name}: 上書きしない`);
    else assert.equal(r.record?.outcome, outcome, `${name}: KV の記録`);
    if (claudeCount === 0) assert.equal(r.kv.get(COST_KEY), opts?.kv?.[COST_KEY], `${name}: 月の累計は変えない`);
  }
});

test('上限が正の有限の数でない（NaN）ときは Claude を呼ばずに budget-exceeded で止まり、KV の記録に budgetInvalid: true を入れ、止めた記録を1件付ける（Issue #989・#1003）', async () => {
  const cases: [string, (c: ReviewConfig) => void][] = [
    ['monthlyUsd が NaN', (c) => (c.budget.monthlyUsd = NaN)],
    ['perReviewUsd が NaN', (c) => (c.budget.perReviewUsd = NaN)],
  ];
  for (const [name, mutate] of cases) {
    const config = baseConfig();
    mutate(config);
    const r = await run({ config });
    assert.equal(r.result.outcome, 'budget-exceeded', name);
    assert.equal(r.claudeCalls.length, 0, `${name}: Claude の呼び出し`);
    assert.equal(r.posted.length, 1, `${name}: 投稿`);
    assertStoppedRecord(r.posted[0]!, 'budget-exceeded', name);
    assert.equal(r.record?.outcome, 'budget-exceeded', `${name}: KV の記録`);
    assert.equal((r.record as { budgetInvalid?: unknown } | null)?.budgetInvalid, true, `${name}: budgetInvalid`);
    assert.equal(r.kv.get(COST_KEY), undefined, `${name}: 月の累計は変えない`);
    assert.ok(r.logs.some((l) => l.includes('budget invalid')), `${name}: ログ ${r.logs.join(' | ')}`);
  }
});

test('JSON の取り出しと検査で落ちた出力は verdict-invalid でレビューを投稿せず止めた記録を1件付け、使った分を月の累計に足す', async () => {
  const cases: [string, Message[], number][] = [
    ['JSON が読めない text', [msg([{ type: 'text', text: 'not json' }], 'end_turn')], 1],
    ['refusal', [msg([{ type: 'text', text: '{}' }], 'refusal')], 1],
    ['max_tokens', [msg([{ type: 'text', text: '{"pass":' }], 'max_tokens')], 1],
    ['Reviewer の検査で落ちる', [answer({ pass: true, blocking: [{ kind: 'bug', detail: 'x' }], nonBlocking: [] }), answer(RISK_OK)], 2],
    ['Risk の検査で落ちる', [answer(REVIEW_OK), answer({ ...RISK_OK, level: 'huge' })], 2],
  ];
  for (const [name, responses, claudeCount] of cases) {
    const r = await run({ responses });
    assert.equal(r.result.outcome, 'verdict-invalid', name);
    assert.equal(r.claudeCalls.length, claudeCount, `${name}: Claude の呼び出し`);
    assert.equal(r.posted.length, 1, `${name}: 投稿`);
    assertStoppedRecord(r.posted[0]!, 'verdict-invalid', name);
    assert.equal(r.record?.outcome, 'verdict-invalid', `${name}: KV の記録`);
    assert.ok(Math.abs(Number(r.kv.get(COST_KEY)) - claudeCount * CALL_USD) < 1e-9, `${name}: 月の累計 ${r.kv.get(COST_KEY)}`);
  }
});

test('posted：目印を含む投稿が1件で、月の累計に足し、鍵と token は戻り値・ログ・コメント・KV・Claude への問いに出ない', async () => {
  const leaky = { ...REVIEW_OK, nonBlocking: [`鍵 ${API_KEY} が見えた`] };
  const r = await run({ kv: { [COST_KEY]: '1' }, responses: [answer(leaky), answer(RISK_OK)] });

  assert.equal(r.result.outcome, 'posted');
  assert.equal(r.result.pr, 5);
  assert.equal(r.result.headSha, HEAD);
  assert.ok(Math.abs(r.result.usd! - 2 * CALL_USD) < 1e-9, String(r.result.usd));
  assert.equal(r.posted.length, 1);
  assert.ok(r.posted[0]!.includes(`<!-- api-review-shadow head=${HEAD} -->`));
  assert.equal(parseShadowComment(r.posted[0]!)?.headSha, HEAD);
  assert.equal(r.record?.outcome, 'posted');
  assert.ok(Math.abs(Number(r.kv.get(COST_KEY)) - (1 + r.result.usd!)) < 1e-9, r.kv.get(COST_KEY));
  assert.ok(r.logs.length > 0);

  const outputs: [string, string][] = [
    ['戻り値', JSON.stringify(r.result)],
    ['ログ', r.logs.join('\n')],
    ['コメント', r.posted.join('\n')],
    ['KV', JSON.stringify([...r.kv.values()])],
    ['Claude への問い', JSON.stringify(r.claudeCalls)],
  ];
  for (const [where, text] of outputs) {
    assert.equal(text.includes(TOKEN), false, `${where}: token`);
    assert.equal(text.includes(API_KEY), false, `${where}: API キー`);
  }
});

test('ツールは秘密の恐れがあるパスと外に出るパスを GitHub に問わず、一覧からも除く', async () => {
  const { gh, calls } = fakeGitHub({ pr: { state: 'open', head: HEAD }, comments: [] });
  const runTool = createToolRunner(gh, HEAD, 100);

  for (const path of ['.env', 'config/server.key', '../x', '/etc/passwd', 'src/../.env', '']) {
    const out = await runTool({ name: 'read_file', input: { path } });
    assert.equal(out.isError, true, path);
  }
  assert.deepEqual(calls, [], '読めないパスでは GitHub を呼ばない');

  const ok = await runTool({ name: 'read_file', input: { path: 'src/a.ts' } });
  assert.notEqual(ok.isError, true);
  assert.ok(ok.content.includes('new'));

  const list = await runTool({ name: 'list_files', input: { prefix: '' } });
  assert.notEqual(list.isError, true);
  const listed = list.content.split(/[\s,"'\[\]]+/);
  assert.ok(listed.includes('src/a.ts'), list.content);
  assert.equal(listed.includes('.env'), false, list.content);
  assert.equal(listed.includes('config/server.key'), false, list.content);
});

test('pipeline.ts は @anthropic-ai/sdk・cloudflare:workers・node:・harness/lib を import しない', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/pipeline.ts', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^@anthropic-ai\/sdk|^cloudflare:workers$|^cloudflare:workflows$|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
