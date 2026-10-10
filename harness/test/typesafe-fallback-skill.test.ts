// Issue #442：plan の skill の手順3と implement の skill の手順10に、typesafe の skill が使えなかったときの扱い（計画の本文・PR の「あなたに確かめてほしいこと」に書く、代わりに読むもの）があることを確かめる（語句は要点だけ）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

/** 行頭が `<n>. ` の番号付きの項から、行頭が `<n+1>. ` か `## ` の行の前までを切り出す（implement-plan-return-skill.test.ts と同じ） */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(`${n + 1}. `) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 語句がすべて text の中にあることを確かめる（implement-plan-return-skill.test.ts と同じ） */
function assertWords(text: string, words: string[], what: string): void {
  assert.ok(text !== '', `${what}がありません`);
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

test('plan の skill の手順3：typesafe の skill を使ったか・使えなかったかを計画の本文に書き、docs/setup.md を案内する', () => {
  assertWords(
    step(readRoot('.claude', 'skills', 'plan', 'SKILL.md'), 3),
    ['typesafe', '使えなかった', '使った', '計画の本文', 'docs/setup.md'],
    'plan の skill の手順3',
  );
});

test('implement の skill の手順10：typesafe の skill が使えなかったら PR の「あなたに確かめてほしいこと」に書き、代わりに読んだものを示す', () => {
  assertWords(
    step(readRoot('.claude', 'skills', 'implement', 'SKILL.md'), 10),
    ['typesafe', '使えなかった', 'あなたに確かめてほしいこと', 'docs.typesafe.ai', 'harness/lib/jev.ts'],
    'implement の skill の手順10',
  );
});
