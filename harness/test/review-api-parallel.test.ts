// review-api の Reviewer と Risk の問いを並べて動かすこと（review-api/src/pipeline.ts の runReview。Issue #1061）を、役ごとに振り分ける偽の Claude で確かめる。
// Risk は Reviewer の最初の応答の後、Reviewer の完了の前に始まり、Reviewer が最初の応答の前に投げたら Risk は呼ばれず runReview が投げること、
// Reviewer が最初の応答の後に投げて Risk が答えたら、runReview は投げ、月の累計に Risk の使用量が足されていること、
// budget の段階の見込みが Reviewer の見込みと、Reviewer と共有する接頭辞（sharedPrefixTokens）をキャッシュ済みとして数えた Risk の見込みの和であることを見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, MessagesClient, MessagesParams } from '../../review-api/src/claude.ts';
import { collectMaterial } from '../../review-api/src/collect.ts';
import { buildAskRequests, estimateLoopUsd, sharedPrefixTokens } from '../../review-api/src/pipeline.ts';
import { answer, baseConfig, CALL_USD, COST_KEY, fakeGitHub, GATE, HEAD, msg, REVIEW_OK, REVIEWER, RISK_OK, run } from './support/review-api-pipeline.ts';

type Role = 'review' | 'risk';
// afterRisk は Risk の create が来るまで（期限 2 秒）返さない
type Reply = Message | Error | { afterRisk: Message | Error };

const toolUse = msg([{ type: 'tool_use', id: 't1', name: 'list_files', input: { prefix: 'src' } }], 'tool_use');

// 役（出力の形に pass があれば Reviewer）ごとの応答の列を返し、create・応答・投げたことを呼ばれた順に events に積む偽の Claude で run を回す
async function runParallel(replies: Record<Role, Reply[]>, opts: Parameters<typeof run>[0] = {}) {
  const events: string[] = [];
  const count = { review: 0, risk: 0 };
  let riskStarted = (): void => {};
  const riskCreated = new Promise<void>((resolve) => (riskStarted = resolve));
  const claude: MessagesClient = {
    async create(p: MessagesParams) {
      const schema = (p['output_config'] as { format: { schema: { properties: Record<string, unknown> } } }).format.schema;
      const role: Role = 'pass' in schema.properties ? 'review' : 'risk';
      const n = ++count[role];
      events.push(`${role} create ${n}`);
      if (role === 'risk') riskStarted();
      let r = replies[role][n - 1];
      if (r === undefined) throw new Error(`偽の Claude の ${role} の応答が足りない`);
      if ('afterRisk' in r) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([riskCreated, new Promise((resolve) => (timer = setTimeout(resolve, 2000)))]);
        clearTimeout(timer);
        r = r.afterRisk;
      }
      if (r instanceof Error) {
        events.push(`${role} error ${n}`);
        throw r;
      }
      events.push(`${role} response ${n}`);
      return r;
    },
  };
  const result = run({ ...opts, claude }).then(
    (v) => ({ ok: true as const, outcome: v.result.outcome }),
    (e: unknown) => ({ ok: false as const, error: e }),
  );
  return { events, ...(await result) };
}

test('Risk は Reviewer の最初の応答の後、Reviewer の完了の前に始まり、Reviewer が最初の応答の前に投げたら Risk は呼ばれず runReview が投げる', async () => {
  const keys = ['review create 1', 'review response 1', 'risk create 1', 'review response 2'];
  const cases: [string, Record<Role, Reply[]>, string | null, string[]][] = [
    ['Reviewer がツールを使う', { review: [toolUse, { afterRisk: answer(REVIEW_OK) }], risk: [answer(RISK_OK)] }, 'posted', keys],
    ['Reviewer が最初の create で投げる', { review: [new Error('review-boom')], risk: [answer(RISK_OK)] }, null, ['review create 1']],
  ];
  for (const [name, replies, outcome, order] of cases) {
    const r = await runParallel(replies);
    if (outcome === null) assert.ok(!r.ok && r.error instanceof Error && r.error.message === 'review-boom', `${name}: 投げる`);
    else assert.equal(r.ok && r.outcome, outcome, name);
    assert.deepEqual(r.events.filter((e) => keys.includes(e)), order, `${name}: 順 ${r.events.join(' | ')}`);
  }
});

test('Reviewer が最初の応答の後に投げ、Risk が答えたら、runReview は投げ、月の累計に Risk の使用量が足されている', async () => {
  const store = new Map<string, string>();
  const r = await runParallel({ review: [toolUse, new Error('review-boom')], risk: [answer(RISK_OK)] }, { store });
  assert.ok(!r.ok && r.error instanceof Error && r.error.message === 'review-boom', `投げる ${r.events.join(' | ')}`);
  assert.ok(r.events.includes('risk response 1'), 'Risk は答えた');
  // Reviewer の使用量は runReview の外に返らないので数えない。Risk の1回分だけ
  assert.ok(Math.abs(Number(store.get(COST_KEY)) - CALL_USD) < 1e-9, `月の累計 ${store.get(COST_KEY)}`);
});

test('budget の段階の見込みは Reviewer の見込みと、共有する接頭辞をキャッシュ済みとして数えた Risk の見込みの和', async () => {
  const config = baseConfig();
  const { gh } = fakeGitHub({ pr: { state: 'open', head: HEAD }, comments: [] });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE, reviewLogin: REVIEWER });
  const asks = buildAskRequests(material, config);
  const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
  const shared = sharedPrefixTokens(asks.review, asks.risk);
  assert.ok(shared > 0, `共有する接頭辞 ${shared}`);
  const a = estimateLoopUsd(asks.review, limits, config.pricing)!;
  const b = estimateLoopUsd(asks.risk, limits, config.pricing, shared)!;
  // キャッシュ済みの分は cacheRead で数えるので、共有を数えない見込みより安い
  assert.ok(b < estimateLoopUsd(asks.risk, limits, config.pricing)!, `Risk の見込み ${b}`);
  const cases: [number, string][] = [
    [a + b, 'posted'],
    [a + b - 1e-6, 'too-large'],
  ];
  for (const [perReviewUsd, outcome] of cases) {
    const c = baseConfig();
    c.budget.perReviewUsd = perReviewUsd;
    const r = await run({ config: c });
    assert.equal(r.result.outcome, outcome, `perReviewUsd ${perReviewUsd}`);
  }
});
