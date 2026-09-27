import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { exemptRecords, exemptState, staleNotified, type ExemptRecord } from '../lib/exempt.ts';
import { APP, config } from './support/gate-fixtures.ts';

const rec = (action: 'labeled' | 'unlabeled', patchId: string, label = 'test:exempt'): ExemptRecord => ({ version: 1, label, action, by: 'me', patchId, headSha: 'a'.repeat(40) });
const comment = (kind: string, value: unknown, login = APP) => ({
  id: 1, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login, type: 'Bot' },
  body: `${appMark(kind)}\n${renderBlock('agent-app', value)}`,
});

test('exemptState：最新の記録が「付けた」で patch-id が同じときだけ valid', () => {
  assert.equal(exemptState([rec('labeled', 'p1')], true, 'p1'), 'valid');
  assert.equal(exemptState([rec('labeled', 'p1')], true, 'p2'), 'stale');
  assert.equal(exemptState([rec('labeled', 'p1')], false, 'p1'), 'off');
  assert.equal(exemptState([], true, 'p1'), 'unrecorded');
  assert.equal(exemptState([rec('labeled', 'p1'), rec('unlabeled', 'p1')], true, 'p1'), 'unrecorded', '外した記録が最新なら効かない');
  assert.equal(exemptState([rec('labeled', 'p1'), rec('unlabeled', 'p1'), rec('labeled', 'p2')], true, 'p2'), 'valid', '付け直すと新しい差分で効く');
  assert.equal(exemptState([rec('labeled', '')], true, ''), 'unrecorded');
});

test('exemptRecords：App が書いた、そのラベルの構造化された記録だけを読む', () => {
  const comments = [
    { ...comment('test-exempt', {}), body: `${appMark('test-exempt')}\n\`test:exempt\` が付けられました（記録）。` },
    comment('test-exempt', rec('labeled', 'forged'), 'someone'),
    comment('review-exempt', rec('labeled', 'r1', 'review:exempt')),
    comment('test-exempt', rec('labeled', 'p1')),
    comment('test-exempt', rec('labeled', 'other', 'review:exempt')),
  ];
  assert.deepEqual(exemptRecords(config, comments, 'test:exempt').map((r) => r.patchId), ['p1']);
  assert.deepEqual(exemptRecords(config, comments, 'review:exempt').map((r) => r.patchId), ['r1']);
  assert.deepEqual(exemptRecords(config, comments, 'plan:exempt'), []);
  assert.deepEqual(exemptRecords(config, comments, 'toString'), []);
});

test('staleNotified：同じラベル・同じ head への通知だけを数える', () => {
  const comments = [comment('exempt-stale', { version: 1, label: 'test:exempt', headSha: 'h1', patchId: 'p', reason: 'stale' })];
  assert.equal(staleNotified(config, comments, 'test:exempt', 'h1'), true);
  assert.equal(staleNotified(config, comments, 'test:exempt', 'h2'), false);
  assert.equal(staleNotified(config, comments, 'review:exempt', 'h1'), false);
  assert.equal(staleNotified(config, [comment('exempt-stale', { version: 1, label: 'test:exempt', headSha: 'h2' }, 'someone')], 'test:exempt', 'h2'), false);
});
