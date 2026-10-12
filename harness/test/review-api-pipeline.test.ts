// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）が、偽の GitHub・偽の Claude・偽の KV で外部 API を呼ばずに、
// head のずれ・closed・merged・同じ head の記録（KV とレビュー用の App の名義のコメント）・月の上限・単価の無いモデル・材料の大きさ・投稿の直前の取り直しで
// Claude を呼ばない（か投稿しない）こと、App 以外の名義の目印では duplicate にならないこと、JSON の取り出しと検査で落ちた出力が verdict-invalid になり
// 使った分が月の累計に足されること、投稿が1件で目印を含むこと、鍵と token が戻り値・ログ・コメント・KV に出ないこと、
// ツール（createToolRunner）が秘密の恐れがあるパスと外に出るパスを GitHub に問わず一覧からも除くこと、
// pipeline.ts が @anthropic-ai/sdk・cloudflare:workers・node:・harness/lib を import しないことを確かめる（Issue #911）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContentBlock, Message, MessagesClient, MessagesParams } from '../../review-api/src/claude.ts';
import type { ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { createToolRunner, runReview, type ReviewOutcome, type ReviewParams } from '../../review-api/src/pipeline.ts';
import { parseShadowComment, renderShadowComment, type ShadowRecord } from '../../review-api/src/record.ts';
import { composeShadowVerdict, RISK_QUESTIONS, type Noul, type RiskOutput, type RiskQuestionKey } from '../../review-api/src/verdict.ts';

const GATE = 'agent-harness[bot]';
const REVIEWER = 'review-api[bot]';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MODEL = 'claude-opus-5-5';
const TOKEN = 'ghs_FAKETOKEN911abcdef';
const API_KEY = 'sk-ant-api03-FAKEKEY911';
const NOW = Date.UTC(2026, 9, 13);
const REVIEW_KEY = `review:o/r:5:${HEAD}`;
const COST_KEY = 'cost:2026-10';
// 1回の問いの usage（入力 1000・出力 100）の料金は 0.005 + 0.0025
const CALL_USD = 0.0075;

const baseConfig = (): ReviewConfig => ({
  trigger: { actions: ['opened'], skipBotSenders: true, branchPrefix: 'claude/', requireClosesIssue: false },
  claude: { reviewModel: MODEL, riskModel: MODEL, effort: 'high', maxTokens: 1000, maxToolCalls: 10, maxDiffChars: 10000, maxFileChars: 100 },
  budget: { monthlyUsd: 10, perReviewUsd: 5 },
  pricing: { [MODEL]: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
});
const params = (config = baseConfig()): ReviewParams => ({ owner: 'o', repo: 'r', pr: 5, headSha: HEAD, gateAppLogin: GATE, reviewAppLogin: REVIEWER, config });

const comment = (id: number, login: string, body: string) => ({ id, body, user: { login }, author_association: 'NONE' });
const RISK_OK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Record<RiskQuestionKey, Noul>,
  rationale: 'r',
  facts: { references: '', tests: '', fileKinds: '' },
};
const REVIEW_OK = { pass: true, blocking: [], nonBlocking: [] as string[] };
const shadowComment = (id: number, login: string, headSha: string) => {
  const record: ShadowRecord = {
    version: 1, pr: 5, headSha,
    verdict: composeShadowVerdict({ pr: 5, headSha, reviewer: REVIEW_OK, risk: RISK_OK, model: MODEL }),
    models: { review: MODEL, risk: MODEL }, usage: {}, usd: null, durationSec: 1,
  };
  return comment(id, login, renderShadowComment(record));
};

type Pr = { state: string; merged?: boolean; head: string };
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
const FILES: Record<string, string> = { 'src/a.ts': 'new', '.env': 'SECRET=1', 'config/server.key': 'KEY' };
const TREE = {
  sha: HEAD,
  truncated: false,
  tree: [
    { path: 'src', type: 'tree', sha: '1' },
    { path: 'src/a.ts', type: 'blob', sha: '2' },
    { path: '.env', type: 'blob', sha: '3' },
    { path: 'config/server.key', type: 'blob', sha: '4' },
  ],
};

// URL で振り分ける偽の GitHub。state は Claude の呼び出しの後に書き換えられる（投稿の直前の取り直しを見るため）
function fakeGitHub(state: { pr: Pr; comments: ReturnType<typeof comment>[] }) {
  const calls: string[] = [];
  const posted: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = String(input instanceof Request ? input.url : input);
    calls.push(raw);
    const url = new URL(raw);
    const p = url.pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') {
      const { state: s, merged = false, head } = state.pr;
      return json({ number: 5, title: 'PR の題', body: '説明', state: s, merged, draft: true, head: { ref: 'h', sha: head }, base: { ref: 'main', sha: OTHER }, user: null });
    }
    if (p === '/issues/5/comments' && init?.method === 'POST') {
      const body = (JSON.parse(String(init.body)) as { body: string }).body;
      posted.push(body);
      return json(comment(99, REVIEWER, body));
    }
    if (p === '/issues/5/comments') return json(state.comments);
    if (p === `/compare/main...${HEAD}`) return new Response(DIFF);
    if (p === `/git/trees/${HEAD}`) return json(TREE);
    const file = p.startsWith('/contents/') ? FILES[decodeURIComponent(p.slice('/contents/'.length))] : undefined;
    if (file !== undefined && url.searchParams.get('ref') === HEAD) return new Response(file);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh: createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetch }), calls, posted };
}

const msg = (content: ContentBlock[], stop_reason: string): Message => ({ model: MODEL, content, stop_reason, usage: { input_tokens: 1000, output_tokens: 100 } });
const answer = (v: unknown): Message => msg([{ type: 'text', text: JSON.stringify(v) }], 'end_turn');

// 1回の runReview を偽の依存で回す。afterClaude は Claude を2回呼んだ後に GitHub の state を書き換える
async function run(opts: {
  pr?: Pr;
  comments?: ReturnType<typeof comment>[];
  kv?: Record<string, string>;
  config?: ReviewConfig;
  responses?: Message[];
  afterClaude?: (state: { pr: Pr; comments: ReturnType<typeof comment>[] }) => void;
} = {}) {
  const state = { pr: opts.pr ?? { state: 'open', head: HEAD }, comments: opts.comments ?? [] };
  const { gh, calls, posted } = fakeGitHub(state);
  const kv = new Map(Object.entries(opts.kv ?? {}));
  const claudeCalls: MessagesParams[] = [];
  const responses = opts.responses ?? [answer(REVIEW_OK), answer(RISK_OK)];
  const claude: MessagesClient = {
    async create(p) {
      claudeCalls.push(structuredClone(p));
      const r = responses[claudeCalls.length - 1];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      if (claudeCalls.length === 2) opts.afterClaude?.(state);
      return r;
    },
  };
  const logs: string[] = [];
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => gh },
      claude,
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => NOW,
      log: (line) => logs.push(line),
      secrets: [API_KEY],
    },
    params(opts.config),
  );
  const record = kv.has(REVIEW_KEY) ? (JSON.parse(kv.get(REVIEW_KEY)!) as { outcome: string }) : null;
  return { result, calls, posted, kv, claudeCalls, logs, record };
}

test('outcome ごとに Claude の呼び出しの数・投稿・KV の review: の記録が決まる', async () => {
  const withConfig = (f: (c: ReviewConfig) => void) => {
    const c = baseConfig();
    f(c);
    return c;
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
    ['投稿の直前に head がずれた', { afterClaude: (s) => (s.pr = { state: 'open', head: OTHER }) }, 'superseded', 2],
    ['投稿の直前に closed', { afterClaude: (s) => (s.pr = { state: 'closed', head: HEAD }) }, 'closed', 2],
    ['投稿の直前に同じ head の自分の記録', { afterClaude: (s) => s.comments.push(shadowComment(2, REVIEWER, HEAD)) }, 'duplicate', 2],
    ['App 以外の名義の同じ head の目印', { comments: [shadowComment(1, GATE, HEAD), shadowComment(2, 'someone', HEAD)] }, 'posted', 2],
  ];
  for (const [name, opts, outcome, claudeCount] of cases) {
    const r = await run(opts);
    assert.equal(r.result.outcome, outcome, name);
    assert.equal(r.claudeCalls.length, claudeCount, `${name}: Claude の呼び出し`);
    assert.equal(r.posted.length, outcome === 'posted' ? 1 : 0, `${name}: 投稿`);
    if (name.startsWith('KV に')) assert.equal(r.kv.get(REVIEW_KEY), opts!.kv![REVIEW_KEY], `${name}: 上書きしない`);
    else assert.equal(r.record?.outcome, outcome, `${name}: KV の記録`);
    if (claudeCount === 0) assert.equal(r.kv.get(COST_KEY), opts?.kv?.[COST_KEY], `${name}: 月の累計は変えない`);
  }
});

test('JSON の取り出しと検査で落ちた出力は verdict-invalid で投稿せず、使った分を月の累計に足す', async () => {
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
    assert.equal(r.posted.length, 0, `${name}: 投稿`);
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
