// Human Merge の依頼（kind=human-review）の形：先頭は人が Merge する理由1行と確かめること3件まで、ほかは <details> の中。理由の重複の除き方と選ぶ順（Issue #973）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Acceptance } from '../lib/merge-route.ts';
import { DEFAULT_TEST_PATTERNS, detectTestTampering } from '../lib/test-tamper.ts';
import { dedupeHumanMergeReasons, primaryHumanMergeReason, renderHumanReview } from '../gates/apply.ts';

const GUARD = 'ガードレールに触れます: harness/gates/run.ts';
const HOLD = 'auto mode の危険の判定で保留: 認証を変える／秘密を読む';

const acceptance = (patch: Partial<Acceptance> = {}): Acceptance => ({
  version: 1, verdictCommentId: 70, verdictHeadSha: 'h', patchId: 'p', reviewPass: true, riskLevel: 'critical', riskOk: false,
  scopeOk: true, outside: [], guardrail: [], humanMerge: [], autoEligible: false, reasons: ['Risk レベルが critical'], ...patch,
});

const diff = ['diff --git a/harness/test/a.test.ts b/harness/test/a.test.ts', '--- a/harness/test/a.test.ts', '+++ b/harness/test/a.test.ts', '@@ -5,1 +5,1 @@', '-  assert.equal(f(), 2);', '+  assert.equal(f(), 3);', ''].join('\n');
const findings = detectTestTampering(diff, DEFAULT_TEST_PATTERNS);

/** <details> より前（先頭）と、<details> の中 */
const split = (body: string) => {
  const at = body.indexOf('<details>');
  assert.ok(at > 0, '<details> がある');
  return { head: body.slice(0, at), details: body.slice(at) };
};

// ---- dedupeHumanMergeReasons：重複を除いても理由は消さない ----

test('dedupeHumanMergeReasons：3つの接頭辞で同じ理由は1回、接頭辞つきだけの理由は接頭辞を残し、「／」は分けるが保留の理由の続きは分けない', () => {
  const cases: Array<[string[], string[]]> = [
    // 接頭辞なし＋3つの接頭辞 → 接頭辞なしの1回
    [[GUARD, `委任承認でも不可: ${GUARD}`, `auto mode でも不可: ${GUARD}`, `bypass でも不可: ${GUARD}`], [GUARD]],
    // 3つの接頭辞だけ → 1回で、名前を現れた順につないで残す
    [[`委任承認でも不可: ${GUARD}`, `auto mode でも不可: ${GUARD}`, `bypass でも不可: ${GUARD}`], [`委任承認・auto mode・bypass でも不可: ${GUARD}`]],
    // 接頭辞1つだけ → 元の行のまま
    [['auto mode でも不可: Risk レベルが critical'], ['auto mode でも不可: Risk レベルが critical']],
    // 末尾の名前が英字なら半角空白を入れる
    [['委任承認でも不可: X', 'bypass でも不可: X'], ['委任承認・bypass でも不可: X']],
    // 「／」で分けて理由ごとにまとめる（順は最初に現れた順）
    [['委任承認でも不可: A／B', 'B'], ['委任承認でも不可: A', 'B']],
    // 保留の理由から後ろは「／」でつなぎ直して1つに戻す
    [[`auto mode でも不可: A／${HOLD}`], ['auto mode でも不可: A', `auto mode でも不可: ${HOLD}`]],
  ];
  for (const [why, expected] of cases) assert.deepEqual(dedupeHumanMergeReasons(why), expected, why.join(' | '));
});

// ---- primaryHumanMergeReason：選ぶ順 ----

test('primaryHumanMergeReason：ガードレール > humanMergePaths > Risk の答え > Risk レベル > 計画の範囲外 > 先頭、空なら（記録なし）', () => {
  const ordered = [
    'ガードレールに触れます（人が Merge する）: harness/gates/run.ts',
    '人が Merge するパスに触れます（humanMergePaths）: src/auth/login.ts',
    '「外部に公開される挙動が変わるか」の答えが yes',
    'Risk レベルが critical',
    '計画の範囲外のファイルがあります: a.ts',
    HOLD,
  ];
  // 優先の低い順に並べた一覧から、選ばれたものを外していく
  let rest = [...ordered].reverse();
  for (const expected of ordered) {
    assert.equal(primaryHumanMergeReason(rest), expected);
    rest = rest.filter((r) => r !== expected);
  }
  assert.equal(primaryHumanMergeReason([]), '（記録なし）');
});

// ---- renderHumanReview：形 ----

test('renderHumanReview：宛先 → 人が Merge する理由 → 確かめること3件 → 枠 → <details>（懸念点・4件目以降・AC の照合・Risk の根拠・自動 Merge しない理由）', () => {
  const a = acceptance({
    riskRationale: 'API の挙動が変わる',
    humanNotes: { concerns: ['空配列のとき例外'], checkPoints: ['P1', 'P2', 'P3', 'P4'], acNotes: ['AC2 は⑧に任せた'] },
  });
  const why = ['Risk レベルが critical', 'ガードレールに触れます（人が Merge する）: harness/gates/run.ts'];
  const body = renderHumanReview('me', a, why, { findings, relaxed: true });
  const lines = body.split('\n');
  assert.match(lines[0]!, /^@me レビューをお願いします（Human Merge）/);
  assert.deepEqual(lines.slice(1, 6), [
    '- **人が Merge する理由**：ガードレールに触れます（人が Merge する）: harness/gates/run.ts',
    '- **Merge の前に確かめること**：',
    '  1. P1',
    '  2. P2',
    '  3. P3',
  ]);
  const { head, details } = split(body);
  // 枠は先頭の後、<details> の前
  assert.ok(head.indexOf('> [!IMPORTANT]') > head.indexOf('  3. P3'), '枠は確かめることの後');
  for (const x of ['P4', '空配列のとき例外', 'AC2 は⑧に任せた', 'API の挙動が変わる', 'Risk レベルが critical', '### テストの変更']) {
    assert.ok(!head.includes(x), `先頭に ${x} が無い`);
  }
  assert.match(details, /### 懸念点\n- 空配列のとき例外/);
  assert.match(details, /### 見てほしい箇所（4件目以降）\n- P4/);
  assert.match(details, /### AC の照合\n- AC2 は⑧に任せた/);
  assert.match(details, /### Risk の根拠\nAPI の挙動が変わる/);
  assert.match(details, /### 自動 Merge しない理由\n- Risk レベルが critical\n- ガードレールに触れます（人が Merge する）: harness\/gates\/run\.ts/);
  assert.ok(body.trimEnd().endsWith('</details>'));
});

test('renderHumanReview：確かめることがちょうど3件・acNotes なしなら、4件目以降と AC の照合の節は無い', () => {
  const body = renderHumanReview('me', acceptance({ humanNotes: { concerns: [], checkPoints: ['P1', 'P2', 'P3'] } }), ['Risk レベルが critical']);
  assert.doesNotMatch(body, /見てほしい箇所（4件目以降）/);
  assert.doesNotMatch(body, /### AC の照合/);
  assert.doesNotMatch(body, /\[!IMPORTANT\]/);
});

test('renderHumanReview：同じ理由が3つの接頭辞で3回あれば、折りたたみに1回だけ出て、先頭の理由はガードレールが優先される', () => {
  const why = ['Risk レベルが critical', `委任承認でも不可: ${GUARD}`, `auto mode でも不可: ${GUARD}`, `bypass でも不可: ${GUARD}`];
  const body = renderHumanReview('me', acceptance(), why);
  const lines = body.split('\n');
  assert.match(lines[1]!, /^- \*\*人が Merge する理由\*\*：.*ガードレールに触れます: harness\/gates\/run\.ts$/);
  const { details } = split(body);
  assert.equal(details.split(GUARD).length - 1, 1, '折りたたみの中に1回だけ');
  assert.match(details, /- Risk レベルが critical/, 'ほかの理由も残る');
});
