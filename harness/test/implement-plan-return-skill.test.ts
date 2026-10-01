// Issue #472：implement の skill の手順4に、計画に無い設計の判断が要るときは即興で決めずに止まって計画に返す手順があり、AskUserQuestion は人が付き添うセッションで人が決めるときだけ、入れ子の ship は聞かずに計画に返すことを確かめる（語句は要点だけ）。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const readRoot = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const implementSkill = (): string => readRoot('.claude', 'skills', 'implement', 'SKILL.md');

/** 行頭が `<n>. ` の番号付きの項から、行頭が `<n+1>. ` か `## ` の行の前までを切り出す（hq-intel-skill.test.ts と同じ） */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith(`${n + 1}. `) || l.startsWith('## '));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

/** 語句がすべて text の中にあることを確かめる（hq-intel-skill.test.ts と同じ） */
function assertWords(text: string, words: string[], what: string): void {
  assert.ok(text !== '', `${what}がありません`);
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${what}に次の語句がありません：${missing.join('、')}`);
}

test('implement の skill の手順4：計画に無い設計の判断が要るときは止まって計画に返す', () => {
  assertWords(
    step(implementSkill(), 4),
    ['計画に無い設計の判断', '新しいファイル', '公開の形', '計画の `files` の外', '止まる', 'claim <番号> --manual --stage plan', 'plan の skill'],
    'implement の skill の手順4',
  );
});

test('implement の skill の手順4：AskUserQuestion は人が付き添うセッションで人が決めるときだけ、入れ子の ship は聞かずに計画に返す', () => {
  const lines = step(implementSkill(), 4).split('\n');
  const ask = lines.filter((l) => l.includes('AskUserQuestion')).join('\n');
  assertWords(ask, ['人が付き添うセッション', '範囲外のまま出す'], 'implement の skill の手順4の AskUserQuestion を含む行');
  const nested = lines.filter((l) => l.includes('入れ子の ship')).join('\n');
  assertWords(nested, ['聞かずに', '計画に返す'], 'implement の skill の手順4の「入れ子の ship」を含む行');
});
