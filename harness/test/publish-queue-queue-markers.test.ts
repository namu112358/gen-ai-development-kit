// Issue #608：queue の節の目印が壊れていても本文を消さないこと
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QUEUE_END, QUEUE_START, queueMarkersOk, renderQueueSection, replaceQueueSection } from '../gates/publish-queue.ts';
import type { QueueResult } from '../lib/facts.ts';

const q: QueueResult = { computedAt: '2026-10-11T00:00:00.000Z', actions: [], skipped: [] };
const SECTION = renderQueueSection(q);
const HUMAN = '人が書いた本文\n消してはいけない';

const broken: [string, string][] = [
  ['開始だけ', `前\n\n${QUEUE_START}\n${HUMAN}`],
  ['終わりだけ', `前\n${HUMAN}\n${QUEUE_END}\n後`],
  ['開始が2つ', `${QUEUE_START}\n古い\n${QUEUE_START}\n${HUMAN}\n${QUEUE_END}`],
  ['終わりが前', `${QUEUE_END}\n${HUMAN}\n${QUEUE_START}\n後`],
  ['2組', `${QUEUE_START}\n一つ目\n${QUEUE_END}\n${HUMAN}\n${QUEUE_START}\n二つ目\n${QUEUE_END}`],
];

test('replaceQueueSection：目印が壊れた本文はそのまま返す', () => {
  for (const [name, body] of broken) assert.equal(replaceQueueSection(body, SECTION), body, name);
});

test('replaceQueueSection：開始の目印だけの本文に2回続けて適用しても、目印の外の本文が残る', () => {
  const startOnly = broken[0]![1];
  const twice = replaceQueueSection(replaceQueueSection(startOnly, SECTION), SECTION);
  assert.equal(twice, startOnly);
  assert.ok(twice.includes(HUMAN) && twice.startsWith('前'), twice);
});

test('replaceQueueSection：古い節を含む本文から差し替えると節が1つだけになり、前後の本文は残る', () => {
  const body = replaceQueueSection(`前\n\n${QUEUE_START}\n古い queue\n${QUEUE_END}\n\n後`, SECTION);
  assert.ok(!body.includes('古い queue'), body);
  assert.equal(body.split(QUEUE_START).length - 1, 1, '節は1つだけ');
  assert.equal(body, `前\n\n${SECTION}\n\n後`);
});

test('replaceQueueSection：目印の無い本文には末尾に節を1つ足す', () => {
  assert.equal(replaceQueueSection(`${HUMAN}\n\n`, SECTION), `${HUMAN}\n\n${SECTION}`);
});

test('queueMarkersOk：目印がちょうど1組で開始が前のときだけ真', () => {
  assert.equal(queueMarkersOk(`前\n${SECTION}\n後`), true, '1組');
  assert.equal(queueMarkersOk(HUMAN), false, '目印なし');
  for (const [name, body] of broken) assert.equal(queueMarkersOk(body), false, name);
});
