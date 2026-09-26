import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readQueueSection, renderQueueSection, replaceQueueSection } from '../gates/publish-queue.ts';
import type { QueueResult } from '../lib/facts.ts';

const q: QueueResult = {
  computedAt: '2026-09-27T00:00:00.000Z',
  actions: [{ kind: 'implement', issue: 8, planCommentId: 1, planFiles: ['docs/glossary.md'] }, { kind: 'judge', pr: 9, issue: 8, headSha: 'a'.repeat(40) }],
  skipped: [{ kind: 'skip', target: '#3', reason: '`agent:hold`' }],
};

test('queue 節の書き出しと読み戻し', () => {
  const body = replaceQueueSection('<!-- agent-harness:app kind=dashboard -->\n本文', renderQueueSection(q));
  assert.deepEqual(readQueueSection(body), { version: 1, kind: 'queue', ...q });
  assert.match(body, /1\. #8 実装/);
});

test('queue 節は差し替えられ、ほかの本文は残る', () => {
  const first = replaceQueueSection('先頭', renderQueueSection(q));
  const second = replaceQueueSection(`${first}\n末尾`, renderQueueSection({ ...q, actions: [] }));
  assert.equal(readQueueSection(second)!.actions.length, 0);
  assert.ok(second.startsWith('先頭') && second.endsWith('末尾'));
  assert.equal(second.split('agent-harness:queue:start').length, 2, '節は1つだけ');
});
