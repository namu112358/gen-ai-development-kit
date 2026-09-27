import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JEV_QUESTION_SET } from '../lib/jev.ts';
import type { Acceptance, JevRecord } from '../lib/merge-route.ts';
import { JA_RATIO_BUCKETS, renderTokenRatios, tokenRatios } from '../lib/report.ts';
import type { ReportRow } from '../lib/report.ts';

// 集計に、日本語の割合の区分ごとの「文字数 / トークン数」の比を出す（Issue #129）

const T0 = Date.parse('2026-09-01T00:00:00Z');
const LABELS = ['0〜5%', '5〜20%', '20〜50%', '50%以上'];

/** status ok の Jev の記録。size を渡せば付ける */
function jevOk(size?: { chars: number; jaRatio: number; inputTokens: number | null; diffChars?: number }): JevRecord {
  return {
    status: 'ok',
    allows: false,
    answers: { q1_risk: { low: 0.2, medium: 0.8, high: 0, critical: 0 } },
    questionSet: JEV_QUESTION_SET,
    ...(size ? { size } : {}),
  } as JevRecord;
}

/** 受け付け記録の fake（必須フィールドを埋める） */
function acc(jev?: JevRecord): Acceptance {
  return {
    version: 1,
    verdictCommentId: 1,
    verdictHeadSha: 'a'.repeat(40),
    patchId: 'p'.repeat(40),
    reviewPass: true,
    riskLevel: 'medium',
    riskOk: false,
    scopeOk: true,
    outside: [],
    guardrail: [],
    autoEligible: false,
    reasons: ['理由'],
    ...(jev ? { jev } : {}),
  };
}

let nextPr = 1;
/** 集計の行の fake。acceptance を渡す */
function row(acceptance: Acceptance | null): ReportRow {
  return {
    pr: nextPr++,
    createdAt: new Date(T0).toISOString(),
    mergedAt: null,
    closedAt: null,
    acceptance,
    rejected: 0,
    fixRequests: 0,
    reverted: false,
    fixedBy: [],
  };
}

/** size 付きで数える行 */
const sized = (jaRatio: number, chars: number, inputTokens: number | null) => row(acc(jevOk({ chars, jaRatio, inputTokens, diffChars: 10 })));

const bucket = (r: ReturnType<typeof tokenRatios>, label: string) => {
  const b = r.buckets.find((x) => x.label === label);
  assert.ok(b, `区分 ${label} が無い: ${r.buckets.map((x) => x.label).join(', ')}`);
  return b;
};

test('JA_RATIO_BUCKETS：区分は 0〜5%・5〜20%・20〜50%・50%以上 の順', () => {
  assert.deepEqual(JA_RATIO_BUCKETS.map((b) => b.label), LABELS);
});

test('tokenRatios：記録が無くても4区分すべてを順に返し、件数 0 の区分の比は null', () => {
  const r = tokenRatios([]);
  assert.deepEqual(r.buckets.map((b) => b.label), LABELS);
  for (const b of r.buckets) assert.deepEqual({ count: b.count, chars: b.chars, tokens: b.tokens, ratio: b.ratio }, { count: 0, chars: 0, tokens: 0, ratio: null });
  assert.equal(r.skipped, 0);
});

test('tokenRatios：区分ごとの件数と、比は文字数の合計 / トークン数の合計', () => {
  const r = tokenRatios([
    sized(0, 3000, 1000),
    sized(0.01, 1000, 500), // 0〜5%：4000 / 1500
    sized(0.1, 2000, 1000), // 5〜20%：2
    sized(0.3, 1500, 1000),
    sized(0.4, 500, 1000), // 20〜50%：2000 / 2000 = 1
    sized(0.8, 900, 1000), // 50%以上：0.9
  ]);
  assert.deepEqual(r.buckets.map((b) => b.label), LABELS);
  const low = bucket(r, '0〜5%');
  assert.deepEqual({ count: low.count, chars: low.chars, tokens: low.tokens }, { count: 2, chars: 4000, tokens: 1500 });
  assert.ok(Math.abs(low.ratio! - 4000 / 1500) < 1e-9, `比が文字数の合計 / トークン数の合計でない: ${low.ratio}`);
  assert.equal(bucket(r, '5〜20%').count, 1);
  assert.equal(bucket(r, '5〜20%').ratio, 2);
  assert.equal(bucket(r, '20〜50%').count, 2);
  assert.equal(bucket(r, '20〜50%').ratio, 1);
  assert.equal(bucket(r, '50%以上').count, 1);
  assert.equal(bucket(r, '50%以上').ratio, 0.9);
  assert.equal(r.skipped, 0);
});

test('tokenRatios：境界は下限を含み上限を含まない（0.05 は 5〜20%、0.2 は 20〜50%、0.5 は 50%以上）', () => {
  const at = (jaRatio: number) => {
    const r = tokenRatios([sized(jaRatio, 100, 50)]);
    const hit = r.buckets.filter((b) => b.count === 1).map((b) => b.label);
    assert.equal(hit.length, 1, `${jaRatio} が1つの区分に入らない: ${hit.join(', ')}`);
    return hit[0];
  };
  assert.equal(at(0), '0〜5%');
  assert.equal(at(0.049), '0〜5%');
  assert.equal(at(0.05), '5〜20%');
  assert.equal(at(0.199), '5〜20%');
  assert.equal(at(0.2), '20〜50%');
  assert.equal(at(0.499), '20〜50%');
  assert.equal(at(0.5), '50%以上');
  assert.equal(at(1), '50%以上');
});

test('tokenRatios：size の無い記録・inputTokens が null や正の整数でないもの・jev の skipped/error は数えず skipped に数える', () => {
  const r = tokenRatios([
    sized(0, 1000, 500), // 数える
    row(acc(jevOk())), // ok だが size が無い（古い記録）
    sized(0, 1000, null), // usage が無かった
    sized(0, 1000, 0), // 正でない
    sized(0, 1000, 1.5), // 整数でない
    row(acc({ status: 'skipped', detail: 'JEV_API_KEY が未設定' })),
    row(acc({ status: 'error', detail: 'HTTP 500' })),
  ]);
  assert.equal(r.skipped, 6);
  const low = bucket(r, '0〜5%');
  assert.deepEqual({ count: low.count, chars: low.chars, tokens: low.tokens, ratio: low.ratio }, { count: 1, chars: 1000, tokens: 500, ratio: 2 });
});

test('tokenRatios：acceptance が null の行と jev の無い行は skipped に数えない', () => {
  const r = tokenRatios([row(null), row(acc()), sized(0.6, 300, 100)]);
  assert.equal(r.skipped, 0);
  assert.equal(bucket(r, '50%以上').count, 1);
  assert.equal(r.buckets.reduce((a, b) => a + b.count, 0), 1);
});

test('renderTokenRatios：見出し・表の列・各区分の比・数えなかった件数が出る', () => {
  const r = tokenRatios([
    sized(0, 3000, 1000), // 0〜5%：3
    sized(0.1, 2000, 1000), // 5〜20%：2
    sized(0.3, 1500, 1000), // 20〜50%：1.5
    row(acc(jevOk())), // skipped
    row(acc({ status: 'error' })), // skipped
  ]);
  const md = renderTokenRatios(r);
  assert.ok(md.includes('## 文字数とトークン数の比（Jev の受け付けの記録）'), md);
  const header = md.split('\n').find((l) => l.startsWith('|') && l.includes('区分'));
  assert.ok(header, `表の見出し行が無い:\n${md}`);
  for (const col of ['区分', '件数', '文字数', 'トークン数', '文字数/トークン']) assert.ok(header.includes(col), `列 ${col} が無い: ${header}`);
  const line = (label: string) => {
    const l = md.split('\n').find((x) => x.startsWith('|') && x.includes(label) && !x.includes('区分'));
    assert.ok(l, `区分 ${label} の行が無い:\n${md}`);
    return l;
  };
  assert.match(line('0〜5%'), /\|\s*3(\.0+)?\s*\|\s*$/);
  assert.match(line('5〜20%'), /\|\s*2(\.0+)?\s*\|\s*$/);
  assert.match(line('20〜50%'), /\|\s*1\.50?\s*\|\s*$/);
  assert.match(line('0〜5%'), /3,?000/, '文字数の合計が無い');
  assert.match(line('0〜5%'), /1,?000/, 'トークン数の合計が無い');
  assert.ok(line('50%以上'), '件数 0 の区分も行が出る');
  const skippedLine = md.split('\n').find((l) => l.includes('数えなかった'));
  assert.ok(skippedLine, `数えなかった件数の行が無い:\n${md}`);
  assert.ok(/(^|\D)2(\D|$)/.test(skippedLine), `数えなかった件数（2）が無い: ${skippedLine}`);
});
