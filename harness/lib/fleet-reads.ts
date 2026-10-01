/**
 * fleet-status と step の事実集め（Issue ごとの Closes する PR・Issue と PR の事実・main との差・human-review・計画の files）。#249。
 * 材料はまとめた GraphQL の問い合わせ（harness/lib/graphql-prefetch.ts の readBatch）で先に読み、issueFacts・prFacts が送る REST の要求には先読みの Transport が答える。
 * 先読みで答えられない要求（PR の差分・Stacked PR の層の /pulls/{n}・読んでいない番号）だけが REST に流れる。書き込みはしない。
 */
import { appMarkKind } from './blocks.ts';
import { areaLimitLabels } from './concurrency.ts';
import type { HarnessConfig } from './config.ts';
import { issueFacts, prFacts } from './facts.ts';
import type { FleetIssue, FleetPr } from './fleet.ts';
import { GitHub, type Transport } from './github.ts';
import { PrefetchTransport, readBatch, Snapshot } from './graphql-prefetch.ts';
import { bodyIssueRefs, isAppComment, isSameRepoPr, latestPlanGate, linkedIssuesWithSource, type PlanGateRecord, type PullRequest, withStack } from './state.ts';

export type FleetIssueItem = { number: number; title: string; state: string; labels: { name: string }[]; pull_request?: unknown; user?: { login: string } | null; author_association?: string; assignees?: { login: string }[] | null };

/** まとめた問い合わせ1回に入れる Issue の数 */
const NUMBERS_PER_QUERY = 20;

/**
 * snap で答える先読みの GitHub（内側は gh。読み取りの回ごとに作る）。空の Snapshot なら、すべての要求が内側に流れる（今の REST の読み方と同じ）。
 * 先読みは読んだ時点のものなので、書き込みと、書いた後の読み直し（着手宣言の競り合い）には使わない
 */
export function prefetchedGitHub(gh: GitHub, config: HarnessConfig, snap: Snapshot): GitHub {
  const inner: Transport = { request: (method, path, opts) => gh.request(method, path, opts) };
  return new GitHub(new PrefetchTransport({ snap, inner, repoPath: gh.repoPath, config, diffs: new Map(), stacks: new Map() }), `${gh.owner}/${gh.repo}`);
}

/** fleet-status の先読み：対象の Issue（20件ごとに1回の問い合わせ）と、開いた PR の詳しい欄 */
export async function readFleetSnapshot(gh: GitHub, config: HarnessConfig, numbers: number[]): Promise<Snapshot> {
  const unique = [...new Set(numbers)];
  const snap = await readBatch(gh, config, { numbers: unique.slice(0, NUMBERS_PER_QUERY), openPrs: 'detail' });
  for (let i = NUMBERS_PER_QUERY; i < unique.length; i += NUMBERS_PER_QUERY) {
    snap.merge(await readBatch(gh, config, { numbers: unique.slice(i, i + NUMBERS_PER_QUERY) }));
  }
  return snap;
}

/**
 * step の先読み：Issue 1件と、開いた PR の一覧（紐付けに要る欄だけ）。Issue を Closes する開いた PR があれば、その番号だけ2回目の問い合わせで詳しく読む
 */
export async function readStepSnapshot(gh: GitHub, config: HarnessConfig, n: number): Promise<Snapshot> {
  const snap = await readBatch(gh, config, { numbers: [n], openPrs: 'light' });
  const repository = `${gh.owner}/${gh.repo}`;
  const open = (snap.closedBy.get(n) ?? []).filter((p) => p.repository.nameWithOwner === repository && p.state === 'OPEN').map((p) => p.number);
  if (open.length > 0) snap.merge(await readBatch(gh, config, { numbers: open }));
  return snap;
}

/** Issue を Closes する PR（開いたもの・Merge 済みのもの）。先読みにあればそれを使い、無ければ GraphQL で読む */
export async function closingPrs(gh: GitHub, issue: number, snap?: Snapshot): Promise<{ number: number; state: string }[]> {
  const nodes = snap?.closedBy.get(issue) ?? (await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`,
    { owner: gh.owner, repo: gh.repo, n: issue },
  )).repository.issue.closedByPullRequestsReferences.nodes;
  return nodes
    .filter((p) => p.repository.nameWithOwner === `${gh.owner}/${gh.repo}` && (p.state === 'OPEN' || p.state === 'MERGED'))
    .map((p) => ({ number: p.number, state: p.state }));
}

/** head が main に遅れているか。先読みの aheadBy があればそれを使い、無ければ（head のブランチが無いなど）REST の compare で読む */
async function behindMain(gh: GitHub, config: HarnessConfig, pr: PullRequest, snap: Snapshot): Promise<boolean> {
  const ahead = snap.details.get(pr.number)?.aheadBy;
  if (typeof ahead === 'number') return ahead > 0;
  const compare = await gh.get<{ ahead_by: number }>(`/compare/${encodeURIComponent(pr.head.sha)}...${encodeURIComponent(config.defaultBranch)}`);
  return compare.ahead_by > 0;
}

/**
 * fleet の Issue ごとの事実を読む（書き込みはしない）。fleet-status と step（Issue #306）が同じ集め方を使う。
 * gh は prefetchedGitHub で snap を被せたもの（素の gh と空の Snapshot なら今の REST の読み方）。openPrs は同じリポジトリの開いた PR（step が head のブランチと領域の上限に使う）
 */
export async function collectFleetIssues(gh: GitHub, config: HarnessConfig, items: FleetIssueItem[], snap: Snapshot): Promise<{ issues: FleetIssue[]; openPrs: PullRequest[]; openPrLabels: string[][] }> {
  const repository = `${gh.owner}/${gh.repo}`;
  const openPrs = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, repository));
  const openPrLabels = areaLimitLabels(config, openPrs, repository);
  const prsOf = new Map<number, { number: number; state: string }[]>();
  for (const i of items) prsOf.set(i.number, await closingPrs(gh, i.number, snap));
  // GitHub の紐付けが空の Issue だけ、開いた PR の本文の Closes #N で補う（紐付けの抜け）
  const linkGaps = new Map<number, number[]>();
  for (const i of items) {
    if ((prsOf.get(i.number) ?? []).some((p) => p.state === 'OPEN')) continue;
    for (const p of openPrs) {
      if (p.number === i.number || !bodyIssueRefs(p.body).some((r) => r.keyword === 'closes' && r.number === i.number)) continue;
      const linked = await linkedIssuesWithSource(gh, config, await withStack(gh, config, p));
      if (!linked.fromBody || !linked.issues.includes(i.number)) continue;
      prsOf.set(i.number, [...(prsOf.get(i.number) ?? []), { number: p.number, state: 'OPEN' }]);
      linkGaps.set(i.number, [...(linkGaps.get(i.number) ?? []), p.number]);
    }
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
      const [facts, comments, behind] = await Promise.all([
        prFacts(gh, config, pr, readyAt, issueLabels),
        gh.listComments(pr.number),
        behindMain(gh, config, pr, snap),
      ]);
      prs.push({
        number: pr.number,
        merged: false,
        draft: pr.draft,
        autoMerge: pr.auto_merge !== null && pr.auto_merge !== undefined,
        humanReview: comments.some((c) => isAppComment(config, c) && appMarkKind(c.body) === 'human-review'),
        behindMain: behind,
        facts,
      });
    }
    issues.push({ facts: iFacts[idx]!, closed: item.state === 'closed', planFiles: gate?.value.plan?.files ?? null, prs, assignees: (item.assignees ?? []).map((u) => u.login), ...(linkGaps.has(item.number) ? { linkGapPrs: linkGaps.get(item.number)! } : {}) });
  }

  return { issues, openPrs, openPrLabels };
}
