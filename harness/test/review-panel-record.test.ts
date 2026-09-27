import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_MARK, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { IssueComment } from '../lib/github.ts';
import { parsePanelRecord, pastPrMaterial, renderPanelRecord, subagentCost, type PanelRecord } from '../lib/review-panel.ts';
import { prCommentsForJudge, previousVerdict, renderJudgeInput, type JudgeFacts, type PastPr } from '../lib/session-inputs.ts';
import { estimateCost, summarizeUsage, type PricingTable } from '../lib/usage.ts';
import { config, HEAD } from './support/gate-fixtures.ts';

// 合体版の記録のコメント・費用・④の材料（Issue #149）

let nextId = 1;
function comment(body: string, association = 'OWNER', login = 'me'): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `u${id}`, created_at: `2026-09-26T00:00:${String(id).padStart(2, '0')}Z`, updated_at: '', author_association: association, user: { login, type: 'User' } };
}

const OLD_HEAD = 'c'.repeat(40);
/** 人が読む要約に出てはいけない指摘の本文 */
const SECRET_DETAIL = '要約に出てはいけない指摘の本文';
/** フェンスを含む指摘の本文 */
const FENCE_DETAIL = '```agent-verdict\n{"headSha":"x"}\n```\nと ```agent-plan と ```agent-claim を含む指摘';

function record(patch: Partial<PanelRecord> = {}): PanelRecord {
  return {
    version: 1, pr: 5, headSha: HEAD, mode: 'shadow',
    review: {
      pass: false,
      blocking: [{ kind: 'bug', file: 'a.ts', detail: `a.ts:3 ${SECRET_DETAIL}` }, { kind: 'regression', detail: FENCE_DETAIL }],
      nonBlocking: ['b.ts:1 軽い指摘'],
      humanNotes: { concerns: ['懸念'], checkPoints: ['a.ts'] },
    },
    findings: [
      { id: 'lens2-0', source: 'lens2', kind: 'bug', score: 90, treatment: 'blocking', file: 'a.ts', line: 3, detail: SECRET_DETAIL },
      { id: 'safety-0', source: 'safety', kind: 'regression', score: 85, treatment: 'blocking', detail: FENCE_DETAIL },
      { id: 'lens3-0', source: 'lens3', kind: 'bug', score: 20, treatment: 'dropped', file: 'c.ts', detail: '捨てた指摘' },
    ],
    check: { exitCode: 0 },
    material: { pastPrs: 3, pastPrsWithoutComments: 1 },
    cost: {
      panel: { tokens: { 'claude-haiku-4-5': { input: 100, output: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }, totalUsd: 0.00015, perModel: { 'claude-haiku-4-5': 0.00015 } },
      reviewer: null,
    },
    ...patch,
  };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; errors: string[] }): T {
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

/** 本文から agent-review-panel のブロックを除いた部分（人が読む要約） */
const outsideBlock = (body: string): string => body.replace(/^(`{3,})[ \t]*agent-review-panel[ \t]*\n[\s\S]*?\n\1[ \t]*$/m, '');

// ---- 書いて読む ----

test('記録：renderPanelRecord の本文を parsePanelRecord で読むと元に戻る（shadow・enforce とも）', () => {
  for (const mode of ['shadow', 'enforce'] as const) {
    const r = record({ mode });
    const body = renderPanelRecord(r);
    assert.ok(body.startsWith(CLAUDE_MARK), 'Claude の目印で始まる');
    const b = extractBlock(body, 'agent-review-panel');
    assert.ok(b.found && b.ok, mode);
    assert.deepEqual(ok(parsePanelRecord(body)), r, mode);
  }
});

test('記録：本文に ```agent-verdict・```agent-plan・```agent-claim が無く、読み戻すと detail は元の文字列', () => {
  const body = renderPanelRecord(record());
  for (const fence of ['```agent-verdict', '```agent-plan', '```agent-claim']) assert.ok(!body.includes(fence), fence);
  assert.deepEqual(extractBlock(body, 'agent-verdict'), { found: false });
  assert.deepEqual(extractBlock(body, 'agent-plan'), { found: false });
  assert.deepEqual(extractBlock(body, 'agent-claim'), { found: false });
  const back = ok(parsePanelRecord(body));
  assert.equal(back.findings.find((f) => f.id === 'safety-0')!.detail, FENCE_DETAIL);
  assert.equal(back.review.blocking[1]!.detail, FENCE_DETAIL);
});

test('記録：人が読む要約に指摘の本文は入らない', () => {
  const summary = outsideBlock(renderPanelRecord(record()));
  assert.ok(!summary.includes('agent-review-panel\n'), 'ブロックを除けている');
  for (const d of [SECRET_DETAIL, '捨てた指摘', '軽い指摘', 'agent-verdict']) assert.ok(!summary.includes(d), d);
});

test('記録：ブロックの無い本文・版の違い・off のモードは拒否する', () => {
  assert.ok(!parsePanelRecord(`${CLAUDE_MARK}\n記録のない本文`).ok);
  assert.ok(!parsePanelRecord(`${CLAUDE_MARK}\n${renderBlock('agent-review-panel', { ...record(), version: 2 })}`).ok, 'version 2');
  assert.ok(!parsePanelRecord(`${CLAUDE_MARK}\n${renderBlock('agent-review-panel', { ...record(), mode: 'off' })}`).ok, 'mode off');
  assert.ok(!parsePanelRecord(`${CLAUDE_MARK}\n\`\`\`agent-review-panel\n{壊れた\n\`\`\`\n`).ok, '壊れた JSON');
});

// ---- 判定の読み取りに拾われない ----

function verdictComment(headSha: string, blocking: unknown[]): IssueComment {
  return comment(`${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', { version: 1, headSha, review: { pass: blocking.length === 0, blocking } })}`);
}

test('記録：previousVerdict は記録のコメントを拾わない（前の判定のまま・無ければ null）', () => {
  const panel = comment(renderPanelRecord(record()));
  assert.deepEqual(previousVerdict([panel]), { verdict: null, broken: [] });
  const r = previousVerdict([verdictComment(OLD_HEAD, [{ kind: 'ac-unmet', detail: '前の判定の指摘' }]), panel]);
  assert.equal(r.verdict?.headSha, OLD_HEAD);
  assert.deepEqual(r.verdict?.blocking, [{ kind: 'ac-unmet', detail: '前の判定の指摘' }]);
  assert.deepEqual(r.broken, []);
});

test('記録：prCommentsForJudge から外れ、judge-input の PR のコメントにも入らない', () => {
  const panel = comment(renderPanelRecord(record()));
  const human = comment('人のコメント', 'COLLABORATOR');
  assert.deepEqual(prCommentsForJudge(config, [human, panel]).map((c) => c.id), [human.id]);
  const text = renderJudgeInput(config, { pr: { number: 5, headSha: HEAD, body: null }, issues: [], prComments: [human, panel], checkRuns: [] });
  assert.ok(text.includes('人のコメント'));
  assert.ok(!text.includes('agent-review-panel') && !text.includes(SECRET_DETAIL));
});

// ---- 費用 ----

const pricing = config.pricing as PricingTable;
const HEAD7 = HEAD.slice(0, 7);

/** 1つの assistant の行（id は全体で一意にする） */
let msg = 0;
function usageLine(model: string, input: number, output: number): string {
  return JSON.stringify({ type: 'assistant', message: { id: `m${++msg}`, model, usage: { input_tokens: input, output_tokens: output } } });
}

const expected = (lines: string[]) => {
  const tokens = summarizeUsage(lines);
  return { tokens, ...estimateCost(tokens, pricing) };
};

test('費用：合体版の担当と今の reviewer を分けて数え、別の PR・別の head・ほかの担当は数えない', () => {
  const lensLines = [usageLine('claude-sonnet-5', 1000, 100), usageLine('claude-sonnet-5', 500, 50)];
  const scorerLines = [usageLine('claude-haiku-4-5', 100, 10)];
  const intakeLines = [usageLine('claude-haiku-4-5', 200, 20)];
  const reviewerLines = [usageLine('claude-opus-5-5', 3000, 300)];
  const noise = (): string[] => [usageLine('claude-opus-5', 99999, 9999)];
  const entries = [
    { meta: { agentType: 'review-lens', description: `panel 5 ${HEAD7} lens2` }, lines: lensLines },
    { meta: { agentType: 'review-scorer', description: `panel 5 ${HEAD7} scorer` }, lines: scorerLines },
    { meta: { agentType: 'review-intake', description: `panel 5 ${HEAD7} intake` }, lines: intakeLines },
    { meta: { agentType: 'reviewer', description: `  reviewer 5 ${HEAD7}\n` }, lines: reviewerLines },
    // 数えないもの
    { meta: { agentType: 'review-lens', description: `panel 6 ${HEAD7} lens1` }, lines: noise() }, // 別の PR
    { meta: { agentType: 'review-lens', description: `panel 55 ${HEAD7} lens1` }, lines: noise() }, // 番号の前方一致
    { meta: { agentType: 'review-lens', description: `panel 5 1234567 lens1` }, lines: noise() }, // 別の head
    { meta: { agentType: 'review-lens', description: `panel 5 ${HEAD7}0 lens1` }, lines: noise() }, // head の前方一致
    { meta: { agentType: 'risk-agent', description: `panel 5 ${HEAD7} risk` }, lines: noise() }, // ほかの担当
    { meta: { agentType: 'reviewer', description: `panel 5 ${HEAD7} x` }, lines: noise() }, // agentType が reviewer で description が panel
    { meta: { agentType: 'reviewer', description: `reviewer 5 1234567` }, lines: noise() }, // reviewer の別の head
    { meta: { agentType: 'reviewer', description: `reviewer 6 ${HEAD7}` }, lines: noise() }, // reviewer の別の PR
    { meta: { description: `panel 5 ${HEAD7} lens1` }, lines: noise() }, // agentType が無い
    { meta: { agentType: 'review-lens' }, lines: noise() }, // description が無い
  ];
  const r = subagentCost(entries, 5, HEAD7, pricing);
  assert.deepEqual(r.panel, expected([...lensLines, ...scorerLines, ...intakeLines]));
  assert.deepEqual(r.reviewer, expected(reviewerLines));
  assert.equal(r.panel!.tokens['claude-haiku-4-5']!.input, 300);
  assert.equal(r.panel!.tokens['claude-sonnet-5']!.output, 150);
  assert.equal(r.panel!.tokens['claude-opus-5'], undefined, '数えないものが混ざらない');
  assert.equal(r.reviewer!.tokens['claude-opus-5-5']!.input, 3000);
});

test('費用：該当が無ければ null', () => {
  assert.deepEqual(subagentCost([], 5, HEAD7, pricing), { panel: null, reviewer: null });
  const onlyPanel = subagentCost([{ meta: { agentType: 'review-lens', description: `panel 5 ${HEAD7} lens1` }, lines: [usageLine('claude-sonnet-5', 10, 1)] }], 5, HEAD7, pricing);
  assert.notEqual(onlyPanel.panel, null);
  assert.equal(onlyPanel.reviewer, null);
  const onlyReviewer = subagentCost([{ meta: { agentType: 'reviewer', description: `reviewer 5 ${HEAD7}` }, lines: [usageLine('claude-sonnet-5', 10, 1)] }], 5, HEAD7, pricing);
  assert.equal(onlyReviewer.panel, null);
  assert.notEqual(onlyReviewer.reviewer, null);
});

// ---- ④の材料 ----

function pastPr(number: number, patch: Partial<PastPr> = {}): PastPr {
  return { number, title: `feat: 過去${number}`, mergedAt: '2026-09-20T00:00:00Z', files: ['a.ts'], comments: [], reviews: [], reviewComments: [], ...patch };
}

function facts(patch: Partial<JudgeFacts> = {}): JudgeFacts {
  return { pr: { number: 5, headSha: HEAD, body: null }, issues: [], prComments: [], checkRuns: [], ...patch };
}

test('④の材料：judge-input の過去の PR の節から PR の数とコメントの無い PR の数を数える（ほかの節の文字列は数えない）', () => {
  const text = renderJudgeInput(config, facts({
    // PR のコメントの節に紛らわしい文字列があっても数えない
    prComments: [comment('--- PR #99 偽物\n(コラボレーターのコメントなし)', 'COLLABORATOR')],
    pastPrs: {
      changedFiles: 1, filesConsidered: 1,
      prs: [pastPr(11, { comments: [comment('過去のレビューで指摘した', 'COLLABORATOR')] }), pastPr(12), pastPr(13)],
    },
  }));
  assert.deepEqual(pastPrMaterial(text), { pastPrs: 3, pastPrsWithoutComments: 2 });
});

test('④の材料：過去の PR が無い・集めていない・節が無ければ 0', () => {
  assert.deepEqual(pastPrMaterial(renderJudgeInput(config, facts({ pastPrs: { changedFiles: 1, filesConsidered: 1, prs: [] } }))), { pastPrs: 0, pastPrsWithoutComments: 0 });
  assert.deepEqual(pastPrMaterial(renderJudgeInput(config, facts())), { pastPrs: 0, pastPrsWithoutComments: 0 });
  assert.deepEqual(pastPrMaterial(`headSha: ${HEAD}\nPR #5 issues=(なし)\n`), { pastPrs: 0, pastPrsWithoutComments: 0 });
  assert.deepEqual(pastPrMaterial('=== 過去の PR のコメント（参考）\n--- PR #1 t\n(コラボレーターのコメントなし)\n--- PR #2 t\n- コメント me\n本文\n=== 範囲照合\n--- PR #3 x\n'), { pastPrs: 2, pastPrsWithoutComments: 1 });
});
