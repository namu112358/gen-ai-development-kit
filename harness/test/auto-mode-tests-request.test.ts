// auto mode でテストを弱める変更を Jev に問う要求の材料（state に Issue・計画・検出した行と前後の差分だけが入る）と、
// 答えのまとめ（欠け・下限未満・下限なしは通さない）・問う大きさの上限を確かめる（Issue #349）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoModeTestsAllows,
  autoModeTestsFindings,
  autoModeTestsRequest,
  buildAutoModeTestsRequest,
  MAX_AUTO_MODE_TESTS_FINDINGS,
  summarizeAutoModeTests,
  type AutoModeTestsFinding,
  type AutoModeTestsInput,
} from '../lib/auto-mode-tests.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';

const base = loadConfig();
/** 実物の harness.config.json の既定値に依存しないよう、下限を明示して重ねる（undefined なら下限なし） */
const withThreshold = (threshold: number | undefined, patch: Partial<HarnessConfig['jev']> = {}): HarnessConfig => {
  const { autoModeTestsProbability: _drop, ...thresholds } = base.jev.thresholds;
  return { ...base, jev: { ...base.jev, ...patch, thresholds: threshold === undefined ? thresholds : { ...thresholds, autoModeTestsProbability: threshold } } };
};
const config = withThreshold(0.9);

const TEST_FILE = 'harness/test/a.test.ts';
/** アサーションの書き換え・skip の追加・テスト定義の削除を1つの hunk に含む差分（前後の行も持つ） */
const DIFF = [
  `diff --git a/${TEST_FILE} b/${TEST_FILE}`,
  `--- a/${TEST_FILE}`,
  `+++ b/${TEST_FILE}`,
  '@@ -10,7 +10,6 @@',
  " test('keep', () => {",
  '-  assert.equal(f(), 2);',
  '+  assert.equal(f(), 3);',
  ' });',
  "-test('a', () => {});",
  "+test.skip('a', () => {});",
  "-test('gone', () => {});",
  ' // CONTEXT_TAIL',
  '',
].join('\n');

const ISSUE = { number: 3, title: 'feat: f を 3 にする', body: 'ISSUE_BODY: f() は 3 を返すように変える' };
const PLAN = 'PLAN_BODY: f() の戻り値を 3 にし、テストの期待値も直す';

const findingsOf = (diff: string) => autoModeTestsFindings(diff, detectTestTampering(diff, DEFAULT_TEST_PATTERNS));
const input = (findings: AutoModeTestsFinding[] = findingsOf(DIFF)): AutoModeTestsInput => ({ issue: ISSUE, plan: PLAN, findings });

// ---- 材料：検出した行と前後の hunk ----

test('autoModeTestsFindings：検出ごとに種類・ファイル・行・変更前・変更後と、その行を含む hunk を材料にする', () => {
  const material = findingsOf(DIFF);
  const kinds = material.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['assertion-changed', 'removed-test', 'skip-added']);

  const assertion = material.find((f) => f.kind === 'assertion-changed')!;
  assert.equal(assertion.file, TEST_FILE);
  assert.equal(assertion.line, 11, '変更前の行番号');
  assert.equal(assertion.before, 'assert.equal(f(), 2);');
  assert.equal(assertion.after, 'assert.equal(f(), 3);');

  const skip = material.find((f) => f.kind === 'skip-added')!;
  assert.equal(skip.before, null, '足された行には変更前が無い');
  assert.equal(skip.after, "test.skip('a', () => {});");

  const removed = material.find((f) => f.kind === 'removed-test')!;
  assert.equal(removed.before, "test('gone', () => {});");
  assert.equal(removed.after, null);

  for (const f of material) {
    assert.ok(f.hunk.includes('@@ -10,7 +10,6 @@'), `${f.kind}: hunk の見出しを含む`);
    assert.ok(f.hunk.includes('CONTEXT_TAIL'), `${f.kind}: 前後の行を含む`);
  }
});

test('autoModeTestsFindings：テストファイルの削除（ファイル単位の検出）は行が null で、そのファイルの diff を材料にする', () => {
  const diff = ['diff --git a/harness/test/b.test.ts b/harness/test/b.test.ts', 'deleted file mode 100644', '--- a/harness/test/b.test.ts', '+++ /dev/null', '@@ -1 +0,0 @@', "-test('b', () => {});", ''].join('\n');
  const [f] = findingsOf(diff);
  assert.equal(f?.kind, 'deleted-file');
  assert.equal(f?.line, null);
  assert.ok(f?.hunk.includes("-test('b', () => {});"), f?.hunk);
});

// ---- 要求：state と問い ----

test('buildAutoModeTestsRequest：state は Issue・計画・検出だけで、Issue の本文・計画の本文・検出した行が入る（PR の本文・コメントは入らない）', () => {
  const material = findingsOf(DIFF);
  const req = buildAutoModeTestsRequest(config, input(material));
  assert.deepEqual(Object.keys(req.state).sort(), ['findings', 'issue', 'plan']);
  assert.deepEqual(req.state.issue, ISSUE);
  assert.equal(req.state.plan, PLAN);
  assert.deepEqual(req.state.findings, material);
  assert.equal(req.model, config.jev.model);
  const json = JSON.stringify(req.state);
  for (const absent of ['pull_request', 'prBody', 'comments', 'verdict']) assert.ok(!json.includes(`"${absent}"`), `state に ${absent} が無い`);
});

test('buildAutoModeTestsRequest：問いは検出ごとに1問（finding_0, finding_1, …）の Noul で、criteria の false に妥当でない例がある', () => {
  const material = findingsOf(DIFF);
  const req = buildAutoModeTestsRequest(config, input(material));
  const keys = Object.keys(req.questions);
  assert.deepEqual(keys, material.map((_, i) => `finding_${i}`));
  for (const [i, k] of keys.entries()) {
    const q = req.questions[k] as { type: string; instructions: string; criteria: { true: string; false: string } };
    assert.equal(q.type, 'noul');
    assert.ok(q.instructions.includes(`findings[${i}]`), `${k} は自分の検出を指す`);
    assert.ok(q.criteria.true.length > 0);
    assert.ok(q.criteria.false.length > 0, `${k} の criteria.false に妥当でない例がある`);
  }
});

// ---- 問う大きさ ----

test('autoModeTestsRequest：検出が0件・上限を超える・state が jev.maxDiffChars を超えると問わない（理由を返す）', () => {
  assert.equal(autoModeTestsRequest(config, input([])).ask, false);

  const one = findingsOf(DIFF)[0]!;
  const many = Array.from({ length: MAX_AUTO_MODE_TESTS_FINDINGS + 1 }, () => ({ ...one }));
  const tooMany = autoModeTestsRequest(config, input(many));
  assert.equal(tooMany.ask, false);
  assert.ok(!tooMany.ask && tooMany.reason.length > 0);

  const atLimit = autoModeTestsRequest(config, input(Array.from({ length: MAX_AUTO_MODE_TESTS_FINDINGS }, () => ({ ...one }))));
  assert.equal(atLimit.ask, true, '上限ちょうどは問う');

  const small = withThreshold(0.9, { maxDiffChars: 100 });
  const tooBig = autoModeTestsRequest(small, input());
  assert.equal(tooBig.ask, false);
  assert.ok(!tooBig.ask && tooBig.reason.length > 0);

  const ok = autoModeTestsRequest(config, input());
  assert.equal(ok.ask, true);
  assert.ok(ok.ask && Object.keys(ok.request.questions).length === 3);
});

// ---- 答えのまとめ ----

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'skip-added' as const, file: TEST_FILE, line: i + 1 }));
const noul = (p: number) => ({ type: 'noul', noul: p });

test('summarizeAutoModeTests：すべての検出が下限以上なら通し、検出ごとの確率と最小値を返す', () => {
  const s = summarizeAutoModeTests(config, { finding_0: noul(0.95), finding_1: noul(0.92) }, lines(2));
  assert.deepEqual(s.findings.map((f) => f.probability), [0.95, 0.92]);
  assert.equal(s.probability, 0.92);
  assert.equal(s.threshold, 0.9);
  assert.equal(s.allows, true);
  assert.equal(summarizeAutoModeTests(config, { finding_0: noul(0.9) }, lines(1)).allows, true, '下限ちょうどは通す');
});

test('summarizeAutoModeTests：1つでも下限未満なら通さない', () => {
  const s = summarizeAutoModeTests(config, { finding_0: noul(0.99), finding_1: noul(0.5) }, lines(2));
  assert.equal(s.probability, 0.5);
  assert.equal(s.allows, false);
});

test('summarizeAutoModeTests：答えが欠けた検出があれば、その確率は null で通さない', () => {
  const s = summarizeAutoModeTests(config, { finding_0: noul(0.99) }, lines(2));
  assert.equal(s.findings[1]?.probability, null);
  assert.equal(s.probability, null);
  assert.equal(s.allows, false);
  assert.equal(summarizeAutoModeTests(config, { finding_0: noul(NaN) }, lines(1)).allows, false, '有限でない確率も欠けとみなす');
});

test('summarizeAutoModeTests・autoModeTestsAllows：下限（jev.thresholds.autoModeTestsProbability）が無ければ通さない', () => {
  const none = withThreshold(undefined);
  const s = summarizeAutoModeTests(none, { finding_0: noul(1) }, lines(1));
  assert.equal(s.threshold, null);
  assert.equal(s.allows, false);
  assert.equal(autoModeTestsAllows(none, 1), false);
  assert.equal(autoModeTestsAllows(config, null), false);
  assert.equal(autoModeTestsAllows(config, 0.95), true);
});
