// 判定の人への伝言（humanNotes）の acNotes（AC の照合の帳簿）を parseVerdict・composeVerdict が受け付け、未知の鍵は拒み、agent の文に acNotes と件数の語があることを確かめる（Issue #972）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { composeVerdict, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD, verdict } from './support/gate-fixtures.ts';

const AC_NOTES = ['AC1：parseVerdict が acNotes を読む → harness/test/verdict-human-notes.test.ts で確かめた', 'AC2：未知の鍵を拒む → 同上'];
const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
const risk = { level: 'low', answers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (humanNotes: unknown): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [], humanNotes }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' },
});

test('parseVerdict：humanNotes.acNotes を review.humanNotes.acNotes に読み、acNotes の無い判定は acNotes の鍵なしで読める', () => {
  const base = verdict();
  const withAc = parseVerdict({ ...base, review: { ...base.review, humanNotes: { concerns: ['c'], checkPoints: ['p'], acNotes: AC_NOTES } } });
  assert.ok(withAc.ok, withAc.ok ? '' : withAc.errors.join(' / '));
  assert.deepEqual(withAc.value.review.humanNotes?.acNotes, AC_NOTES);

  const without = parseVerdict({ ...base, review: { ...base.review, humanNotes: { concerns: ['c'], checkPoints: ['p'] } } });
  assert.ok(without.ok, without.ok ? '' : without.errors.join(' / '));
  assert.deepEqual(without.value.review.humanNotes, { concerns: ['c'], checkPoints: ['p'] });
  assert.ok(!('acNotes' in without.value.review.humanNotes!), 'acNotes の鍵がある');
});

test('composeVerdict：humanNotes.acNotes を受け付けて agent-verdict に入れ、humanNotes の未知の鍵（summary）は今までどおり拒む', () => {
  const r = composeVerdict(input({ concerns: [], checkPoints: ['a.ts'], acNotes: AC_NOTES }));
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  const v = parseVerdict(b.value);
  assert.ok(v.ok, v.ok ? '' : v.errors.join(' / '));
  assert.deepEqual(v.value.review.humanNotes?.acNotes, AC_NOTES);

  const unknown = composeVerdict(input({ concerns: [], checkPoints: [], acNotes: AC_NOTES, summary: ['x'] }));
  assert.ok(!unknown.ok && unknown.errors.some((e) => e.includes('reviewer.humanNotes.summary') && e.includes('未知')), unknown.ok ? '通った' : unknown.errors.join(' / '));
});

test('agent の文：reviewer・review-ac-scope は acNotes と「3件」「5件」の語、review-safety は「3件」「5件」の語を持つ', () => {
  const cases: [string, boolean][] = [['reviewer.md', true], ['review-ac-scope.md', true], ['review-safety.md', false]];
  for (const [file, needsAcNotes] of cases) {
    const text = readFileSync(new URL(`../../.claude/agents/${file}`, import.meta.url), 'utf8');
    if (needsAcNotes) assert.ok(text.includes('acNotes'), `${file} に acNotes が無い`);
    assert.match(text, /3\s*件/, `${file} に「3件」が無い`);
    assert.match(text, /5\s*件/, `${file} に「5件」が無い`);
  }
});
