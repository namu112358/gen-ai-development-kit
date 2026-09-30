import { spawnSync } from 'node:child_process';
import { requireAssignee } from '../../../lib/assignee.ts';
import { appMarkKind } from '../../../lib/blocks.ts';
import { areaLimitLabels } from '../../../lib/concurrency.ts';
import { fleetConfig } from '../../../lib/config.ts';
import { issueFacts, prFacts } from '../../../lib/facts.ts';
import { type FleetIssue, type FleetPr, fleetStatus, fleetStatusData, fleetTargets, mergeTreeResult, type PrConflict, renderFleetStatus, selectFleet } from '../../../lib/fleet.ts';
import { GitHub } from '../../../lib/github.ts';
import { splitArgs } from '../../../lib/session-inputs.ts';
import { isAppComment, isSameRepoPr, latestPlanGate, type PlanGateRecord, type PullRequest } from '../../../lib/state.ts';
import { type AgentCommand, config, currentSession, fail } from '../cli.ts';

/**
 * fleet で並行して進める Issue・PR の表（読むだけ）。
 *
 *   node harness/scripts/agent.ts fleet-status [--max <n>] [--json] [<Issue 番号>...]
 *                                                           fleet で並行して進める Issue・PR ごとの段階・次にやること・選ぶか（待つ理由）・触るファイルの重なり・
 *                                                           PR 同士の衝突の表（読むだけ）。番号を渡さなければ agent:ready・agent:plan-ok・agent:plan-review の開いた Issue と、agent:* の無い、コラボレーターか App が立てた開いた Issue（harness/lib/fleet.ts の fleetTargets）。
 *                                                           開いた PR 同士は head を fetch して git merge-tree で試し、衝突する組だけ後の側が待つ。
 *                                                           本数は --max を渡したときだけ制限する（既定は制限しない）
 *                                                           requireAssignee が true なら、Assignee が自分1人でない Issue を理由付きで待つにする。
 *                                                           --json なら、表と同じ中身（行・段階・選択と理由・重なり・メモ・着手宣言・選んだ数・進め方）を JSON で出す（harness/lib/fleet.ts の fleetStatusData）
 */

type FleetIssueItem = { number: number; title: string; state: string; labels: { name: string }[]; pull_request?: unknown; user?: { login: string } | null; author_association?: string; assignees?: { login: string }[] | null };

/** Issue を Closes する PR（開いたもの・Merge 済みのもの） */
async function closingPrs(gh: GitHub, issue: number): Promise<{ number: number; state: string }[]> {
  const data = await gh.graphql<{ repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number state repository{nameWithOwner}}}}}}`,
    { owner: gh.owner, repo: gh.repo, n: issue },
  );
  return data.repository.issue.closedByPullRequestsReferences.nodes
    .filter((p) => p.repository.nameWithOwner === `${gh.owner}/${gh.repo}` && (p.state === 'OPEN' || p.state === 'MERGED'))
    .map((p) => ({ number: p.number, state: p.state }));
}

/**
 * fleet の Issue の開いた PR 同士を git merge-tree で試し、衝突する組（試せなかった組を含む）を返す。
 * PR ごとに head を fetch し（refs/pull/<n>/head）、組ごとに merge-tree を実行する。どちらもシェルを通さず、作業ツリーは変えない。
 */
function prConflicts(issues: FleetIssue[]): PrConflict[] {
  const heads = issues.flatMap((i) => i.prs.filter((p) => !p.merged && p.facts !== null).map((p) => ({ number: p.number, sha: p.facts!.headSha })));
  if (heads.length < 2) return [];
  const fetched = new Map(heads.map((h) => [h.number, spawnSync('git', ['fetch', '--quiet', '--no-tags', 'origin', `refs/pull/${h.number}/head`], { encoding: 'utf8' }).status === 0]));
  const out: PrConflict[] = [];
  for (const [idx, a] of heads.entries()) {
    for (const b of heads.slice(idx + 1)) {
      let status: number | null = null;
      if (fetched.get(a.number) && fetched.get(b.number)) {
        const r = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', a.sha, b.sha], { encoding: 'utf8' });
        // head が手元に無いときも終了コードは 1 になるが、木の ID を出さないので「試せなかった」に数える
        status = r.status === 1 && (r.stdout ?? '').trim() === '' ? null : r.status;
      }
      const result = mergeTreeResult(status);
      if (result !== 'clean') out.push({ prs: [a.number, b.number], untested: result === 'untested' });
    }
  }
  return out;
}

/** fleet の事実を GitHub から読み（書き込みはしない）、段階・選び方の表を返す。判断は harness/lib/fleet.ts の純粋関数 */
async function fleetStatusText(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'fleet-status [--max <n>] [--json] [<Issue 番号>...]';
  // --json は値を取らないので、splitArgs（値を取るオプションだけを扱う）の前に取り除く
  const json = args.includes('--json');
  const a = splitArgs(args.filter((x) => x !== '--json'), ['--max']);
  if (!a.ok) fail([...a.errors, usage]);
  const maxArg = a.value.options['--max'];
  if ((maxArg !== undefined && !/^[1-9]\d*$/.test(maxArg)) || a.value.positional.some((p) => !/^\d+$/.test(p))) fail([usage]);
  const max = maxArg === undefined ? null : Number(maxArg);
  // 進め方が決まらないまま表を出さない（設定の誤りは GitHub を読む前に止める）
  let mode: ReturnType<typeof fleetConfig>;
  try {
    mode = fleetConfig(config);
  } catch (e) {
    fail([`harness.config.json: ${(e as Error).message}`]);
  }
  const items: FleetIssueItem[] = a.value.positional.length > 0
    ? await Promise.all(a.value.positional.map((n) => gh.get<FleetIssueItem>(`/issues/${n}`)))
    : fleetTargets(await gh.paginate<FleetIssueItem>('/issues?state=open', 10), config);
  const nonIssue = items.find((i) => i.pull_request);
  if (nonIssue) fail([`#${nonIssue.number} は PR です。Issue 番号を渡してください`]);

  const repository = `${gh.owner}/${gh.repo}`;
  const openPrs = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, repository));
  const openPrLabels = areaLimitLabels(config, openPrs, repository);
  const prsOf = new Map<number, { number: number; state: string }[]>();
  for (const i of items) prsOf.set(i.number, await closingPrs(gh, i.number));
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
        number: pr.number,
        merged: false,
        draft: pr.draft,
        autoMerge: pr.auto_merge !== null && pr.auto_merge !== undefined,
        humanReview: comments.some((c) => isAppComment(config, c) && appMarkKind(c.body) === 'human-review'),
        behindMain: compare.ahead_by > 0,
        facts,
      });
    }
    issues.push({ facts: iFacts[idx]!, closed: item.state === 'closed', planFiles: gate?.value.plan?.files ?? null, prs, assignees: (item.assignees ?? []).map((u) => u.login) });
  }

  const facts = { issues, prConflicts: prConflicts(issues) };
  const rows = fleetStatus(facts);
  // Assignee を確かめる設定のときだけ、今の GitHub のユーザーを読む（Issue #172）
  const me = requireAssignee(config) ? (await gh.get<{ login: string }>('/user')).login : null;
  const session = currentSession();
  const sel = selectFleet(config, facts, rows, max, session, me);
  return json ? JSON.stringify(fleetStatusData(facts, rows, sel, max, session, mode), null, 2) : renderFleetStatus(rows, sel, max, mode);
}

export const commands: AgentCommand[] = [
  { name: 'fleet-status', run: async (args, ctx) => void console.log(await fleetStatusText(ctx.gh(), args)) },
];
