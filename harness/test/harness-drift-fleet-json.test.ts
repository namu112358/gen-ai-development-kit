// Issue #405：fleet-status --json は読み込みの古さ（harnessDrift、git fetch を走らせる）を調べない。
// fleetStatusText で harnessDrift( を if (json) の分岐の後ろに置き、watchNotes の戻り値に recorded を返さないことをソースで確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const FLEET_STATUS = 'harness/scripts/agent/commands/fleet-status.ts';

const source = (): string => readFileSync(join(root, FLEET_STATUS), 'utf8').replace(/\r\n/g, '\n');

/** text の from 以降で open（例：`if (json)`）から始まり、行末の { から波かっこの対応が取れるまでの本体と、その終わりの位置 */
function block(text: string, open: string, from = 0): { body: string; start: number; end: number } {
  const start = text.indexOf(open, from);
  assert.ok(start >= 0, `「${open}」がありません`);
  // 引数の型の { … } を飛ばし、行末の { から数える
  const brace = text.indexOf('{\n', start + open.length);
  let depth = 0;
  for (let i = brace; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return { body: text.slice(start, i + 1), start, end: i + 1 };
  }
  assert.fail(`「${open}」の本体が閉じていません`);
}

test('fleetStatusText は、if (json) の分岐で harnessDrift を呼ばず、分岐の後ろで呼ぶ', () => {
  const fn = block(source(), 'async function fleetStatusText').body;
  const json = block(fn, 'if (json)');
  assert.ok(!json.body.includes('harnessDrift('), 'if (json) の分岐の中で harnessDrift( を呼んでいます');
  const call = fn.indexOf('harnessDrift(');
  assert.ok(call >= 0, 'fleetStatusText で harnessDrift( を呼んでいません');
  assert.ok(call > json.end, 'harnessDrift( が if (json) の分岐より前にあります（--json でも git fetch が走ります）');
});

test('watchNotes の戻り値に recorded が無い', () => {
  const fn = block(source(), 'function watchNotes').body;
  const ret = fn.slice(fn.lastIndexOf('return '));
  assert.ok(!ret.includes('recorded'), `watchNotes の戻り値に recorded があります：${ret.split('\n')[0]}`);
});
