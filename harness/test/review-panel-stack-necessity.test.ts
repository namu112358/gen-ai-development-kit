// Issue #751：合体版のレビュー（review-ac-scope）が、Stacked PR の層が積む条件に当たるかを確かめ、当たらなければ範囲の外の指摘にする
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

/** 番号つきの手順 `n. ` の行から、次の番号の手順か見出しの前までを切り出す */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

const AC_SCOPE = '.claude/agents/review-ac-scope.md';

test('review-ac-scope の手順2は、積む3条件のどれにも当たらない層を out-of-scope にし、既定ブランチ宛ての別の PR を勧める', () => {
  const step2 = step(read(AC_SCOPE), 2);
  assert.ok(step2 !== '', `${AC_SCOPE} に手順2 が無い`);
  for (const w of ['同じファイル', '下の層が足したもの', '`Stack: 理由`', 'out-of-scope', '既定ブランチ宛ての別の PR']) {
    assert.ok(step2.includes(w), `${AC_SCOPE} の手順2 に「${w}」が無い`);
  }
});

test('review-ac-scope の手順2は、スタックの層でない PR と一番下の層を検査しない', () => {
  const step2 = step(read(AC_SCOPE), 2);
  for (const w of ['スタックの層ではありません', '一番下の層']) {
    assert.ok(step2.includes(w), `${AC_SCOPE} の手順2 に「${w}」が無い`);
  }
});

test('review-ac-scope の積む条件は reviewer の手順5 の条件(1)〜(3) と同じ文言', () => {
  const reviewer5 = step(read('.claude/agents/reviewer.md'), 5);
  const conditions = reviewer5
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \([1-3]\) /.test(l));
  assert.equal(conditions.length, 3, 'reviewer.md の手順5 に条件(1)〜(3) の行が3つ無い');
  const acScope = read(AC_SCOPE);
  for (const c of conditions) {
    assert.ok(acScope.includes(c), `${AC_SCOPE} に reviewer の条件「${c}」が無い`);
  }
});

test('review-panel の文書の ⑥ の行に「積む必要」がある', () => {
  const row = read('harness/docs/review-panel.md')
    .split('\n')
    .find((l) => l.startsWith('| 3 ⑥ |'));
  assert.ok(row !== undefined, 'review-panel.md に「| 3 ⑥ |」の行が無い');
  assert.ok(row.includes('積む必要'), 'review-panel.md の ⑥ の行に「積む必要」が無い');
});
