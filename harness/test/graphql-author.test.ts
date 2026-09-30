// Issue #249：GraphQL の作者・関係・ID を REST の形にそろえる変換（restUser・restId・restComment・restReview・restEvent）の後で、App の名義と作者の関係の判定が REST の形と同じ結果になる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { claimOf, humanFeedback, issueFacts } from '../lib/facts.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { PrefetchTransport, restComment, restEvent, restId, restReview, restUser, Snapshot, type GComment, type GEvent, type GReview } from '../lib/graphql-prefetch.ts';
import { pastPrItemsForJudge, type PastPr, type PastPrReview } from '../lib/session-inputs.ts';
import { appRecords, isAppComment, isTrustedComment, type Review, type TimelineEvent } from '../lib/state.ts';
import { APP, config, FakeGitHub, HEAD } from './support/gate-fixtures.ts';

const SLUG = config.appSlug;
const T = (h: number) => `2026-09-26T${String(h).padStart(2, '0')}:00:00Z`;
/** 2^31 を超える ID（GraphQL の fullDatabaseId は文字列で返る） */
const BIG = '5902898007';

/** 作者の書き方：REST（user）と GraphQL（author）の組 */
interface Who { rest: { login: string; type: string } | null; graphql: { __typename: string; login: string } | null; name: string }
const WHO: Record<string, Who> = {
  app: { name: 'App（Bot）', rest: { login: APP, type: 'Bot' }, graphql: { __typename: 'Bot', login: SLUG } },
  human: { name: '人（User）', rest: { login: 'me', type: 'User' }, graphql: { __typename: 'User', login: 'me' } },
  slugUser: { name: 'App の slug と同じ login の User', rest: { login: SLUG, type: 'User' }, graphql: { __typename: 'User', login: SLUG } },
  otherBot: { name: 'ほかの Bot', rest: { login: 'dependabot[bot]', type: 'Bot' }, graphql: { __typename: 'Bot', login: 'dependabot' } },
  ghost: { name: '作者の無いもの（author: null）', rest: null, graphql: null },
};

/** 同じコメントの REST の形と GraphQL の形 */
function commentPair(id: string | number, body: string, who: Who, association: string, at = T(0)): { rest: IssueComment; graphql: GComment } {
  const url = `https://github.com/o/r/issues/3#issuecomment-${id}`;
  return {
    rest: { id: Number(id), body, html_url: url, created_at: at, updated_at: at, author_association: association, user: who.rest },
    graphql: { fullDatabaseId: String(id), body, url, createdAt: at, updatedAt: at, authorAssociation: association, author: who.graphql },
  };
}

function reviewPair(id: string | number, state: string, body: string, who: Who, association: string, commit = HEAD, at = T(1)): { rest: Review; graphql: GReview } {
  return {
    rest: { id: Number(id), state, body, submitted_at: at, commit_id: commit, author_association: association, user: who.rest },
    graphql: { fullDatabaseId: String(id), state, body, submittedAt: at, commit: { oid: commit }, authorAssociation: association, author: who.graphql },
  };
}

function eventPair(event: 'labeled' | 'unlabeled', label: string, who: Who, at: string): { rest: TimelineEvent; graphql: GEvent } {
  return {
    rest: { event, created_at: at, actor: who.rest, label: { name: label } },
    graphql: { __typename: event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent', createdAt: at, actor: who.graphql, label: { name: label } },
  };
}

const claimBody = (stage: string) => [claudeMark(), '着手しました。', '', renderBlock('agent-claim', { by: 'manual', at: T(0), stage })].join('\n');
const planGateBody = (planCommentId: number) =>
  [appMark('plan-gate'), 'ok', renderBlock('agent-app', { version: 1, planCommentId, pass: true, reasons: [], plan: { files: ['docs/**'] } })].join('\n');

test('restUser：Bot だけ login に [bot] を付けて type は Bot。User はそのまま（type は __typename）。null・undefined は null', () => {
  assert.deepEqual(restUser({ __typename: 'Bot', login: SLUG }), { login: APP, type: 'Bot' });
  assert.deepEqual(restUser({ __typename: 'User', login: 'me' }), { login: 'me', type: 'User' });
  assert.deepEqual(restUser({ __typename: 'User', login: SLUG }), { login: SLUG, type: 'User' });
  assert.deepEqual(restUser({ __typename: 'Mannequin', login: 'old' }), { login: 'old', type: 'Mannequin' });
  assert.equal(restUser(null), null);
  assert.equal(restUser(undefined), null);
});

test('restId：2^31 を超える fullDatabaseId（文字列）も REST の id に正しく写る', () => {
  assert.equal(restId(BIG), 5902898007);
  assert.equal(restId(5902898007), 5902898007);
  assert.equal(restId('12'), 12);
  const pair = commentPair(BIG, 'x', WHO.human!, 'OWNER');
  assert.equal(restComment(pair.graphql).id, 5902898007);
  assert.equal(restReview(reviewPair(BIG, 'COMMENTED', 'x', WHO.human!, 'OWNER').graphql).id, 5902898007);
});

test('restComment・restReview・restEvent：変換した結果が REST の形と同じ（作者・関係・ID・時刻・本文）', () => {
  for (const who of Object.values(WHO)) {
    for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE']) {
      const c = commentPair(BIG, `本文 ${who.name}`, who, association);
      assert.deepEqual(restComment(c.graphql), c.rest, `${who.name} ${association}`);
      const r = reviewPair(BIG, 'COMMENTED', `レビュー ${who.name}`, who, association);
      assert.deepEqual(restReview(r.graphql), r.rest, `${who.name} ${association}`);
    }
    for (const kind of ['labeled', 'unlabeled'] as const) {
      const e = eventPair(kind, LABELS.planOk, who, T(2));
      assert.deepEqual(restEvent(e.graphql), e.rest, `${who.name} ${kind}`);
    }
  }
});

test('isAppComment：Bot の App だけが App。App の slug と同じ login の User・ほかの Bot・作者の無いものは App でない（REST と GraphQL で同じ）', () => {
  const cases: [Who, boolean][] = [
    [WHO.app!, true],
    [WHO.human!, false],
    [WHO.slugUser!, false],
    [WHO.otherBot!, false],
    [WHO.ghost!, false],
  ];
  for (const [who, expected] of cases) {
    const c = commentPair(1, 'x', who, 'NONE');
    assert.equal(isAppComment(config, c.rest), expected, `REST: ${who.name}`);
    assert.equal(isAppComment(config, restComment(c.graphql)), expected, `GraphQL: ${who.name}`);
  }
});

test('isTrustedComment：OWNER・MEMBER・COLLABORATOR は信頼し、NONE・CONTRIBUTOR・知らない値・作者の無いもの（NONE）は信頼しない（REST と GraphQL で同じ）', () => {
  const cases: [Who, string, boolean][] = [
    [WHO.human!, 'OWNER', true],
    [WHO.human!, 'MEMBER', true],
    [WHO.human!, 'COLLABORATOR', true],
    [WHO.human!, 'CONTRIBUTOR', false],
    [WHO.human!, 'NONE', false],
    [WHO.human!, 'FIRST_TIME_CONTRIBUTOR', false],
    [WHO.human!, 'SOMETHING_NEW', false],
    [WHO.human!, 'owner', false],
    [WHO.ghost!, 'NONE', false],
  ];
  for (const [who, association, expected] of cases) {
    const c = commentPair(1, 'x', who, association);
    assert.equal(isTrustedComment(c.rest), expected, `REST: ${who.name} ${association}`);
    assert.equal(isTrustedComment(restComment(c.graphql)), expected, `GraphQL: ${who.name} ${association}`);
    const r = reviewPair(1, 'COMMENTED', 'x', who, association);
    assert.equal(isTrustedComment(restReview(r.graphql)), expected, `GraphQL review: ${who.name} ${association}`);
  }
});

/** App の記録・着手宣言・人のコメントが混ざったコメントの列（REST と GraphQL の両方） */
function mixedComments(): { rest: IssueComment[]; graphql: GComment[] } {
  const pairs = [
    commentPair(BIG, claimBody('plan'), WHO.human!, 'OWNER', T(0)),
    commentPair('5902898008', planGateBody(80), WHO.app!, 'NONE', T(1)),
    // App の slug と同じ login の User が書いた計画ゲートの記録は App の記録でない
    commentPair('5902898009', planGateBody(81), WHO.slugUser!, 'OWNER', T(2)),
    // 信頼しない作者の着手宣言は数えない（持ち主にならない・段階を更新しない）
    commentPair('5902898011', claimBody('implement'), WHO.human!, 'CONTRIBUTOR', T(4)),
    commentPair('5902898012', claimBody('implement'), WHO.ghost!, 'NONE', T(5)),
    commentPair('5902898013', claimBody('implement'), WHO.human!, 'SOMETHING_NEW', T(6)),
    commentPair('5902898014', claimBody('plan-critique'), WHO.human!, 'MEMBER', T(7)),
    commentPair('5902898015', 'ふつうのコメント', WHO.human!, 'COLLABORATOR', T(8)),
  ];
  return { rest: pairs.map((p) => p.rest), graphql: pairs.map((p) => p.graphql) };
}

test('appRecords：App（Bot）の記録だけを読み、App の slug を名乗る User の記録は読まない（REST と GraphQL で同じ）', () => {
  const { rest, graphql } = mixedComments();
  const fromRest = appRecords<{ planCommentId: number }>(config, rest, 'plan-gate');
  const fromGraphql = appRecords<{ planCommentId: number }>(config, graphql.map(restComment), 'plan-gate');
  assert.deepEqual(fromGraphql, fromRest);
  assert.deepEqual(fromRest.map((r) => r.value.planCommentId), [80]);
  assert.equal(fromRest[0]!.comment.id, 5902898008);
});

test('claimOf：信頼する作者の着手宣言だけを読む（REST と GraphQL で同じ）', () => {
  const { rest, graphql } = mixedComments();
  const fromRest = claimOf(rest);
  assert.deepEqual(claimOf(graphql.map(restComment)), fromRest);
  assert.equal(fromRest?.stage, 'plan-critique', 'CONTRIBUTOR・作者の無いもの・知らない関係の宣言は飛ばし、MEMBER の宣言で段階が変わる');
});

test('humanFeedback：今の head への、信頼する人（App 以外）の COMMENTED・CHANGES_REQUESTED のレビュー（REST と GraphQL で同じ）', () => {
  const pairs = [
    reviewPair('5902898100', 'COMMENTED', '直してください', WHO.human!, 'OWNER'),
    reviewPair('5902898101', 'CHANGES_REQUESTED', '変えてください', WHO.human!, 'MEMBER'),
    reviewPair('5902898102', 'COMMENTED', 'App', WHO.app!, 'NONE'),
    reviewPair('5902898103', 'COMMENTED', 'App の slug と同じ login の User（信頼する）', WHO.slugUser!, 'COLLABORATOR'),
    reviewPair('5902898104', 'COMMENTED', '外の人', WHO.human!, 'CONTRIBUTOR'),
    reviewPair('5902898105', 'COMMENTED', '作者なし', WHO.ghost!, 'NONE'),
    reviewPair('5902898106', 'COMMENTED', '前の head', WHO.human!, 'OWNER', 'b'.repeat(40)),
    reviewPair('5902898107', 'APPROVED', 'LGTM', WHO.human!, 'OWNER'),
    reviewPair('5902898108', 'COMMENTED', [claudeMark(), 'Claude'].join('\n'), WHO.human!, 'OWNER'),
  ];
  const fromRest = humanFeedback(pairs.map((p) => p.rest), HEAD, APP);
  const fromGraphql = humanFeedback(pairs.map((p) => restReview(p.graphql)), HEAD, APP);
  assert.deepEqual(fromGraphql, fromRest);
  assert.deepEqual(fromRest.map((r) => r.id), [5902898100, 5902898101, 5902898103]);
});

test('pastPrItemsForJudge：過去の PR のコメント・レビューを判定に渡すかどうかが REST と GraphQL で同じ', () => {
  const comments = mixedComments();
  const reviews = [
    reviewPair('5902898200', 'COMMENTED', '人のレビュー', WHO.human!, 'OWNER', HEAD, T(9)),
    reviewPair('5902898201', 'COMMENTED', 'App のレビュー', WHO.app!, 'NONE', HEAD, T(10)),
    reviewPair('5902898202', 'COMMENTED', '外の人のレビュー', WHO.human!, 'CONTRIBUTOR', HEAD, T(11)),
    reviewPair('5902898203', 'COMMENTED', '作者の無いレビュー', WHO.ghost!, 'NONE', HEAD, T(12)),
  ];
  const url = (id: string) => `https://github.com/o/r/pull/9#pullrequestreview-${id}`;
  const restReviews: PastPrReview[] = reviews.map((r) => ({ id: r.rest.id, body: r.rest.body, state: r.rest.state, submitted_at: r.rest.submitted_at, html_url: url(String(r.rest.id)), author_association: r.rest.author_association, user: r.rest.user as PastPrReview['user'] }));
  // past-pr-reads.ts の変換と同じ：{ id: restId(fullDatabaseId), body, state, submitted_at: submittedAt, html_url: url, author_association, user: restUser(author) }
  const graphqlReviews: PastPrReview[] = reviews.map((r) => ({ id: restId(r.graphql.fullDatabaseId), body: r.graphql.body, state: r.graphql.state, submitted_at: r.graphql.submittedAt, html_url: url(String(r.graphql.fullDatabaseId)), author_association: r.graphql.authorAssociation, user: restUser(r.graphql.author) }));
  const base = { number: 9, title: 'past', mergedAt: T(20), files: ['docs/a.md'], reviewComments: [] };
  const fromRest: PastPr = { ...base, comments: comments.rest, reviews: restReviews };
  const fromGraphql: PastPr = { ...base, comments: comments.graphql.map(restComment), reviews: graphqlReviews };
  const items = pastPrItemsForJudge(config, fromRest);
  assert.deepEqual(pastPrItemsForJudge(config, fromGraphql), items);
  const bodies = items.map((i) => i.body);
  for (const kept of ['ふつうのコメント', '人のレビュー']) assert.ok(bodies.includes(kept), kept);
  for (const dropped of ['App のレビュー', '外の人のレビュー', '作者の無いレビュー', planGateBody(80)]) assert.ok(!bodies.includes(dropped), dropped);
  assert.ok(!bodies.some((b) => b.includes('agent-claim')), 'Claude の目印の着手宣言は渡さない');
  assert.ok(items.every((i) => !i.heading.includes(' ? ')), '作者の無いものは残らない');
});

/** issueFacts が読む Issue #3 の材料を REST で返す偽物 */
function restIssueFake(comments: IssueComment[], events: TimelineEvent[]): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /^\/repos\/o\/r\/issues\/3\/timeline/, () => events)
    .on('GET', /^\/repos\/o\/r\/issues\/3\/comments/, () => comments)
    .on('POST', /^\/graphql$/, (_m, body) => {
      if (String(body.query).includes('blockedBy(first:50)')) return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
      throw new Error('unexpected graphql');
    });
}

/** 同じ材料を GraphQL 由来の Snapshot から答える GitHub（内側には何も流さない） */
function prefetchedIssueGitHub(comments: GComment[], events: GEvent[]): { gh: GitHub; inner: FakeGitHub } {
  const snap = new Snapshot();
  snap.items.set(3, { number: 3, title: 't', state: 'open', body: null, html_url: 'u', labels: [] });
  snap.comments.set(3, comments.map(restComment));
  snap.timelines.set(3, events.map(restEvent));
  snap.blockers.set(3, []);
  snap.closedBy.set(3, []);
  const inner = new FakeGitHub();
  const transport = new PrefetchTransport({ snap, inner, repoPath: '/repos/o/r', config, diffs: new Map(), stacks: new Map() });
  return { gh: new GitHub(transport, 'o/r'), inner };
}

test('issueFacts の planOkByApp・readyAt：ラベルのイベントを GraphQL 由来で読んでも REST と同じ。App（Bot）が付けたときだけ App の付けた plan-ok', async () => {
  const cases: { name: string; events: ReturnType<typeof eventPair>[]; planOkByApp: boolean }[] = [
    { name: 'App（Bot）が付けた', events: [eventPair('labeled', LABELS.ready, WHO.human!, T(1)), eventPair('labeled', LABELS.planOk, WHO.app!, T(2))], planOkByApp: true },
    { name: 'App の slug と同じ login の User が付けた', events: [eventPair('labeled', LABELS.planOk, WHO.slugUser!, T(2))], planOkByApp: false },
    { name: '人が付けた', events: [eventPair('labeled', LABELS.planOk, WHO.human!, T(2))], planOkByApp: false },
    { name: 'App が付けた後に人が外した', events: [eventPair('labeled', LABELS.planOk, WHO.app!, T(2)), eventPair('unlabeled', LABELS.planOk, WHO.human!, T(3))], planOkByApp: false },
    { name: 'App が付けて外し、人が付け直した', events: [eventPair('labeled', LABELS.planOk, WHO.app!, T(2)), eventPair('unlabeled', LABELS.planOk, WHO.app!, T(3)), eventPair('labeled', LABELS.planOk, WHO.human!, T(4))], planOkByApp: false },
    { name: '作者の無いイベントの後に App が付けた', events: [eventPair('labeled', LABELS.planOk, WHO.ghost!, T(2)), eventPair('unlabeled', LABELS.planOk, WHO.ghost!, T(3)), eventPair('labeled', LABELS.planOk, WHO.app!, T(4))], planOkByApp: true },
  ];
  const comments = mixedComments();
  const item = { number: 3, title: 't', labels: [{ name: LABELS.planOk }] };
  for (const c of cases) {
    const rest = await issueFacts(new GitHub(restIssueFake(comments.rest, c.events.map((e) => e.rest)), 'o/r'), config, item, new Map());
    const { gh, inner } = prefetchedIssueGitHub(comments.graphql, c.events.map((e) => e.graphql));
    const fromGraphql = await issueFacts(gh, config, item, new Map());
    assert.deepEqual(fromGraphql, rest, c.name);
    assert.equal(rest.planOkByApp, c.planOkByApp, c.name);
    assert.deepEqual(inner.calls, [], `${c.name}：先読みから答え、内側に流さない`);
  }
});

test('`slug[bot]` という login の User（__typename が User）は、REST と GraphQL で同じ扱いになり、restUser は Bot にしない', () => {
  // GitHub の login には [ を使えないので、人が `slug[bot]` を名乗ることは実際には起きない。App かどうかは isAppComment（login の一致）が決め、
  // その判定が REST と GraphQL の形で食い違わないこと、GraphQL の User を Bot に読み替えないことを確かめる
  const impostor: Who = { name: '`slug[bot]` という login の User', rest: { login: APP, type: 'User' }, graphql: { __typename: 'User', login: APP } };
  const c = commentPair('5902898010', planGateBody(82), impostor, 'OWNER');
  assert.deepEqual(restComment(c.graphql).user, { login: APP, type: 'User' }, 'restUser は User の login をそのまま写し、[bot] を重ねない');
  assert.equal(isAppComment(config, restComment(c.graphql)), isAppComment(config, c.rest));
  assert.deepEqual(appRecords(config, [restComment(c.graphql)], 'plan-gate').map((r) => r.value), appRecords(config, [c.rest], 'plan-gate').map((r) => r.value));
});
