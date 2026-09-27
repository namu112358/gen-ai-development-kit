import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LABEL_DEFS, MANAGED_PREFIXES, PRIORITY_LABELS, priorityRank } from '../lib/config.ts';
import { buildQueue, type IssueFacts } from '../lib/queue.ts';
import { TITLE_TYPES } from '../lib/title.ts';

const opts = { currentSession: null, now: new Date('2026-09-26T12:00:00Z'), routineClaimTakeoverMinutes: 90, humanClaimStaleHours: 6 };
const issue = (number: number, labels: string[], readyAt = '2026-09-26T00:00:00Z'): IssueFacts => ({
  number, title: 't', labels: ['agent:ready', ...labels], readyAt, claim: null, openBlockers: [],
  gate: null, latestPlanAt: null, planOkByApp: false, openPr: null,
});

test('優先度は5段階で、high・low のラベル名は変わらない', () => {
  assert.deepEqual(PRIORITY_LABELS, {
    highest: 'priority:highest', high: 'priority:high', medium: 'priority:medium', low: 'priority:low', lowest: 'priority:lowest',
  });
  const ranks = ['highest', 'high', 'medium', 'low', 'lowest'].map((p) => priorityRank([`priority:${p}`]));
  assert.deepEqual(ranks, [0, 1, 2, 3, 4]);
});

test('優先度が無ければ medium、複数付いていれば最も高いもの', () => {
  assert.equal(priorityRank([]), priorityRank([PRIORITY_LABELS.medium]));
  assert.equal(priorityRank(['agent:ready']), priorityRank([PRIORITY_LABELS.medium]));
  assert.equal(priorityRank([PRIORITY_LABELS.lowest, PRIORITY_LABELS.high]), priorityRank([PRIORITY_LABELS.high]));
  assert.equal(priorityRank([PRIORITY_LABELS.low, PRIORITY_LABELS.highest, PRIORITY_LABELS.medium]), priorityRank([PRIORITY_LABELS.highest]));
});

test('queue は5段階の優先度 → 先着順に並ぶ', () => {
  const q = buildQueue(
    [
      issue(1, ['priority:lowest'], '2026-09-26T00:00:00Z'),
      issue(2, [], '2026-09-26T01:00:00Z'),
      issue(3, ['priority:low'], '2026-09-26T00:00:00Z'),
      issue(4, ['priority:highest'], '2026-09-26T05:00:00Z'),
      issue(5, ['priority:medium'], '2026-09-26T00:30:00Z'),
      issue(6, ['priority:high'], '2026-09-26T00:00:00Z'),
      issue(7, ['priority:lowest', 'priority:highest'], '2026-09-26T06:00:00Z'),
    ],
    [],
    opts,
    10,
  );
  assert.deepEqual(q.actions.map((a) => ('issue' in a ? a.issue : null)), [4, 7, 6, 5, 2, 3, 1]);
});

test('ラベル定義に priority の5段階と TITLE_TYPES と同じ type:* がある', () => {
  const names = LABEL_DEFS.map((d) => d.name);
  for (const p of Object.values(PRIORITY_LABELS)) assert.ok(names.includes(p), p);
  assert.deepEqual(names.filter((n) => n.startsWith('type:')), TITLE_TYPES.map((t) => `type:${t}`));
  for (const d of LABEL_DEFS) assert.ok(d.description.length <= 100, d.name);
});

test('setup の管理対象の接頭辞に type: が入る', () => {
  assert.ok(MANAGED_PREFIXES.includes('type:'));
  for (const p of ['agent:', 'risk:', 'priority:', 'size:', 'area:', 'plan:', 'review:', 'test:']) assert.ok(MANAGED_PREFIXES.includes(p), p);
});
