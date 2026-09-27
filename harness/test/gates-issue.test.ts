import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onIssue } from '../gates/on-issue.ts';
import { ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

test('Issue が閉じたら進み具合のラベルを外す（hold は残す）', async () => {
  const fake = acceptanceFake({ pr: pr() })
    .on('POST', /\/graphql/, () => ({ data: { repository: { issue: { blocking: { nodes: [] }, parent: null } } } }));
  await onIssue(ctxFor(fake, 'issues', { action: 'closed', sender: { login: 'me' }, issue: { number: 3, body: '', state: 'closed', labels: [{ name: 'agent:ready' }, { name: 'agent:in-pr' }, { name: 'agent:hold' }, { name: 'risk:low' }] } }));
  const w = fake.writes().filter((x) => x.startsWith('label-'));
  assert.deepEqual(w, ['label-agent:ready', 'label-agent:in-pr']);
});

test('形式でない Issue タイトルは agent:ready で blocked になる', async () => {
  const fake = acceptanceFake({ pr: pr() });
  const body = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
  await onIssue(ctxFor(fake, 'issues', { action: 'labeled', label: { name: 'agent:ready' }, sender: { login: 'me' }, issue: { number: 3, title: '用語集に追加', body, labels: [], state: 'open' } }));
  assert.deepEqual(fake.writes(), ['label+agent:blocked', 'comment:form-error']);
});
