// review-api の流し直し（review-api/src/replay.ts の replayReview）が、偽の fetch と偽の Claude で外部 API を呼ばずに、
// closed・merged の PR の古い head でも Reviewer と Risk を問い（比べる Risk は問わない）verdict・使用量・推定 USD を返すこと、
// GitHub に GET 以外を送らず deps に書き込みと KV を持たないこと、見込みが remainingUsd を超えるか出せないとき Claude を呼ばず over-budget を返すこと、
// 検査で落ちたら invalid と理由を返すこと、鍵を含む例外でもログと返す値に鍵が出ないこと、
// collectMaterial の previous: false で前回の shadow の記録を読まず省略時は今どおり読むこと、
// replay.ts が @anthropic-ai/sdk・cloudflare:workers・node:・harness/lib を import しないことを確かめる（Issue #1040）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, MessagesClient, MessagesParams } from '../../review-api/src/claude.ts';
import { collectMaterial } from '../../review-api/src/collect.ts';
import type { ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { buildAskRequests, estimateLoopUsd } from '../../review-api/src/pipeline.ts';
import { replayReview, type ReplayDeps } from '../../review-api/src/replay.ts';
import {
  answer, API_KEY, baseConfig, DIFF, fakeGitHub, FILES, GATE, HEAD, MODEL, OTHER, REVIEW_OK, REVIEWER, RISK_OK, shadowComment, TOKEN, TREE, type Pr,
} from './support/review-api-pipeline.ts';

const RISK_MODEL = 'claude-sonnet-5';
const PRICE = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };

// Reviewer と Risk のモデルを違える（riskCompare は既定のまま。比べる Risk を問わないことを見るため）
const twoModels = (): ReviewConfig => {
  const c = baseConfig();
  c.claude.riskModel = RISK_MODEL;
  c.pricing[RISK_MODEL] = PRICE;
  return c;
};

// method と URL を記録する偽の fetch。replay に要る分だけ fakeGitHub と同じに答える
function recordingGitHub(pr: Pr) {
  const requests: { method: string; url: string }[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    requests.push({ method: init?.method ?? (input instanceof Request ? input.method : 'GET'), url: raw });
    const url = new URL(raw);
    const p = url.pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') {
      return json({ number: 5, title: 'PR の題', body: '説明', state: pr.state, merged: pr.merged ?? false, draft: false, head: { ref: 'h', sha: pr.head }, base: { ref: 'main', sha: OTHER }, user: null });
    }
    if (p === '/issues/5/comments') return json([]);
    if (p === `/compare/main...${HEAD}`) return new Response(DIFF);
    if (p === `/git/trees/${HEAD}`) return json(TREE);
    const file = p.startsWith('/contents/') ? FILES[decodeURIComponent(p.slice('/contents/'.length))] : undefined;
    if (file !== undefined && url.searchParams.get('ref') === HEAD) return new Response(file);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh: createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetch }), requests };
}

// 偽の Claude（応答の列。Error の要素は投げる）
function fakeClaude(responses: (Message | Error)[]) {
  const calls: MessagesParams[] = [];
  const claude: MessagesClient = {
    async create(p) {
      calls.push(structuredClone(p));
      const r = responses[calls.length - 1];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { claude, calls };
}

async function replay(opts: { pr?: Pr; config?: ReviewConfig; responses?: (Message | Error)[]; remainingUsd?: number } = {}) {
  const { gh, requests } = recordingGitHub(opts.pr ?? { state: 'closed', merged: true, head: OTHER });
  const { claude, calls } = fakeClaude(opts.responses ?? []);
  const logs: string[] = [];
  const deps: ReplayDeps = { github: { reader: async () => gh }, claude, now: () => 0, log: (l) => logs.push(l), secrets: [API_KEY, TOKEN] };
  const result = await replayReview(deps, {
    owner: 'o', repo: 'r', pr: 5, headSha: HEAD, gateAppLogin: GATE, config: opts.config ?? baseConfig(), remainingUsd: opts.remainingUsd ?? 100,
  });
  return { result, requests, calls, logs, deps };
}

test('closed・merged の PR の古い head でも Reviewer と Risk を問い、verdict・使用量・推定 USD を返す。GET だけで、deps に書き込みと KV が無い', async () => {
  const cases: [string, Pr][] = [
    ['closed', { state: 'closed', merged: false, head: OTHER }],
    ['merged', { state: 'closed', merged: true, head: OTHER }],
  ];
  for (const [name, pr] of cases) {
    const r = await replay({ pr, config: twoModels(), responses: [answer(REVIEW_OK), answer(RISK_OK, RISK_MODEL)] });
    assert.equal(r.calls.length, 2, `${name}: Claude の呼び出し（比べる Risk は問わない）`);
    assert.deepEqual(r.calls.map((c) => c.model), [MODEL, RISK_MODEL], `${name}: Reviewer → Risk`);
    assert.equal(r.result.outcome, 'reviewed', name);
    if (r.result.outcome !== 'reviewed') continue;
    assert.equal(r.result.headSha, HEAD, `${name}: 問い直した head`);
    assert.equal(r.result.record.headSha, HEAD, `${name}: 記録の head`);
    assert.ok(r.result.record.verdict, `${name}: verdict`);
    assert.deepEqual(Object.keys(r.result.record.usage).sort(), [MODEL, RISK_MODEL].sort(), `${name}: usage`);
    assert.equal(typeof r.result.record.usd, 'number', `${name}: usd`);
    assert.equal(typeof r.result.estimatedUsd, 'number', `${name}: estimatedUsd`);
    assert.equal(r.result.record.riskCompare, undefined, `${name}: riskCompare が無い`);
    assert.equal(r.result.record.usageByRole?.riskCompare, undefined, `${name}: usageByRole.riskCompare が無い`);
    assert.ok(r.requests.length > 0, `${name}: GitHub を読んだ`);
    assert.deepEqual(r.requests.filter((q) => q.method.toUpperCase() !== 'GET'), [], `${name}: GET 以外が無い`);
    assert.deepEqual(Object.keys(r.deps).sort(), ['claude', 'github', 'log', 'now', 'secrets'], `${name}: deps のキー`);
    assert.deepEqual(Object.keys(r.deps.github), ['reader'], `${name}: github のキー`);
  }
});

test('見込みが remainingUsd を超えるか出せないとき、Claude を1度も呼ばず over-budget を返す', async () => {
  // 同じ材料から見込みを出し、その半分を remainingUsd に渡す（数を直書きしない）
  const config = baseConfig();
  const { gh } = fakeGitHub({ pr: { state: 'closed', merged: true, head: OTHER }, comments: [] });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE, previous: false });
  const asks = buildAskRequests(material, config);
  const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
  const estimated = estimateLoopUsd(asks.review, limits, config.pricing)! + estimateLoopUsd(asks.risk, limits, config.pricing)!;
  const noPrice = baseConfig();
  noPrice.claude.reviewModel = 'unknown-model';
  const cases: [string, ReviewConfig, number, number | null][] = [
    ['見込みより小さい remainingUsd', config, estimated / 2, estimated],
    ['単価の無いモデル', noPrice, 100, null],
  ];
  for (const [name, c, remainingUsd, expected] of cases) {
    const r = await replay({ config: c, remainingUsd, responses: [answer(REVIEW_OK), answer(RISK_OK)] });
    assert.equal(r.calls.length, 0, `${name}: Claude の呼び出し`);
    assert.equal(r.result.outcome, 'over-budget', name);
    if (r.result.outcome !== 'over-budget') continue;
    if (expected === null) assert.equal(r.result.estimatedUsd, null, name);
    else assert.ok(Math.abs(r.result.estimatedUsd! - expected) < 1e-9, `${name}: estimatedUsd ${r.result.estimatedUsd}`);
  }
});

test('Reviewer の出力が検査で落ちたら invalid と理由を返す', async () => {
  const r = await replay({ responses: [answer({ pass: true, blocking: [{ kind: 'bug', detail: 'x' }], nonBlocking: [] }), answer(RISK_OK)] });
  assert.equal(r.result.outcome, 'invalid');
  if (r.result.outcome !== 'invalid') return;
  assert.match(r.result.detail, /^review:invalid\(\d+\)/);
});

test('collectMaterial は previous: false で前回の shadow の記録を読まず、省略時は今どおり読む', async () => {
  const input = { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE };
  const state = () => ({ pr: { state: 'open', head: HEAD }, comments: [shadowComment(1, REVIEWER, OTHER)] });

  const off = fakeGitHub(state());
  const without = await collectMaterial(off.gh, baseConfig(), { ...input, previous: false });
  assert.equal(without.previous, null, 'previous: false');
  assert.ok(!off.calls.some((u) => new URL(u).pathname.endsWith('/issues/5/comments')), `previous: false で PR のコメントを読まない ${off.calls.join(' ')}`);

  const on = fakeGitHub(state());
  const withPrev = await collectMaterial(on.gh, baseConfig(), { ...input, reviewLogin: REVIEWER });
  assert.notEqual(withPrev.previous, null, '省略時は前回の記録を読む');
  assert.ok(on.calls.some((u) => new URL(u).pathname.endsWith('/issues/5/comments')), '省略時は PR のコメントを読む');
});

test('偽のクライアントが鍵を含むエラーを投げても、ログと返す値に鍵が出ない', async () => {
  const r = await replay({ responses: [new Error(`boom ${API_KEY} ${TOKEN}`)] });
  assert.equal(r.result.outcome, 'error');
  if (r.result.outcome !== 'error') return;
  assert.equal(r.result.stage, 'review');
  const text = [JSON.stringify(r.result), ...r.logs].join('\n');
  for (const secret of [API_KEY, TOKEN]) assert.ok(!text.includes(secret), `${secret} が出た: ${text}`);
});

test('replay.ts は cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しない', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/replay.ts', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^cloudflare:workers$|^@anthropic-ai\/sdk|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
