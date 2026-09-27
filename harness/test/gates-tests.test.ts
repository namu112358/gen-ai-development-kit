import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onPullRequest } from '../gates/on-pr.ts';
import { HEAD, ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";

/** 差分だけ差し替えた偽の GitHub */
function fakeWith(diff: string, patch: Record<string, unknown> = {}) {
  return acceptanceFake({ pr: pr(patch), dashboardLabels: [] }).on('GET', /\/compare\//, (_m, _b, o) => (o.raw ? diff : { behind_by: 0 }));
}

const testsCheck = (fake: ReturnType<typeof fakeWith>) => fake.calls.find((c) => c.path.endsWith('/check-runs') && c.body.name === 'agent/tests')?.body;

test('agent/tests：push のたびに書き、テストを弱める変更はファイルと行を付けて failure', async () => {
  const ng = fakeWith(SKIP_DIFF);
  await onPullRequest(ctxFor(ng, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  const body = testsCheck(ng);
  assert.equal(body.conclusion, 'failure');
  assert.equal(body.head_sha, HEAD);
  assert.match(body.output.summary, /`a\.test\.ts:1`/);

  const ok = fakeWith('diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1 @@\n-a\n+b\n');
  await onPullRequest(ctxFor(ok, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  assert.ok(ok.writes().includes('check:agent/tests=success'));
});

test('agent/tests：fork の PR にも書く', async () => {
  const fake = fakeWith(SKIP_DIFF, { head: { ref: 'x', sha: HEAD, repo: { full_name: 'evil/r' } } });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(w.includes('check:agent/tests=failure'));
  assert.ok(w.indexOf('check:agent/tests=failure') < w.findIndex((x) => x.startsWith('check:merge-route')), 'fork の早い return より前に書く');
});

test('test:exempt を付けると agent/tests を通し、App が記録する。外すと検査し直す', async () => {
  const on = fakeWith(SKIP_DIFF, { labels: [{ name: 'test:exempt' }] });
  await onPullRequest(ctxFor(on, 'pull_request_target', { action: 'labeled', label: { name: 'test:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(on.writes().includes('comment:test-exempt') && on.writes().includes('check:agent/tests=success'));

  const pushed = fakeWith(SKIP_DIFF, { labels: [{ name: 'test:exempt' }] });
  await onPullRequest(ctxFor(pushed, 'pull_request_target', { action: 'synchronize', pull_request: { number: 5 } }));
  assert.ok(pushed.writes().includes('check:agent/tests=success'), '付いている間は push しても success');

  const off = fakeWith(SKIP_DIFF);
  await onPullRequest(ctxFor(off, 'pull_request_target', { action: 'unlabeled', label: { name: 'test:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(off.writes().includes('comment:test-exempt') && off.writes().includes('check:agent/tests=failure'));
});

test('agent/tests は関係のないラベルや編集では書かない', async () => {
  const fake = fakeWith(SKIP_DIFF);
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'edited', pull_request: { number: 5 } }));
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'labeled', label: { name: 'agent:hold' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(!fake.writes().some((x) => x.startsWith('check:agent/tests')));
});
