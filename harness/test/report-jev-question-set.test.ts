import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { JEV_QUESTION_SET } from '../lib/jev.ts';
import type { Acceptance, JevRecord } from '../lib/merge-route.ts';
import { renderReport, summarize } from '../lib/report.ts';
import type { ReportRow } from '../lib/report.ts';

const config = loadConfig();
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** status ok の Jev の記録。questionSet が undefined ならキーを入れない（版 1 の古い記録） */
function jevOk(low: number, allows: boolean, questionSet?: number): JevRecord {
  return {
    status: 'ok',
    allows,
    answers: { q1_risk: { low, medium: 1 - low, high: 0, critical: 0 } },
    ...(questionSet === undefined ? {} : { questionSet }),
  };
}

/** 受け付け記録の fake（必須フィールドを埋める） */
function acc(autoEligible: boolean, jev?: JevRecord): Acceptance {
  return {
    version: 1,
    verdictCommentId: 1,
    verdictHeadSha: 'a'.repeat(40),
    patchId: 'p'.repeat(40),
    reviewPass: true,
    riskLevel: autoEligible ? 'low' : 'medium',
    riskOk: autoEligible,
    scopeOk: true,
    outside: [],
    guardrail: [],
    autoEligible,
    reasons: autoEligible ? [] : ['理由'],
    ...(jev ? { jev } : {}),
  };
}

let nextPr = 1;
/** 集計の行の fake */
function row(over: Partial<ReportRow> = {}): ReportRow {
  return {
    pr: nextPr++,
    createdAt: at(0),
    mergedAt: at(HOUR),
    closedAt: null,
    acceptance: acc(true),
    rejected: 0,
    fixRequests: 0,
    reverted: false,
    fixedBy: [],
    ...over,
  };
}

/** 否定側 20 件（Claude も Jev も不可）。questionSet を渡さなければ版 1 の記録 */
function negatives(questionSet?: number): ReportRow[] {
  return Array.from({ length: 20 }, () => row({ acceptance: acc(false, jevOk(0.2, false, questionSet)) }));
}

test('今の問いの版は 2', () => {
  assert.equal(JEV_QUESTION_SET, 2);
});

test('summarize：版 1 の記録（questionSet 無し）だけの否定側 20 件では基準を満たさない', () => {
  const s = summarize(config, negatives());
  assert.equal(s.negatives, 20);
  assert.equal(s.negativesJev, 0);
  assert.equal(s.jevOtherSets, 20);
  assert.equal(s.jevOk, 0);
  assert.equal(s.jevOnly, 0);
  assert.equal(s.criteria.met, false);
  assert.ok(s.criteria.unmet.some((u) => u.includes('否定側が 0 件')), s.criteria.unmet.join(' / '));
});

test('summarize：同じ行を今の版（2）の記録にすると基準を満たす', () => {
  const s = summarize(config, negatives(JEV_QUESTION_SET));
  assert.equal(s.negatives, 20);
  assert.equal(s.negativesJev, 20);
  assert.equal(s.jevOtherSets, 0);
  assert.equal(s.jevOk, 20);
  assert.deepEqual(s.criteria, { met: true, unmet: [] });
});

test('summarize：今の版に Jev だけが「可」が1件あると基準を満たさない', () => {
  const rows = [...negatives(JEV_QUESTION_SET), row({ acceptance: acc(false, jevOk(0.97, true, JEV_QUESTION_SET)) })];
  const s = summarize(config, rows);
  assert.equal(s.jevOnly, 1);
  assert.equal(s.negativesJev, 21);
  assert.equal(s.criteria.met, false);
  assert.ok(s.criteria.unmet.some((u) => u.includes('Jev だけが「可」')), s.criteria.unmet.join(' / '));
});

test('summarize：版 1 の Jev だけが「可」は jevOnly に入らず、除いた記録に数える（negatives は版に関わらず数える）', () => {
  const rows = [...negatives(JEV_QUESTION_SET), row({ acceptance: acc(false, jevOk(0.97, true)) })];
  const s = summarize(config, rows);
  assert.equal(s.jevOnly, 0);
  assert.equal(s.negatives, 21);
  assert.equal(s.negativesJev, 20);
  assert.equal(s.jevOtherSets, 1);
  assert.equal(s.jevOk, 20);
  assert.deepEqual(s.criteria, { met: true, unmet: [] });
});

test('summarize：版 1 の Jev の low の外れ・「可」の外れ・一致率は Jev の数に入らない', () => {
  const rows = [
    row({ acceptance: acc(true, jevOk(0.97, true)), reverted: true }), // 版 1：数えない
    row({ acceptance: acc(true, jevOk(0.97, true, 1)), fixedBy: [9] }), // 版 1（明示）：数えない
    row({ acceptance: acc(true, jevOk(0.97, true, JEV_QUESTION_SET)) }), // 版 2：一致・外れなし
    row({ acceptance: acc(true, jevOk(0.3, false, JEV_QUESTION_SET)) }), // 版 2：不一致
  ];
  const s = summarize(config, rows);
  assert.equal(s.jevOk, 2);
  assert.equal(s.jevLow, 1);
  assert.equal(s.jevLowMisses, 0);
  assert.equal(s.jevLowMissRate, 0);
  assert.equal(s.jevMisses, 0);
  assert.equal(s.agreement, 0.5);
  assert.equal(s.jevOtherSets, 2);
  // Claude 側の外れは Jev の版に関わらず数える
  assert.equal(s.claudeMisses, 2);
});

test('summarize：negativesJev は Jev が ok で今の版の記録がある否定側だけ（skipped・error・Jev 無しは入らない）', () => {
  const rows = [
    row({ acceptance: acc(false, jevOk(0.2, false, JEV_QUESTION_SET)) }),
    row({ acceptance: acc(false, { status: 'skipped', questionSet: JEV_QUESTION_SET }) }),
    row({ acceptance: acc(false, { status: 'error', questionSet: JEV_QUESTION_SET }) }),
    row({ acceptance: acc(false) }),
    row({ acceptance: acc(true, jevOk(0.97, true, JEV_QUESTION_SET)) }),
  ];
  const s = summarize(config, rows);
  assert.equal(s.negatives, 4);
  assert.equal(s.negativesJev, 1);
  assert.equal(s.jevOtherSets, 0);
});

test('renderReport：Jev の数は問いの版 2 の記録だけで数えるという注記と、否定側のうち今の版・除いた記録の行が出る', () => {
  const rows = negatives();
  const md = renderReport(summarize(config, rows), rows, 30);
  const note = md.indexOf('問いの版 2 の記録だけで数える');
  assert.ok(note >= 0, '注記が無い');
  const jevRow = md.indexOf('| Jev の応答あり');
  assert.ok(jevRow >= 0 && note < jevRow, '注記が Jev の行より前に無い');
  assert.ok(md.includes('| 否定側のうち今の問いの版で Jev が応答したもの | 0 |'), md);
  assert.ok(md.includes('| Jev の数から除いた、版の違う記録 | 20 |'), md);
  assert.ok(md.includes('否定側が 0 件'), '基準の行に否定側の不足が無い');
});
