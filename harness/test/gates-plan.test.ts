import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { onComment } from '../gates/on-comment.ts';
import { onIssue } from '../gates/on-issue.ts';
import { APP, CRITIQUE, critiqueClaim, ctxFor, pr, acceptanceFake, planGateComment } from './support/gate-fixtures.ts';

test('計画ゲート：通過なら plan-ok と計画の写し、停止なら plan-review', async () => {
  const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'], critique: CRITIQUE };
  const event = (p: unknown) => ({
    action: 'created',
    issue: { number: 3, labels: [{ name: 'agent:ready' }], state: 'open' },
    comment: { id: 80, body: renderBlock('agent-plan', p), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  });
  // 批評の関所を通る計画（critique と、計画より前の段階 plan-critique の宣言）
  const comments = [critiqueClaim(), planGateComment];
  const fake = acceptanceFake({ pr: pr(), issueComments: comments });
  await onComment(ctxFor(fake, 'issue_comment', event(plan)));
  assert.deepEqual(fake.writes(), ['label+agent:plan-ok', 'label+area:docs', 'comment:plan-gate', 'check:agent/plan-link=success'], '計画を投稿したら、その Issue を Closes する PR の plan-link を書き直す');
  assert.match(fake.calls.find((c) => c.path.endsWith('/issues/3/comments') && c.method === 'POST')!.body.body, /"files": \[\s*"docs\/a.md"/);

  const stop = acceptanceFake({ pr: pr(), issueComments: comments });
  await onComment(ctxFor(stop, 'issue_comment', event({ ...plan, openQuestions: ['?'] })));
  assert.deepEqual(stop.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate', 'check:agent/plan-link=success'], '人の判断待ちの計画も計画ありとみなす');
});

test('App 以外が付けた plan-ok は外す', async () => {
  const fake = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(fake, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: 'me' }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'comment:plan-ok-removed']);
  const byApp = acceptanceFake({ pr: pr() });
  await onIssue(ctxFor(byApp, 'issues', { action: 'labeled', label: { name: 'agent:plan-ok' }, sender: { login: APP }, issue: { number: 3, body: '', labels: [], state: 'open' } }));
  assert.equal(byApp.calls.length, 0);
});
