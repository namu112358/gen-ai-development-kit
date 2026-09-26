import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { acceptanceItems, parseIssueBody, SECTIONS } from '../lib/issue-form.ts';

const formYaml = readFileSync(new URL('../../.github/ISSUE_TEMPLATE/agent-task.yml', import.meta.url), 'utf8');

/** フォームの textarea の label と required を順に取り出す（依存なしの簡易読み取り） */
function formFields(): { label: string; required: boolean }[] {
  return formYaml.split(/\n  - type: /).slice(1).filter((b) => b.startsWith('textarea')).map((block) => ({
    label: block.match(/\n\s+label: (.+)/)![1]!.trim(),
    required: /\n\s+required: true/.test(block),
  }));
}

/** GitHub が Issue Forms から生成する本文を再現する */
function renderForm(values: Record<string, string>): string {
  return formFields().map((f) => `### ${f.label}\n\n${values[f.label] || '_No response_'}`).join('\n\n');
}

test('フォームの項目とパーサの SECTIONS が一致する', () => {
  assert.deepEqual(formFields(), SECTIONS.map((s) => ({ label: s.label, required: s.required })));
});

test('フォームが出力する本文を読める', () => {
  const body = renderForm({
    Goal: 'ログ出力を JSON にする',
    Requirements: '- JSON で出す',
    'Acceptance Criteria': '- [ ] `log()` が JSON を出す\n- [x] 既存テストが通る\n1. 番号付き',
  });
  const r = parseIssueBody(body);
  assert.ok(r.ok);
  assert.equal(r.contract.goal, 'ログ出力を JSON にする');
  assert.equal(r.contract.background, '');
  assert.deepEqual(acceptanceItems(r.contract), ['`log()` が JSON を出す', '既存テストが通る', '番号付き']);
});

test('CRLF と本文中のコードブロックを扱える', () => {
  const body = renderForm({ Goal: 'g', Requirements: '```\n## not heading\n```', 'Acceptance Criteria': '- a' }).replace(/\n/g, '\r\n');
  const r = parseIssueBody(body);
  assert.ok(r.ok);
  assert.equal(r.contract.requirements, '```\n## not heading\n```');
});

test('必須項目が空・欠落なら読めない', () => {
  const r = parseIssueBody(renderForm({ Goal: 'g' }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('Requirements')));
  const r2 = parseIssueBody('自由記述の Issue');
  assert.ok(!r2.ok && r2.errors.length === 3);
  assert.equal(parseIssueBody(null).ok, false);
});
