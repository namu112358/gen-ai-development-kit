import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

test('revert の検知：GitHub の Revert ボタンと git revert の両方', () => {
  assert.deepEqual(revertedPrNumbers('Revert "Add foo" (#12)\n\nReverts namu112358/gen-ai-development-kit#11'), [11]);
  assert.deepEqual(revertedShas('Revert "x"\n\nThis reverts commit 0123456789abcdef0123456789abcdef01234567.'), ['0123456789abcdef0123456789abcdef01234567']);
  assert.deepEqual(revertedPrNumbers('fix: normal commit'), []);
});
