// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）で Reviewer と Risk の問いを並行に動かすこと（Issue #1061）を、偽の GitHub・偽の Claude・偽の KV で確かめる。
// 片方の完了を待たずにもう片方の Claude の呼び出しが始まること、Reviewer が失敗しても verdict-invalid（detail は review:<理由>）のままで Risk も呼ばれ、
// Risk の使用量が記録の usageByRole.risk・usage・usd と月の累計に数えられること、budget の段階が Reviewer と Risk の見込み（estimateLoopUsd）の和で
// too-large を決めること（キャッシュは共有しない前提で見込みの式は変えない）を見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, MessagesClient, MessagesParams } from '../../review-api/src/claude.ts';
import { collectMaterial } from '../../review-api/src/collect.ts';
import { buildAskRequests, estimateLoopUsd } from '../../review-api/src/pipeline.ts';
import {
  answer,
  baseConfig,
  CALL_USD,
  COST_KEY,
  fakeGitHub,
  GATE,
  HEAD,
  MODEL,
  msg,
  REVIEW_KEY,
  REVIEW_OK,
  REVIEWER,
  RISK_OK,
  run,
} from './support/review-api-pipeline.ts';

type Role = 'review' | 'risk';

// 出力の形（output_config.format.schema）に pass があれば Reviewer の問い
const roleOf = (p: MessagesParams): Role => {
  const schema = (p['output_config'] as { format?: { schema?: { properties?: Record<string, unknown> } } } | undefined)?.format?.schema;
  return schema?.properties !== undefined && Object.hasOwn(schema.properties, 'pass') ? 'review' : 'risk';
};

const near = (actual: unknown, expected: number, label: string): void => {
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${label}: ${String(actual)} ≠ ${expected}`);
};

const ONE_CALL = { input: 1000, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };

test('Reviewer と Risk の問いは並行に始まる（Reviewer の最初の応答の前に Risk の create が呼ばれる）', async () => {
  // 両方の役の最初の create が来るまでどちらにも返さない。WAIT_MS 待っても揃わなければ投げる（順に呼ぶ実装でテストが止まり続けない）
  const WAIT_MS = 2000;
  const events: string[] = [];
  const arrived = new Set<Role>();
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => (release = resolve));
  const claude: MessagesClient = {
    async create(p): Promise<Message> {
      const role = roleOf(p);
      events.push(`create ${role}`);
      arrived.add(role);
      if (arrived.size === 2) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${WAIT_MS}ms 待っても Reviewer と Risk の create が揃わない（順に呼んでいる）: ${events.join(', ')}`)), WAIT_MS);
      });
      try {
        await Promise.race([both, timeout]);
      } finally {
        clearTimeout(timer);
      }
      events.push(`return ${role}`);
      return role === 'review' ? answer(REVIEW_OK) : answer(RISK_OK);
    },
  };
  const r = await run({ claude });
  assert.equal(r.result.outcome, 'posted', events.join(', '));
  assert.equal(r.claudeCalls.length, 2);
  const riskCreate = events.indexOf('create risk');
  const reviewReturn = events.indexOf('return review');
  assert.ok(riskCreate >= 0 && reviewReturn >= 0 && riskCreate < reviewReturn, `Reviewer の応答の前に Risk の create: ${events.join(', ')}`);
});

test('Reviewer が失敗しても Risk は呼ばれ、outcome は verdict-invalid・detail は review:<理由> のままで、Risk の使用量を記録と月の累計に数える', async () => {
  const cases: [string, Message, string][] = [
    ['JSON が読めない text', msg([{ type: 'text', text: 'not json' }], 'end_turn'), 'review:invalid-json'],
    ['refusal', msg([{ type: 'text', text: '{}' }], 'refusal'), 'review:refusal'],
    ['max_tokens', msg([{ type: 'text', text: '{"pass":' }], 'max_tokens'), 'review:max-tokens'],
  ];
  for (const [name, reviewReply, detail] of cases) {
    const r = await run({ responses: [reviewReply, answer(RISK_OK)] });
    assert.equal(r.result.outcome, 'verdict-invalid', name);
    assert.equal(r.claudeCalls.length, 2, `${name}: Claude の呼び出し`);
    assert.deepEqual(r.claudeCalls.map(roleOf).sort(), ['review', 'risk'], `${name}: 両方の役を問う`);
    assert.equal(r.posted.length, 1, `${name}: 止めた記録だけを投稿`);
    const rec = JSON.parse(r.kv.get(REVIEW_KEY)!) as {
      outcome: string;
      detail?: string;
      usage?: unknown;
      usd?: number | null;
      usageByRole?: { review?: unknown; risk?: unknown };
    };
    assert.equal(rec.outcome, 'verdict-invalid', `${name}: KV の記録`);
    assert.equal(rec.detail, detail, `${name}: detail`);
    assert.deepEqual(rec.usageByRole?.risk, { usage: { [MODEL]: ONE_CALL }, usd: CALL_USD }, `${name}: usageByRole.risk`);
    assert.deepEqual(rec.usageByRole?.review, { usage: { [MODEL]: ONE_CALL }, usd: CALL_USD }, `${name}: usageByRole.review`);
    assert.deepEqual(rec.usage, { [MODEL]: { ...ONE_CALL, input: 2000, output: 200 } }, `${name}: usage`);
    near(rec.usd, 2 * CALL_USD, `${name}: 記録の usd`);
    near(r.result.usd, 2 * CALL_USD, `${name}: 戻り値の usd`);
    near(Number(r.kv.get(COST_KEY)), 2 * CALL_USD, `${name}: 月の累計`);
  }
});

test('budget の段階は Reviewer と Risk の見込み（estimateLoopUsd）の和で too-large を決める（キャッシュを共有しない見込みのまま）', async () => {
  // runReview と同じ材料を偽の GitHub から集め、同じ問いを組んで見込みを出す
  const config = baseConfig();
  const { gh } = fakeGitHub({ pr: { state: 'open', head: HEAD }, comments: [] });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE, reviewLogin: REVIEWER });
  const asks = buildAskRequests(material, config);
  const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
  const a = estimateLoopUsd(asks.review, limits, config.pricing);
  const b = estimateLoopUsd(asks.risk, limits, config.pricing);
  assert.ok(a !== null && b !== null, '見込みが出る');
  const sum = a + b;
  assert.ok(sum < config.budget.monthlyUsd, `月の上限より小さい: ${sum}`);
  const cases: [string, number, string, number][] = [
    ['見込みの和ちょうど', sum, 'posted', 2],
    ['見込みの和より少し小さい', sum - 1e-6, 'too-large', 0],
  ];
  for (const [name, perReviewUsd, outcome, claudeCount] of cases) {
    const c = baseConfig();
    c.budget.perReviewUsd = perReviewUsd;
    const r = await run({ config: c });
    assert.equal(r.result.outcome, outcome, name);
    assert.equal(r.claudeCalls.length, claudeCount, `${name}: Claude の呼び出し`);
  }
});
