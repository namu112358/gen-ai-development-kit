import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanFeedback } from '../lib/facts.ts';
import type { Review } from '../lib/state.ts';

const HEAD = 'a'.repeat(40);
const review = (patch: Partial<Review>): Review => ({
  id: 1, state: 'COMMENTED', body: '直してください', submitted_at: '2026-09-27T01:24:02Z', commit_id: HEAD, author_association: 'OWNER', user: { login: 'me' }, ...patch,
});

test('人の修正依頼は、現在の head に対するレビューだけを数える（時刻は見ない）', () => {
  assert.equal(humanFeedback([review({})], HEAD, 'app[bot]').length, 1, 'push 直後のレビューも数える');
  assert.equal(humanFeedback([review({ commit_id: 'b'.repeat(40) })], HEAD, 'app[bot]').length, 0, '前の head へのレビューは数えない');
});

test('App・Claude・コラボレーター以外・承認は数えない', () => {
  assert.equal(humanFeedback([review({ user: { login: 'app[bot]' } })], HEAD, 'app[bot]').length, 0);
  assert.equal(humanFeedback([review({ body: '<!-- agent-harness:claude -->\n判定' })], HEAD, 'app[bot]').length, 0);
  assert.equal(humanFeedback([review({ author_association: 'NONE' })], HEAD, 'app[bot]').length, 0);
  assert.equal(humanFeedback([review({ state: 'APPROVED' })], HEAD, 'app[bot]').length, 0);
});
