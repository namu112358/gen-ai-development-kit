// Issue #469：ship の SKILL.md の節「実装のモデル（fleet から起こされた ship）」が、implementModel で実装だけを動かし、計画・判定・test-designer のモデルを変えないと書くことを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const HEADING = '## 実装のモデル（fleet から起こされた ship）';

/** 見出しの行から、次の `## ` の見出しの前までを切り出す（無ければ空） */
function section(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(HEADING));
  if (start < 0) return '';
  const end = lines.slice(start + 1).findIndex((l) => l.startsWith('## '));
  return lines.slice(start, end < 0 ? undefined : start + 1 + end).join('\n');
}

test('ship の SKILL.md：実装のモデルの節が implementModel で実装を動かし、計画・判定・test-designer は変えないと書く', () => {
  const body = section(readFileSync(join(root, '.claude', 'skills', 'ship', 'SKILL.md'), 'utf8'));
  assert.notEqual(body, '', `${HEADING} の節が無い`);
  for (const word of ['panes.ts config', 'implementModel', 'model', 'test-designer', '--stage plan', '実装のモデル:']) {
    assert.ok(body.includes(word), `節に「${word}」が無い`);
  }
  const keep = body.split('\n').find((l) => l.includes('変えないもの'));
  assert.ok(keep, '「変えないもの」の行が無い');
  for (const word of ['plan-critic', 'judge', 'test-designer']) {
    assert.ok(keep.includes(word), `「変えないもの」の行に「${word}」が無い`);
  }
});
