import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import type { Acceptance, JevRecord } from '../lib/merge-route.ts';
import { jevQuestionStats, renderReport, summarize } from '../lib/report.ts';
import type { JevQuestionStat, ReportRow } from '../lib/report.ts';

const config = loadConfig();
const LOW = config.jev.thresholds.lowProbability;
const SAFE = config.jev.thresholds.noulSafe;
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

const KEYS = ['q1_risk', 'q2_revertible', 'q3_publicInterface', 'q4_tested', 'q5_persistentData', 'q6_authBillingSecrets', 'q7_dependencies', 'q8_harnessConfig'];

type Flat = Record<string, Record<string, number>>;

/** すべての問いがしきい値を満たす記録用の形。over で問いごとに差し替える（null はキーごと消す） */
function flat(over: Record<string, Record<string, number> | null> = {}): Flat {
  const out: Flat = {
    q1_risk: { low: 0.95, medium: 0.05, high: 0, critical: 0 },
    q2_revertible: { yes: 0.97 },
    q3_publicInterface: { yes: 0.02 },
    q4_tested: { yes: 0.95 },
    q5_persistentData: { yes: 0.01 },
    q6_authBillingSecrets: { yes: 0.01 },
    q7_dependencies: { yes: 0 },
    q8_harnessConfig: { yes: 0.05 },
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** status ok の Jev の記録。questionSet が undefined ならキーを入れない（版 1 の古い記録） */
function jev(answers: Flat, questionSet?: number): JevRecord {
  return { status: 'ok', allows: false, answers, ...(questionSet === undefined ? {} : { questionSet }) };
}

/** 受け付け記録の fake（必須フィールドを埋める） */
function acc(autoEligible: boolean, j?: JevRecord): Acceptance {
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
    ...(j ? { jev: j } : {}),
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

/**
 * 版 2 の 5 件、版 1 の 3 件（questionSet 無し 2 件、questionSet 1 が 1 件）、数えない行 4 件。
 *
 * 版 2：
 * - A：q1 0.5 → q1 だけで落ちる
 * - B：q1 0.8、q4 0.5 → q1 と q4 で落ちる
 * - C：q1 0.92、q3 0.3 → q3 だけで落ちる
 * - D：q1 0.95 → 落ちない
 * - E：q1 0.99、q2 がキーごと無い → q2 だけで落ちる
 */
function sampleRows(): ReportRow[] {
  return [
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.5 } }), 2)) }),
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.8 }, q4_tested: { yes: 0.5 } }), 2)) }),
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.92 }, q3_publicInterface: { yes: 0.3 } }), 2)) }),
    row({ acceptance: acc(true, jev(flat({ q1_risk: { low: 0.95 } }), 2)) }),
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.99 }, q2_revertible: null }), 2)) }),
    // 版 1（questionSet 無しは版 1）
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.3 } }))) }),
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.6 } }))) }),
    row({ acceptance: acc(false, jev(flat({ q1_risk: { low: 0.7 } }), 1)) }),
    // 数えない行（受け付けが無い・Jev が無い・skipped・error）
    row({ acceptance: null }),
    row({ acceptance: acc(false) }),
    row({ acceptance: acc(false, { status: 'skipped', detail: 'no key', answers: flat({ q1_risk: { low: 0.01 } }), questionSet: 2 }) }),
    row({ acceptance: acc(false, { status: 'error', detail: '401', answers: flat({ q1_risk: { low: 0.01 } }), questionSet: 2 }) }),
  ];
}

const stat = (stats: JevQuestionStat[], key: string) => {
  const s = stats.find((x) => x.key === key);
  assert.ok(s, `${key} の統計が無い`);
  return s;
};

test('jevQuestionStats：版ごとに昇順で分かれ、questionSet が無い記録は版 1 に入る。Jev が ok でない行・受け付けの無い行は数えない', () => {
  const sets = jevQuestionStats(config, sampleRows());
  assert.deepEqual(sets.map((s) => s.questionSet), [1, 2]);
  assert.equal(sets[0]!.records, 3);
  assert.equal(sets[1]!.records, 5);
  for (const s of sets) assert.deepEqual(s.questions.map((q) => q.key), KEYS);
});

test('jevQuestionStats：版 2 の q1_risk（P(low)）の件数・最小・25%・中央・75%・最大と、落とした件数', () => {
  const v2 = jevQuestionStats(config, sampleRows()).find((s) => s.questionSet === 2)!;
  // 小さい順 [0.5, 0.8, 0.92, 0.95, 0.99]、位置 round(p×4)
  assert.deepEqual(stat(v2.questions, 'q1_risk'), {
    key: 'q1_risk',
    count: 5,
    min: 0.5,
    q25: 0.8,
    median: 0.92,
    q75: 0.95,
    max: 0.99,
    failed: 2,
    onlyFailed: 1,
  });
});

test('jevQuestionStats：版 2 の各 Noul の問いの件数・分布・落とした件数・その問いだけで落とした件数', () => {
  const q = jevQuestionStats(config, sampleRows()).find((s) => s.questionSet === 2)!.questions;

  // q2：E はキーが無いので件数に入らないが、落とした件数には入る（E は q2 だけで落ちる）
  assert.deepEqual(stat(q, 'q2_revertible'), { key: 'q2_revertible', count: 4, min: 0.97, q25: 0.97, median: 0.97, q75: 0.97, max: 0.97, failed: 1, onlyFailed: 1 });

  // q3：[0.02, 0.02, 0.02, 0.02, 0.3]、C は q3 だけで落ちる
  assert.deepEqual(stat(q, 'q3_publicInterface'), { key: 'q3_publicInterface', count: 5, min: 0.02, q25: 0.02, median: 0.02, q75: 0.02, max: 0.3, failed: 1, onlyFailed: 1 });

  // q4：[0.5, 0.95, 0.95, 0.95, 0.95]、B は q1 と q4 で落ちるので「だけ」ではない
  assert.deepEqual(stat(q, 'q4_tested'), { key: 'q4_tested', count: 5, min: 0.5, q25: 0.95, median: 0.95, q75: 0.95, max: 0.95, failed: 1, onlyFailed: 0 });

  for (const key of ['q5_persistentData', 'q6_authBillingSecrets', 'q7_dependencies', 'q8_harnessConfig']) {
    const s = stat(q, key);
    assert.equal(s.count, 5, key);
    assert.equal(s.failed, 0, key);
    assert.equal(s.onlyFailed, 0, key);
  }
});

test('jevQuestionStats：版 1 は版 1 の記録だけで数える', () => {
  const v1 = jevQuestionStats(config, sampleRows()).find((s) => s.questionSet === 1)!;
  const q1 = stat(v1.questions, 'q1_risk');
  assert.equal(q1.count, 3);
  assert.equal(q1.min, 0.3);
  assert.equal(q1.median, 0.6);
  assert.equal(q1.max, 0.7);
  assert.equal(q1.failed, 3);
  assert.equal(q1.onlyFailed, 3);
  const q2 = stat(v1.questions, 'q2_revertible');
  assert.equal(q2.count, 3);
  assert.equal(q2.failed, 0);
});

test('jevQuestionStats：値が1件も無い問いは件数 0 で分布は null、落とした件数には入る', () => {
  const rows = [row({ acceptance: acc(true, jev(flat({ q7_dependencies: null }), 2)) })];
  const [only] = jevQuestionStats(config, rows);
  assert.equal(only!.questionSet, 2);
  assert.deepEqual(stat(only!.questions, 'q7_dependencies'), {
    key: 'q7_dependencies',
    count: 0,
    min: null,
    q25: null,
    median: null,
    q75: null,
    max: null,
    failed: 1,
    onlyFailed: 1,
  });
});

test('jevQuestionStats：NaN の値は件数に入らず、落とした件数に入る', () => {
  const rows = [
    row({ acceptance: acc(true, jev(flat({ q5_persistentData: { yes: NaN } }), 2)) }),
    row({ acceptance: acc(true, jev(flat({ q5_persistentData: { yes: 0.4 } }), 2)) }),
  ];
  const s = stat(jevQuestionStats(config, rows)[0]!.questions, 'q5_persistentData');
  assert.equal(s.count, 1);
  assert.equal(s.min, 0.4);
  assert.equal(s.max, 0.4);
  assert.equal(s.failed, 2);
  assert.equal(s.onlyFailed, 2);
});

test('jevQuestionStats：数える行が無ければ []', () => {
  assert.deepEqual(jevQuestionStats(config, []), []);
  assert.deepEqual(jevQuestionStats(config, [row({ acceptance: null }), row({ acceptance: acc(true, { status: 'skipped' }) })]), []);
});

test('summarize：jevQuestions に版ごとの統計としきい値が入る', () => {
  const rows = sampleRows();
  const s = summarize(config, rows);
  assert.deepEqual(s.jevQuestions.sets, jevQuestionStats(config, rows));
  assert.equal(s.jevQuestions.lowProbability, LOW);
  assert.equal(s.jevQuestions.noulSafe, SAFE);
});

test('renderReport：PR ごとの表の後に「問いごとの確率（Jev）」の節があり、版ごとの表・各問いのキー・落とした件数・しきい値が出る', () => {
  const rows = sampleRows();
  const md = renderReport(summarize(config, rows), rows, 30);
  const head = md.indexOf('## 問いごとの確率（Jev）');
  assert.ok(head >= 0, '節の見出しが無い');
  const lastPr = md.indexOf(`| #${rows.at(-1)!.pr} |`);
  assert.ok(lastPr >= 0 && lastPr < head, '節が PR ごとの表の後に無い');

  const section = md.slice(head);
  assert.ok(section.includes('### 問いの版 1（3 件）'), section);
  assert.ok(section.includes('### 問いの版 2（5 件）'), section);
  assert.ok(section.indexOf('### 問いの版 1') < section.indexOf('### 問いの版 2'));
  assert.ok(section.includes('| 問い | 件数 | 最小 | 25% | 中央 | 75% | 最大 | 落とした件数 | その問いだけで落とした件数 |'));

  const v2 = section.slice(section.indexOf('### 問いの版 2'));
  const lines = v2.split('\n');
  for (const key of KEYS) assert.ok(lines.some((l) => l.startsWith(`| ${key} |`)), `版 2 に ${key} の行が無い`);
  // 落とした件数・その問いだけで落とした件数は行の最後の2セル
  const lastCells = (key: string) => {
    const line = lines.find((l) => l.startsWith(`| ${key} |`))!;
    const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
    return cells.slice(-2);
  };
  assert.deepEqual(lastCells('q1_risk'), ['2', '1']);
  assert.deepEqual(lastCells('q2_revertible'), ['1', '1']);
  assert.deepEqual(lastCells('q3_publicInterface'), ['1', '1']);
  assert.deepEqual(lastCells('q4_tested'), ['1', '0']);
  assert.deepEqual(lastCells('q8_harnessConfig'), ['0', '0']);

  assert.ok(section.includes(String(LOW)), 'lowProbability の値が無い');
  assert.ok(section.includes(String(SAFE)), 'noulSafe の値が無い');
});
