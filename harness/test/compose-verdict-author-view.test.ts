// compose-verdict の --author-view（PR を実装したセッションの見解のファイル）の読み取りと、composeVerdict が見解を agent-verdict の authorView に入れ、
// 見解が無ければ今までと同じ本文、空の見解は誤りになることを確かめる（Issue #426）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { composeVerdict, parseComposeArgs, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const VIEW = 'docs を直すだけで、安全装置には触れていません。';
const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
const risk = { level: 'low', answers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' }, ...patch,
});

test('parseComposeArgs：--author-view <file> を authorViewFile に読む（位置に関わらず）', () => {
  const want = { pr: 5, reviewerFile: 'r.json', riskFile: 'k.json', judgeInput: 'in.txt', authorViewFile: 'view.txt' };
  assert.deepEqual(parseComposeArgs(['5', 'r.json', 'k.json', '--judge-input', 'in.txt', '--author-view', 'view.txt']), { ok: true, value: want });
  assert.deepEqual(parseComposeArgs(['--author-view', 'view.txt', '5', 'r.json', '--judge-input', 'in.txt', 'k.json']), { ok: true, value: want });
  const withModel = parseComposeArgs(['5', 'r.json', 'k.json', '--judge-input', 'in.txt', '--model', 'm', '--author-view', 'view.txt']);
  assert.deepEqual(withModel, { ok: true, value: { ...want, model: 'm' } });
});

test('parseComposeArgs：--author-view が無ければ authorViewFile の欄が無く、値の欠けは誤り', () => {
  const r = parseComposeArgs(['5', 'r.json', 'k.json', '--judge-input', 'in.txt']);
  assert.ok(r.ok);
  assert.ok(!('authorViewFile' in r.value), 'authorViewFile の欄がある');
  assert.equal(parseComposeArgs(['5', 'r.json', 'k.json', '--judge-input', 'in.txt', '--author-view']).ok, false, '値の欠け');
});

test('composeVerdict：authorView を渡すと agent-verdict の authorView に入り、parseVerdict で読み戻せる', () => {
  const r = composeVerdict(input({ authorView: VIEW }));
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  assert.equal((b.value as { authorView?: string }).authorView, VIEW);
  const v = parseVerdict(b.value);
  assert.ok(v.ok);
  assert.equal(v.value.authorView, VIEW);
});

test('composeVerdict：authorView を渡さなければ本文に authorView が出ず、見解ありとの違いは authorView の欄だけ', () => {
  const plain = composeVerdict(input());
  assert.ok(plain.ok);
  assert.ok(!plain.value.includes('"authorView"'), plain.value);
  const viewed = composeVerdict(input({ authorView: VIEW }));
  assert.ok(viewed.ok);
  const a = extractBlock(plain.value, 'agent-verdict');
  const b = extractBlock(viewed.value, 'agent-verdict');
  assert.ok(a.found && a.ok && b.found && b.ok);
  const { authorView: _view, ...rest } = b.value as Record<string, unknown>;
  assert.deepEqual(rest, a.value, '見解のほかの欄が変わった');
});

test('composeVerdict：空（trim して空）・2001 文字の見解は誤り', () => {
  for (const [name, view] of [['空', ''], ['空白だけ', ' \n\t '], ['2001 文字', 'x'.repeat(2001)]] as [string, string][]) {
    assert.equal(composeVerdict(input({ authorView: view })).ok, false, name);
  }
});
