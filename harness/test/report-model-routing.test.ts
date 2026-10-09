// 集計に、実装のモデルの勧め（計画ゲートの記録の modelRouting）×使ったモデルごとの結果の指標（件数・1回で合格・修正の往復・ブロッキング指摘・
// fix の PR・revert・mutation の survived）を出す（Issue #139 の AC3）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Acceptance } from '../lib/merge-route.ts';
import { UNKNOWN_IMPLEMENT_MODEL, modelRoutingQuality, renderModelRoutingQuality } from '../lib/report.ts';
import type { ModelRoutingQualityRow, ReportRow } from '../lib/report.ts';

/** 受け付け記録の fake（必須フィールドを埋める） */
const ACC: Acceptance = {
  version: 1,
  verdictCommentId: 1,
  verdictHeadSha: 'a'.repeat(40),
  patchId: 'p'.repeat(40),
  reviewPass: true,
  riskLevel: 'low',
  riskOk: true,
  scopeOk: true,
  outside: [],
  guardrail: [],
  autoEligible: true,
  reasons: [],
};

let nextPr = 1;
/** 集計の行の fake。足りない欄は既定値 */
function row(extra: Partial<ReportRow> = {}): ReportRow {
  return { pr: nextPr++, createdAt: '2026-10-01T00:00:00Z', mergedAt: null, closedAt: null, acceptance: ACC, rejected: 0, fixRequests: 0, reverted: false, fixedBy: [], ...extra };
}

/** 通過した計画で勧めがある行 */
const passed = (recommendedModel: 'opus' | 'sonnet', extra: Partial<ReportRow> = {}) => row({ recommendedModel, recommendedGatePass: true, blockingFindings: 0, mutationSurvived: null, ...extra });

const NONE = '記録なし';
const key = (r: ModelRoutingQualityRow) => [r.gate, r.recommended, r.model].join('/');
const near = (a: number | null, b: number, what: string) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${what}: ${a}`);

test('modelRoutingQuality：ゲート・勧め・モデルの組ごとに指標を出し、受け付け記録の無い行は除き、並びは pass→stopped→none・opus→sonnet→記録なし・モデル（不明は最後）', () => {
  const rows = [
    row({ implementModel: 'sonnet' }), // 勧めの欄が無い → none・記録なし
    passed('sonnet', { implementModel: undefined }), // モデルが無い → 不明
    row({ implementModel: 'sonnet', recommendedModel: null, recommendedGatePass: null }), // 勧めが null → none・記録なし
    passed('opus', { implementModel: 'sonnet', fixRequests: 0, blockingFindings: 0, mutationSurvived: 2 }),
    passed('opus', { implementModel: 'sonnet', fixRequests: 2, blockingFindings: 3, fixedBy: [90] }),
    passed('opus', { implementModel: 'sonnet', fixRequests: 1, blockingFindings: 1, reverted: true, mutationSurvived: 4 }),
    passed('sonnet', { implementModel: 'sonnet', mutationSurvived: 0 }),
    passed('opus', { implementModel: 'opus' }),
    row({ implementModel: 'sonnet', recommendedModel: 'opus', recommendedGatePass: false, blockingFindings: 0 }), // 止まった計画 → stopped
    passed('opus', { implementModel: 'sonnet', fixRequests: 9, acceptance: null }), // 受け付け記録が無い → 母数から除く
  ];
  const r = modelRoutingQuality(rows);
  assert.deepEqual(r.map(key), [
    'pass/opus/opus',
    'pass/opus/sonnet',
    'pass/sonnet/sonnet',
    `pass/sonnet/${UNKNOWN_IMPLEMENT_MODEL}`,
    'stopped/opus/sonnet',
    `none/${NONE}/sonnet`,
  ]);
  const get = (k: string) => r.find((x) => key(x) === k)!;

  const opusSonnet = get('pass/opus/sonnet');
  assert.deepEqual(
    { count: opusSonnet.count, firstPass: opusSonnet.firstPass, fixedPrs: opusSonnet.fixedPrs, reverted: opusSonnet.reverted, mutationPrs: opusSonnet.mutationPrs },
    { count: 3, firstPass: 1, fixedPrs: 1, reverted: 1, mutationPrs: 2 },
  );
  near(opusSonnet.firstPassRate, 1 / 3, '1回で合格の割合');
  near(opusSonnet.fixRequestsAvg, 1, '修正の往復の平均');
  near(opusSonnet.blockingAvg, 4 / 3, 'ブロッキング指摘の平均');
  near(opusSonnet.mutationSurvivedAvg, 3, 'mutation の survived の平均（null を除く）');

  const sonnetSonnet = get('pass/sonnet/sonnet');
  assert.deepEqual({ count: sonnetSonnet.count, firstPass: sonnetSonnet.firstPass, firstPassRate: sonnetSonnet.firstPassRate, mutationPrs: sonnetSonnet.mutationPrs, mutationSurvivedAvg: sonnetSonnet.mutationSurvivedAvg }, { count: 1, firstPass: 1, firstPassRate: 1, mutationPrs: 1, mutationSurvivedAvg: 0 });

  const opusOpus = get('pass/opus/opus');
  assert.deepEqual({ count: opusOpus.count, mutationPrs: opusOpus.mutationPrs, mutationSurvivedAvg: opusOpus.mutationSurvivedAvg }, { count: 1, mutationPrs: 0, mutationSurvivedAvg: null }, 'mutation が読めた PR が無ければ平均は null');

  assert.equal(get('stopped/opus/sonnet').count, 1);
  assert.equal(get(`none/${NONE}/sonnet`).count, 2, '勧めの欄が無い行と null の行は同じ none・記録なし');
  assert.equal(r.reduce((a, x) => a + x.count, 0), 9, '受け付け記録の無い行を数えた');

  assert.deepEqual(modelRoutingQuality([]), []);
  assert.deepEqual(modelRoutingQuality([passed('opus', { acceptance: null })]), []);
});

test('renderModelRoutingQuality：見出し・注記・表の行が出て、行が0件なら「対象の PR はありません」', () => {
  const md = renderModelRoutingQuality(
    modelRoutingQuality([
      passed('opus', { implementModel: 'sonnet' }),
      passed('opus', { implementModel: 'sonnet', fixRequests: 1 }),
      passed('opus', { implementModel: 'sonnet', fixRequests: 1 }),
    ]),
  );
  assert.ok(md.includes('## 実装のモデルの勧めと結果'), md);
  assert.ok(md.includes('modelRouting'), `注記に勧めの出どころ（modelRouting）が無い:\n${md}`);
  assert.ok(md.includes('docs/plan.md'), `注記に切り替えの基準の場所（docs/plan.md）が無い:\n${md}`);
  const line = md.split('\n').find((l) => l.startsWith('|') && l.includes('opus') && l.includes('sonnet'));
  assert.ok(line?.includes('33.3%'), `opus の勧め×sonnet の行に 1回で合格の割合（33.3%）が無い:\n${md}`);
  const empty = renderModelRoutingQuality([]);
  assert.ok(empty.includes('## 実装のモデルの勧めと結果'), empty);
  assert.ok(empty.includes('対象の PR はありません'), empty);
});
