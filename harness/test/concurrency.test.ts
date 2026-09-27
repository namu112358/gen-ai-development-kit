import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFullAreas, fullAreas } from '../lib/concurrency.ts';
import { loadConfig } from '../lib/config.ts';
import { decideIssue, type IssueFacts } from '../lib/queue.ts';

const config = { ...loadConfig(), areaConcurrency: { harness: 2 } };
const opts = { currentSession: null, now: new Date('2026-09-26T12:00:00Z'), routineClaimTakeoverMinutes: 90, humanClaimStaleHours: 6 };
const passed: IssueFacts = {
  number: 1, title: 't', labels: ['agent:ready', 'agent:plan-ok'], readyAt: '2026-09-26T00:00:00Z', claim: null, openBlockers: [],
  gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null,
};

test('area:harness の開いた PR が上限に達していれば、harness を触る計画は上限の領域として返す', () => {
  const open = [['area:harness'], ['area:harness', 'area:docs'], ['area:docs']];
  assert.deepEqual(fullAreas(config, ['harness/lib/queue.ts', 'docs/a.md'], open), [{ area: 'harness', open: 2, limit: 2 }]);
  assert.match(describeFullAreas(fullAreas(config, ['harness/lib/queue.ts'], open)), /area:harness.*2\/2/);
});

test('上限に達していない領域や、設定の無い領域には上限をかけない', () => {
  assert.deepEqual(fullAreas(config, ['harness/lib/queue.ts'], [['area:harness']]), []);
  assert.deepEqual(fullAreas(config, ['docs/a.md'], [['area:docs'], ['area:docs'], ['area:docs']]), []);
  assert.deepEqual(fullAreas({ ...config, areaConcurrency: undefined }, ['harness/lib/queue.ts'], [['area:harness'], ['area:harness']]), []);
});

test('queue：上限に達した領域の Issue は implement せず、理由付きで skip する', () => {
  assert.equal(decideIssue(passed, opts).kind, 'implement');
  const skipped = decideIssue({ ...passed, areaFull: '`area:harness` の開いた PR が上限（2/2）' }, opts);
  assert.equal(skipped.kind, 'skip');
  assert.match(skipped.kind === 'skip' ? skipped.reason : '', /上限/);
});
