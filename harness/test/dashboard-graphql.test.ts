// Issue #279：ダッシュボードの読み直しを、変わった番号をまとめた GraphQL の問い合わせで取る（表示の中身が今と同じ・内側に流れる呼び出し・ページ送り・作者の名前とコメントの ID・費用の見積もり）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, appMarkKind, claudeMark, renderBlock } from '../lib/blocks.ts';
import { areaLimitLabels } from '../lib/concurrency.ts';
import { CHECKS, LABELS } from '../lib/config.ts';
import { critiqueClaimedBefore, issueFacts, prFacts } from '../lib/facts.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import { patchId } from '../lib/patch-id.ts';
import { isAgentPr, isAppComment, isSameRepoPr, latestPlanGate, linkedIssues, withStack, type PullRequest, type Review } from '../lib/state.ts';
import { buildBatchQuery, DashboardData, PrefetchTransport, ReadOnlyTransport, Snapshot } from '../scripts/dashboard/github.ts';
import type { DashIssue, DashPr, PlanCopy } from '../scripts/dashboard/graph.ts';
import type { FleetPr } from '../lib/fleet.ts';
import { APP, config, DIFF, type FakeGitHub } from './support/gate-fixtures.ts';
import { APP_SLUG, callNames, dashboardFake, REPO, type WActor, type WComment, type WEvent, type World } from './support/dashboard-fixtures.ts';
import { FEATURE_BASE, STACK } from './support/stack-fixtures.ts';

const APP_ACTOR: WActor = { login: APP_SLUG, bot: true };
const RATE_LIMIT = 'rateLimit{cost limit remaining resetAt}';
/** 2^31 を超える ID（GraphQL の databaseId（32 ビット）に収まらない。今のコメントの ID はこの大きさ） */
const BIG = 5891733118;
const sha = (c: string) => c.repeat(40);

/** Claude の着手宣言（session の無い手動の宣言） */
function claimC(id: number, stage: string, extra: Record<string, unknown> = {}): WComment {
  return { id, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', { by: 'manual', at: '2026-09-26T00:00:00Z', stage, ...extra })].join('\n') };
}
/** Claude の計画コメント */
function planC(id: number): WComment {
  return { id, body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') };
}
/** App のコメント（kind の印と agent-app の記録）。作者は GraphQL では Bot、REST では `<appSlug>[bot]` */
function appC(id: number, kind: string, record?: unknown): WComment {
  return { id, author: APP_ACTOR, association: 'NONE', body: [appMark(kind), 'App です。', ...(record === undefined ? [] : [renderBlock('agent-app', record)])].join('\n') };
}
const planGate = (id: number, planCommentId: number) =>
  appC(id, 'plan-gate', { version: 1, planCommentId, pass: true, reasons: [], plan: { files: ['docs/**'], critique: { verdict: 'go', rounds: 1 } } });
const acceptance = (id: number) =>
  appC(id, 'acceptance', { version: 1, verdictCommentId: 70, verdictHeadSha: sha('a'), patchId: patchId(DIFF), reviewPass: true, riskLevel: 'low', riskOk: true, scopeOk: true, outside: [], autoEligible: false, reasons: [] });

/**
 * 表示の中身を比べる見本：
 * #3 Agent の Issue（着手宣言・計画ゲートの App の記録・ラベルの付け外し・依存・Merge 済みの PR #4）と、Closes #3 の PR #5（レビュー・チェック・App の human-review・受け付け・main に遅れ・衝突）、
 * #6 に Refs #6 だけで紐付く Stacked PR の層 #7、紐付けの無い Agent PR #8、Agent でも紐付きでもない PR #10、fork の PR #12、
 * 対象外の Issue #4、ラベルだけの Agent の Issue #11、ダッシュボード Issue #1
 */
function baseWorld(): World {
  return {
    diff: DIFF,
    issues: [
      { number: 1, title: config.dashboardIssueTitle, labels: ['agent:delegate-plan'] },
      {
        number: 3, title: 'feat: three', body: 'Issue 3 の本文', labels: [LABELS.planOk, 'priority:p1'],
        comments: [
          claimC(BIG, 'plan-critique'),
          planC(BIG + 100),
          { id: BIG + 150, body: '作者の無いコメント', author: null, association: 'NONE' },
          planGate(BIG + 200, BIG + 100),
          claimC(BIG + 300, 'implement'),
        ],
        events: [
          { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T01:00:00Z' },
          { event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T02:00:00Z', actor: APP_ACTOR },
          { event: 'labeled', label: LABELS.hold, created_at: '2026-09-26T03:00:00Z' },
          { event: 'unlabeled', label: LABELS.hold, created_at: '2026-09-26T04:00:00Z' },
        ],
        blockedBy: [{ number: 2, state: 'OPEN' }, { number: 9, state: 'CLOSED' }],
        closedBy: [{ number: 5, state: 'OPEN' }, { number: 4, state: 'MERGED' }],
      },
      { number: 4, title: 'feat: four' },
      { number: 6, title: 'feat: six', body: 'Stacked PR の層の Issue' },
      { number: 11, title: 'feat: eleven', labels: [LABELS.ready] },
    ],
    prs: [
      {
        number: 5, title: 'feat: pr5', body: 'Closes #3', closing: [3], headRef: 'claude/issue-3-x', headSha: sha('a'), labels: ['area:harness'],
        mergeableState: 'dirty', aheadBy: 2,
        comments: [appC(BIG + 400, 'human-review'), acceptance(BIG + 500)],
        reviews: [
          { id: BIG + 600, state: 'COMMENTED', author: { login: 'rev' } },
          { id: 12, state: 'APPROVED', commit_id: sha('0'), author: { login: 'rev2' } },
          { id: BIG + 700, state: 'COMMENTED', author: APP_ACTOR, association: 'NONE' },
        ],
        checks: [
          { name: CHECKS.scope, app: APP_SLUG, started_at: '2026-09-26T05:00:00Z' },
          { name: CHECKS.review, app: APP_SLUG },
          { name: 'ci', app: 'github-actions' },
          { name: 'external', app: null },
        ],
      },
      { number: 7, title: 'feat: pr7', body: 'Refs #6', headRef: 'claude/issue-6-top', headSha: sha('d'), baseRef: FEATURE_BASE.ref, stack: STACK, draft: false, autoMerge: true },
      { number: 8, title: 'feat: pr8', body: 'no link', headRef: 'claude/issue-9-x', headSha: sha('e'), aheadBy: 1 },
      { number: 10, title: 'feat: pr10', body: null, headRef: 'feature/x', headSha: sha('f'), author: { login: 'someone' } },
      { number: 12, title: 'feat: fork', body: 'Closes #3', closing: [3], headRef: 'claude/issue-3-fork', headSha: sha('1'), headRepo: 'fork/r' },
    ],
  };
}

interface Item { number: number; title: string; state: string; body: string | null; html_url: string; labels: { name: string }[]; pull_request?: unknown }

const CLOSED_BY_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`;

/**
 * 今の読み方の正解：同じ見本に REST で harness/lib の issueFacts・prFacts・linkedIssues を直接呼び、
 * #279 の前の DashboardData.loadAll と同じ手順で表示の中身を組む（behindMain は /compare/{head}...main の ahead_by）
 */
async function restView(world: World): Promise<{ issues: DashIssue[]; prs: DashPr[] }> {
  const gh = new GitHub(dashboardFake(world), REPO);
  const open = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, REPO));
  const links = new Map<number, number[]>();
  for (const p of open) links.set(p.number, await linkedIssues(gh, config, await withStack(gh, config, p)));
  const openOf = (n: number) => open.filter((p) => links.get(p.number)!.includes(n));
  const prs = new Map<number, DashPr>();
  const row = async (pr: PullRequest, issue: number | null, readyAt = new Map<number, string | null>(), labels = new Map<number, string[]>()): Promise<DashPr> => {
    const facts = await prFacts(gh, config, pr, readyAt, labels);
    const comments = await gh.listComments(pr.number);
    const compare = await gh.get<{ ahead_by: number }>(`/compare/${encodeURIComponent(pr.head.sha)}...${encodeURIComponent(config.defaultBranch)}`);
    const dash: DashPr = {
      number: pr.number, title: pr.title, url: pr.html_url, headRef: pr.head.ref, baseRef: pr.base.ref, issue,
      fleet: {
        number: pr.number, merged: false, draft: pr.draft, autoMerge: pr.auto_merge !== null && pr.auto_merge !== undefined,
        humanReview: comments.some((c) => isAppComment(config, c) && appMarkKind(c.body) === 'human-review'),
        behindMain: compare.ahead_by > 0,
        facts,
      },
    };
    prs.set(pr.number, dash);
    return dash;
  };
  const issues: DashIssue[] = [];
  const items = (await gh.paginate<Item>('/issues?state=open')).filter((i) => !i.pull_request && i.title !== config.dashboardIssueTitle);
  for (const item of items) {
    const mine = openOf(item.number);
    const facts = await issueFacts(gh, config, item, new Map(mine.length > 0 ? [[item.number, mine[0]!.number]] : []), areaLimitLabels(config, open, REPO));
    if (!(facts.labels.some((l) => l.startsWith('agent:')) || facts.claim !== null || mine.length > 0)) continue;
    const closedBy = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
      CLOSED_BY_QUERY, { owner: gh.owner, repo: gh.repo, n: item.number });
    const fleetPrs: FleetPr[] = closedBy.repository.issue.closedByPullRequestsReferences.nodes
      .filter((p) => p.repository.nameWithOwner === REPO && p.state === 'MERGED')
      .map((p) => ({ number: p.number, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null }));
    for (const pr of mine) fleetPrs.push((await row(pr, item.number, new Map([[item.number, facts.readyAt]]), new Map([[item.number, facts.labels]]))).fleet);
    const gate = latestPlanGate(config, await gh.listComments(item.number)) as { value: { plan?: PlanCopy } } | null;
    const plan = gate?.value.plan && typeof gate.value.plan === 'object' ? gate.value.plan : null;
    issues.push({ fleet: { facts, closed: false, planFiles: null, prs: fleetPrs }, body: item.body, url: item.html_url, plan });
  }
  for (const p of open) if (!prs.has(p.number) && isAgentPr(config, p, REPO)) await row(p, null);
  return { issues: issues.sort((a, b) => a.fleet.facts.number - b.fleet.facts.number), prs: [...prs.values()].sort((a, b) => a.number - b.number) };
}

function dashboard(world: World): { fake: FakeGitHub; data: DashboardData } {
  const fake = dashboardFake(world);
  return { fake, data: new DashboardData(new GitHub(new ReadOnlyTransport(fake), REPO), config) };
}

/** 内側に流れた呼び出しを数える（GraphQL は操作の名前、REST は短いパス） */
function count(names: string[], pred: (n: string) => boolean): number {
  return names.filter(pred).length;
}

/** PR の差分（patch-id 用）の要求：/compare/{base}...{head}（head が後ろ） */
const diffPath = (base: string, head: string) => `GET /compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

/** 許された REST（PR の差分と Stacked PR の層の /pulls/{n}）のほかに、内側に流れた呼び出し */
function unexpected(names: string[], allowed: string[]): string[] {
  return names.filter((n) => !n.startsWith('graphql:Dash') && !allowed.includes(n));
}

function sortedCopy<T>(xs: T[]): T[] {
  return [...xs].sort();
}

test('loadAll：表示の中身（facts・PR の行・紐付く Issue・Stacked PR の層・behindMain・humanReview・計画の写し）が、REST で harness/lib を直接呼んだ今の読み方と同じ', async () => {
  const world = baseWorld();
  const expected = await restView(world);
  const { fake, data } = dashboard(world);
  await data.loadAll();
  assert.deepEqual(data.issues().map((i) => i.fleet.facts.number), [3, 6, 11], '見本の前提：#4 は対象外、#1 はダッシュボード');
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[5, 3], [7, 6], [8, null]], '見本の前提：Stacked PR の層 #7 は Refs #6 で紐付く');
  assert.deepEqual(data.issues(), expected.issues);
  assert.deepEqual(data.prs(), expected.prs);
  assert.deepEqual(fake.writes(), []);

  // 見本が確かめたい値を実際に含んでいる（どちらの読み方でも同じ値が落ちていて一致しただけ、を避ける）
  const i3 = data.issues().find((i) => i.fleet.facts.number === 3)!;
  assert.equal(i3.fleet.facts.gate?.planCommentId, BIG + 100);
  assert.equal(i3.fleet.facts.planOkByApp, true);
  assert.equal(i3.fleet.facts.readyAt, '2026-09-26T01:00:00Z');
  assert.deepEqual(i3.fleet.facts.openBlockers, [2]);
  assert.equal(i3.fleet.facts.claim?.stage, 'implement');
  assert.deepEqual(i3.fleet.prs.map((p) => [p.number, p.merged]), [[4, true], [5, false]]);
  assert.deepEqual(i3.plan, { files: ['docs/**'], critique: { verdict: 'go', rounds: 1 } });
  const p5 = data.prs().find((p) => p.number === 5)!;
  assert.equal(p5.fleet.humanReview, true);
  assert.equal(p5.fleet.behindMain, true);
  assert.equal(p5.fleet.facts?.conflicted, true);
  assert.equal(p5.fleet.facts?.humanFeedbackSincePush, 1);
  assert.equal(p5.fleet.facts?.headPushedAt, '2026-09-26T05:00:00Z');
  assert.deepEqual(p5.fleet.facts?.acceptance, { reviewPass: true, at: '2026-09-26T00:00:00Z' });
  const p7 = data.prs().find((p) => p.number === 7)!;
  assert.equal(p7.fleet.autoMerge, true);
  assert.equal(p7.fleet.facts?.issue, 6);
  assert.equal(data.prs().find((p) => p.number === 8)!.fleet.behindMain, true);
});

test('loadAll：内側に流れるのは DashBatch 1回と、PR の差分（/compare の raw）と、Stacked PR の層の /pulls/{n}（1回だけ）', async () => {
  const { fake, data } = dashboard(baseWorld());
  await data.loadAll();
  const names = callNames(fake);
  assert.equal(count(names, (n) => n === 'graphql:DashBatch'), 1, names.join('\n'));
  assert.equal(count(names, (n) => n.startsWith('graphql:') && n !== 'graphql:DashBatch'), 0, 'ページ送りの要らない見本');
  assert.equal(count(names, (n) => n === 'GET /pulls/7'), 1, 'Stacked PR の層の /pulls/{n} は同じ回で1回だけ');
  const diffs = [diffPath('main', sha('a')), diffPath(FEATURE_BASE.ref, sha('d')), diffPath('main', sha('e'))];
  assert.deepEqual(sortedCopy(names.filter((n) => n.startsWith('GET /compare/'))), sortedCopy(diffs), '差分は表示する PR ごとに1回。main との比較（ahead_by）は流れない');
  assert.deepEqual(unexpected(names, ['GET /pulls/7', ...diffs]), [], 'それ以外の REST は流れない');
});

test('refresh：DashBatch 1回と許された REST だけ。head が変わった PR の差分は1回だけ流れ、2回目の refresh ではキャッシュから答える', async () => {
  const world = baseWorld();
  const { fake, data } = dashboard(world);
  await data.loadAll();

  const pr5 = world.prs.find((p) => p.number === 5)!;
  pr5.headSha = sha('2');
  pr5.updatedAt = '2026-09-27T00:00:00Z';
  let from = fake.calls.length;
  await data.refresh([5]);
  let names = callNames(fake, from);
  assert.equal(count(names, (n) => n === 'graphql:DashBatch'), 1, names.join('\n'));
  assert.deepEqual(unexpected(names, [diffPath('main', sha('2'))]), [], names.join('\n'));
  assert.equal(count(names, (n) => n === diffPath('main', sha('2'))), 1, '新しい head の差分');
  const batch = fake.calls.slice(from).find((c) => c.path === '/graphql')!;
  assert.match(String(batch.body.query), /\bn3:issueOrPullRequest\b/, 'PR #5 の Issue #3 も同じ問い合わせで読む');
  assert.match(String(batch.body.query), /\bn5:issueOrPullRequest\b/);
  const expected = await restView(world);
  assert.deepEqual(data.issues(), expected.issues);
  assert.deepEqual(data.prs(), expected.prs);

  from = fake.calls.length;
  await data.refresh([5]);
  names = callNames(fake, from);
  assert.deepEqual(names, ['graphql:DashBatch'], '差分はキャッシュされて流れない');

  from = fake.calls.length;
  await data.refresh([7]);
  names = callNames(fake, from);
  assert.deepEqual(sortedCopy(names), sortedCopy(['graphql:DashBatch', 'GET /pulls/7']), 'Stacked PR の層は /pulls/{n} を1回だけ');
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[5, 3], [7, 6], [8, null]]);
  assert.deepEqual(fake.writes(), []);
});

/** 見本に、Issue #20 と、それを Closes する新しく開いた PR #21 を足す */
function addNewPr(world: World): void {
  world.issues.push({ number: 20, title: 'feat: twenty', body: 'new' });
  world.prs.push({ number: 21, title: 'feat: pr21', body: 'Closes #20', closing: [20], headRef: 'claude/issue-20-x', headSha: sha('3'), updatedAt: '2026-09-27T00:00:00Z' });
}

test('refresh：新しく開いた PR が、その回に読んでいない Issue に Closes で紐付くときだけ DashBatch が2回になる', async () => {
  const world = baseWorld();
  const { fake, data } = dashboard(world);
  await data.loadAll();
  addNewPr(world);
  const from = fake.calls.length;
  await data.refresh([21]);
  const names = callNames(fake, from);
  assert.equal(count(names, (n) => n === 'graphql:DashBatch'), 2, names.join('\n'));
  const second = fake.calls.slice(from).filter((c) => c.path === '/graphql')[1]!;
  assert.match(String(second.body.query), /\bn20:issueOrPullRequest\b/, '2回目で読んでいない Issue #20 を読む');
  assert.deepEqual(unexpected(names, [diffPath('main', sha('3'))]), [], names.join('\n'));
  assert.deepEqual(data.issues().find((i) => i.fleet.facts.number === 20)?.fleet.prs.map((p) => p.number), [21]);
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[5, 3], [7, 6], [8, null], [21, 20]]);
  const expected = await restView(world);
  assert.deepEqual(data.issues(), expected.issues);
  assert.deepEqual(data.prs(), expected.prs);
});

test('refresh：新しい PR とその Issue が同じ回の変化に入っていれば、DashBatch は1回', async () => {
  const world = baseWorld();
  const { fake, data } = dashboard(world);
  await data.loadAll();
  addNewPr(world);
  const from = fake.calls.length;
  await data.refresh([21, 20]);
  const names = callNames(fake, from);
  assert.equal(count(names, (n) => n === 'graphql:DashBatch'), 1, names.join('\n'));
  assert.deepEqual(unexpected(names, [diffPath('main', sha('3'))]), [], names.join('\n'));
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[5, 3], [7, 6], [8, null], [21, 20]]);
});

/** 100 件を超えるコメント・レビュー・ラベル・ラベルの付け外し、20 を超える checkSuite と 50 を超える checkRun の見本 */
function bigWorld(): World {
  const filler = (from: number, n: number): WComment[] => Array.from({ length: n }, (_, k) => ({ id: from + k, body: `filler ${from + k}` }));
  // Issue #30：コメント 250（宣言が最初、計画ゲートの記録と解除が最後のページ）、ラベル 130、付け外し 130（最後の付け直しが2ページ目）
  const issueComments: WComment[] = [claimC(BIG, 'implement'), ...filler(BIG + 1, 238), planGate(BIG + 1000, BIG + 500), ...filler(BIG + 2000, 9), claimC(BIG + 3000, 'implement', { released: true })];
  const events: WEvent[] = Array.from({ length: 130 }, (_, k) => ({ event: 'labeled' as const, label: `x${k}`, created_at: '2026-09-26T00:00:00Z' }));
  events[0] = { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T01:00:00Z' };
  events[110] = { event: 'unlabeled', label: LABELS.ready, created_at: '2026-09-26T02:00:00Z' };
  events[120] = { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T03:00:00Z' };
  // PR #31：コメント 150（受け付けと human-review は2ページ目）、レビュー 150（すべて今の head への人のレビュー）、ラベル 120
  const prComments: WComment[] = [...filler(BIG + 5000, 140), acceptance(BIG + 6000), ...filler(BIG + 6001, 4), appC(BIG + 7000, 'human-review'), ...filler(BIG + 7001, 4)];
  const reviews = Array.from({ length: 150 }, (_, k) => ({ id: BIG + 10000 + k, state: 'COMMENTED', author: { login: `rev${k}` } }));
  // checkSuite 25（App の suite は 25 番目）、App の suite の checkRun 60（範囲照合と判定のチェックは最後のページ）
  const checks = [
    ...Array.from({ length: 24 }, (_, k) => ({ name: `other${k}`, app: `app${k}` })),
    ...Array.from({ length: 55 }, (_, k) => ({ name: `run${k}`, app: APP_SLUG })),
    { name: CHECKS.scope, app: APP_SLUG, started_at: '2026-09-26T09:00:00Z' },
    ...Array.from({ length: 3 }, (_, k) => ({ name: `tail${k}`, app: APP_SLUG })),
    { name: CHECKS.review, app: APP_SLUG },
  ];
  return {
    diff: DIFF,
    issues: [{ number: 30, title: 'feat: big', labels: Array.from({ length: 130 }, (_, k) => (k === 129 ? LABELS.planOk : `label-${k}`)), comments: issueComments, events }],
    prs: [{ number: 31, title: 'feat: big pr', body: 'Closes #30', closing: [30], headRef: 'claude/issue-30-x', headSha: sha('a'), labels: Array.from({ length: 120 }, (_, k) => `pl-${k}`), comments: prComments, reviews, checks }],
  };
}

test('ページ送り：100 件を超えるコメント・レビュー・ラベル・ラベルの付け外しと、20 を超える checkSuite・50 を超える checkRun を DashMore・DashMoreNode で読み、REST に流さずに今の読み方とそろう', async () => {
  const world = bigWorld();
  const expected = await restView(world);
  const { fake, data } = dashboard(world);
  await data.loadAll();
  const names = callNames(fake);
  assert.equal(count(names, (n) => n === 'graphql:DashBatch'), 1, names.join('\n'));
  // Issue #30：labels 1・comments 2・timelineItems 1、PR #31：labels 1・comments 1・reviews 1
  assert.equal(count(names, (n) => n === 'graphql:DashMore'), 7, names.join('\n'));
  // commit の checkSuites 1、App の suite の checkRuns 1
  assert.equal(count(names, (n) => n === 'graphql:DashMoreNode'), 2, names.join('\n'));
  assert.deepEqual(unexpected(names, [diffPath('main', sha('a'))]), [], 'REST に流れない');

  assert.deepEqual(data.issues(), expected.issues);
  assert.deepEqual(data.prs(), expected.prs);
  const f30 = data.issues()[0]!.fleet.facts;
  assert.equal(f30.labels.length, 130, 'ラベルの件数がそろい、重複が無い');
  assert.equal(new Set(f30.labels).size, 130);
  assert.equal(f30.readyAt, '2026-09-26T03:00:00Z', '2ページ目の付け直しまで読む');
  assert.equal(f30.claim, null, '最後のページの解除まで読む（最初のページを重ねて読むと宣言が残る）');
  assert.equal(f30.gate?.planCommentId, BIG + 500, '3ページ目の計画ゲートの記録');
  const p31 = data.prs()[0]!;
  assert.equal(p31.fleet.facts?.humanFeedbackSincePush, 150, 'レビューの件数がそろい、重複が無い');
  assert.equal(p31.fleet.facts?.labels.length, 120);
  assert.equal(new Set(p31.fleet.facts?.labels).size, 120);
  assert.equal(p31.fleet.facts?.headPushedAt, '2026-09-26T09:00:00Z', '2ページ目の suite の、2ページ目の checkRun');
  assert.deepEqual(p31.fleet.facts?.acceptance, { reviewPass: true, at: '2026-09-26T00:00:00Z' }, '判定のチェック（最後の checkRun）と受け付けの記録（2ページ目のコメント）');
  assert.equal(p31.fleet.humanReview, true);

  for (const c of fake.calls.filter((x) => x.path === '/graphql')) assert.ok(String(c.body.query).includes(RATE_LIMIT), `rateLimit を含む：${String(c.body.query).slice(0, 40)}`);
});

// --- AC 2：作者の名前とコメントの ID ---

/** 見本の番号をまとめた問い合わせで読み、先読みの Transport と REST の GitHub を並べる */
async function prefetchedPair(world: World, issues: number[], prs: number[]): Promise<{ fake: FakeGitHub; rest: GitHub; pre: GitHub }> {
  const fake = dashboardFake(world);
  const built = buildBatchQuery({ numbers: [...issues, ...prs] });
  const res = (await fake.request('POST', '/graphql', { body: { query: built.query, variables: { owner: 'o', repo: 'r', base: config.defaultBranch, ...built.variables } } })) as { data: { repository: Record<string, any> } };
  const snap = new Snapshot();
  for (const n of issues) snap.add(res.data.repository[`n${n}`], 'issue');
  for (const n of prs) snap.add(res.data.repository[`n${n}`], 'pr-detail');
  const pre = new GitHub(new PrefetchTransport({ snap, inner: fake, repoPath: '/repos/o/r', config, diffs: new Map(), stacks: new Map() }), REPO);
  return { fake, rest: new GitHub(fake, REPO), pre };
}

test('AC 2：先読みの Transport が答えるコメント・レビュー・ラベルの付け外しの作者の名前と ID が REST と同じ（Bot は <appSlug>[bot]、2^31 を超える ID）', async () => {
  const { fake, rest, pre } = await prefetchedPair(baseWorld(), [3], [5]);
  const from = fake.calls.length;
  const comments3 = await pre.listComments(3);
  const comments5 = await pre.listComments(5);
  const reviews5 = await pre.paginate<Review>('/pulls/5/reviews');
  assert.deepEqual(callNames(fake, from), [], '読んだ番号のコメント・レビューは内側に流れない');
  assert.deepEqual(comments3, await rest.listComments(3));
  assert.deepEqual(comments5, await rest.listComments(5));
  assert.deepEqual(reviews5, await rest.paginate<Review>('/pulls/5/reviews'));

  const gate = comments3.find((c) => c.id === BIG + 200)!;
  assert.equal(gate.user?.login, APP, 'App の作者は <appSlug>[bot]');
  assert.equal(gate.user?.login, `${config.appSlug}[bot]`);
  assert.equal(isAppComment(config, gate), true, 'App の記録として読まれる');
  assert.equal(comments3.find((c) => c.id === BIG + 150)!.user, null, '作者の無いコメント');
  assert.equal(comments3[0]!.id, BIG, 'ID は 2^31 を超えても REST と同じ数');
  assert.ok(comments3[0]!.id > 2 ** 31);
  assert.equal(typeof comments3[0]!.id, 'number');
  assert.deepEqual(reviews5.map((r) => r.id), [BIG + 600, 12, BIG + 700]);
  assert.equal(reviews5[2]!.user?.login, APP);

  // ラベルの付け外しの作者（App が付けた agent:plan-ok）
  const events = await pre.paginate<{ event: string; actor: { login: string } | null; label?: { name: string } }>('/issues/3/timeline');
  const restEvents = (await rest.paginate<{ event: string; actor: { login: string } | null; label?: { name: string } }>('/issues/3/timeline')).filter((e) => e.event === 'labeled' || e.event === 'unlabeled');
  assert.deepEqual(events.map((e) => [e.event, e.label?.name, e.actor?.login]), restEvents.map((e) => [e.event, e.label?.name, e.actor?.login]));
  assert.equal(events.find((e) => e.label?.name === LABELS.planOk)?.actor?.login, APP);
});

test('AC 2：critiqueClaimedBefore と計画ゲートの記録の planCommentId との比較が、2^31 を超える ID でも REST と同じ結果', async () => {
  const cases: { critique: number; plan: number; want: boolean }[] = [
    { critique: BIG, plan: BIG + 100, want: true },
    { critique: BIG + 100, plan: BIG, want: false },
    { critique: 2 ** 32 + 5, plan: 2 ** 32 + 6, want: true },
    // databaseId（32 ビット）に切り詰めると大小が逆になる組
    { critique: 2 ** 32 + 1, plan: 2 ** 31 + 1, want: false },
  ];
  for (const c of cases) {
    const world: World = { issues: [{ number: 3, labels: [LABELS.ready], comments: [claimC(c.critique, 'plan-critique'), planC(c.plan), planGate(Math.max(c.critique, c.plan) + 1, c.plan)] }], prs: [] };
    const { rest, pre } = await prefetchedPair(world, [3], []);
    const viaPre = await pre.listComments(3);
    const viaRest = await rest.listComments(3);
    const gatePre = latestPlanGate(config, viaPre);
    const gateRest = latestPlanGate(config, viaRest);
    assert.equal(gatePre?.value.planCommentId, c.plan, JSON.stringify(c));
    assert.equal(critiqueClaimedBefore(viaPre, gatePre!.value.planCommentId), c.want, JSON.stringify(c));
    assert.equal(critiqueClaimedBefore(viaPre, gatePre!.value.planCommentId), critiqueClaimedBefore(viaRest, gateRest!.value.planCommentId));
    assert.deepEqual(viaPre.map((x: IssueComment) => x.id), viaRest.map((x) => x.id));
  }
});

test('AC 2：DashboardData でも、Bot の作者の App の記録（計画ゲート・App が付けた agent:plan-ok・human-review）が読まれる', async () => {
  const { data } = dashboard(baseWorld());
  await data.loadAll();
  const i3 = data.issues().find((i) => i.fleet.facts.number === 3)!;
  assert.notEqual(i3.fleet.facts.gate, null, '計画ゲートの記録（App の名義）');
  assert.equal(i3.fleet.facts.planOkByApp, true, 'App が付けた agent:plan-ok');
  assert.equal(data.prs().find((p) => p.number === 5)!.fleet.humanReview, true, 'App の human-review のコメント');
  // App の名義のレビューは人のレビューに数えない（REST と同じ）
  assert.equal(data.prs().find((p) => p.number === 5)!.fleet.facts?.humanFeedbackSincePush, 1);
});

// --- 費用の見積もり ---

test('buildBatchQuery：rateLimit を問い合わせに含み、費用の見積もりは固定値', () => {
  const nums = (n: number) => Array.from({ length: n }, (_, k) => k + 1);
  for (const spec of [{ numbers: [1] }, { numbers: [], openPrs: 'detail' as const, openIssues: true }, { numbers: [3, 5], openPrs: 'light' as const }]) {
    assert.ok(buildBatchQuery(spec).query.includes(RATE_LIMIT), JSON.stringify(spec));
    assert.match(buildBatchQuery(spec).query, /^query DashBatch\(/);
  }
  assert.equal(buildBatchQuery({ numbers: nums(1) }).estimatedCost, 1, '番号 1 件');
  assert.equal(buildBatchQuery({ numbers: nums(10) }).estimatedCost, 3, '番号 10 件');
  assert.equal(buildBatchQuery({ numbers: nums(50) }).estimatedCost, 16, '番号 50 件');
  assert.equal(buildBatchQuery({ numbers: [], openPrs: 'detail', openIssues: true }).estimatedCost, 6, 'loadAll の1ページ');
  assert.equal(buildBatchQuery({ numbers: [3, 5], openPrs: 'light' }).estimatedCost, 1, 'refresh の1回目（変わった番号と、開いた PR の一覧の紐付けの欄）');
  assert.equal(buildBatchQuery({ numbers: [3, 3, 5] }).query, buildBatchQuery({ numbers: [5, 3] }).query, '同じ番号は1回だけ読む');
});

// --- 境目 ---

test('headRef の無い PR：main との比較が内側に流れず、behindMain は false', async () => {
  const world: World = { diff: DIFF, issues: [], prs: [{ number: 40, title: 'feat: pr40', body: 'no link', headRef: 'claude/issue-40-x', headSha: sha('4'), headRefMissing: true }] };
  const { fake, data } = dashboard(world);
  await data.loadAll();
  assert.deepEqual(data.prs().map((p) => [p.number, p.fleet.behindMain]), [[40, false]]);
  const names = callNames(fake);
  assert.deepEqual(unexpected(names, [diffPath('main', sha('4'))]), [], names.join('\n'));
  assert.equal(count(names, (n) => n === diffPath(sha('4'), 'main')), 0, '/compare/{head}...main は流れない');
});

test('refresh：見つからない番号（issueOrPullRequest が null、NOT_FOUND）を渡しても投げず、その番号のカードが消える', async () => {
  const world = baseWorld();
  const { fake, data } = dashboard(world);
  await data.loadAll();
  assert.ok(data.issues().some((i) => i.fleet.facts.number === 11));
  world.issues = world.issues.filter((i) => i.number !== 11);
  const from = fake.calls.length;
  await data.refresh([11, 99]);
  const names = callNames(fake, from);
  assert.deepEqual(names, ['graphql:DashBatch'], '見つからない番号を REST で確かめ直さない');
  assert.match(String(fake.calls.at(-1)!.body.query), /\bn99:issueOrPullRequest\b/);
  assert.deepEqual(data.issues().map((i) => i.fleet.facts.number), [3, 6], '#11 のカードが消える');
  assert.deepEqual(data.prs().map((p) => [p.number, p.issue]), [[5, 3], [7, 6], [8, null]], 'ほかのカードは残る');
});

test('非公開の App の check run（GraphQL の checkSuite の app が null）は、REST と同じくハーネスの App の名義として読む', async () => {
  const world = baseWorld();
  const p5 = world.prs.find((p) => p.number === 5)!;
  p5.checks = (p5.checks ?? []).map((c) => (c.app === APP_SLUG ? { ...c, hidden: true } : c));
  assert.ok(p5.checks.some((c) => c.hidden), '見本の前提：App の check run がある');
  const expected = await restView(world);
  const { data } = dashboard(world);
  await data.loadAll();
  assert.deepEqual(data.prs(), expected.prs);
  const facts = data.prs().find((p) => p.number === 5)!.fleet.facts;
  assert.equal(facts?.headPushedAt, '2026-09-26T05:00:00Z', 'App の agent/scope の開始時刻を push の時刻に使う');
  assert.deepEqual(facts?.acceptance, { reviewPass: true, at: '2026-09-26T00:00:00Z' }, 'App の agent/review があるので受け付けを読む');
});
