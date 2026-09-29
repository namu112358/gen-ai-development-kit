// Issue #257：README の表を作る extractComment が、.mjs でも .ts と同じく先頭のブロックコメントの要約を取り出すか
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractComment, firstSentence } from '../scripts/readme.ts';

test('.mjs：先頭の JSDoc の1文目を取り出す（@ の行は含めない）', () => {
  const content = [
    '/**',
    ' * hook の入口。Node の版を確かめてから hook を読み込む。',
    ' * @param argv hook のファイルのパス',
    ' */',
    "import { basename } from 'node:path';",
    '',
    'export function f() {}',
    '',
  ].join('\n');
  const raw = extractComment('x.mjs', content);
  assert.ok(raw !== null, '.mjs でも先頭のコメントを読む');
  assert.ok(!raw!.includes('@param'));
  assert.equal(firstSentence(raw!), 'hook の入口。');
});

test('.mjs：import の後の JSDoc も .ts と同じく読む', () => {
  const content = ["import { a } from './a.mjs';", '', '/**', ' * 説明の1文目です。2文目。', ' */', 'export function f() {}'].join('\n');
  const raw = extractComment('x.mjs', content);
  assert.equal(raw, extractComment('x.ts', content));
  assert.equal(firstSentence(raw!), '説明の1文目です。');
});

test('.mjs：先頭に JSDoc が無ければ null（.ts と同じ）', () => {
  const content = ["import { a } from './a.mjs';", '', 'export function f() {}', ''].join('\n');
  assert.equal(extractComment('x.mjs', content), null);
});
