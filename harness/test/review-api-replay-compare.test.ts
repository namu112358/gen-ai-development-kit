// review-api の流し直しの比べ（review-api/src/replay-compare.ts）が、外部 API を呼ばずに、
// コラボレーター以外・フェンスが2つ・JSON が壊れた・ブロッキングの無い agent-verdict を対象に数えないこと、
// 注入した fs に PR ごとの JSON と summary.md を書き、既にあるファイルを上書きしないこと、
// 上限を超えた後の PR を「未実行」、対象外の PR を理由つきで表に載せ、合計の行を出すこと、ログと書いたファイルに鍵が出ないこと、
// --list（listReplayTargets）が Claude を呼ばず書かずに対象と見込みを出すこと、replay-compare.ts が @anthropic-ai/sdk・cloudflare:workers・node:・harness/lib を
// import しないことを確かめる（Issue #1041）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Message, MessagesClient } from '../../review-api/src/claude.ts';
import { collectMaterial } from '../../review-api/src/collect.ts';
import type { IssueComment } from '../../review-api/src/github.ts';
import { buildAskRequests, estimateLoopUsd, type GitHubReader } from '../../review-api/src/pipeline.ts';
import {
  listReplayTargets, runReplayCompare, selectBlockingVerdicts, type ReplayCompareDeps, type ReplayFs,
} from '../../review-api/src/replay-compare.ts';
import { answer, API_KEY, baseConfig, CALL_USD, fakeGitHub, GATE, HEAD, OTHER, RISK_OK, TOKEN } from './support/review-api-pipeline.ts';

// summary.md の中で検査する文字列（実装の renderSummary の表記と合わせる）
const NOT_RUN = '未実行';
const NO_BLOCKING_REASON = 'ブロッキング指摘のある agent-verdict が無い';
const TOTAL = '合計';

const OUT = 'out/';
const LOCAL_FINDING = { kind: 'bug', file: 'src/a.ts', detail: 'ローカルの指摘' };
const API_REVIEW = { pass: false, blocking: [{ kind: 'bug', file: 'src/a.ts', detail: 'API の指摘' }], nonBlocking: [] as string[] };

// agent-verdict のフェンスを持つコメント（support の comment は NONE 固定なので、author_association を引数で変える）
const verdictBody = (v: unknown) => ['<!-- agent-harness:claude -->', '## 判定', '', '```agent-verdict', JSON.stringify(v, null, 2), '```', ''].join('\n');
const verdict = (pr: number, blocking: unknown[] = [LOCAL_FINDING]) => ({
  version: 1, pr, headSha: HEAD,
  review: { pass: blocking.length === 0, blocking, nonBlocking: [] },
  risk: { level: RISK_OK.level, answers: RISK_OK.answers, rationale: 'r' },
});
const vc = (id: number, body: string, association = 'COLLABORATOR'): IssueComment => ({ id, body, user: { login: 'someone' }, author_association: association });

// PR 5 にしか答えない fakeGitHub を包み、getPr(n) は number を n に、listComments(n) は PR ごとの表にする（diff・ツリー・ファイルは HEAD の同じもの）
function github(commentsByPr: Record<number, IssueComment[] | Error>) {
  const { gh } = fakeGitHub({ pr: { state: 'closed', merged: true, head: OTHER }, comments: [] });
  const reader: GitHubReader = {
    ...gh,
    getPr: async (n) => ({ ...(await gh.getPr(5)), number: n }),
    listComments: async (n) => {
      const c = commentsByPr[n] ?? [];
      if (c instanceof Error) throw c;
      return c;
    },
  };
  return reader;
}

// Map の偽の fs（writeNew は既にあれば投げる）
function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const fs: ReplayFs = {
    exists: async (p) => files.has(p),
    mkdir: async () => {},
    writeNew: async (p, text) => {
      if (files.has(p)) throw new Error(`既にある: ${p}`);
      files.set(p, text);
      writes.push(p);
    },
  };
  return { fs, files, writes };
}

function fakeClaude(responses: (Message | Error)[]) {
  let calls = 0;
  const claude: MessagesClient = {
    async create() {
      const r = responses[calls++];
      if (r === undefined) throw new Error('偽の Claude の応答が足りない');
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { claude, count: () => calls };
}

async function compare(opts: { commentsByPr: Record<number, IssueComment[] | Error>; prs: number[]; maxUsd: number; files?: Record<string, string>; responses?: (Message | Error)[] }) {
  const reader = github(opts.commentsByPr);
  const mem = memoryFs(opts.files);
  const c = fakeClaude(opts.responses ?? []);
  const logs: string[] = [];
  const deps: ReplayCompareDeps = { github: { reader: async () => reader }, claude: c.claude, now: () => 0, log: (l) => logs.push(l), secrets: [API_KEY, TOKEN], fs: mem.fs };
  const result = await runReplayCompare(deps, { owner: 'o', repo: 'r', prs: opts.prs, maxUsd: opts.maxUsd, outDir: OUT, gateAppLogin: GATE, config: baseConfig() });
  return { result, ...mem, claudeCalls: c.count(), logs };
}

// 1件の見込み（Reviewer と Risk）を同じ材料から出す（数を直書きしない）
async function estimate(): Promise<number> {
  const config = baseConfig();
  const { gh } = fakeGitHub({ pr: { state: 'closed', merged: true, head: OTHER }, comments: [] });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: GATE, previous: false });
  const asks = buildAskRequests(material, config);
  const limits = { maxToolCalls: config.claude.maxToolCalls, maxFileChars: config.claude.maxFileChars };
  return estimateLoopUsd(asks.review, limits, config.pricing)! + estimateLoopUsd(asks.risk, limits, config.pricing)!;
}

test('コラボレーター以外・フェンスが2つ・JSON が壊れた・ブロッキングの無い agent-verdict は数えず、残りを id の古い順に返す', () => {
  const fence = '```agent-verdict\n' + JSON.stringify(verdict(5)) + '\n```';
  const ignored: [string, IssueComment][] = [
    ['コラボレーター以外', vc(10, verdictBody(verdict(5)), 'NONE')],
    ['フェンスが2つ', vc(11, `${fence}\n\n${fence}\n`)],
    ['JSON が壊れた', vc(12, '```agent-verdict\n{"version": 1, "pr": 5,\n```\n')],
    ['ブロッキングの無い判定', vc(13, verdictBody(verdict(5, [])))],
  ];
  for (const [name, c] of ignored) assert.deepEqual(selectBlockingVerdicts([c], 5), [], name);

  const picked = selectBlockingVerdicts([vc(6, verdictBody(verdict(5)), 'COLLABORATOR'), ...ignored.map(([, c]) => c), vc(3, verdictBody(verdict(5)), 'OWNER')], 5);
  assert.deepEqual(picked.map((v) => v.commentId), [3, 6]);
  assert.equal(picked[0]!.headSha, HEAD);
  assert.equal(picked[0]!.pass, false);
  assert.deepEqual(picked[0]!.blocking, [LOCAL_FINDING]);
  assert.equal(picked[0]!.riskLevel, 'low');
});

test('上限で止めた後の PR は未実行、対象外は理由つきで、PR ごとの JSON と summary.md に合計の行が書かれる', async () => {
  const maxUsd = (await estimate()) + CALL_USD;
  const r = await compare({
    commentsByPr: { 5: [vc(1, verdictBody(verdict(5)))], 6: [vc(2, verdictBody(verdict(6)))], 7: [vc(3, verdictBody(verdict(7, [])))] },
    prs: [5, 6, 7],
    maxUsd,
    responses: [answer(API_REVIEW), answer(RISK_OK)],
  });
  assert.equal(r.claudeCalls, 2, 'PR 5 だけ問う');
  assert.equal(r.result.outcome, 'done');
  if (r.result.outcome !== 'done') return;
  const [row5, row6, row7] = r.result.rows;
  assert.ok(row5?.status === 'compared', JSON.stringify(row5));
  assert.equal(row5.passMatch, true);
  assert.equal(row5.riskAgree, 8);
  assert.deepEqual(row5.local.blocking.map((f) => f.candidate), [true]);
  assert.deepEqual(row5.api.blocking.map((f) => f.candidate), [true]);
  assert.deepEqual(row6, { pr: 6, status: 'not-run', headSha: HEAD, reason: 'budget' });
  assert.deepEqual(row7, { pr: 7, status: 'excluded', reason: NO_BLOCKING_REASON });

  assert.deepEqual([...r.files.keys()].sort(), ['out/pr-5.json', 'out/summary.md']);
  const json = JSON.parse(r.files.get('out/pr-5.json')!) as { version: number; pr: number };
  assert.equal(json.version, 1);
  assert.equal(json.pr, 5);
  const summary = r.files.get('out/summary.md')!;
  for (const s of [NOT_RUN, NO_BLOCKING_REASON, TOTAL]) assert.ok(summary.includes(s), `summary.md に ${s} が無い:\n${summary}`);
});

test('既にあるファイルは上書きしない（summary.md があれば何もしない、pr-<番号>.json があればその PR は未実行）', async () => {
  const commentsByPr = { 5: [vc(1, verdictBody(verdict(5)))] };
  const before = await compare({ commentsByPr, prs: [5], maxUsd: 100, files: { 'out/summary.md': '元の summary' } });
  assert.deepEqual(before.result, { outcome: 'exists', path: 'out/summary.md' });
  assert.equal(before.claudeCalls, 0);
  assert.deepEqual(before.writes, []);
  assert.equal(before.files.get('out/summary.md'), '元の summary');

  const pr = await compare({ commentsByPr, prs: [5], maxUsd: 100, files: { 'out/pr-5.json': '元の JSON' } });
  assert.equal(pr.claudeCalls, 0);
  assert.equal(pr.result.outcome, 'done');
  if (pr.result.outcome === 'done') assert.deepEqual(pr.result.rows, [{ pr: 5, status: 'not-run', headSha: HEAD, reason: 'exists' }]);
  assert.equal(pr.files.get('out/pr-5.json'), '元の JSON');
  assert.deepEqual(pr.writes, ['out/summary.md']);
});

test('ローカルの判定と Claude のエラーが鍵を含んでも、ログと書いたファイルに鍵が出ない', async () => {
  const local = verdict(5, [{ ...LOCAL_FINDING, detail: `token ${TOKEN}` }]);
  const r = await compare({ commentsByPr: { 5: [vc(1, verdictBody(local))] }, prs: [5], maxUsd: 100, responses: [new Error(`boom ${API_KEY} ${TOKEN}`)] });
  assert.equal(r.result.outcome, 'done');
  assert.ok(r.files.has('out/pr-5.json') && r.files.has('out/summary.md'), [...r.files.keys()].join(','));
  assert.ok(r.logs.length > 0, 'ログが出る');
  const text = [...r.logs, ...r.files.values()].join('\n');
  for (const secret of [API_KEY, TOKEN]) assert.ok(!text.includes(secret), `${secret} が出た: ${text}`);
});

test('listReplayTargets は Claude を呼ばず書かずに、対象の見込みと合計、対象外の理由を出す', async () => {
  const expected = await estimate();
  const reader = github({ 5: [vc(1, verdictBody(verdict(5)))], 7: [vc(2, verdictBody(verdict(7, [])))] });
  const mem = memoryFs();
  const c = fakeClaude([]);
  // 呼ばれないことを見るため、Claude と fs も持たせて渡す
  const deps: ReplayCompareDeps = { github: { reader: async () => reader }, claude: c.claude, now: () => 0, log: () => {}, secrets: [API_KEY, TOKEN], fs: mem.fs };
  const r = await listReplayTargets(deps, { owner: 'o', repo: 'r', prs: [5, 7], gateAppLogin: GATE, config: baseConfig() });
  assert.equal(c.count(), 0);
  assert.deepEqual(mem.writes, []);
  const [row5, row7] = r.rows;
  assert.ok(row5 && 'estimatedUsd' in row5, JSON.stringify(row5));
  assert.equal(row5.pr, 5);
  assert.equal(row5.headSha, HEAD);
  assert.ok(Math.abs(row5.estimatedUsd! - expected) < 1e-9, `estimatedUsd ${row5.estimatedUsd}`);
  assert.ok(row7 && 'reason' in row7, JSON.stringify(row7));
  assert.equal(row7.pr, 7);
  assert.equal(row7.reason, NO_BLOCKING_REASON);
  assert.ok(Math.abs(r.totalUsd! - expected) < 1e-9, `totalUsd ${r.totalUsd}`);
});

test('replay-compare.ts は cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しない', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/replay-compare.ts', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^cloudflare:workers$|^@anthropic-ai\/sdk|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
