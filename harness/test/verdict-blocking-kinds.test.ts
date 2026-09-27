import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { BLOCKING_KINDS, CRITICAL_BLOCKING, fixAllowed, hasCriticalBlocking, parseVerdict, RISK_QUESTIONS, type BlockingFinding, type Verdict } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

// ブロッキング指摘の種類に bug・claude-md を足す（Issue #148）

const safeAnswers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as Verdict['risk']['answers'];

/** ブロッキング指摘を持つ不合格の判定 */
function failing(blocking: BlockingFinding[]): Verdict {
  return {
    version: 1,
    pr: 3,
    headSha: HEAD,
    review: { pass: false, blocking, nonBlocking: [] },
    risk: { level: 'low', answers: safeAnswers, rationale: 'docs のみ' },
    facts: { references: 'なし', tests: 'なし', fileKinds: 'code' },
  };
}

const bug: BlockingFinding = { kind: 'bug', file: 'harness/lib/a.ts', detail: '境界で1つずれる' };
const claudeMd: BlockingFinding = { kind: 'claude-md', file: 'harness/lib/b.ts', detail: 'enum を使っている（CLAUDE.md のコードの書き方に反する）' };

test('BLOCKING_KINDS の末尾に bug・claude-md があり、CRITICAL_BLOCKING は変わらない', () => {
  assert.deepEqual(BLOCKING_KINDS.slice(-2), ['bug', 'claude-md']);
  for (const k of ['ac-unmet', 'out-of-scope', 'typecheck-test-failure', 'data-destruction', 'secret-leak', 'regression']) {
    assert.ok((BLOCKING_KINDS as readonly string[]).includes(k), `既存の種類 ${k} が残る`);
  }
  assert.deepEqual([...CRITICAL_BLOCKING].sort(), ['data-destruction', 'secret-leak', 'typecheck-test-failure']);
});

test('parseVerdict：kind の bug・claude-md を受け付ける', () => {
  for (const finding of [bug, claudeMd]) {
    const r = parseVerdict(failing([finding]));
    assert.ok(r.ok, `${finding.kind} を受け付ける`);
    assert.equal(r.value.review.blocking[0]!.kind, finding.kind);
  }
  const both = parseVerdict(failing([bug, claudeMd]));
  assert.ok(both.ok);
  assert.deepEqual(both.value.review.blocking.map((b) => b.kind), ['bug', 'claude-md']);
});

test('parseVerdict：未知の kind（style など）は拒否する', () => {
  for (const kind of ['style', 'Bug', 'claude_md', '']) {
    const r = parseVerdict({ ...failing([]), review: { pass: false, blocking: [{ kind, detail: 'x' }], nonBlocking: [] } });
    assert.ok(!r.ok, `${JSON.stringify(kind)} を拒否する`);
    assert.ok(r.errors.some((e) => e.includes('verdict.review.blocking[0].kind')), r.errors.join('\n'));
  }
});

const risk = { level: 'low', answers: safeAnswers, rationale: 'コードの変更', facts: { references: 'none', tests: 'none', fileKinds: 'code' } };
const input = (reviewer: unknown): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' },
});

test('composeVerdict：bug・claude-md のブロッキング指摘を持つ reviewer の出力から判定コメントを作れる', () => {
  const r = composeVerdict(input({ pass: false, blocking: [bug, claudeMd], nonBlocking: [] }));
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  assert.ok(r.value.includes('不合格（ブロッキング指摘 2 件）'));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  const v = parseVerdict(b.value);
  assert.ok(v.ok);
  assert.deepEqual(v.value.review.blocking, [bug, claudeMd]);
});

test('composeVerdict：未知の kind の reviewer の出力は拒否する', () => {
  const r = composeVerdict(input({ pass: false, blocking: [{ kind: 'style', detail: 'x' }] }));
  assert.ok(!r.ok && r.errors.some((e) => e.includes('kind')), r.ok ? '' : r.errors.join('\n'));
});

test('hasCriticalBlocking：bug・claude-md だけなら false で、修正は通常の上限（3回目は許さない）', () => {
  const limits = { normalLimit: 2, criticalLimit: 3 };
  for (const blocking of [[bug], [claudeMd], [bug, claudeMd]]) {
    const v = failing(blocking);
    assert.equal(hasCriticalBlocking(v), false, blocking.map((b) => b.kind).join(','));
    assert.equal(fixAllowed(2, hasCriticalBlocking(v), limits), false);
    assert.equal(fixAllowed(1, hasCriticalBlocking(v), limits), true);
  }
  // critical なものと混ざれば critical
  assert.equal(hasCriticalBlocking(failing([bug, { kind: 'secret-leak', detail: 'x' }])), true);
});
