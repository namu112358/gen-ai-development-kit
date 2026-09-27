import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { auditLabels } from '../lib/label-rules.ts';

const config = loadConfig();
const issue = (title: string, labels: string[], subIssues = 0) => auditLabels(config, { kind: 'issue', title, labels, subIssues });
const pr = (title: string, labels: string[]) => auditLabels(config, { kind: 'pr', title, labels });

test('必須ラベルが揃った Issue・PR は問題なし', () => {
  assert.deepEqual(issue('feat(harness): x', ['type:feat', 'area:harness', 'priority:medium', 'agent:ready']), { missing: [], violations: [] });
  assert.deepEqual(pr('fix: y', ['type:fix', 'area:docs', 'size:S']), { missing: [], violations: [] });
});

test('Issue は type・area・priority の不足を返す', () => {
  const r = issue('feat: x', ['agent:ready']);
  assert.deepEqual(r.missing, ['type:feat', 'area:*', 'priority:*']);
  assert.deepEqual(r.violations, []);
});

test('PR は type・area・size の不足を返し、priority は求めない', () => {
  const r = pr('docs: x', []);
  assert.deepEqual(r.missing, ['type:docs', 'area:*', 'size:*']);
  assert.deepEqual(r.violations, []);
});

test('設定に無い area・size のラベルは付いていないものとして扱う', () => {
  assert.deepEqual(pr('docs: x', ['type:docs', 'area:unknown', 'size:huge']).missing, ['area:*', 'size:*']);
});

test('子を持つ Issue（Epic）は type が無くても不足としない', () => {
  assert.deepEqual(issue('feat: epic', ['epic', 'area:harness', 'priority:high'], 3), { missing: [], violations: [] });
});

test('子を持つ Issue に type がある、epic が無いのは違反', () => {
  const withType = issue('feat: epic', ['epic', 'type:feat', 'area:harness', 'priority:high'], 2);
  assert.deepEqual(withType.missing, []);
  assert.equal(withType.violations.length, 1);
  assert.match(withType.violations[0]!, /type:feat/);

  const noEpic = issue('feat: epic', ['area:harness', 'priority:high'], 2);
  assert.deepEqual(noEpic.missing, [], '子を持つ Issue に type を求めない');
  assert.equal(noEpic.violations.length, 1);
  assert.match(noEpic.violations[0]!, /epic/);
});

test('epic ラベルがあれば子が 0 でも Epic として扱う（子課題を作る途中）', () => {
  assert.deepEqual(issue('feat: epic', ['epic', 'area:harness', 'priority:low'], 0), { missing: [], violations: [] });
  const withType = issue('feat: epic', ['epic', 'type:feat', 'area:harness', 'priority:low'], 0);
  assert.equal(withType.violations.length, 1);
  assert.match(withType.violations[0]!, /type:feat/);
});

test('Epic でも area と priority の不足は返す', () => {
  assert.deepEqual(issue('feat: epic', ['epic'], 1).missing, ['area:*', 'priority:*']);
});

test('優先度が2つ以上は違反', () => {
  const r = issue('fix: x', ['type:fix', 'area:harness', 'priority:high', 'priority:low']);
  assert.deepEqual(r.missing, []);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0]!, /priority:high/);
  assert.match(r.violations[0]!, /priority:low/);
});

test('type がタイトルと食い違うのは違反（Issue・PR とも）', () => {
  const i = issue('feat: x', ['type:fix', 'area:harness', 'priority:medium']);
  assert.deepEqual(i.missing, []);
  assert.equal(i.violations.length, 1);
  assert.match(i.violations[0]!, /type:fix/);
  assert.match(i.violations[0]!, /feat/);
  assert.equal(pr('docs: x', ['type:feat', 'area:docs', 'size:XS']).violations.length, 1);
});

test('type が2つ以上は、1つがタイトルと合っていても違反', () => {
  const r = issue('feat: x', ['type:feat', 'type:fix', 'area:harness', 'priority:medium']);
  assert.deepEqual(r.missing, []);
  assert.equal(r.violations.length, 1);
});

test('タイトルの形式違いは違反で、type の不足は type:* として返す', () => {
  const r = issue('タイトルだけ', ['area:harness', 'priority:medium']);
  assert.deepEqual(r.missing, ['type:*']);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0]!, /タイトル/);
  const p = pr('Update README', ['type:docs', 'area:docs', 'size:XS']);
  assert.deepEqual(p.missing, []);
  assert.equal(p.violations.length, 1, 'タイトルが読めなければ食い違いは判定しない');
});

test('違反は重なれば全部返す', () => {
  const r = issue('feat: x', ['type:fix', 'area:harness', 'priority:high', 'priority:highest'], 1);
  // 子を持つのに epic が無い・Epic に type がある・優先度が2つ以上
  assert.equal(r.violations.length, 3);
});
