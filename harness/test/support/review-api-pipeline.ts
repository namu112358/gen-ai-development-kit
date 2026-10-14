// review-api のレビューの段階（review-api/src/pipeline.ts の runReview）を外部 API を呼ばずに回す補助。偽の GitHub・偽の Claude（応答の列。Error の要素は投げる）・偽の KV と run、
// 設定・記録・応答の見本と定数を持つ（review-api-pipeline.test.ts と review-api-risk-compare.test.ts・review-api-rules-material.test.ts・review-api-dry-run-record.test.ts が共有する。#995）
// 偽の GitHub には ref（commit の SHA）ごとの規則のファイル（CLAUDE.md など）を渡せる。渡さない ref・パスは 404（#1052）
import type { ContentBlock, Message, MessagesClient, MessagesParams } from '../../../review-api/src/claude.ts';
import type { ReviewConfig } from '../../../review-api/src/config.ts';
import { createGitHubClient } from '../../../review-api/src/github.ts';
import { runReview, type ReviewParams } from '../../../review-api/src/pipeline.ts';
import { renderShadowComment, type ShadowRecord } from '../../../review-api/src/record.ts';
import { composeShadowVerdict, RISK_QUESTIONS, type Noul, type RiskOutput, type RiskQuestionKey } from '../../../review-api/src/verdict.ts';

export const GATE = 'agent-harness[bot]';
export const REVIEWER = 'review-api[bot]';
export const HEAD = 'a'.repeat(40);
export const OTHER = 'b'.repeat(40);
export const MODEL = 'claude-opus-5-5';
export const TOKEN = 'ghs_FAKETOKEN911abcdef';
export const API_KEY = 'sk-ant-api03-FAKEKEY911';
export const NOW = Date.UTC(2026, 9, 13);
export const REVIEW_KEY = `review:o/r:5:${HEAD}`;
export const COST_KEY = 'cost:2026-10';
// 1回の問いの usage（入力 1000・出力 100）の料金は 0.005 + 0.0025
export const CALL_USD = 0.0075;

export const baseConfig = (): ReviewConfig => ({
  trigger: { actions: ['opened'], skipBotSenders: true, branchPrefix: 'claude/', requireClosesIssue: false, settleSeconds: 0 },
  claude: { reviewModel: MODEL, riskModel: MODEL, effort: 'high', maxTokens: 1000, maxToolCalls: 10, maxDiffChars: 10000, maxFileChars: 100, diffOnlyExtensions: [] },
  budget: { monthlyUsd: 10, perReviewUsd: 5 },
  pricing: { [MODEL]: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 } },
});
export const params = (config = baseConfig()): ReviewParams => ({ owner: 'o', repo: 'r', pr: 5, headSha: HEAD, gateAppLogin: GATE, reviewAppLogin: REVIEWER, config });

export const comment = (id: number, login: string, body: string) => ({ id, body, user: { login }, author_association: 'NONE' });
export const RISK_OK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Record<RiskQuestionKey, Noul>,
  rationale: 'r',
  facts: { references: '', tests: '', fileKinds: '' },
};
export const REVIEW_OK = { pass: true, blocking: [], nonBlocking: [] as string[] };
export const shadowComment = (id: number, login: string, headSha: string) => {
  const record: ShadowRecord = {
    version: 1, pr: 5, headSha,
    verdict: composeShadowVerdict({ pr: 5, headSha, reviewer: REVIEW_OK, risk: RISK_OK, model: MODEL }),
    models: { review: MODEL, risk: MODEL }, usage: {}, usd: null, durationSec: 1,
  };
  return comment(id, login, renderShadowComment(record));
};

export type Pr = { state: string; merged?: boolean; head: string };
export const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
export const FILES: Record<string, string> = { 'src/a.ts': 'new', '.env': 'SECRET=1', 'config/server.key': 'KEY' };
export const TREE = {
  sha: HEAD,
  truncated: false,
  tree: [
    { path: 'src', type: 'tree', sha: '1' },
    { path: 'src/a.ts', type: 'blob', sha: '2' },
    { path: '.env', type: 'blob', sha: '3' },
    { path: 'config/server.key', type: 'blob', sha: '4' },
  ],
};

/** ref（commit の SHA）→ パス → 中身。PR の base の SHA は OTHER */
export type FilesByRef = Record<string, Record<string, string>>;

// URL で振り分ける偽の GitHub。state は Claude の呼び出しの後に書き換えられる（投稿の直前の取り直しを見るため）。filesByRef は ref ごとのファイル（無ければ 404）
export function fakeGitHub(state: { pr: Pr; comments: ReturnType<typeof comment>[] }, filesByRef: FilesByRef = {}) {
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
    const path = p.startsWith('/contents/') ? decodeURIComponent(p.slice('/contents/'.length)) : undefined;
    const ref = url.searchParams.get('ref') ?? '';
    const byRef = path === undefined ? undefined : filesByRef[ref]?.[path];
    if (byRef !== undefined) return new Response(byRef);
    const file = path === undefined ? undefined : FILES[path];
    if (file !== undefined && ref === HEAD) return new Response(file);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { gh: createGitHubClient({ token: TOKEN, owner: 'o', repo: 'r', fetch }), calls, posted };
}

// usage はモデル名の鍵に足されるので、問いのモデルと同じ名前を model に渡す
export const msg = (content: ContentBlock[], stop_reason: string, model = MODEL): Message => ({ model, content, stop_reason, usage: { input_tokens: 1000, output_tokens: 100 } });
export const answer = (v: unknown, model = MODEL): Message => msg([{ type: 'text', text: JSON.stringify(v) }], 'end_turn', model);

// 1回の runReview を偽の依存で回す。responses の Error の要素は、その回の問いで投げる。afterClaude は Claude を2回呼んだ後に GitHub の state を書き換える。
// filesByRef は偽の GitHub に ref ごとに置くファイル（規則のファイルなど）。dryRun は渡したときだけ runReview の deps に入れる（#1068）
export async function run(opts: {
  pr?: Pr;
  comments?: ReturnType<typeof comment>[];
  kv?: Record<string, string>;
  config?: ReviewConfig;
  responses?: (Message | Error)[];
  afterClaude?: (state: { pr: Pr; comments: ReturnType<typeof comment>[] }) => void;
  filesByRef?: FilesByRef;
  dryRun?: boolean;
} = {}) {
  const state = { pr: opts.pr ?? { state: 'open', head: HEAD }, comments: opts.comments ?? [] };
  const { gh, calls, posted } = fakeGitHub(state, opts.filesByRef);
  const kv = new Map(Object.entries(opts.kv ?? {}));
  const claudeCalls: MessagesParams[] = [];
  const responses = opts.responses ?? [answer(REVIEW_OK), answer(RISK_OK)];
  const claude: MessagesClient = {
    async create(p) {
      claudeCalls.push(structuredClone(p));
      const r = responses[claudeCalls.length - 1];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      if (claudeCalls.length === 2) opts.afterClaude?.(state);
      if (r instanceof Error) throw r;
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
      ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
    },
    params(opts.config),
  );
  const record = kv.has(REVIEW_KEY) ? (JSON.parse(kv.get(REVIEW_KEY)!) as { outcome: string }) : null;
  return { result, calls, posted, kv, claudeCalls, logs, record };
}
