// 集計に、実装のモデルごとの品質（1回で合格した割合・修正の回数・計画に返した回数）を出す（Issue #473）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueComment } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import {
  UNKNOWN_IMPLEMENT_MODEL,
  implementModelOf,
  implementModelQuality,
  planReturnsOf,
  renderImplementModelQuality,
} from '../lib/report.ts';
import type { ImplementModelRow, ReportRow } from '../lib/report.ts';

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
  return { pr: nextPr++, createdAt: '2026-09-01T00:00:00Z', mergedAt: null, closedAt: null, acceptance: ACC, rejected: 0, fixRequests: 0, reverted: false, fixedBy: [], ...extra };
}

test('implementModelOf：PR 本文の「実装のモデル:」の行からモデルを読み、無い・雛形のままなら不明', () => {
  assert.equal(UNKNOWN_IMPLEMENT_MODEL, '不明');
  const cases: [string, string | null | undefined, string][] = [
    ['半角コロン', '## 概要\n実装のモデル: sonnet\n', 'sonnet'],
    ['全角コロン', '実装のモデル：opus', 'opus'],
    ['バッククォート付き', '実装のモデル: `sonnet`', 'sonnet'],
    ['箇条書き（-）と前の空白', '  - 実装のモデル: sonnet', 'sonnet'],
    ['箇条書き（*）', '* 実装のモデル: opus', 'opus'],
    ['大文字は小文字に', '実装のモデル: Sonnet', 'sonnet'],
    ['複数あれば最初の行', '実装のモデル: opus\n実装のモデル: sonnet', 'opus'],
    ['行が無い', 'Closes #1\n本文だけ', UNKNOWN_IMPLEMENT_MODEL],
    ['値が空', '実装のモデル:   \n', UNKNOWN_IMPLEMENT_MODEL],
    ['雛形の <model> のまま', '実装のモデル: <model>', UNKNOWN_IMPLEMENT_MODEL],
    ['body が null', null, UNKNOWN_IMPLEMENT_MODEL],
    ['body が undefined', undefined, UNKNOWN_IMPLEMENT_MODEL],
  ];
  for (const [name, body, want] of cases) assert.equal(implementModelOf(body), want, name);
});

/** 着手宣言のコメント。opts で目印・書いた人の関係を変える */
function claim(id: number, c: { stage?: string; session?: string; released?: boolean; takeover?: boolean }, opts: { mark?: boolean; assoc?: string } = {}): IssueComment {
  const value = { by: 'manual', at: '2026-09-01T00:00:00Z', session: c.session ?? 's1', ...(c.stage ? { stage: c.stage } : {}), ...(c.released ? { released: true } : {}), ...(c.takeover ? { takeover: true } : {}) };
  const mark = opts.mark === false ? '' : '<!-- agent-harness:claude -->\n';
  return {
    id,
    body: `${mark}着手宣言\n\n\`\`\`agent-claim\n${JSON.stringify(value)}\n\`\`\``,
    html_url: `https://example.test/c/${id}`,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    author_association: opts.assoc ?? 'OWNER',
    user: { login: 'u', type: 'User' },
  };
}

/** 段階の並びを id 1, 2, ... の宣言にする */
const seq = (...stages: string[]) => stages.map((stage, i) => claim(i + 1, { stage }));

test('planReturnsOf：着手宣言で implement の次の宣言が plan だった回数を数える', () => {
  const cases: [string, IssueComment[], number][] = [
    ['宣言が無い', [], 0],
    ['戻りの無い通常の流れ', seq('plan', 'plan-critique', 'plan-gate', 'implement', 'judge'), 0],
    ['implement → plan で1回', seq('plan', 'plan-critique', 'plan-gate', 'implement', 'plan', 'plan-critique', 'plan-gate', 'implement'), 1],
    ['2回戻る', seq('plan', 'implement', 'plan', 'implement', 'plan', 'implement'), 2],
    ['implement → plan-critique は数えない', seq('plan', 'implement', 'plan-critique'), 0],
    ['解除は飛ばす（implement → 解除 → plan で1回）', [claim(1, { stage: 'implement' }), claim(2, { stage: 'implement', released: true }), claim(3, { stage: 'plan' })], 1],
    ['別のセッションの takeover の plan も数える', [claim(1, { stage: 'implement', session: 's1' }), claim(2, { stage: 'plan', session: 's2', takeover: true })], 1],
    ['別のセッションの宣言し直しも数える', [claim(1, { stage: 'implement', session: 's1' }), claim(2, { stage: 'plan', session: 's2' })], 1],
    ['stage の無い宣言が間にあれば数えない', [claim(1, { stage: 'implement' }), claim(2, {}), claim(3, { stage: 'plan' })], 0],
    ['コラボレーター以外の宣言は数えない', [claim(1, { stage: 'implement' }), claim(2, { stage: 'plan' }, { assoc: 'NONE' })], 0],
    ['目印の無い宣言は数えない', [claim(1, { stage: 'implement' }), claim(2, { stage: 'plan' }, { mark: false })], 0],
    ['コラボレーター以外の宣言は並びを切らない', [claim(1, { stage: 'implement' }), claim(2, { stage: 'judge' }, { assoc: 'NONE' }), claim(3, { stage: 'plan' })], 1],
    ['配列の順が乱れていても id の順で数える', [claim(3, { stage: 'plan' }), claim(1, { stage: 'plan' }), claim(2, { stage: 'implement' })], 1],
    ['id の順で implement が後なら数えない', [claim(2, { stage: 'implement' }), claim(1, { stage: 'plan' })], 0],
  ];
  for (const [name, comments, want] of cases) {
    const before = comments.map((c) => c.id);
    assert.equal(planReturnsOf(comments), want, name);
    assert.deepEqual(comments.map((c) => c.id), before, `${name}：入力の配列を変えた`);
  }
});

test('implementModelQuality：受け付け記録のある PR をモデルごとに集計し、不明は最後', () => {
  const rows = [
    row({ implementModel: 'sonnet', fixRequests: 0, planReturns: 1 }),
    row({ implementModel: 'sonnet', fixRequests: 0, fixedBy: [90, 91], planReturns: 0 }),
    row({ implementModel: 'sonnet', fixRequests: 2, reverted: true, planReturns: 2 }),
    row({ implementModel: 'opus', fixRequests: 1, planReturns: 1 }),
    row({}), // 欄が無い → 不明・計画に返した回数 0
    row({ implementModel: null, fixRequests: 3 }), // null → 不明
    row({ implementModel: 'sonnet', fixRequests: 5, acceptance: null, planReturns: 4 }), // 受け付け記録が無い → 母数から除く
  ];
  const r = implementModelQuality(rows);
  assert.deepEqual(r.map((x) => x.model), ['opus', 'sonnet', UNKNOWN_IMPLEMENT_MODEL]);
  const [opus, sonnet, unknown] = r as [ImplementModelRow, ImplementModelRow, ImplementModelRow];
  assert.deepEqual(
    { count: sonnet.count, firstPass: sonnet.firstPass, fixRequests: sonnet.fixRequests, fixedPrs: sonnet.fixedPrs, reverted: sonnet.reverted, planReturns: sonnet.planReturns },
    { count: 3, firstPass: 2, fixRequests: 2, fixedPrs: 1, reverted: 1, planReturns: 3 },
  );
  assert.ok(Math.abs(sonnet.firstPassRate! - 2 / 3) < 1e-9, `1回で合格の割合: ${sonnet.firstPassRate}`);
  assert.ok(Math.abs(sonnet.fixRequestsAvg! - 2 / 3) < 1e-9, `修正の平均: ${sonnet.fixRequestsAvg}`);
  assert.deepEqual(
    { count: opus.count, firstPass: opus.firstPass, firstPassRate: opus.firstPassRate, fixRequests: opus.fixRequests, fixRequestsAvg: opus.fixRequestsAvg, fixedPrs: opus.fixedPrs, reverted: opus.reverted, planReturns: opus.planReturns },
    { count: 1, firstPass: 0, firstPassRate: 0, fixRequests: 1, fixRequestsAvg: 1, fixedPrs: 0, reverted: 0, planReturns: 1 },
  );
  assert.deepEqual(
    { count: unknown.count, firstPass: unknown.firstPass, firstPassRate: unknown.firstPassRate, fixRequests: unknown.fixRequests, planReturns: unknown.planReturns },
    { count: 2, firstPass: 1, firstPassRate: 0.5, fixRequests: 3, planReturns: 0 },
  );
  assert.equal(r.reduce((a, x) => a + x.planReturns, 0), 4, '計画に返した回数の合計が、母数の行の planReturns の和でない');
  assert.deepEqual(implementModelQuality([]), []);
  assert.deepEqual(implementModelQuality([row({ acceptance: null })]), []);
});

test('renderImplementModelQuality：表の行にモデルと割合が出て、注記に人のやり直しも数に入る旨が出る', () => {
  const md = renderImplementModelQuality(
    implementModelQuality([row({ implementModel: 'sonnet' }), row({ implementModel: 'sonnet' }), row({ implementModel: 'sonnet', fixRequests: 2 }), row({ implementModel: 'opus', fixRequests: 1 })]),
  );
  assert.ok(md.includes('## 実装のモデルごとの品質'), md);
  const line = (model: string) => md.split('\n').find((l) => l.startsWith('|') && l.includes(model));
  assert.ok(line('sonnet')?.includes('66.7%'), `sonnet の行に 1回で合格の割合（66.7%）が無い:\n${md}`);
  assert.ok(line('opus')?.includes('0%'), `opus の行に 1回で合格の割合（0%）が無い:\n${md}`);
  assert.match(md, /人が計画のやり直しを求めた/, `注記に人のやり直しの旨が無い:\n${md}`);
  const empty = renderImplementModelQuality([]);
  assert.ok(empty.includes('## 実装のモデルごとの品質'), empty);
  assert.match(empty, /人が計画のやり直しを求めた/, '行が0件でも注記が出る');
});
