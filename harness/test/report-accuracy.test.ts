import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { JEV_QUESTION_SET } from '../lib/jev.ts';
import type { Acceptance, JevRecord } from '../lib/merge-route.ts';
import { JEV_ENFORCE_CRITERIA, fixPrsFor, isFixPr, isJevLow, renderReport, summarize } from '../lib/report.ts';
import type { MergedPr, ReportRow } from '../lib/report.ts';

const config = loadConfig();
const LOW = config.jev.thresholds.lowProbability;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** Jev の記録。low を渡すと status ok で q1_risk.low を入れる */
function jevOk(low: number, allows: boolean): JevRecord {
  return { status: 'ok', allows, answers: { q1_risk: { low, medium: 1 - low, high: 0, critical: 0 } }, questionSet: JEV_QUESTION_SET };
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

/** 基準を満たす母集団：否定側 20 件（Jev は不可）、Jev の low で外れなしが 3 件 */
function passingRows(): ReportRow[] {
  const rows: ReportRow[] = [];
  for (let i = 0; i < 20; i++) rows.push(row({ acceptance: acc(false, jevOk(0.2, false)) }));
  for (let i = 0; i < 3; i++) rows.push(row({ acceptance: acc(true, jevOk(0.97, true)) }));
  return rows;
}

/** fix の PR の fake。本文で元の PR（#10）を参照するので、ファイルが重なれば参照の根拠で結び付く（期間・fix の判定・自分自身の条件を確かめるため） */
function mpr(number: number, title: string, headRef: string, mergedAt: string | null, files: string[]): MergedPr {
  return { number, title, headRef, mergedAt, files, body: 'Refs #10' };
}

test('isFixPr：タイトルが fix/hotfix で始まるか「修正」を含む、またはブランチのセグメントが fix で始まる', () => {
  assert.equal(isFixPr({ title: 'fix: 直す', headRef: 'feature/x' }), true);
  assert.equal(isFixPr({ title: 'Fix(harness): typo', headRef: 'feature/x' }), true);
  assert.equal(isFixPr({ title: 'HOTFIX release', headRef: 'feature/x' }), true);
  assert.equal(isFixPr({ title: 'ログの修正', headRef: 'feature/x' }), true);
  assert.equal(isFixPr({ title: 'feat: 追加', headRef: 'fix/login' }), true);
  assert.equal(isFixPr({ title: 'feat: 追加', headRef: 'claude/fix-login' }), true);
  assert.equal(isFixPr({ title: 'feat: 追加', headRef: 'claude/issue-1-prefix' }), false);
  assert.equal(isFixPr({ title: 'feat: prefix を足す', headRef: 'feature/x' }), false);
  assert.equal(isFixPr({ title: 'docs: 更新', headRef: 'claude/issue-2-docs' }), false);
});

test('fixPrsFor：Merge 後 7 日以内でファイルが重なる fix の PR だけを数える', () => {
  const base = mpr(10, 'feat: 追加', 'claude/issue-10-a', at(0), ['a.ts', 'b.ts']);
  const all = [
    base,
    mpr(11, 'fix: a を直す', 'claude/issue-11-a', at(3 * DAY), ['a.ts']), // 数える
    mpr(12, 'fix: b を直す', 'claude/issue-12-b', at(8 * DAY), ['b.ts']), // 8 日後：数えない
    mpr(13, 'fix: c を直す', 'claude/issue-13-c', at(2 * DAY), ['c.ts']), // 重ならない：数えない
    mpr(14, 'feat: a を拡張', 'claude/issue-14-a', at(1 * DAY), ['a.ts']), // fix でない：数えない
    mpr(15, 'b の修正', 'claude/issue-15-b', at(7 * DAY), ['b.ts']), // ちょうど 7 日：数える
    mpr(16, 'feat: x', 'fix/a', null, ['a.ts']), // 未 Merge：数えない
    mpr(17, 'fix: 先に入った', 'claude/issue-17', at(-1 * DAY), ['a.ts']), // Merge より前：数えない
    mpr(18, 'feat: y', 'claude/fix-b', at(5 * DAY), ['b.ts']), // ブランチで fix：数える
  ];
  assert.deepEqual([...fixPrsFor(base, all)].sort((x, y) => x - y), [11, 15, 18]);
});

test('fixPrsFor：自分自身は数えず、未 Merge の PR は [] を返す', () => {
  const self = mpr(20, 'fix: 自分', 'fix/self', at(0), ['a.ts']);
  assert.deepEqual(fixPrsFor(self, [self]), []);
  const open = mpr(21, 'feat: 未 Merge', 'claude/issue-21', null, ['a.ts']);
  assert.deepEqual(fixPrsFor(open, [open, mpr(22, 'fix: a', 'fix/a', at(DAY), ['a.ts'])]), []);
});

test('isJevLow：status が ok で P(low) が設定の閾値以上のときだけ low', () => {
  assert.equal(isJevLow(config, jevOk(LOW, true)), true);
  assert.equal(isJevLow(config, jevOk(Math.min(1, LOW + 0.05), true)), true);
  assert.equal(isJevLow(config, jevOk(LOW - 0.01, false)), false);
  assert.equal(isJevLow(config, { status: 'skipped', answers: { q1_risk: { low: 1 } } }), false);
  assert.equal(isJevLow(config, { status: 'error', answers: { q1_risk: { low: 1 } } }), false);
  assert.equal(isJevLow(config, { status: 'ok' }), false);
  assert.equal(isJevLow(config, null), false);
  assert.equal(isJevLow(config, undefined), false);
});

test('JEV_ENFORCE_CRITERIA：否定側 20 件以上、low の外れ 0、Jev だけが「可」0', () => {
  assert.deepEqual(JEV_ENFORCE_CRITERIA, { minNegatives: 20, maxJevLowMisses: 0, maxJevOnly: 0 });
});

test('summarize：Jev の low で revert された PR と fix PR が出た PR を外れに数える', () => {
  const rows = [
    row({ acceptance: acc(true, jevOk(0.95, true)), reverted: true }),
    row({ acceptance: acc(true, jevOk(0.95, true)), fixedBy: [99] }),
    row({ acceptance: acc(true, jevOk(0.95, true)) }),
    row({ acceptance: acc(true, jevOk(0.95, true)) }),
  ];
  const s = summarize(config, rows);
  assert.equal(s.jevOk, 4);
  assert.equal(s.jevLow, 4);
  assert.equal(s.jevLowMisses, 2);
  assert.equal(s.jevLowMissRate, 0.5);
  assert.equal(s.jevLowAccuracy, 0.5);
  assert.equal(s.jevMisses, 2);
  assert.equal(s.claudeMisses, 2);
});

test('summarize：Jev が skipped・error・無しの行は Jev の件数に入らない', () => {
  const rows = [
    row({ acceptance: acc(true, { status: 'skipped', detail: 'no key', answers: { q1_risk: { low: 1 } } }), reverted: true }),
    row({ acceptance: acc(true, { status: 'error', detail: '401', allows: true, answers: { q1_risk: { low: 1 } } }), fixedBy: [5] }),
    row({ acceptance: acc(false) }),
    row({ acceptance: null }),
    row({ acceptance: acc(true, jevOk(0.95, true)) }),
  ];
  const s = summarize(config, rows);
  assert.equal(s.total, 5);
  assert.equal(s.judged, 4);
  assert.equal(s.negatives, 1);
  assert.equal(s.jevOk, 1);
  assert.equal(s.jevLow, 1);
  assert.equal(s.jevLowMisses, 0);
  assert.equal(s.jevMisses, 0);
  assert.equal(s.jevOnly, 0);
  // Claude（autoEligible）側の外れは Jev の状態に関わらず数える
  assert.equal(s.claudeMisses, 2);
});

test('summarize：外れ率・一致率。Jev の low・Jev の ok が 0 件なら null', () => {
  const rows = [
    row({ acceptance: acc(true, jevOk(0.95, true)) }), // 一致
    row({ acceptance: acc(false, jevOk(0.1, false)) }), // 一致
    row({ acceptance: acc(false, jevOk(0.95, true)) }), // 不一致（Jev だけが可）
    row({ acceptance: acc(true, jevOk(0.3, false)) }), // 不一致
  ];
  const s = summarize(config, rows);
  assert.equal(s.jevOk, 4);
  assert.equal(s.jevLow, 2);
  assert.equal(s.jevLowMisses, 0);
  assert.equal(s.jevLowMissRate, 0);
  assert.equal(s.jevLowAccuracy, 1);
  assert.equal(s.agreement, 0.5);
  assert.equal(s.jevOnly, 1);

  const none = summarize(config, [row({ acceptance: acc(true, { status: 'skipped' }) })]);
  assert.equal(none.jevLow, 0);
  assert.equal(none.jevLowMissRate, null);
  assert.equal(none.jevLowAccuracy, null);
  assert.equal(none.agreement, null);
});

test('summarize：否定側 20 件・low の外れ 0・Jev だけが可 0 で基準を満たす', () => {
  const s = summarize(config, passingRows());
  assert.equal(s.negatives, 20);
  assert.equal(s.jevLowMisses, 0);
  assert.equal(s.jevOnly, 0);
  assert.deepEqual(s.criteria, { met: true, unmet: [] });
});

test('summarize：否定側 19 件では基準を満たさず、unmet に否定側の不足が出る', () => {
  const rows = passingRows().slice(1);
  const s = summarize(config, rows);
  assert.equal(s.negatives, 19);
  assert.equal(s.criteria.met, false);
  assert.equal(s.criteria.unmet.length, 1);
  assert.ok(s.criteria.unmet[0]!.includes('否定側'), s.criteria.unmet[0]);
});

test('summarize：Jev の low の外れが 1 件あると基準を満たさず、unmet に外れが出る', () => {
  const rows = [...passingRows(), row({ acceptance: acc(true, jevOk(0.97, true)), reverted: true })];
  const s = summarize(config, rows);
  assert.equal(s.negatives, 20);
  assert.equal(s.jevLowMisses, 1);
  assert.equal(s.criteria.met, false);
  assert.equal(s.criteria.unmet.length, 1);
  assert.ok(s.criteria.unmet[0]!.includes('外れ'), s.criteria.unmet[0]);
});

test('summarize：Jev だけが「可」が 1 件あると基準を満たさず、unmet に理由が出る', () => {
  const rows = passingRows();
  rows[0] = row({ acceptance: acc(false, jevOk(0.97, true)) });
  const s = summarize(config, rows);
  assert.equal(s.negatives, 20);
  assert.equal(s.jevOnly, 1);
  assert.equal(s.jevLowMisses, 0);
  assert.equal(s.criteria.met, false);
  assert.equal(s.criteria.unmet.length, 1);
  assert.ok(s.criteria.unmet[0]!.includes('Jev だけが「可」'), s.criteria.unmet[0]);
});

test('summarize：3つとも満たさないと unmet に3行出る', () => {
  const rows = [
    row({ acceptance: acc(false, jevOk(0.97, true)) }),
    row({ acceptance: acc(true, jevOk(0.97, true)), fixedBy: [3] }),
  ];
  const s = summarize(config, rows);
  assert.equal(s.criteria.met, false);
  assert.equal(s.criteria.unmet.length, 3);
  assert.ok(s.criteria.unmet.some((u) => u.includes('否定側')));
  assert.ok(s.criteria.unmet.some((u) => u.includes('外れ')));
  assert.ok(s.criteria.unmet.some((u) => u.includes('Jev だけが「可」')));
});

test('summarize：修正の往復の合計と平均、受け付けられなかった判定の合計', () => {
  const rows = [row({ fixRequests: 0, rejected: 1 }), row({ fixRequests: 2 }), row({ fixRequests: 4, rejected: 2 })];
  const s = summarize(config, rows);
  assert.equal(s.fixRequestsTotal, 6);
  assert.equal(s.fixRequestsAverage, 2);
  assert.equal(s.rejectedTotal, 3);

  const empty = summarize(config, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.fixRequestsTotal, 0);
  assert.equal(empty.fixRequestsAverage, null);
  assert.equal(empty.stallMedianHours, null);
});

test('summarize：停滞時間の中央値（Merge が無ければ close まで、どちらも無い行は除く、偶数個は中央2つの平均）', () => {
  const odd = [
    row({ createdAt: at(0), mergedAt: at(2 * HOUR) }),
    row({ createdAt: at(0), mergedAt: null, closedAt: at(10 * HOUR) }),
    row({ createdAt: at(HOUR), mergedAt: at(5 * HOUR) }),
    row({ createdAt: at(0), mergedAt: null, closedAt: null }),
  ];
  assert.equal(summarize(config, odd).stallMedianHours, 4);
  const even = [...odd, row({ createdAt: at(0), mergedAt: at(6 * HOUR) })];
  assert.equal(summarize(config, even).stallMedianHours, 5);
  assert.equal(summarize(config, [row({ mergedAt: null, closedAt: null })]).stallMedianHours, null);
});

test('renderReport：基準を満たすときは docs/security.md の参照と「**満たす**」、PR ごとの表を出す', () => {
  const rows = passingRows();
  const md = renderReport(summarize(config, rows), rows, 30);
  assert.ok(md.includes('docs/security.md'));
  assert.ok(md.includes('**満たす**'));
  assert.ok(!md.includes('満たさない'));
  for (const r of rows) assert.ok(md.includes(`#${r.pr}`), `#${r.pr} が無い`);
});

test('renderReport：基準を満たさないときは「満たさない」と unmet の各項目を出す', () => {
  const rows = [
    row({ acceptance: acc(false, jevOk(0.97, true)) }),
    row({ acceptance: acc(true, jevOk(0.97, true)), reverted: true }),
  ];
  const s = summarize(config, rows);
  const md = renderReport(s, rows, 7);
  assert.ok(md.includes('docs/security.md'));
  assert.ok(md.includes('満たさない'));
  assert.ok(!md.includes('**満たす**'));
  assert.ok(s.criteria.unmet.length > 0);
  for (const u of s.criteria.unmet) assert.ok(md.includes(u), `unmet の項目が無い: ${u}`);
});
