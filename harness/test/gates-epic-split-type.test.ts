// Issue #573：split で Epic にするとき、App が付けた type:* を外し、人が付けたものは外さない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import type { SplitChild } from '../lib/epic.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, CRITIQUE, critiqueClaim, ctxFor, pr } from './support/gate-fixtures.ts';

const split: SplitChild[] = [
  { title: 'feat(x): 一つ目', goal: 'g1', requirements: ['r1'], acceptanceCriteria: ['a1'], files: ['src/a.ts'], dependsOn: [] },
  { title: 'docs: 二つ目', goal: 'g2', requirements: ['r2'], acceptanceCriteria: ['a2'], files: ['docs/guide/**'], dependsOn: [0] },
];
const plan = { version: 1, issue: 3, risk: 'critical', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [], split, critique: CRITIQUE };
const event = () => ({
  action: 'created',
  issue: { number: 3, labels: [{ name: 'agent:ready' }, { name: 'priority:high' }, { name: 'risk:critical' }, { name: 'type:feat' }], state: 'open' },
  comment: { id: 80, body: renderBlock('agent-plan', plan), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});

/** 親 #3 の分割に要る経路と、#3 のラベルの events を持つ偽の GitHub。子は #100 から番号を振る */
function splitFake(events: unknown[]) {
  const comments: unknown[] = [critiqueClaim()];
  let next = 100;
  return acceptanceFake({ pr: pr() })
    .on('GET', /\/issues\/3\/comments/, () => comments)
    .on('POST', /\/issues\/3\/comments$/, (_m, body) => {
      const c = { id: 500 + comments.length, body: body.body, html_url: 'u', created_at: '', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' } };
      comments.push(c);
      return c;
    })
    .on('GET', /\/issues\/3\/sub_issues/, () => [])
    .on('GET', /\/issues\?state=all&creator=/, () => [])
    .on('POST', /\/repos\/o\/r\/issues$/, (_m, body) => ({ id: 9000 + next, number: next++, body: body.body, labels: [], user: { login: APP } }))
    .on('POST', /\/issues\/3\/sub_issues$/, () => ({}))
    .on('GET', /\/issues\/\d+\/dependencies\/blocked_by/, () => [])
    .on('POST', /\/issues\/\d+\/dependencies\/blocked_by$/, () => ({}))
    .on('GET', /\/issues\/3\/events/, () => events);
}

const labeled = (login: string) => ({ event: 'labeled', created_at: '2026-10-01T00:00:00Z', actor: { login }, label: { name: 'type:feat' } });

test('App が付けた type:* は、epic を付けた後に外す', async () => {
  const fake = splitFake([labeled(APP)]);
  await onComment(ctxFor(fake, 'issue_comment', event()));
  const writes = fake.writes();
  const epic = writes.indexOf('label+epic');
  assert.ok(epic >= 0, 'epic を付ける');
  assert.ok(writes.indexOf('label-type:feat') > epic, `epic の後に type:feat を外す: ${writes.join(' | ')}`);
});

test('人が付けた type:* は外さない（epic は付ける）', async () => {
  const fake = splitFake([labeled('me')]);
  await onComment(ctxFor(fake, 'issue_comment', event()));
  const writes = fake.writes();
  assert.ok(writes.includes('label+epic'));
  assert.ok(!writes.includes('label-type:feat'), `人の type:feat は残す: ${writes.join(' | ')}`);
});
