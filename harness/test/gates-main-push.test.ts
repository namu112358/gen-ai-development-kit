import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onMainPush } from '../gates/on-main-push.ts';
import { ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

test('main への push で、auto-merge 待ちでない Agent PR も main に追従させる', async () => {
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], behindBy: 2 });
  fake.on('GET', /\/pulls\?state=open/, () => [pr()]);
  let updated = false;
  fake.on('PUT', /\/pulls\/5\/update-branch/, () => (updated = true));
  await onMainPush(ctxFor(fake, 'push', { commits: [{ id: 'x', message: 'docs: 何か' }] }));
  assert.equal(updated, true);
});
