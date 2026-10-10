/**
 * 判定の⑨（過剰さ）のブロッキング指摘を Jev に問う純粋関数（harness/lib/overbuild-jev.ts。Issue #583、Epic #497）。
 * - 選別：⑨の種類だけを拾い、0件・上限超え・diff の文字数超えでは問わない
 * - 要求の state は diff・findings（kind・file・detail）と、recent_diff があるときだけ recent_diff。recent_* もそのときだけ問う
 * - 答えが欠けた指摘は block・wouldBlock が null で外さない
 * - enforce で下限未満の⑨だけを外して pass を決め直す。shadow・下限なしでは外さない。元の判定は変えない
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { JevAnswers } from '../lib/jev.ts';
import { OVERBUILD_MAX_FINDINGS } from '../lib/review-panel.ts';
import { RISK_QUESTIONS, type BlockingFinding, type Verdict } from '../lib/verdict.ts';
import { applyOverbuildJev, askableOverbuild, buildOverbuildRequest, overbuildBlocking, summarizeOverbuildJev } from '../lib/overbuild-jev.ts';

const base = loadConfig();
/** 実物の harness.config.json の既定値に依存しないよう、Jev の設定を明示して重ねる。threshold に null を渡すと overbuildBlockProbability を設定しない */
const withOverbuild = (mode: 'off' | 'shadow' | 'enforce', threshold: number | null, maxDiffChars = base.jev.maxDiffChars): HarnessConfig => {
  const { overbuildBlockProbability: _drop, ...thresholds } = base.jev.thresholds;
  return { ...base, jev: { ...base.jev, maxDiffChars, overbuild: mode, thresholds: threshold === null ? thresholds : { ...thresholds, overbuildBlockProbability: threshold } } };
};

/** block_<i> の noul の答え（undefined は欠け） */
const blocks = (...ps: (number | undefined)[]): JevAnswers =>
  Object.fromEntries(ps.flatMap((p, i) => (p === undefined ? [] : [[`block_${i}`, { type: 'noul', noul: p }]])));

const OVER_IMPL: BlockingFinding = { kind: 'over-implementation', file: 'harness/lib/a.ts', detail: '使われない分岐を足している' };
const OVER_TEST: BlockingFinding = { kind: 'over-testing', file: 'harness/test/a.test.ts', detail: '文言を固定するだけのテスト' };
const OVER_ENG: BlockingFinding = { kind: 'over-engineering', detail: '一度しか使わない抽象' };
const BUG: BlockingFinding = { kind: 'bug', file: 'harness/lib/b.ts', detail: '境界で落ちる' };

const safeAnswers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'];
const verdictWith = (blocking: BlockingFinding[]): Verdict => ({
  version: 1,
  pr: 7,
  headSha: 'a'.repeat(40),
  review: { pass: blocking.length === 0, blocking, nonBlocking: ['命名'] },
  risk: { level: 'low', answers: safeAnswers, rationale: 'r' },
  facts: { references: 'なし', tests: 't', fileKinds: 'code' },
});

// (1) 選別と問えるか
test('overbuildBlocking は⑨の種類だけを元の順で返し、askableOverbuild は0件・上限超え・文字数超えで問わない', () => {
  assert.deepEqual(overbuildBlocking(verdictWith([OVER_IMPL, BUG, OVER_TEST, OVER_ENG])), [OVER_IMPL, OVER_TEST, OVER_ENG]);

  const config = withOverbuild('shadow', 0.7, 100);
  const over = Array.from({ length: OVERBUILD_MAX_FINDINGS + 1 }, () => OVER_IMPL);
  const cases: { name: string; findings: BlockingFinding[]; diff: string; recent: string | null; ask: boolean }[] = [
    { name: '1件', findings: [OVER_IMPL], diff: 'x'.repeat(60), recent: null, ask: true },
    { name: '0件', findings: [], diff: 'x', recent: null, ask: false },
    { name: '上限超え', findings: over, diff: 'x', recent: null, ask: false },
    { name: 'diff+recentDiff が maxDiffChars 超え', findings: [OVER_IMPL], diff: 'x'.repeat(60), recent: 'y'.repeat(50), ask: false },
  ];
  for (const c of cases) {
    const r = askableOverbuild(config, c.findings, c.diff, c.recent);
    assert.equal(r.ask, c.ask, c.name);
    if (!r.ask) assert.ok(r.reason.length > 0, `${c.name} の理由`);
  }
});

// (2) 要求の state と問い
test('buildOverbuildRequest：state は diff・findings（kind・file・detail）・recent_diff だけで、recent_diff が無ければ recent_* を問わない', () => {
  const config = withOverbuild('shadow', 0.7);
  const extra = { ...OVER_IMPL, authorView: 'セッションの言い分', facts: 'x' } as unknown as BlockingFinding;

  const withRecent = buildOverbuildRequest(config, 'DIFF', [extra], 'RECENT');
  assert.deepEqual(Object.keys(withRecent.state).sort(), ['diff', 'findings', 'recent_diff']);
  assert.equal(withRecent.state.diff, 'DIFF');
  assert.equal(withRecent.state.recent_diff, 'RECENT');
  for (const f of withRecent.state.findings) assert.deepEqual(Object.keys(f).sort(), ['detail', 'file', 'kind']);
  assert.deepEqual(Object.keys(withRecent.questions).sort(), ['block_0', 'recent_0']);

  for (const recent of [null, '']) {
    const r = buildOverbuildRequest(config, 'DIFF', [OVER_IMPL], recent);
    assert.deepEqual(Object.keys(r.state).sort(), ['diff', 'findings'], `recentDiff=${JSON.stringify(recent)}`);
    assert.deepEqual(Object.keys(r.questions), ['block_0'], `recentDiff=${JSON.stringify(recent)}`);
  }
});

// (3) 答えの欠け
test('summarizeOverbuildJev：block_<i> の答えが欠けた指摘は block・wouldBlock が null で demoted は偽', () => {
  const r = summarizeOverbuildJev(withOverbuild('enforce', 0.7), 'jev-test', blocks(0.9), [OVER_IMPL, OVER_TEST], false);
  assert.equal(r.status, 'ok');
  assert.equal(r.findings.length, 2);
  assert.equal(r.findings[1]!.block, null);
  assert.equal(r.findings[1]!.wouldBlock, null);
  assert.equal(r.findings[1]!.demoted, false);
});

// (4) enforce での組み替えと shadow
test('applyOverbuildJev：enforce で下限未満の⑨だけを外して nonBlocking に回し、pass を決め直す。元の判定は変えず、shadow では外さない', () => {
  const enforce = withOverbuild('enforce', 0.7);
  const mixed = verdictWith([OVER_IMPL, BUG, OVER_TEST]);
  const snapshot = structuredClone(mixed);
  const record = summarizeOverbuildJev(enforce, 'jev-test', blocks(0.3, 0.9), overbuildBlocking(mixed), false);
  const out = applyOverbuildJev(mixed, record);
  assert.deepEqual(out.review.blocking, [BUG, OVER_TEST]);
  assert.equal(out.review.pass, false);
  assert.equal(out.review.nonBlocking.length, snapshot.review.nonBlocking.length + 1);
  assert.ok(out.review.nonBlocking.some((s) => s.includes(OVER_IMPL.detail)), '外した⑨は nonBlocking に回る');
  assert.deepEqual(mixed, snapshot, '元の判定は変えない');

  const onlyOver = verdictWith([OVER_IMPL]);
  const onlyOut = applyOverbuildJev(onlyOver, summarizeOverbuildJev(enforce, 'jev-test', blocks(0.3), overbuildBlocking(onlyOver), false));
  assert.deepEqual(onlyOut.review.blocking, []);
  assert.equal(onlyOut.review.pass, true);

  const shadowRecord = summarizeOverbuildJev(withOverbuild('shadow', 0.7), 'jev-test', blocks(0.3, 0.9), overbuildBlocking(mixed), false);
  assert.deepEqual(applyOverbuildJev(mixed, shadowRecord), snapshot);
});

// (5) 下限なし
test('applyOverbuildJev：overbuildBlockProbability が無ければ enforce でも外さない', () => {
  const v = verdictWith([OVER_IMPL]);
  const record = summarizeOverbuildJev(withOverbuild('enforce', null), 'jev-test', blocks(0.01), overbuildBlocking(v), false);
  assert.ok(record.findings.every((f) => f.wouldBlock === null && f.demoted === false));
  assert.deepEqual(applyOverbuildJev(v, record), v);
});
