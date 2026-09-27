import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reasonMark, reasonOf, REASON_CODES } from '../lib/config.ts';
import { classifyBase, stackOf } from '../lib/stack.ts';
import { STACK } from './support/stack-fixtures.ts';

const MAIN = 'main';

test('stackOf：stack のキーが無い・null ならスタックでない（null）', () => {
  assert.equal(stackOf({ base: { ref: 'main' } }), null);
  assert.equal(stackOf({ base: { ref: 'main' }, stack: null }), null);
});

test('stackOf：形が正しければその値を返す', () => {
  assert.deepEqual(stackOf({ base: { ref: 'feature/base' }, stack: STACK }), STACK);
});

test('stackOf：形が崩れていれば malformed', () => {
  const broken: unknown[] = [
    {},
    'x',
    { base: null, id: 1, number: 1, position: 1, size: 1 },
    { id: 1, number: 1, position: 1, size: 1 },
    { ...STACK, base: { ref: 1, sha: 'c' } },
    { ...STACK, base: { sha: 'c' } },
    { ...STACK, base: { ref: 'main' } },
    { ...STACK, id: '1' },
    { ...STACK, number: null },
    { ...STACK, position: '2' },
    { ...STACK, size: undefined },
  ];
  for (const stack of broken) assert.equal(stackOf({ base: { ref: 'main' }, stack }), 'malformed', JSON.stringify(stack));
});

test('classifyBase：スタックでなく base が既定ブランチなら default', () => {
  assert.equal(classifyBase({ base: { ref: MAIN } }, MAIN), 'default');
  assert.equal(classifyBase({ base: { ref: MAIN }, stack: null }, MAIN), 'default');
});

test('classifyBase：スタックでないのに base が既定ブランチ以外なら orphan-base', () => {
  assert.equal(classifyBase({ base: { ref: 'feature/base' } }, MAIN), 'orphan-base');
  assert.equal(classifyBase({ base: { ref: 'feature/base' }, stack: null }, MAIN), 'orphan-base');
});

test('classifyBase：stack.base.ref が既定ブランチのスタックは stacked（上の層も一番下の層も）', () => {
  assert.equal(classifyBase({ base: { ref: 'feature/base' }, stack: STACK }, MAIN), 'stacked');
  assert.equal(classifyBase({ base: { ref: MAIN }, stack: { ...STACK, position: 1 } }, MAIN), 'stacked');
});

test('classifyBase：stack.base.ref が既定ブランチでないスタックは orphan-base と見分ける', () => {
  const stack = { ...STACK, base: { ref: 'develop', sha: 'c'.repeat(40) } };
  assert.equal(classifyBase({ base: { ref: 'feature/base' }, stack }, MAIN), 'orphan-base');
  assert.equal(classifyBase({ base: { ref: 'develop' }, stack: { ...stack, position: 1 } }, MAIN), 'orphan-base');
});

test('classifyBase：stack の形が崩れていれば orphan-base（base が既定ブランチでも）', () => {
  assert.equal(classifyBase({ base: { ref: MAIN }, stack: { id: 1 } }, MAIN), 'orphan-base');
  assert.equal(classifyBase({ base: { ref: 'feature/base' }, stack: 'x' }, MAIN), 'orphan-base');
});

test('classifyBase：既定ブランチは引数で決まる（main 決め打ちでない）', () => {
  assert.equal(classifyBase({ base: { ref: 'trunk' } }, 'trunk'), 'default');
  assert.equal(classifyBase({ base: { ref: 'main' } }, 'trunk'), 'orphan-base');
});

test('理由コード orphan-base があり、reasonMark と reasonOf が往復する', () => {
  assert.ok(Object.hasOwn(REASON_CODES, 'orphan-base'));
  assert.equal(reasonOf(`前置き\n${reasonMark('orphan-base')}\n本文`), 'orphan-base');
});
