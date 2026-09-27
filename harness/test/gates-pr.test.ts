import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, HEAD, DIFF, ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

test('push：最初に auto-merge を解除し、差分が同じなら判定を引き継ぐ', async () => {
  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const fake = acceptanceFake({ pr: pr({ auto_merge: { enabled: true }, draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.equal(w[0], 'disablePullRequestAutoMerge', '最初に解除');
  assert.ok(w.indexOf('enablePullRequestAutoMerge') < w.indexOf('check:agent/review=success'));
});

test('push：差分が変わっていれば auto-merge を外したまま、agent/review は書かない', async () => {
  const fake = acceptanceFake({ pr: pr({ auto_merge: { enabled: true }, draft: false }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.equal(w[0], 'disablePullRequestAutoMerge');
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(!w.some((x) => x.startsWith('check:agent/review')));
  assert.ok(w.includes('check:merge-route=success'), 'auto-merge なし＝Human Merge 経路');
});

test('人の PR は判定が出るまで agent/review を書かない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }), dashboardLabels: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(!w.some((x) => x.startsWith('check:agent/review')));
  assert.ok(w.includes('check:agent/plan-link=success') && w.includes('check:merge-route=success'));
});

test('review:exempt を付けると agent/review を通し、App が記録する。外すと判定待ちに戻す', async () => {
  const human = { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } };
  const on = acceptanceFake({ pr: pr({ head: human, labels: [{ name: 'review:exempt' }] }), dashboardLabels: [] });
  await onPullRequest(ctxFor(on, 'pull_request_target', { action: 'labeled', label: { name: 'review:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(on.writes().includes('comment:review-exempt') && on.writes().includes('check:agent/review=success'));
  const off = acceptanceFake({ pr: pr({ head: human }), dashboardLabels: [] });
  await onPullRequest(ctxFor(off, 'pull_request_target', { action: 'unlabeled', label: { name: 'review:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(off.writes().includes('check:agent/review=failure'));
});

test('fork の claude/ ブランチは Agent PR とみなさない', async () => {
  const fake = acceptanceFake({ pr: pr({ head: { ref: 'claude/x', sha: HEAD, repo: { full_name: 'evil/r' } }, auto_merge: { enabled: true } }), dashboardLabels: [] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(fake.writes().includes('check:merge-route=failure'), 'auto-merge が付いていても自動経路に乗らない');
});

test('hold を外すと、条件を満たす判定があれば auto-merge を付け直す', async () => {
  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'unlabeled', label: { name: 'agent:hold' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(w.includes('comment:hold-removed'));
  assert.ok(w.indexOf('enablePullRequestAutoMerge') < w.indexOf('check:agent/review=success'));
});

test('plan-link：計画のある Issue を Closes しない PR は failure、plan:exempt なら success', async () => {
  const none = acceptanceFake({ pr: pr({ head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }) })
    .on('POST', /\/graphql/, (_m, body) => (String(body.query).includes('closingIssuesReferences') ? { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } } : { data: {} }));
  await onPullRequest(ctxFor(none, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(none.writes().includes('check:agent/plan-link=failure'));

  const exempt = acceptanceFake({ pr: pr({ labels: [{ name: 'plan:exempt' }], head: { ref: 'feature/x', sha: HEAD, repo: { full_name: 'o/r' } } }) });
  await onPullRequest(ctxFor(exempt, 'pull_request_target', { action: 'labeled', label: { name: 'plan:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.deepEqual(exempt.writes(), ['check:agent/plan-link=success', 'comment:plan-exempt']);
});

test('判定前に Ready で出された PR は Draft に戻す。判定を引き継げる push と例外ラベルでは戻さない', async () => {
  const ready = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(ready, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(ready.writes().includes('convertPullRequestToDraft') && ready.writes().includes('comment:draft-until-judged'));

  const exempt = acceptanceFake({ pr: pr({ draft: false, labels: [{ name: 'review:exempt' }] }), dashboardLabels: [], prComments: [] });
  await onPullRequest(ctxFor(exempt, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(!exempt.writes().includes('convertPullRequestToDraft'));

  const { patchId } = await import('../lib/patch-id.ts');
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const prComments = [{ id: 91, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('acceptance')}\n${renderBlock('agent-app', acceptance)}` }];
  const carried = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], prComments });
  await onPullRequest(ctxFor(carried, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.ok(!carried.writes().includes('convertPullRequestToDraft'));
});

test('agent/title：PR のタイトルの形式を検査する', async () => {
  const ok = acceptanceFake({ pr: pr({ title: 'fix(harness): 直す' }), dashboardLabels: [] });
  await onPullRequest(ctxFor(ok, 'pull_request_target', { action: 'edited', pull_request: { number: 5 } }));
  assert.equal(ok.writes()[0], 'check:agent/title=success');
  const ng = acceptanceFake({ pr: pr({ title: '直す' }), dashboardLabels: [] });
  await onPullRequest(ctxFor(ng, 'pull_request_target', { action: 'edited', pull_request: { number: 5 } }));
  assert.equal(ng.writes()[0], 'check:agent/title=failure');
});
