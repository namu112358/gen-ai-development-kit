import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTitle } from '../lib/title.ts';

test('Conventional Commits の形式として読める', () => {
  assert.deepEqual(parseTitle('feat(harness): queue を公開する'), { ok: true, type: 'feat', scope: 'harness', breaking: false, subject: 'queue を公開する' });
  assert.deepEqual(parseTitle('fix!: 互換性のない修正'), { ok: true, type: 'fix', scope: null, breaking: true, subject: '互換性のない修正' });
  assert.equal(parseTitle('docs(glossary/terms): 追加').ok, true);
});

test('形式でないタイトルは理由付きで拒否する', () => {
  for (const t of ['用語集に追加する', 'Feat: 大文字', 'feat:説明（空白なし）', 'feat(): 空の scope', 'feature: 未知の type', 'feat: ']) {
    const r = parseTitle(t);
    assert.equal(r.ok, false, t);
  }
  const r = parseTitle('wip: 途中');
  assert.ok(!r.ok && r.error.includes('wip'));
});
