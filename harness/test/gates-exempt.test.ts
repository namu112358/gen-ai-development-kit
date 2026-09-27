import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import { patchId } from '../lib/patch-id.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { APP, DIFF, HEAD, ctxFor, pr, acceptanceFake } from './support/gate-fixtures.ts';

/** 例外ラベルは付けた時点の差分（patch-id）にだけ効く */

const SKIP_DIFF = "diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-test('a', () => {});\n+test.skip('a', () => {});\n";
const MORE_SKIP_DIFF = `${SKIP_DIFF}diff --git a/b.test.ts b/b.test.ts\n--- a/b.test.ts\n+++ b/b.test.ts\n@@ -1 +1 @@\n-test('b', () => {});\n+test.skip('b', () => {});\n`;
const BOTH = [{ name: 'test:exempt' }, { name: 'review:exempt' }];

let nextId = 100;
const appComment = (kind: string, value: unknown) => ({
  id: nextId++, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark(kind)}\n${renderBlock('agent-app', value)}`,
});
const record = (label: string, diff: string, action: 'labeled' | 'unlabeled' = 'labeled') =>
  appComment(label === 'test:exempt' ? 'test-exempt' : 'review-exempt', { version: 1, label, action, by: 'me', patchId: patchId(diff), headSha: 'c'.repeat(40) });

/** 現在の差分と PR のコメントを差し替えた偽の GitHub。diffs は head ごとの差分（無ければ current） */
function fakeWith(current: string, opts: { labels?: { name: string }[]; prComments?: unknown[]; draft?: boolean; autoMerge?: boolean; diffs?: Record<string, string> } = {}) {
  return acceptanceFake({ pr: pr({ labels: opts.labels ?? [], draft: opts.draft ?? true, auto_merge: opts.autoMerge ? { enabled: true } : null }), dashboardLabels: [], prComments: opts.prComments ?? [] })
    .on('GET', /\/compare\/[^.]+\.\.\.(\w+)/, (m, _b, o) => (o.raw ? opts.diffs?.[m[1]!] ?? current : { behind_by: 0 }));
}
const sync = { action: 'synchronize', pull_request: { number: 5 } };
const posted = (fake: ReturnType<typeof fakeWith>, kind: string) =>
  fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments') && String(c.body.body).includes(`kind=${kind} `));

test('付けた後、差分が同じ push では例外が効き続ける（両方のラベル）', async () => {
  const fake = fakeWith(SKIP_DIFF, { labels: BOTH, draft: false, prComments: [record('test:exempt', SKIP_DIFF), record('review:exempt', SKIP_DIFF)] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  const w = fake.writes();
  assert.ok(w.includes('check:agent/tests=success'));
  assert.ok(w.includes('check:agent/review=success'));
  assert.ok(!w.includes('check:agent/tests=failure') && !w.includes('check:agent/review=failure'));
  assert.ok(!w.includes('comment:exempt-stale'));
  assert.ok(!w.includes('convertPullRequestToDraft'), '有効な review:exempt では Draft に戻さない');
});

test('差分が変わる push で例外が無効になり、チェックを評価し直して知らせる', async () => {
  const fake = fakeWith(MORE_SKIP_DIFF, { labels: BOTH, draft: false, autoMerge: true, prComments: [record('test:exempt', SKIP_DIFF), record('review:exempt', SKIP_DIFF)] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  const w = fake.writes();
  assert.equal(w[0], 'disablePullRequestAutoMerge', '最初に auto-merge を解除する');
  assert.ok(w.includes('check:agent/tests=failure'), 'agent/tests は通常の検査');
  assert.ok(!w.includes('check:agent/tests=success'));
  assert.ok(w.includes('check:agent/review=failure'), 'agent/review は判定待ち');
  assert.ok(!w.includes('check:agent/review=success'));
  assert.ok(w.includes('convertPullRequestToDraft'));
  const notices = posted(fake, 'exempt-stale');
  assert.equal(notices.length, 2);
  for (const n of notices) {
    assert.match(n.body.body, /付け直して/);
    const block = extractBlock(n.body.body, 'agent-app');
    assert.ok(block.found && block.ok);
    assert.equal((block.value as { headSha: string }).headSha, HEAD);
    assert.equal((block.value as { reason: string }).reason, 'stale');
  }
});

test('効いていないことの通知は同じ head に二重に書かない', async () => {
  const prComments = [
    record('test:exempt', SKIP_DIFF),
    appComment('exempt-stale', { version: 1, label: 'test:exempt', headSha: HEAD, patchId: patchId(MORE_SKIP_DIFF), reason: 'stale' }),
  ];
  const fake = fakeWith(MORE_SKIP_DIFF, { labels: [{ name: 'test:exempt' }], prComments });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.ok(fake.writes().includes('check:agent/tests=failure'));
  assert.ok(!fake.writes().includes('comment:exempt-stale'));
});

test('差分が変わっても、同じ差分に受け付け済みの判定があればその結果を書く', async () => {
  const acceptance = { version: 1, verdictCommentId: 70, verdictHeadSha: HEAD, patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: true, reasons: [] };
  const fake = fakeWith(DIFF, { labels: [{ name: 'review:exempt' }], draft: false, prComments: [record('review:exempt', SKIP_DIFF), appComment('acceptance', acceptance)] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  const w = fake.writes();
  assert.ok(w.includes('check:agent/review=success'));
  assert.ok(!w.includes('check:agent/review=failure'), '判定待ちで上書きしない');
  assert.ok(w.includes('comment:exempt-stale'));
});

test('ラベルを外して付け直すと、新しい差分で例外が効く', async () => {
  const off = fakeWith(MORE_SKIP_DIFF, { prComments: [record('test:exempt', SKIP_DIFF)] });
  await onPullRequest(ctxFor(off, 'pull_request_target', { action: 'unlabeled', label: { name: 'test:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  assert.ok(off.writes().includes('comment:test-exempt') && off.writes().includes('check:agent/tests=failure'));

  const on = fakeWith(MORE_SKIP_DIFF, { labels: [{ name: 'test:exempt' }], prComments: [record('test:exempt', SKIP_DIFF), record('test:exempt', MORE_SKIP_DIFF, 'unlabeled')] });
  await onPullRequest(ctxFor(on, 'pull_request_target', { action: 'labeled', label: { name: 'test:exempt' }, sender: { login: 'me' }, pull_request: { number: 5, head: { sha: HEAD } } }));
  assert.ok(on.writes().includes('check:agent/tests=success'));
  const rec = posted(on, 'test-exempt')[0]!;
  const block = extractBlock(rec.body.body, 'agent-app');
  assert.ok(block.found && block.ok);
  assert.deepEqual(block.value, { version: 1, label: 'test:exempt', action: 'labeled', by: 'me', patchId: patchId(MORE_SKIP_DIFF), headSha: HEAD });

  // 付け直した記録が最新なら、同じ差分の push でも効き続ける
  const pushed = fakeWith(MORE_SKIP_DIFF, { labels: [{ name: 'test:exempt' }], prComments: [record('test:exempt', SKIP_DIFF), record('test:exempt', MORE_SKIP_DIFF, 'unlabeled'), record('test:exempt', MORE_SKIP_DIFF)] });
  await onPullRequest(ctxFor(pushed, 'pull_request_target', sync));
  assert.ok(pushed.writes().includes('check:agent/tests=success'));
});

test('記録の無いラベル（この仕組みの前に付けたもの）は効かない', async () => {
  const fake = fakeWith(SKIP_DIFF, { labels: BOTH, draft: false });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'opened', pull_request: { number: 5 } }));
  const w = fake.writes();
  assert.ok(w.includes('check:agent/tests=failure'));
  assert.ok(w.includes('check:agent/review=failure'));
  assert.ok(w.includes('convertPullRequestToDraft'));
  const notices = posted(fake, 'exempt-stale');
  assert.equal(notices.length, 2);
  for (const n of notices) {
    const block = extractBlock(n.body.body, 'agent-app');
    assert.ok(block.found && block.ok);
    assert.equal((block.value as { reason: string }).reason, 'unrecorded');
  }
});

test('App 以外が書いた記録は信頼しない', async () => {
  const forged = { ...record('test:exempt', SKIP_DIFF), user: { login: 'me', type: 'User' }, author_association: 'OWNER' };
  const fake = fakeWith(SKIP_DIFF, { labels: [{ name: 'test:exempt' }], prComments: [forged] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', sync));
  assert.ok(fake.writes().includes('check:agent/tests=failure'));
});

test('付けた時点の head（イベントの中身）の差分で記録し、その後の push の差分には効かせない', async () => {
  const LABELED_HEAD = 'd'.repeat(40);
  const fake = fakeWith(MORE_SKIP_DIFF, { labels: [{ name: 'test:exempt' }], diffs: { [LABELED_HEAD]: SKIP_DIFF } });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'labeled', label: { name: 'test:exempt' }, sender: { login: 'me' }, pull_request: { number: 5, head: { sha: LABELED_HEAD } } }));
  const block = extractBlock(posted(fake, 'test-exempt')[0]!.body.body, 'agent-app');
  assert.ok(block.found && block.ok);
  assert.equal((block.value as { patchId: string }).patchId, patchId(SKIP_DIFF));
  assert.equal((block.value as { headSha: string }).headSha, LABELED_HEAD);
  assert.ok(fake.writes().includes('check:agent/tests=failure'));
  assert.ok(fake.writes().includes('comment:exempt-stale'));
});

test('review:exempt を付けた時点の差分で記録し、agent/review を通す', async () => {
  const fake = fakeWith(DIFF, { labels: [{ name: 'review:exempt' }] });
  await onPullRequest(ctxFor(fake, 'pull_request_target', { action: 'labeled', label: { name: 'review:exempt' }, sender: { login: 'me' }, pull_request: { number: 5 } }));
  const block = extractBlock(posted(fake, 'review-exempt')[0]!.body.body, 'agent-app');
  assert.ok(block.found && block.ok);
  assert.deepEqual(block.value, { version: 1, label: 'review:exempt', action: 'labeled', by: 'me', patchId: patchId(DIFF), headSha: HEAD });
  assert.ok(fake.writes().includes('check:agent/review=success'));
});
