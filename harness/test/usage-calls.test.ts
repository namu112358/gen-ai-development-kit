// Issue #447：usage の呼び出しの回数（countCalls）。fleet の入れ子で ship を段階ごとに新しく呼ぶ前後で、
// 1回あたりのキャッシュの読み込み量を比べるため、応答の数を数える。同じ message.id の行（ストリームの途中と最後）は1回に数える。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countCalls } from '../lib/usage.ts';

const line = (id: string | undefined, input = 10, output = 1): string =>
  JSON.stringify({ type: 'assistant', message: { ...(id === undefined ? {} : { id }), model: 'claude-opus-5-5', usage: { input_tokens: input, output_tokens: output } } });

test('countCalls：応答の数を数え、数えない行を飛ばす', () => {
  const cases: Array<[string, string[], number]> = [
    ['空', [], 0],
    ['id ごとに1回', [line('a'), line('b')], 2],
    ['同じ id の重複は1回', [line('a', 10, 1), line('a', 10, 5), line('b')], 2],
    ['id の無い行は1行1回', [line(undefined), line(undefined)], 2],
    ['assistant 以外は数えない', [JSON.stringify({ type: 'user', message: { id: 'u', usage: { input_tokens: 1, output_tokens: 1 } } }), line('a')], 1],
    ['usage の無い行は数えない', [JSON.stringify({ type: 'assistant', message: { id: 'x', model: 'claude-opus-5-5' } }), line('a')], 1],
    ['壊れた行・空行は数えない', ['{not json', '', line('a')], 1],
  ];
  for (const [name, lines, expected] of cases) assert.equal(countCalls(lines), expected, name);
});
