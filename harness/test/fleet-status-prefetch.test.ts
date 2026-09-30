// Issue #249：fleet-status と step の事実の集め方（collectFleetIssues）を、まとめた GraphQL の問い合わせの先読み（readFleetSnapshot・readStepSnapshot）で読んでも、今の REST の読み方と同じ事実・表・JSON になる（内側に流れる呼び出し・100件を超えるコメントとラベルのイベント）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, appMarkKind, claudeMark, renderBlock } from '../lib/blocks.ts';
import { areaLimitLabels } from '../lib/concurrency.ts';
import { CHECKS, fleetConfig, LABELS } from '../lib/config.ts';
import { issueFacts, prFacts } from '../lib/facts.ts';
import { type FleetIssue, type FleetPr, fleetStatus, fleetStatusData, renderFleetStatus, selectFleet } from '../lib/fleet.ts';
import { collectFleetIssues, type FleetIssueItem, prefetchedGitHub, readFleetSnapshot, readStepSnapshot } from '../lib/fleet-reads.ts';
import { GitHub } from '../lib/github.ts';
import { Snapshot } from '../lib/graphql-prefetch.ts';
import { isAppComment, isSameRepoPr, latestPlanGate, type PlanGateRecord, type PullRequest } from '../lib/state.ts';
import { config, type FakeGitHub } from './support/gate-fixtures.ts';
import { APP_SLUG, callNames, dashboardFake, REPO, type WActor, type WComment, type WEvent, type World } from './support/dashboard-fixtures.ts';

const APP_ACTOR: WActor = { login: APP_SLUG, bot: true };
/** 2^31 を超える ID（今のコメントの ID はこの大きさ） */
const BIG = 5902898007;
const sha = (c: string) => c.repeat(40);
const T = (m: number) => new Date(Date.UTC(2026, 8, 26, 0, m)).toISOString().replace('.000Z', 'Z');

function claimC(id: number, stage: string, at = '2026-09-26T00:00:00Z'): WComment {
  return { id, created_at: at, body: [claudeMark(), '着手しました。', '', renderBlock('agent-claim', { by: 'manual', at, stage })].join('\n') };
}
function planC(id: number, at?: string): WComment {
  return { id, ...(at ? { created_at: at } : {}), body: [claudeMark(), '計画です。', '', renderBlock('agent-plan', { version: 1 })].join('\n') };
}
function appC(id: number, kind: string, record?: unknown, at?: string): WComment {
  return { id, ...(at ? { created_at: at } : {}), author: APP_ACTOR, association: 'NONE', body: [appMark(kind), 'App です。', ...(record === undefined ? [] : [renderBlock('agent-app', record)])].join('\n') };
}
const planGate = (id: number, planCommentId: number, files: string[], at?: string) =>
  appC(id, 'plan-gate', { version: 1, planCommentId, pass: true, reasons: [], plan: { files, critique: { verdict: 'go', rounds: 1 } } }, at);

/**
 * 見本：
 * #3 plan-ok の Issue（人と App のコメント・着手宣言・計画ゲートの記録（plan.files）・ラベルのイベント・依存）と、Closes #3 の開いた PR #5（レビュー・check-run・App の human-review・main に遅れ）と Merge 済みの PR #4、
 * #13 計画ゲートを通った PR の無い Issue（#3 と files が重なる）、#11 ラベルだけの Issue、紐付けの無い開いた PR #8（領域のラベル）
 */
function baseWorld(): World {
  return {
    issues: [
      {
        number: 3, title: 'feat: three', body: 'Issue 3', labels: [LABELS.planOk, 'priority:p1'],
        comments: [
          { id: 100, body: '人のコメントです', author: { login: 'me' }, association: 'OWNER' },
          claimC(BIG, 'plan-critique'),
          planC(BIG + 100),
          { id: BIG + 150, body: '作者の無いコメント', author: null, association: 'NONE' },
          appC(BIG + 160, 'label-triage', { version: 1 }),
          planGate(BIG + 200, BIG + 100, ['docs/**', 'harness/lib/x.ts']),
          claimC(BIG + 300, 'implement'),
        ],
        events: [
          { event: 'labeled', label: LABELS.ready, created_at: '2026-09-26T01:00:00Z' },
          { event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T02:00:00Z', actor: APP_ACTOR },
          { event: 'labeled', label: LABELS.hold, created_at: '2026-09-26T03:00:00Z' },
          { event: 'unlabeled', label: LABELS.hold, created_at: '2026-09-26T04:00:00Z' },
        ],
        blockedBy: [{ number: 2, state: 'OPEN' }, { number: 9, state: 'CLOSED' }],
        closedBy: [{ number: 5, state: 'OPEN' }, { number: 4, state: 'MERGED' }, { number: 6, state: 'CLOSED' }],
      },
      {
        number: 13, title: 'feat: thirteen', labels: [LABELS.planOk],
        comments: [planC(BIG + 1000), planGate(BIG + 1001, BIG + 1000, ['docs/**'])],
        events: [{ event: 'labeled', label: LABELS.planOk, created_at: '2026-09-26T05:00:00Z', actor: APP_ACTOR }],
      },
      { number: 11, title: 'feat: eleven', labels: [LABELS.ready] },
    ],
    prs: [
      { number: 4, title: 'feat: pr4', state: 'closed', body: 'Closes #3', closing: [3], headSha: sha('4') },
      {
        number: 5, title: 'feat: pr5', body: 'Closes #3', closing: [3], headRef: 'claude/issue-3-x', headSha: sha('a'), labels: ['area:harness'],
        mergeableState: 'clean', aheadBy: 2,
        comments: [appC(BIG + 400, 'human-review'), { id: BIG + 450, body: 'PR への人のコメント', author: { login: 'me' } }],
        reviews: [
          { id: BIG + 600, state: 'COMMENTED', author: { login: 'rev' } },
          { id: 12, state: 'APPROVED', commit_id: sha('0'), author: { login: 'rev2' } },
          { id: BIG + 700, state: 'COMMENTED', author: APP_ACTOR, association: 'NONE' },
        ],
        checks: [
          { name: CHECKS.scope, app: APP_SLUG, started_at: '2026-09-26T05:00:00Z' },
          { name: CHECKS.review, app: APP_SLUG },
          { name: 'ci', app: 'github-actions' },
        ],
      },
      { number: 8, title: 'feat: pr8', body: 'no link', headRef: 'claude/issue-9-x', headSha: sha('e'), labels: ['area:harness'], aheadBy: 1 },
    ],
  };
}

const CLOSED_BY_QUERY = `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`;

/** #249 の前の harness/scripts/agent/commands/fleet-status.ts の collectFleetIssues（REST で harness/lib を直接呼ぶ）をそのまま書き直したもの。正解を作る */
async function restCollect(gh: GitHub, items: FleetIssueItem[]): Promise<{ issues: FleetIssue[]; openPrs: PullRequest[]; openPrLabels: string[][] }> {
  const repository = `${gh.owner}/${gh.repo}`;
  const openPrs = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, repository));
  const openPrLabels = areaLimitLabels(config, openPrs, repository);
  const prsOf = new Map<number, { number: number; state: string }[]>();
  for (const i of items) {
    const data = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
      CLOSED_BY_QUERY, { owner: gh.owner, repo: gh.repo, n: i.number });
    prsOf.set(i.number, data.repository.issue.closedByPullRequestsReferences.nodes
      .filter((p) => p.repository.nameWithOwner === repository && (p.state === 'OPEN' || p.state === 'MERGED'))
      .map((p) => ({ number: p.number, state: p.state })));
  }
  const prByIssue = new Map<number, number>();
  for (const [n, prs] of prsOf) {
    const open = prs.find((p) => p.state === 'OPEN');
    if (open) prByIssue.set(n, open.number);
  }
  const iFacts = await Promise.all(items.map((i) => issueFacts(gh, config, i, prByIssue, openPrLabels)));
  const readyAt = new Map(iFacts.map((f) => [f.number, f.readyAt]));
  const issueLabels = new Map(iFacts.map((f) => [f.number, f.labels]));
  const issues: FleetIssue[] = [];
  for (const [idx, item] of items.entries()) {
    const gate = latestPlanGate(config, await gh.listComments(item.number)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    const prs: FleetPr[] = [];
    for (const ref of prsOf.get(item.number) ?? []) {
      if (ref.state === 'MERGED') {
        prs.push({ number: ref.number, merged: true, draft: false, autoMerge: false, humanReview: false, behindMain: false, facts: null });
        continue;
      }
      const pr = openPrs.find((p) => p.number === ref.number) ?? await gh.get<PullRequest>(`/pulls/${ref.number}`);
      const [facts, comments, compare] = await Promise.all([
        prFacts(gh, config, pr, readyAt, issueLabels),
        gh.listComments(pr.number),
        gh.get<{ ahead_by: number }>(`/compare/${encodeURIComponent(pr.head.sha)}...${encodeURIComponent(config.defaultBranch)}`),
      ]);
      prs.push({
        number: pr.number, merged: false, draft: pr.draft, autoMerge: pr.auto_merge !== null && pr.auto_merge !== undefined,
        humanReview: comments.some((c) => isAppComment(config, c) && appMarkKind(c.body) === 'human-review'),
        behindMain: compare.ahead_by > 0,
        facts,
      });
    }
    issues.push({ facts: iFacts[idx]!, closed: item.state === 'closed', planFiles: gate?.value.plan?.files ?? null, prs, assignees: (item.assignees ?? []).map((u) => u.login) });
  }
  return { issues, openPrs, openPrLabels };
}

async function itemsOf(fake: FakeGitHub, numbers: number[]): Promise<FleetIssueItem[]> {
  const gh = new GitHub(fake, REPO);
  return Promise.all(numbers.map((n) => gh.get<FleetIssueItem>(`/issues/${n}`)));
}

/** 3通りの読み方：前の REST の集め方・空の Snapshot（全部が内側に流れる）・readFleetSnapshot の先読み */
async function threeWays(world: World, numbers: number[]) {
  const restFake = dashboardFake(world);
  const items = await itemsOf(restFake, numbers);
  const before = await restCollect(new GitHub(restFake, REPO), items);

  const emptyFake = dashboardFake(world);
  const emptyGh = new GitHub(emptyFake, REPO);
  const empty = await collectFleetIssues(prefetchedGitHub(emptyGh, config, new Snapshot()), config, items, new Snapshot());

  const fake = dashboardFake(world);
  const gh = new GitHub(fake, REPO);
  const snap = await readFleetSnapshot(gh, config, numbers);
  const snapCalls = fake.calls.length;
  const prefetched = await collectFleetIssues(prefetchedGitHub(gh, config, snap), config, items, snap);
  return { before, empty, prefetched, fake, snapCalls, items };
}

/** 先読みのときに内側に流れてはいけない呼び出し（Issue のコメント・timeline・blockedBy・closedBy の問い合わせ、PR のコメント・レビュー、main との比較、開いた PR の一覧） */
function forbidden(names: string[], issues: number[], prs: number[], heads: string[]): string[] {
  const bad = new Set<string>([
    'graphql:anonymous',
    'GET /pulls',
    ...issues.flatMap((n) => [`GET /issues/${n}/comments`, `GET /issues/${n}/timeline`]),
    ...prs.flatMap((n) => [`GET /issues/${n}/comments`, `GET /pulls/${n}/reviews`, `GET /commits/${sha('a')}/check-runs`]),
    ...heads.map((h) => `GET /compare/${encodeURIComponent(h)}...${encodeURIComponent(config.defaultBranch)}`),
  ]);
  return names.filter((n) => bad.has(n));
}

test('collectFleetIssues：readFleetSnapshot の先読みで読んだ事実が、空の Snapshot（今の REST の読み方）と、#249 の前の fleet-status の集め方と同じ', async () => {
  const { before, empty, prefetched } = await threeWays(baseWorld(), [3, 13, 11]);
  assert.deepEqual(empty, before, '空の Snapshot は前の REST の読み方と同じ');
  assert.deepEqual(prefetched, before, '先読みは前の REST の読み方と同じ');

  // 見本が確かめたい値を実際に含んでいる（どちらの読み方でも同じ値が落ちていて一致しただけ、を避ける）
  const i3 = prefetched.issues.find((i) => i.facts.number === 3)!;
  assert.equal(i3.facts.claim?.stage, 'implement');
  assert.equal(i3.facts.gate?.planCommentId, BIG + 100);
  assert.equal(i3.facts.planOkByApp, true);
  assert.equal(i3.facts.readyAt, '2026-09-26T01:00:00Z');
  assert.deepEqual(i3.facts.openBlockers, [2]);
  assert.equal(i3.facts.openPr, 5);
  assert.deepEqual(i3.planFiles, ['docs/**', 'harness/lib/x.ts']);
  assert.deepEqual(i3.prs.map((p) => [p.number, p.merged]), [[5, false], [4, true]], 'CLOSED の #6 は入らない');
  const p5 = i3.prs.find((p) => p.number === 5)!;
  assert.equal(p5.humanReview, true);
  assert.equal(p5.behindMain, true);
  assert.equal(p5.draft, true);
  assert.equal(p5.facts?.humanFeedbackSincePush, 1);
  assert.equal(p5.facts?.headPushedAt, '2026-09-26T05:00:00Z');
  assert.equal(p5.facts?.issue, 3);
  assert.deepEqual(prefetched.issues.find((i) => i.facts.number === 13)!.planFiles, ['docs/**']);
  assert.equal(prefetched.issues.find((i) => i.facts.number === 11)!.planFiles, null);
  assert.deepEqual(prefetched.openPrs.map((p) => p.number).sort((a, b) => a - b), [5, 8]);
  assert.ok(prefetched.openPrLabels.length > 0, '領域のラベルを数える材料');
});

test('fleetStatus → selectFleet → renderFleetStatus と fleetStatusData の出力が、今の REST の読み方と同じ', async () => {
  const { before, prefetched } = await threeWays(baseWorld(), [3, 13, 11]);
  const mode = fleetConfig(config);
  const render = (issues: FleetIssue[]) => {
    const facts = { issues, prConflicts: [] };
    const rows = fleetStatus(facts);
    const sel = selectFleet(config, facts, rows, null, null, null);
    return { text: renderFleetStatus(rows, sel, null, mode), json: fleetStatusData(facts, rows, sel, null, null, mode) };
  };
  const expected = render(before.issues);
  const got = render(prefetched.issues);
  assert.equal(got.text, expected.text);
  assert.deepEqual(got.json, expected.json);
  assert.match(got.text, /#3\b/);
  assert.match(got.text, /#13\b/);
});

test('readFleetSnapshot：先読みのときは、Issue のコメント・timeline・blockedBy・closedBy の問い合わせ、PR のコメント・レビュー・check-run、main との比較が内側に流れない', async () => {
  const { fake, snapCalls } = await threeWays(baseWorld(), [3, 13, 11]);
  const reading = callNames(fake).slice(0, snapCalls);
  assert.ok(reading.length > 0 && reading.every((n) => n.startsWith('graphql:Dash')), `先読みはまとめた問い合わせだけ：${reading.join(', ')}`);
  const after = callNames(fake, snapCalls);
  assert.deepEqual(forbidden(after, [3, 13, 11], [5], [sha('a')]), [], after.join('\n'));
  // 流れてよいのは PR の差分（patch-id 用の /compare/{base}...{head}）だけ
  assert.deepEqual(after.filter((n) => !n.startsWith(`GET /compare/${config.defaultBranch}...`)), [], after.join('\n'));
});

test('readFleetSnapshot：番号は 20 件ごとの問い合わせにまとめ、どの番号も1回だけ読む', async () => {
  const world = baseWorld();
  const extra = Array.from({ length: 24 }, (_, k) => 100 + k);
  for (const n of extra) world.issues.push({ number: n, title: `feat: ${n}`, labels: [LABELS.ready] });
  const numbers = [3, 13, 11, ...extra];
  const { before, prefetched, fake, snapCalls } = await threeWays(world, numbers);
  assert.deepEqual(prefetched, before);
  const batches = fake.calls.slice(0, snapCalls).filter((c) => /^query DashBatch\(/.test(String(c.body?.query)));
  const aliases = batches.map((c) => [...String(c.body.query).matchAll(/\bn(\d+):issueOrPullRequest\(/g)].map((m) => Number(m[1])));
  assert.ok(aliases.every((a) => a.length <= 20), aliases.map((a) => a.length).join(','));
  assert.deepEqual(aliases.flat().sort((a, b) => a - b), [...numbers].sort((a, b) => a - b));
});

/** コメント150件・ラベルのイベント120件の Issue #30。最後のページに着手宣言・計画・計画ゲートの記録・ラベルのイベントを置く */
function bigWorld(): World {
  const world = baseWorld();
  const comments: WComment[] = [];
  comments.push(claimC(BIG + 5000, 'plan', T(0)));
  for (let k = 1; k < 120; k++) comments.push({ id: BIG + 5000 + k, body: `人のコメント ${k}`, created_at: T(k), author: { login: 'me' } });
  comments.push(planC(BIG + 5120, T(120)));
  for (let k = 121; k < 130; k++) comments.push({ id: BIG + 5000 + k, body: `人のコメント ${k}`, created_at: T(k) });
  comments.push(planGate(BIG + 5130, BIG + 5120, ['src/big/**'], T(130)));
  for (let k = 131; k < 140; k++) comments.push({ id: BIG + 5000 + k, body: `人のコメント ${k}`, created_at: T(k) });
  comments.push(claimC(BIG + 5140, 'implement', T(140)));
  for (let k = 141; k < 150; k++) comments.push({ id: BIG + 5000 + k, body: `人のコメント ${k}`, created_at: T(k) });
  assert.equal(comments.length, 150);

  const events: WEvent[] = [];
  // 最初のページ：人が plan-ok を付ける（ここだけ読むと planOkByApp は false、readyAt は null）
  events.push({ event: 'labeled', label: LABELS.planOk, created_at: T(0) });
  for (let k = 1; k < 110; k++) events.push({ event: k % 2 === 1 ? 'labeled' : 'unlabeled', label: 'priority:p2', created_at: T(k) });
  events.push({ event: 'labeled', label: LABELS.ready, created_at: T(110) });
  for (let k = 111; k < 115; k++) events.push({ event: k % 2 === 1 ? 'labeled' : 'unlabeled', label: 'priority:p3', created_at: T(k) });
  events.push({ event: 'unlabeled', label: LABELS.planOk, created_at: T(115) });
  events.push({ event: 'labeled', label: LABELS.planOk, created_at: T(116), actor: APP_ACTOR });
  for (let k = 117; k < 120; k++) events.push({ event: 'labeled', label: 'area:harness', created_at: T(k) });
  assert.equal(events.length, 120);

  world.issues.push({ number: 30, title: 'feat: big', labels: [LABELS.planOk, LABELS.ready], comments, events });
  return world;
}

test('コメント150件・ラベルのイベント120件の Issue でも、最後のページの着手宣言・計画ゲートの記録・ラベルのイベントを取りこぼさない（AC 3）', async () => {
  const { before, empty, prefetched, fake, snapCalls } = await threeWays(bigWorld(), [30, 3]);
  assert.deepEqual(empty, before);
  assert.deepEqual(prefetched, before);
  const i30 = prefetched.issues.find((i) => i.facts.number === 30)!;
  assert.equal(i30.facts.claim?.stage, 'implement', '最後のページ（150件目の近く）の着手宣言');
  assert.equal(i30.facts.gate?.planCommentId, BIG + 5120, '2ページ目の計画ゲートの記録');
  assert.equal(i30.facts.latestPlanAt, T(120));
  assert.deepEqual(i30.planFiles, ['src/big/**']);
  assert.equal(i30.facts.readyAt, T(110), '2ページ目のラベルのイベント');
  assert.equal(i30.facts.planOkByApp, true, '2ページ目で App が付け直した plan-ok');

  const reading = callNames(fake).slice(0, snapCalls);
  assert.ok(reading.includes('graphql:DashMore'), `続きのページは GraphQL の問い合わせで読む：${reading.join(', ')}`);
  assert.ok(reading.every((n) => n.startsWith('graphql:Dash')), reading.join(', '));
  assert.deepEqual(forbidden(callNames(fake, snapCalls), [30, 3], [5], [sha('a')]), []);
});

test('readStepSnapshot：Issue 1件の collectFleetIssues が空の Snapshot のときと同じ。Closes する開いた PR は2回目の問い合わせで詳しく読む', async () => {
  for (const n of [3, 13, 11, 30]) {
    const world = bigWorld();
    const restFake = dashboardFake(world);
    const [item] = await itemsOf(restFake, [n]);
    const before = await restCollect(new GitHub(restFake, REPO), [item!]);
    const empty = await collectFleetIssues(prefetchedGitHub(new GitHub(dashboardFake(world), REPO), config, new Snapshot()), config, [item!], new Snapshot());

    const fake = dashboardFake(world);
    const gh = new GitHub(fake, REPO);
    const snap = await readStepSnapshot(gh, config, n);
    const snapCalls = fake.calls.length;
    const got = await collectFleetIssues(prefetchedGitHub(gh, config, snap), config, [item!], snap);
    assert.deepEqual(empty, before, `#${n} 空の Snapshot`);
    assert.deepEqual(got, empty, `#${n} 先読み`);

    const batches = fake.calls.slice(0, snapCalls).filter((c) => /^query DashBatch\(/.test(String(c.body?.query))).map((c) => String(c.body.query));
    if (n === 3) {
      assert.equal(batches.length, 2, '開いた PR #5 を2回目で詳しく読む');
      assert.match(batches[1]!, /\bn5:issueOrPullRequest\(/);
      assert.doesNotMatch(batches[1]!, /\bn4:issueOrPullRequest\(/, 'Merge 済みの PR は詳しく読まない');
      assert.equal(got.issues[0]!.prs.find((p) => p.number === 5)!.behindMain, true);
    } else {
      assert.equal(batches.length, 1, `#${n} は Closes する開いた PR が無いので1回`);
    }
    assert.deepEqual(forbidden(callNames(fake, snapCalls), [n], n === 3 ? [5] : [], n === 3 ? [sha('a')] : []), [], `#${n}`);
  }
});
