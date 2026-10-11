// Issue #712：Issue・PR を GraphQL を使わずに REST だけで読む入口（harness/lib/gh-rest.ts の restIssueView・restIssueSearch・restPrView・restPrList・restOpenPrsReferencing・prsReferencing）と、
// GitHub.request が /search/ で始まるパスに /repos/{owner}/{repo} を付けないこと（harness/lib/github.ts）を確かめる。
// 偽の GitHub（FakeGitHub）に REST の応答を置き、出力が gh の --json の欄の名前（id は REST の数の ID）になること、GET だけを送り /graphql を呼ばないことを見る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHub } from '../lib/github.ts';
import type { PullRequest } from '../lib/state.ts';
import { prsReferencing, restIssueSearch, restIssueView, restOpenPrsReferencing, restPrList, restPrView } from '../lib/gh-rest.ts';
import { FakeGitHub, HEAD, pr } from './support/gate-fixtures.ts';

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

const issue7 = {
  number: 7, title: 'feat: x', body: '本文', state: 'open', html_url: 'https://github.com/o/r/issues/7',
  labels: [{ name: 'type:feat', color: 'fff' }], user: { login: 'alice', type: 'User' },
};
const issueComments = [
  { id: 101, body: 'c1', html_url: 'u1', created_at: '2026-10-01T00:00:00Z', updated_at: '', author_association: 'OWNER', user: { login: 'alice', type: 'User' } },
  { id: 102, body: 'c2', html_url: 'u2', created_at: '2026-10-02T00:00:00Z', updated_at: '', author_association: 'NONE', user: null },
];
const expectedComments = [
  { id: 101, author: { login: 'alice' }, authorAssociation: 'OWNER', body: 'c1', createdAt: '2026-10-01T00:00:00Z', url: 'u1' },
  { id: 102, author: null, authorAssociation: 'NONE', body: 'c2', createdAt: '2026-10-02T00:00:00Z', url: 'u2' },
];
const COMMENT_KEYS = ['id', 'author', 'authorAssociation', 'body', 'createdAt', 'url'];

const pr9 = pr({
  number: 9, title: 'feat: y', body: 'Closes #7', state: 'open', draft: true, html_url: 'https://github.com/o/r/pull/9',
  labels: [{ name: 'agent:verdict-ok' }],
  auto_merge: { enabled_by: { login: 'alice' }, merge_method: 'squash', commit_title: 't', commit_message: 'm' },
});
const checkRuns = [
  { name: 'test', status: 'completed', conclusion: 'success', details_url: 'd1', started_at: 's1', completed_at: 'e1' },
  { name: 'lint', status: 'in_progress', conclusion: null, details_url: 'd2', started_at: 's2', completed_at: null },
];
const combinedStatus = { state: 'pending', statuses: [{ context: 'ci/x', state: 'pending', target_url: 't1' }] };
const reviews = [
  { id: 301, user: { login: 'bob' }, author_association: 'MEMBER', state: 'APPROVED', body: 'ok', submitted_at: 'r1', commit_id: HEAD },
  { id: 302, user: null, author_association: 'NONE', state: 'COMMENTED', body: '', submitted_at: 'r2', commit_id: HEAD },
];

/** 開いた PR の一覧（closing-prs・prsReferencing 用）。本文と head.repo だけを変える */
const listed = (number: number, body: string | null, repo: string | null = 'o/r') =>
  pr({ number, body, draft: number % 2 === 0, head: { ref: `claude/issue-${number}`, sha: HEAD, repo: repo === null ? null : { full_name: repo } }, base: { ref: 'main', sha: 'b'.repeat(40) } }) as unknown as PullRequest;
const openPrs = [
  listed(1, 'Closes #3'),
  listed(2, 'fixes #3'),
  listed(3, 'Refs #3'),
  listed(4, 'Closes #30'), // 別の番号
  listed(5, 'see #3'), // キーワード無し
  listed(6, 'Closes #3', 'fork/r'), // fork
  listed(7, null),
];
const expectedRefs = [{ number: 1, keyword: 'closes' }, { number: 2, keyword: 'closes' }, { number: 3, keyword: 'refs' }];

/** すべてのサブコマンドの REST を置いた偽の GitHub（/graphql の経路は置かない） */
function restFake(opts: { searchItems?: unknown[] } = {}): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/issues\/7(\?|$)/, () => issue7)
    .on('GET', /^\/repos\/o\/r\/issues\/7\/comments(\?|$)/, () => issueComments)
    .on('GET', /^\/search\/issues\?/, () => ({ total_count: (opts.searchItems ?? []).length, items: opts.searchItems ?? [issue7] }))
    .on('GET', /^\/repos\/o\/r\/pulls\/9(\?|$)/, () => pr9)
    .on('GET', new RegExp(`^/repos/o/r/commits/${HEAD}/check-runs(\\?|$)`), () => ({ total_count: checkRuns.length, check_runs: checkRuns }))
    .on('GET', new RegExp(`^/repos/o/r/commits/${HEAD}/status(\\?|$)`), () => combinedStatus)
    .on('GET', /^\/repos\/o\/r\/issues\/9\/comments(\?|$)/, () => issueComments)
    .on('GET', /^\/repos\/o\/r\/pulls\/9\/reviews(\?|$)/, () => reviews)
    .on('GET', /^\/repos\/o\/r\/pulls\?state=open/, () => openPrs);
}

test('restIssueView：本文・状態・ラベル・作成者とコメント（数の id・author.login・authorAssociation）を gh の --json の欄で出す', async () => {
  const out: any = await restIssueView(new GitHub(restFake(), 'o/r'), 7);
  assert.deepEqual(pick(out, ['number', 'title', 'body', 'state', 'labels', 'author', 'url']), {
    number: 7, title: 'feat: x', body: '本文', state: 'OPEN', labels: [{ name: 'type:feat' }], author: { login: 'alice' }, url: 'https://github.com/o/r/issues/7',
  });
  assert.deepEqual(out.comments.map((c: any) => pick(c, COMMENT_KEYS)), expectedComments);
});

test('restIssueView：閉じた Issue の state は CLOSED', async () => {
  const fake = restFake().on('GET', /^\/repos\/o\/r\/issues\/7(\?|$)/, () => ({ ...issue7, state: 'closed' }));
  const out: any = await restIssueView(new GitHub(fake, 'o/r'), 7);
  assert.equal(out.state, 'CLOSED');
});

test('restPrView：isDraft・head・base・autoMergeRequest・statusCheckRollup（check run と commit status、大文字）・コメント・reviews を出す', async () => {
  const out: any = await restPrView(new GitHub(restFake(), 'o/r'), 9);
  assert.deepEqual(pick(out, ['number', 'title', 'body', 'state', 'isDraft', 'headRefName', 'headRefOid', 'baseRefName', 'labels', 'url']), {
    number: 9, title: 'feat: y', body: 'Closes #7', state: 'OPEN', isDraft: true, headRefName: 'claude/issue-3', headRefOid: HEAD, baseRefName: 'main',
    labels: [{ name: 'agent:verdict-ok' }], url: 'https://github.com/o/r/pull/9',
  });
  assert.deepEqual(pick(out.autoMergeRequest, ['enabledBy', 'mergeMethod', 'commitHeadline', 'commitBody']), {
    enabledBy: { login: 'alice' }, mergeMethod: 'SQUASH', commitHeadline: 't', commitBody: 'm',
  });
  assert.deepEqual(out.statusCheckRollup, [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'd1', startedAt: 's1', completedAt: 'e1' },
    { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '', detailsUrl: 'd2', startedAt: 's2', completedAt: null },
    { __typename: 'StatusContext', context: 'ci/x', state: 'PENDING', targetUrl: 't1' },
  ]);
  assert.deepEqual(out.comments.map((c: any) => pick(c, COMMENT_KEYS)), expectedComments);
  assert.deepEqual(out.reviews.map((r: any) => pick(r, ['id', 'author', 'authorAssociation', 'state', 'body', 'submittedAt', 'commit'])), [
    { id: 301, author: { login: 'bob' }, authorAssociation: 'MEMBER', state: 'APPROVED', body: 'ok', submittedAt: 'r1', commit: { oid: HEAD } },
    { id: 302, author: null, authorAssociation: 'NONE', state: 'COMMENTED', body: '', submittedAt: 'r2', commit: { oid: HEAD } },
  ]);
});

test('restPrView：state（merged_at があれば MERGED）・isDraft・auto_merge が無ければ autoMergeRequest は null', async () => {
  const cases: [string, Record<string, unknown>, { state: string; isDraft: boolean; autoMergeRequest: unknown }][] = [
    ['閉じた PR', { state: 'closed', draft: false, merged_at: null, auto_merge: null }, { state: 'CLOSED', isDraft: false, autoMergeRequest: null }],
    ['Merge 済み', { state: 'closed', draft: false, merged_at: '2026-10-01T00:00:00Z', merged: true, auto_merge: null }, { state: 'MERGED', isDraft: false, autoMergeRequest: null }],
    ['Ready で auto-merge 無し', { state: 'open', draft: false, auto_merge: null }, { state: 'OPEN', isDraft: false, autoMergeRequest: null }],
  ];
  for (const [name, patch, expected] of cases) {
    const fake = restFake().on('GET', /^\/repos\/o\/r\/pulls\/9(\?|$)/, () => ({ ...pr9, ...patch }));
    const out: any = await restPrView(new GitHub(fake, 'o/r'), 9);
    assert.deepEqual(pick(out, ['state', 'isDraft', 'autoMergeRequest']), expected, name);
  }
});

test('restPrList：開いた PR を一覧の順に gh の --json の欄で出す', async () => {
  const out: any[] = await restPrList(new GitHub(restFake(), 'o/r'));
  assert.deepEqual(out.map((p) => pick(p, ['number', 'title', 'body', 'headRefName', 'baseRefName', 'isDraft', 'url'])), openPrs.map((p) => ({
    number: p.number, title: p.title, body: p.body, headRefName: p.head.ref, baseRefName: p.base.ref, isDraft: p.draft, url: p.html_url,
  })));
});

test('prsReferencing：本文で Closes（Fixes など）・Refs する同じリポジトリの PR を一覧の順に返し、別の番号・キーワード無し・fork・本文なしは入れない', () => {
  const out = prsReferencing(openPrs, 3, 'o/r');
  assert.deepEqual(out.map((r: any) => ({ number: r.number, keyword: r.keyword })), expectedRefs);
  assert.deepEqual(prsReferencing([listed(8, 'Closes #3', null)], 3, 'o/r'), [], 'head.repo が null（消えた fork）は入れない');
});

test('restOpenPrsReferencing：GET /repos/o/r/pulls?state=open を読み、Issue を Closes / Refs する開いた PR を keyword・head・base・isDraft 付きで出す', async () => {
  const fake = restFake();
  const out: any[] = await restOpenPrsReferencing(new GitHub(fake, 'o/r'), 3);
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path.startsWith('/repos/o/r/pulls?state=open')));
  assert.deepEqual(out.map((p) => pick(p, ['number', 'keyword', 'headRefName', 'baseRefName', 'isDraft'])), [
    { number: 1, keyword: 'closes', headRefName: 'claude/issue-1', baseRefName: 'main', isDraft: false },
    { number: 2, keyword: 'closes', headRefName: 'claude/issue-2', baseRefName: 'main', isDraft: true },
    { number: 3, keyword: 'refs', headRefName: 'claude/issue-3', baseRefName: 'main', isDraft: false },
  ]);
});

test('restIssueSearch：/search/issues（/repos/ の下ではない）を1回だけ呼び、q に repo:o/r・is:issue・is:open と語が入る', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...issue7, number: i + 1 }));
  const fake = restFake({ searchItems: many });
  const out: any[] = await restIssueSearch(new GitHub(fake, 'o/r'), ['gh rest', '#12']);
  const searches = fake.calls.filter((c) => c.path.includes('/search/issues'));
  assert.equal(searches.length, 1, '1ページまで');
  const path = searches[0]!.path;
  assert.ok(path.startsWith('/search/issues?'), path);
  assert.ok(!path.includes('#'), '語の # は符号化する');
  const q = new URLSearchParams(path.slice(path.indexOf('?') + 1)).get('q') ?? '';
  for (const part of ['repo:o/r', 'is:issue', 'is:open', 'gh rest', '#12']) assert.ok(q.includes(part), `${part} が q に無い：${q}`);
  assert.equal(out.length, 100);
  assert.deepEqual(pick(out[0], ['number', 'title', 'state', 'labels', 'url']), {
    number: 1, title: 'feat: x', state: 'OPEN', labels: [{ name: 'type:feat' }], url: 'https://github.com/o/r/issues/7',
  });
});

test('どのサブコマンドの関数も偽の GitHub に GET だけを送り、/graphql を一度も呼ばない', async () => {
  const runs: [string, (gh: GitHub) => Promise<unknown>][] = [
    ['restIssueView', (gh) => restIssueView(gh, 7)],
    ['restIssueSearch', (gh) => restIssueSearch(gh, ['x'])],
    ['restPrView', (gh) => restPrView(gh, 9)],
    ['restPrList', (gh) => restPrList(gh)],
    ['restOpenPrsReferencing', (gh) => restOpenPrsReferencing(gh, 3)],
  ];
  for (const [name, run] of runs) {
    const fake = restFake();
    await run(new GitHub(fake, 'o/r'));
    assert.ok(fake.calls.length > 0, `${name} が何も読んでいない`);
    assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], `${name} が GET 以外を送った`);
    assert.deepEqual(fake.calls.filter((c) => c.path.includes('graphql')).map((c) => c.path), [], `${name} が /graphql を呼んだ`);
  }
});

test('GitHub.request：/search/ で始まるパスだけ前置きなしで送り、/issues/1 などは今までどおり /repos/o/r の下に送る', async () => {
  const cases: [string, string][] = [
    ['/issues/1', '/repos/o/r/issues/1'],
    ['/pulls?state=open', '/repos/o/r/pulls?state=open'],
    ['/search/issues?q=x', '/search/issues?q=x'],
    ['/repos/a/b/issues/1', '/repos/a/b/issues/1'],
    ['/graphql', '/graphql'],
    ['/user', '/user'],
  ];
  for (const [given, sent] of cases) {
    const fake = new FakeGitHub().on('GET', /./, () => ({}));
    await new GitHub(fake, 'o/r').get(given);
    assert.deepEqual(fake.calls.map((c) => c.path), [sent], given);
  }
});
