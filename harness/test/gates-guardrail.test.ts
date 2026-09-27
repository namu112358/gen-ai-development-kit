import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/** 計画の files を差し替えた受け付けの偽物（変更ファイルも差し替える） */
function fakeWith(planned: string[], files: { filename: string; previous_filename?: string }[]): FakeGitHub {
  const gate = {
    id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: planned } })}`,
  };
  return acceptanceFake({ pr: pr(), dashboardLabels: [] })
    .on('GET', /\/issues\/3\/comments/, () => [gate])
    .on('GET', /\/pulls\/5\/files/, () => files.map((f) => ({ ...f, additions: 1, deletions: 1 })));
}

const acceptanceBody = (fake: FakeGitHub): string =>
  String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments') && /kind=acceptance/.test(c.body.body))!.body.body);

test('ガードレールに触れる PR は、low の判定でも auto-merge を付けず、理由を受け付けのコメントに書く', async () => {
  const fake = fakeWith(['harness/gates/**'], [{ filename: 'harness/gates/run.ts' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.equal(w.at(-1), 'check:agent/review=success', 'Human Merge は通す');
  const body = acceptanceBody(fake);
  assert.match(body, /Human Merge/);
  assert.match(body, /ガードレールに触れます（人が Merge する）: harness\/gates\/run\.ts/);
  assert.match(body, /"guardrail": \[\s*"harness\/gates\/run\.ts"/);
});

test('一覧自身（harness.config.json）の変更と、ガードレールからのリネームも当たる', async () => {
  for (const files of [[{ filename: 'harness.config.json' }], [{ filename: 'docs/moved.md', previous_filename: 'docs/risk-policy.md' }]]) {
    const fake = fakeWith(['harness.config.json', 'docs/**'], files);
    await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
    assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), files[0]!.filename);
    assert.match(acceptanceBody(fake), /ガードレールに触れます/);
  }
});

test('ガードレールに触れない PR は、従来どおり Risk Agent の答えで決まる', async () => {
  const low = fakeWith(['harness/scripts/agent.ts', 'CLAUDE.md'], [{ filename: 'harness/scripts/agent.ts' }, { filename: 'CLAUDE.md' }]);
  await onComment(ctxFor(low, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
  assert.ok(low.writes().includes('enablePullRequestAutoMerge'));
  assert.match(acceptanceBody(low), /\| ガードレール \| 触れない \|/);
  assert.doesNotMatch(acceptanceBody(low), /ガードレールに触れます/);

  const medium = fakeWith(['harness/scripts/agent.ts'], [{ filename: 'harness/scripts/agent.ts' }]);
  await onComment(ctxFor(medium, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict({ risk: { ...verdict().risk, level: 'medium' } })))));
  assert.ok(!medium.writes().includes('enablePullRequestAutoMerge'));
  assert.doesNotMatch(acceptanceBody(medium), /ガードレールに触れます/);
});

const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['harness/lib/plan.ts'] };
const planEvent = (p: unknown) => ({
  action: 'created',
  issue: { number: 3, labels: [{ name: 'agent:ready' }], state: 'open' },
  comment: { id: 80, body: renderBlock('agent-plan', p), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});
const gateBody = (fake: FakeGitHub): string => String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments'))!.body.body);

test('計画ゲート（App）：files がガードレールに触れると、想定 Risk が low でも plan-review で止める', async () => {
  const fake = acceptanceFake({ pr: pr() });
  await onComment(ctxFor(fake, 'issue_comment', planEvent(plan)));
  assert.deepEqual(fake.writes().slice(0, 3), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate']);
  assert.match(gateBody(fake), /reason code=high-risk/);
  assert.match(gateBody(fake), /ガードレールに触れます.*harness\/lib\/plan\.ts/);

  const ok = acceptanceFake({ pr: pr() });
  await onComment(ctxFor(ok, 'issue_comment', planEvent({ ...plan, files: ['harness/lib/usage.ts'] })));
  assert.equal(ok.writes()[0], 'label+agent:plan-ok', '除外したファイルは止めない');
});
