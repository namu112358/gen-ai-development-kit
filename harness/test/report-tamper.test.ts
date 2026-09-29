import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { ExemptRecord } from '../lib/exempt.ts';
import { renderReport, summarize, tamperDecision, type ReportRow } from '../lib/report.ts';
import type { TamperJevRecord } from '../lib/test-tamper-jev.ts';

/**
 * テストの改ざんの検査で Jev が出した確率と、人の判断との一致率の集計（Issue #126、AC3）。
 * - tamperDecision：PR ごとに最後の test-tamper-jev の記録だけを使い、人の判断を決める
 *   - pass：同じ patch-id に test:exempt を付けた記録がある、または Merge され最後の受け付けの patch-id が同じ
 *   - fix：pass でなく、Merge された（違う差分で Merge）
 *   - null：未 Merge・記録なし・enforce で Jev 自身が通した記録
 * - summarize の tamper：件数・一致・一致率・危険側（Jev は通す・人は直させた）と逆側の件数
 * - renderReport の指標の表に、その3行が出る
 */

const base = loadConfig();
/** 実物の harness.config.json の既定値に依存しないよう、下限を明示して重ねる */
const withThreshold = (threshold: number | undefined): HarnessConfig => {
  const { testTamperProbability: _drop, ...thresholds } = base.jev.thresholds;
  return { ...base, jev: { ...base.jev, testTamper: 'shadow', thresholds: threshold === undefined ? thresholds : { ...thresholds, testTamperProbability: threshold } } };
};
const config = withThreshold(0.9);

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const record = (patchId: string, probability: number, patch: Partial<TamperJevRecord> = {}): TamperJevRecord => ({
  version: 1, patchId, headSha: 'h'.repeat(40), mode: 'shadow', model: 'jev-test', probabilities: [probability], probability, threshold: 0.9, allows: probability >= 0.9, ...patch,
});
const exempt = (patchId: string, action: 'labeled' | 'unlabeled' = 'labeled'): ExemptRecord => ({ version: 1, label: 'test:exempt', action, by: 'me', patchId, headSha: 'h'.repeat(40) });

// ---- tamperDecision ----

test('tamperDecision：同じ patch-id に test:exempt を付けた記録があれば pass（未 Merge でも）', () => {
  assert.deepEqual(tamperDecision([record(A, 0.8)], [exempt(A)], false, null), { probability: 0.8, human: 'pass' });
  assert.deepEqual(tamperDecision([record(A, 0.8)], [exempt(A)], true, B), { probability: 0.8, human: 'pass' });
});

test('tamperDecision：違う差分に付けた test:exempt・外した記録は pass にならない', () => {
  assert.equal(tamperDecision([record(A, 0.8)], [exempt(B)], false, null), null);
  assert.equal(tamperDecision([record(A, 0.8)], [exempt(A, 'unlabeled')], false, null), null);
});

test('tamperDecision：Merge され、最後の受け付けの patch-id が記録と同じなら pass（Human Merge）', () => {
  assert.deepEqual(tamperDecision([record(A, 0.7)], [], true, A), { probability: 0.7, human: 'pass' });
});

test('tamperDecision：Merge されたが、最後の受け付けの差分が記録と違えば fix（付けずに直させた）', () => {
  assert.deepEqual(tamperDecision([record(A, 0.95)], [], true, B), { probability: 0.95, human: 'fix' });
  assert.deepEqual(tamperDecision([record(A, 0.95)], [], true, null), { probability: 0.95, human: 'fix' }, '受け付けの記録が無くても Merge は fix');
});

test('tamperDecision：未 Merge で exempt も無い・記録が無いなら null（集計しない）', () => {
  assert.equal(tamperDecision([record(A, 0.95)], [], false, null), null);
  assert.equal(tamperDecision([record(A, 0.95)], [], false, A), null);
  assert.equal(tamperDecision([], [exempt(A)], true, A), null);
});

test('tamperDecision：記録は最後の1件だけを使う（前の差分の記録は後の判断で置き換わる）', () => {
  const records = [record(A, 0.3), record(B, 0.96)];
  assert.deepEqual(tamperDecision(records, [], true, B), { probability: 0.96, human: 'pass' });
  assert.deepEqual(tamperDecision(records, [exempt(A)], true, A), { probability: 0.96, human: 'fix' }, '前の差分に付けた exempt は最後の記録には効かない');
});

test('tamperDecision：enforce で Jev が通した記録は null（自分で自分を数えない）。enforce で通さなかった記録は数える', () => {
  assert.equal(tamperDecision([record(A, 0.95, { mode: 'enforce', allows: true })], [], true, A), null);
  assert.deepEqual(tamperDecision([record(A, 0.5, { mode: 'enforce', allows: false })], [exempt(A)], true, A), { probability: 0.5, human: 'pass' });
  assert.deepEqual(tamperDecision([record(A, 0.95, { mode: 'shadow', allows: true })], [], true, A), { probability: 0.95, human: 'pass' }, 'shadow の記録は数える');
});

// ---- summarize・renderReport ----

let nextPr = 1;
const row = (tamper: ReportRow['tamper']): ReportRow => ({
  pr: nextPr++, createdAt: '2026-09-01T00:00:00Z', mergedAt: '2026-09-01T01:00:00Z', closedAt: null, acceptance: null,
  rejected: 0, fixRequests: 0, reverted: false, fixedBy: [], tamper,
});

/** 一致 2・Jev は通す／人は直させた 1・Jev は止める／人は通した 1。記録なし（null・未設定）は数えない */
const rows = (): ReportRow[] => [
  row({ probability: 0.95, human: 'pass' }),
  row({ probability: 0.95, human: 'fix' }),
  row({ probability: 0.5, human: 'pass' }),
  row({ probability: 0.5, human: 'fix' }),
  row(null),
  { ...row(null), tamper: undefined },
];

test('summarize：Jev の「通す」（確率 ≥ 下限）と人の判断の一致率と、外れの向きごとの件数', () => {
  const t = summarize(config, rows()).tamper;
  assert.equal(t.rows, 4);
  assert.equal(t.agreed, 2);
  assert.equal(t.agreement, 0.5);
  assert.equal(t.jevPassHumanFix, 1, '危険側（enforce で通してしまう）');
  assert.equal(t.jevFixHumanPass, 1);
});

test('summarize：下限ちょうどは「通す」として数える', () => {
  const t = summarize(config, [row({ probability: 0.9, human: 'pass' })]).tamper;
  assert.equal(t.agreed, 1);
  assert.equal(t.jevFixHumanPass, 0);
});

test('summarize：下限が未設定なら「通す」は0件（すべて止める側）として数える', () => {
  const t = summarize(withThreshold(undefined), rows()).tamper;
  assert.equal(t.rows, 4);
  assert.equal(t.jevPassHumanFix, 0);
  assert.equal(t.jevFixHumanPass, 2);
  assert.equal(t.agreed, 2);
});

test('summarize：集計できる行が無ければ件数 0 で一致率は null', () => {
  const t = summarize(config, [row(null)]).tamper;
  assert.equal(t.rows, 0);
  assert.equal(t.agreement, null);
  assert.equal(t.jevPassHumanFix, 0);
  assert.equal(t.jevFixHumanPass, 0);
});

test('summarize：tamper の無い既存の行の形でも動く（任意の項目）', () => {
  const plain: ReportRow = { pr: 999, createdAt: '2026-09-01T00:00:00Z', mergedAt: null, closedAt: null, acceptance: null, rejected: 0, fixRequests: 0, reverted: false, fixedBy: [] };
  assert.equal(summarize(config, [plain]).tamper.rows, 0);
});

/** 指標の表で、最初の列に label を含む行（「テストの改ざん：」などの前置きがあってもよい） */
const lineOf = (report: string, label: string): string => {
  const line = report.split('\n').find((l) => l.startsWith('| ') && (l.split('|')[1] ?? '').includes(label));
  assert.ok(line, `「${label}」の行がある`);
  return line;
};

test('renderReport：指標の表にテストの改ざんの3行（件数 / 一致率、危険側、逆側）が出る', () => {
  const rs = rows();
  const report = renderReport(summarize(config, rs), rs, 30);
  const agree = lineOf(report, 'テストの改ざん：Jev と人の判断（件数 / 一致率）');
  assert.match(agree, /4 \/ 50%/);
  assert.match(lineOf(report, 'Jev は通す・人は直させた'), /\| 1 \|$/);
  assert.match(lineOf(report, 'Jev は止める・人は通した'), /\| 1 \|$/);
  assert.ok(report.indexOf('テストの改ざん：Jev と人の判断') < report.indexOf('| PR | Merge |'), '指標の表の中（PR ごとの表より前）');
});

test('renderReport：件数が 0 のときは一致率を - で出し、「満たす」「満たさない」の語を足さない', () => {
  const report = renderReport(summarize(config, [row(null)]), [row(null)], 30);
  assert.match(lineOf(report, 'テストの改ざん：Jev と人の判断（件数 / 一致率）'), /0 \/ -/);
  for (const label of ['テストの改ざん：Jev と人の判断（件数 / 一致率）', 'Jev は通す・人は直させた', 'Jev は止める・人は通した']) {
    assert.doesNotMatch(lineOf(report, label), /満たす|満たさない/);
  }
});

test('renderReport：下限が未設定なら、表に使った下限として「未設定」と出す', () => {
  const rs = rows();
  const unset = renderReport(summarize(withThreshold(undefined), rs), rs, 30);
  assert.match(unset, /未設定/);
  const set = renderReport(summarize(config, rs), rs, 30);
  assert.match(set, /0\.9|90%/);
});
