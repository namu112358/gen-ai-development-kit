// review-api の文書用のモデル（review.config.json の claude.docsOnly）を確かめる（Issue #993）。
// chooseModels が、変更ファイルが全部 docsOnly.extensions に当たる diff（大文字・小文字を区別しない）でだけ文書用のモデルを選び、
// コードを含む・削除や名前の変更でコードのパスがある・diff が切り詰められた・空の diff・docsOnly の設定が無いときは今のモデルのままにすること、
// loadReviewConfig が docsOnly 無しを通し、extensions の空・'.' で始まらない項目・model の空を誤りにすること、
// runReview が文書だけの PR で Claude の2回の問いと KV の記録の models に文書用のモデルを使うことを見る
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, MessagesClient, MessagesParams } from '../../review-api/src/claude.ts';
import { loadReviewConfig, type ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { chooseModels, runReview } from '../../review-api/src/pipeline.ts';
import { RISK_QUESTIONS, type Noul, type RiskOutput, type RiskQuestionKey } from '../../review-api/src/verdict.ts';

const REVIEW = 'model-review';
const RISK = 'model-risk';
const DOCS = 'model-docs';
const HEAD = 'a'.repeat(40);

const fileDiff = (a: string, b: string, plus = `+++ b/${b}`) => [`diff --git a/${a} b/${b}`, `--- a/${a}`, plus, '@@ -1 +1 @@', '-old', '+new'].join('\n');
const claudeConfig = (docsOnly = true): ReviewConfig['claude'] => ({
  reviewModel: REVIEW, riskModel: RISK, effort: 'high', maxTokens: 1000, maxToolCalls: 10, maxDiffChars: 10000, maxFileChars: 100, diffOnlyExtensions: [],
  ...(docsOnly ? { docsOnly: { extensions: ['.md', '.html'], model: DOCS } } : {}),
});

test('chooseModels は変更ファイルが全部文書のときだけ文書用のモデルを選ぶ', () => {
  const now = { review: REVIEW, risk: RISK, docsOnly: false };
  const docs = { review: DOCS, risk: DOCS, docsOnly: true };
  const cases: [string, string, boolean, boolean, typeof now][] = [
    ['.md だけ', fileDiff('docs/a.md', 'docs/a.md'), false, true, docs],
    ['.md と .ts', [fileDiff('docs/a.md', 'docs/a.md'), fileDiff('src/a.ts', 'src/a.ts')].join('\n'), false, true, now],
    ['docsOnly 無しで .md だけ', fileDiff('docs/a.md', 'docs/a.md'), false, false, now],
    ['.ts の削除を含む', [fileDiff('docs/a.md', 'docs/a.md'), fileDiff('src/old.ts', 'src/old.ts', '+++ /dev/null')].join('\n'), false, true, now],
    ['diff が切り詰められた', fileDiff('docs/a.md', 'docs/a.md'), true, true, now],
    ['空の diff', '', false, true, now],
    ['README.MD だけ（大文字）', fileDiff('README.MD', 'README.MD'), false, true, docs],
    ['名前の変更 a.ts → a.md', fileDiff('src/a.ts', 'src/a.md'), false, true, now],
  ];
  for (const [name, diff, diffTruncated, withDocs, expected] of cases) {
    assert.deepEqual(chooseModels({ diff, diffTruncated }, claudeConfig(withDocs)), expected, name);
  }
});

test('loadReviewConfig は docsOnly 無しを通し、extensions の空・. で始まらない項目・model の空を誤りにする', () => {
  const configPath = fileURLToPath(new URL('../../review-api/review.config.json', import.meta.url));
  const raw = (docsOnly?: unknown): Record<string, any> => {
    const r = JSON.parse(readFileSync(configPath, 'utf8'));
    delete r.claude.docsOnly;
    if (docsOnly !== undefined) r.claude.docsOnly = docsOnly;
    return r;
  };
  assert.equal(loadReviewConfig(raw()).claude.docsOnly, undefined, 'docsOnly 無し');
  assert.deepEqual(loadReviewConfig(raw({ extensions: ['.md'], model: DOCS })).claude.docsOnly, { extensions: ['.md'], model: DOCS }, '有効な docsOnly');
  const invalid: [string, unknown, string][] = [
    ['extensions が空', { extensions: [], model: DOCS }, 'claude.docsOnly.extensions'],
    ['. で始まらない項目', { extensions: ['md'], model: DOCS }, 'claude.docsOnly.extensions'],
    ['model が空', { extensions: ['.md'], model: '' }, 'claude.docsOnly.model'],
  ];
  for (const [name, docsOnly, path] of invalid) {
    assert.throws(() => loadReviewConfig(raw(docsOnly)), (e: unknown) => e instanceof Error && e.message.includes(path), name);
  }
});

test('runReview は .md だけの PR で Claude の2回の問いと KV の記録の models に文書用のモデルを使う', async () => {
  const price = { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 };
  const config: ReviewConfig = {
    trigger: { actions: ['opened'], skipBotSenders: true, branchPrefix: 'claude/', requireClosesIssue: false, settleSeconds: 0 },
    claude: claudeConfig(true),
    budget: { monthlyUsd: 10, perReviewUsd: 5 },
    pricing: { [REVIEW]: price, [RISK]: price, [DOCS]: price },
  };
  const diff = fileDiff('docs/a.md', 'docs/a.md') + '\n';
  // compare・pulls・comments・contents・trees にだけ答える偽の GitHub
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const p = new URL(String(input instanceof Request ? input.url : input)).pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') return json({ number: 5, title: 't', body: 'b', state: 'open', merged: false, draft: true, head: { ref: 'h', sha: HEAD }, base: { ref: 'main', sha: 'b'.repeat(40) }, user: null });
    if (p === '/issues/5/comments' && init?.method === 'POST') return json({ id: 9, body: (JSON.parse(String(init.body)) as { body: string }).body, user: { login: 'review-api[bot]' }, author_association: 'NONE' });
    if (p === '/issues/5/comments') return json([]);
    if (p === `/compare/main...${HEAD}`) return new Response(diff);
    if (p === `/git/trees/${HEAD}`) return json({ sha: HEAD, truncated: false, tree: [{ path: 'docs/a.md', type: 'blob', sha: '1' }] });
    if (p === '/contents/docs/a.md') return new Response('new');
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const gh = createGitHubClient({ token: 't', owner: 'o', repo: 'r', fetch });

  const riskOk: RiskOutput = {
    level: 'low',
    answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Record<RiskQuestionKey, Noul>,
    rationale: 'r',
    facts: { references: '', tests: '', fileKinds: '' },
  };
  const answer = (v: unknown): Message => ({ model: DOCS, content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
  const responses = [answer({ pass: true, blocking: [], nonBlocking: [] }), answer(riskOk)];
  const claudeCalls: MessagesParams[] = [];
  const claude: MessagesClient = {
    async create(p) {
      claudeCalls.push(p);
      const r = responses[claudeCalls.length - 1];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      return r;
    },
  };
  const kv = new Map<string, string>();
  const result = await runReview(
    {
      github: { reader: async () => gh, writer: async () => gh },
      claude,
      kv: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => void kv.set(k, v) },
      now: () => Date.UTC(2026, 9, 13),
      log: () => {},
    },
    { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, gateAppLogin: 'agent-harness[bot]', reviewAppLogin: 'review-api[bot]', config },
  );

  assert.equal(result.outcome, 'posted');
  assert.deepEqual(claudeCalls.map((c) => c.model), [DOCS, DOCS]);
  const record = JSON.parse(kv.get(`review:o/r:5:${HEAD}`)!) as { outcome: string; models: unknown };
  assert.equal(record.outcome, 'posted');
  assert.deepEqual(record.models, { review: DOCS, risk: DOCS });
});
