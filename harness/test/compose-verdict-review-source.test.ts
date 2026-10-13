// compose-verdict の --review-source <api|local>・--api-record <URL> の読み取りと誤り、composeVerdict が metrics.reviewSource・metrics.apiReviewRecord と
// 本文の「- レビュー：」の1行を入れ、parseVerdict が metrics を残すこと、指定が無ければ今と同じ本文・metrics になることを確かめる（Issue #1043）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractBlock } from '../lib/blocks.ts';
import { composeVerdict, parseComposeArgs, type ComposeInput } from '../lib/session-inputs.ts';
import { parseVerdict, RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const URL = 'https://review-api.example.workers.dev/records/5/abc';
const BASE = ['5', 'r.json', 'k.json', '--judge-input', 'in.txt'];
const WANT = { pr: 5, reviewerFile: 'r.json', riskFile: 'k.json', judgeInput: 'in.txt' };
const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
// 安全側でない答えを1つ持たせ、「- レビュー：」の行がその答えの行の後に来ることを確かめる
const risk = { level: 'high', answers: { ...answers, q8_harnessConfig: 'yes' }, rationale: '設定に触れる', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (meta: Partial<ComposeInput['meta']> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション', ...meta },
});

test('parseComposeArgs：--review-source api --api-record <URL> と --review-source local を読む（位置に関わらず）', () => {
  const api = { ...WANT, reviewSource: 'api', apiRecord: URL };
  for (const args of [
    [...BASE, '--review-source', 'api', '--api-record', URL],
    ['--api-record', URL, '5', '--review-source', 'api', 'r.json', '--judge-input', 'in.txt', 'k.json'],
  ]) assert.deepEqual(parseComposeArgs(args), { ok: true, value: api }, args.join(' '));
  const local = { ...WANT, reviewSource: 'local' };
  for (const args of [[...BASE, '--review-source', 'local'], ['--review-source', 'local', ...BASE]]) {
    assert.deepEqual(parseComposeArgs(args), { ok: true, value: local }, args.join(' '));
  }
});

test('parseComposeArgs：--review-source・--api-record が無ければ reviewSource・apiRecord の欄が無い', () => {
  const r = parseComposeArgs(BASE);
  assert.ok(r.ok);
  assert.ok(!('reviewSource' in r.value), 'reviewSource の欄がある');
  assert.ok(!('apiRecord' in r.value), 'apiRecord の欄がある');
});

test('parseComposeArgs：--review-source の未知の値・--api-record との組み合わせの誤り・URL でない値は止まる', () => {
  const cases: [string, string[]][] = [
    ['未知の値', ['--review-source', 'remote']],
    ['大文字の値', ['--review-source', 'API', '--api-record', URL]],
    ['--review-source の値の欠け', ['--review-source']],
    ['--api-record だけ', ['--api-record', URL]],
    ['local と --api-record', ['--review-source', 'local', '--api-record', URL]],
    ['api で --api-record 無し', ['--review-source', 'api']],
    ['--api-record が URL でない', ['--review-source', 'api', '--api-record', 'record.json']],
    ['--api-record が http://', ['--review-source', 'api', '--api-record', 'http://review-api.example.workers.dev/records/5']],
    ['--api-record の値の欠け', ['--review-source', 'api', '--api-record']],
  ];
  for (const [name, extra] of cases) assert.equal(parseComposeArgs([...BASE, ...extra]).ok, false, name);
});

test('composeVerdict：api・local で metrics と本文の「- レビュー：」の1行が入り、parseVerdict が metrics を残す', () => {
  const cases: [string, Partial<ComposeInput['meta']>, string, Record<string, string>][] = [
    ['api', { reviewSource: 'api', apiRecord: URL }, `- レビュー：API（${URL}）`, { reviewSource: 'api', apiReviewRecord: URL }],
    ['local', { reviewSource: 'local' }, '- レビュー：ローカル', { reviewSource: 'local' }],
  ];
  for (const [name, meta, line, extra] of cases) {
    const r = composeVerdict(input(meta));
    assert.ok(r.ok, r.ok ? '' : `${name}: ${r.errors.join(' / ')}`);
    const lines = r.value.split('\n');
    const at = lines.indexOf(line);
    assert.ok(at >= 0, `${name}: 本文に「${line}」が無い\n${r.value}`);
    assert.equal(lines.filter((l) => l.startsWith('- レビュー：')).length, 1, `${name}: 「- レビュー：」の行が1行でない`);
    const riskLine = lines.findIndex((l) => l.startsWith('- Risk：'));
    const unsafeLast = lines.findLastIndex((l) => l.startsWith('  - '));
    assert.ok(riskLine >= 0 && unsafeLast > riskLine, `${name}: Risk・安全側でない答えの行が無い`);
    assert.equal(at, unsafeLast + 1, `${name}: 安全側でない答えの行のすぐ後でない`);
    assert.equal(lines[at + 1], '', `${name}: 後ろが空行でない`);
    assert.equal(lines[at + 2], '```agent-verdict', `${name}: 空行の後が agent-verdict のブロックでない`);
    const b = extractBlock(r.value, 'agent-verdict');
    assert.ok(b.found && b.ok, name);
    const metrics = { model: 'm', stage: 'judge', judgedBy: '付き添いのセッション', ...extra };
    assert.deepEqual((b.value as { metrics?: unknown }).metrics, metrics, `${name}: ブロックの metrics`);
    const v = parseVerdict(b.value);
    assert.ok(v.ok, v.ok ? '' : `${name}: ${v.errors.join(' / ')}`);
    assert.deepEqual(v.value.metrics, metrics, `${name}: parseVerdict の後の metrics`);
  }
});

test('composeVerdict：指定が無ければ「- レビュー：」の行が無く、metrics のキーは model・stage・judgedBy だけ', () => {
  const r = composeVerdict(input());
  assert.ok(r.ok, r.ok ? '' : r.errors.join(' / '));
  assert.ok(!r.value.includes('- レビュー：'), r.value);
  const lines = r.value.split('\n');
  const unsafeLast = lines.findLastIndex((l) => l.startsWith('  - '));
  assert.equal(lines[unsafeLast + 1], '', '安全側でない答えの行の後が空行でない');
  assert.equal(lines[unsafeLast + 2], '```agent-verdict');
  const b = extractBlock(r.value, 'agent-verdict');
  assert.ok(b.found && b.ok);
  assert.deepEqual(Object.keys((b.value as { metrics: object }).metrics).sort(), ['judgedBy', 'model', 'stage']);
});
