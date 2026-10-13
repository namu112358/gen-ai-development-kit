// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）が、fetch-pr の前に trigger.settleSeconds 秒だけ deps.sleep で待ち、
// 待っている間に head が変わったら Claude を呼ばず・投稿せずに superseded を KV の review: に今と同じ鍵（version・outcome・pr・headSha・at）で記録すること、
// head が変わらなければ待った後に今と同じく review・risk を呼んで投稿すること、0 なら待たないこと、
// 設定（review.config.json・loadReviewConfig）の trigger.settleSeconds が 120 で、欠け・負の数・小数・文字列を鍵のパスつきの誤りにすることを確かめる（Issue #991）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, MessagesClient } from '../../review-api/src/claude.ts';
import { loadReviewConfig, type ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { runReview } from '../../review-api/src/pipeline.ts';
import { RISK_QUESTIONS, type Noul, type RiskOutput, type RiskQuestionKey } from '../../review-api/src/verdict.ts';

const GATE = 'agent-harness[bot]';
const REVIEWER = 'review-api[bot]';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MODEL = 'claude-opus-5-5';
const NOW = Date.UTC(2026, 9, 13);
const REVIEW_KEY = `review:o/r:5:${HEAD}`;

const configWith = (settleSeconds: number): ReviewConfig => ({
  trigger: { actions: ['opened'], skipBotSenders: true, branchPrefix: 'claude/', requireClosesIssue: false, settleSeconds },
  claude: { reviewModel: MODEL, riskModel: MODEL, effort: 'high', maxTokens: 1000, maxToolCalls: 10, maxDiffChars: 10000, maxFileChars: 100, diffOnlyExtensions: [] },
  budget: { monthlyUsd: 10, perReviewUsd: 5 },
  pricing: { [MODEL]: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
});

const RISK_OK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Record<RiskQuestionKey, Noul>,
  rationale: 'r',
  facts: { references: '', tests: '', fileKinds: '' },
};
const REVIEW_OK = { pass: true, blocking: [], nonBlocking: [] as string[] };
const answer = (v: unknown): Message => ({
  model: MODEL,
  content: [{ type: 'text', text: JSON.stringify(v) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1000, output_tokens: 100 },
});

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
const TREE = { sha: HEAD, truncated: false, tree: [{ path: 'src/a.ts', type: 'blob', sha: '2' }] };

// 1回の runReview を偽の GitHub・Claude・KV・sleep で回す。sleep・PR の読み取り・Claude の呼び出しは呼ばれた順に events へ積む。
// duringSleep は sleep の中で PR の head を書き換える（待っている間の push）
async function run(opts: { settleSeconds: number; duringSleep?: (pr: { head: string }) => void; withSleep?: boolean }) {
  const pr = { head: HEAD };
  const events: string[] = [];
  const posted: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const p = url.pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') {
      events.push(`getPr:${pr.head}`);
      return json({ number: 5, title: 'PR の題', body: '説明', state: 'open', merged: false, draft: true, head: { ref: 'h', sha: pr.head }, base: { ref: 'main', sha: OTHER }, user: null });
    }
    if (p === '/issues/5/comments' && init?.method === 'POST') {
      const body = (JSON.parse(String(init.body)) as { body: string }).body;
      posted.push(body);
      return json({ id: 99, body, user: { login: REVIEWER }, author_association: 'NONE' });
    }
    if (p === '/issues/5/comments') return json([]);
    if (p === `/compare/main...${HEAD}`) return new Response(DIFF);
    if (p === `/git/trees/${HEAD}`) return json(TREE);
    if (p === '/contents/src/a.ts' && url.searchParams.get('ref') === HEAD) return new Response('new');
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const gh = createGitHubClient({ token: 'ghs_FAKE991', owner: 'o', repo: 'r', fetch });

  const responses = [answer(REVIEW_OK), answer(RISK_OK)];
  let claudeCount = 0;
  const claude: MessagesClient = {
    async create() {
      events.push('claude');
      const r = responses[claudeCount++];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      return r;
    },
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    events.push(`sleep:${ms}`);
    opts.duringSleep?.(pr);
  };
  const kv = new Map<string, string>();
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => gh },
      claude,
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => NOW,
      log: () => {},
      ...(opts.withSleep === false ? {} : { sleep }),
    },
    { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, gateAppLogin: GATE, reviewAppLogin: REVIEWER, config: configWith(opts.settleSeconds) },
  );
  const raw = kv.get(REVIEW_KEY);
  const record = raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
  return { result, events, sleeps, posted, claudeCount, record };
}

test('待っている間に head が変わると、Claude を呼ばず投稿せずに superseded を今と同じ鍵だけで KV に記録する', async () => {
  const r = await run({ settleSeconds: 30, duringSleep: (pr) => (pr.head = OTHER) });
  assert.equal(r.result.outcome, 'superseded');
  assert.equal(r.result.usd, null);
  assert.deepEqual(r.sleeps, [30000], 'sleep は settleSeconds*1000 で1回');
  assert.equal(r.claudeCount, 0, 'Claude を呼ばない');
  assert.equal(r.posted.length, 0, '投稿しない');
  assert.deepEqual(r.events, ['sleep:30000', `getPr:${OTHER}`], '待ってから PR を取り直す');
  assert.ok(r.record !== null, 'KV の review: の記録がある');
  assert.deepEqual(Object.keys(r.record).sort(), ['at', 'headSha', 'outcome', 'pr', 'version']);
  assert.deepEqual(r.record, { version: 1, outcome: 'superseded', pr: 5, headSha: HEAD, at: new Date(NOW).toISOString() });
});

test('head が変わらなければ、待った後に今と同じく review・risk を呼んで投稿する', async () => {
  const r = await run({ settleSeconds: 30 });
  assert.equal(r.result.outcome, 'posted');
  assert.deepEqual(r.sleeps, [30000]);
  assert.equal(r.claudeCount, 2, 'review と risk');
  assert.equal(r.posted.length, 1);
  assert.equal(r.record?.outcome, 'posted');
  // sleep が最初で、PR の読み取りと Claude の2回はその後
  assert.equal(r.events[0], 'sleep:30000', r.events.join(','));
  assert.equal(r.events.filter((e) => e.startsWith('sleep:')).length, 1, r.events.join(','));
  assert.equal(r.events.indexOf(`getPr:${HEAD}`), 1, r.events.join(','));
  assert.deepEqual(r.events.filter((e) => e === 'claude'), ['claude', 'claude']);
});

test('settleSeconds が 0 なら sleep を呼ばず、deps.sleep が無ければ待たずに今どおり進む', async () => {
  const cases: [string, Parameters<typeof run>[0]][] = [
    ['settleSeconds 0', { settleSeconds: 0 }],
    ['deps.sleep が無い', { settleSeconds: 30, withSleep: false }],
  ];
  for (const [name, opts] of cases) {
    const r = await run(opts);
    assert.deepEqual(r.sleeps, [], `${name}: sleep`);
    assert.equal(r.result.outcome, 'posted', name);
    assert.equal(r.claudeCount, 2, `${name}: Claude`);
  }
});

const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
const readRaw = (): Record<string, any> => JSON.parse(readFileSync(configPath, 'utf8'));

// message に鍵のパスがすべて入る Error かを見る検証関数（文言全体は固定しない）
const errorWith = (...paths: string[]) => (error: unknown) => {
  assert.ok(error instanceof Error, 'Error を投げる');
  for (const p of paths) assert.ok(error.message.includes(p), `message に ${p} がない: ${error.message}`);
  return true;
};

test('review.config.json の trigger.settleSeconds は 120 で読め、0 も通る', () => {
  assert.equal(loadReviewConfig(readRaw()).trigger.settleSeconds, 120);
  const raw = readRaw();
  raw.trigger.settleSeconds = 0;
  assert.equal(loadReviewConfig(raw).trigger.settleSeconds, 0);
});

test('trigger.settleSeconds の欠け・負の数・小数・文字列は trigger.settleSeconds を含む誤りになる', () => {
  const cases: [string, (t: Record<string, any>) => void][] = [
    ['欠け', (t) => { delete t.settleSeconds; }],
    ['負の数', (t) => { t.settleSeconds = -1; }],
    ['小数', (t) => { t.settleSeconds = 1.5; }],
    ['文字列', (t) => { t.settleSeconds = '120'; }],
  ];
  for (const [name, mutate] of cases) {
    const raw = readRaw();
    mutate(raw.trigger);
    assert.throws(() => loadReviewConfig(raw), errorWith('trigger.settleSeconds'), name);
  }
});
