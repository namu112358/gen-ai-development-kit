import { spawnSync } from 'node:child_process';
import { checkAssignee, requireAssignee } from '../../../lib/assignee.ts';
import { appMarkKind, hasClaudeMark } from '../../../lib/blocks.ts';
import { describeFullAreas, fullAreas } from '../../../lib/concurrency.ts';
import { fleetConfig, reasonOf, type ReasonCode, syncLoopConfig } from '../../../lib/config.ts';
import { collectFleetIssues, type FleetIssueItem, prefetchedGitHub, readFleetSnapshot, readStepSnapshot } from '../../../lib/fleet-reads.ts';
import { type FleetIssue, fleetStatus, fleetStatusData, fleetTargets, mergeTreeResult, type PrConflict, renderFleetStatus, selectFleet } from '../../../lib/fleet.ts';
import { GitHub } from '../../../lib/github.ts';
import { fixRequestFindings } from '../../../lib/report.ts';
import { splitArgs } from '../../../lib/session-inputs.ts';
import { carriedCritique, type CritiqueRound, readStageFile, stageFilePath, writeStageFile } from '../../../lib/stage-file.ts';
import { isAppComment, type PullRequest } from '../../../lib/state.ts';
import { applyStepClaims, decideStep, type StepLocal, type StepResult } from '../../../lib/step.ts';
import { type AgentCommand, assigneeIo, checkFile, config, currentSession, fail, readJson, renderClaim, spawnGit } from '../cli.ts';

/**
 * fleet で並行して進める Issue・PR の表（読むだけ）と、Issue ごとに今やってよいノードを1つだけ返す step（同じ事実の集め方を使う）。
 *
 *   node harness/scripts/agent.ts fleet-status [--max <n>] [--json] [<Issue 番号>...]
 *                                                           fleet で並行して進める Issue・PR ごとの段階・次にやること・選ぶか（待つ理由）・触るファイルの重なり・
 *                                                           PR 同士の衝突の表（読むだけ）。番号を渡さなければ agent:ready・agent:plan-ok・agent:plan-review の開いた Issue と、agent:* の無い、コラボレーターか App が立てた開いた Issue（harness/lib/fleet.ts の fleetTargets）。
 *                                                           開いた PR 同士は head を fetch して git merge-tree で試し、衝突する組だけ後の側が待つ。
 *                                                           本数は --max を渡したときだけ制限する（既定は制限しない）。
 *                                                           Issue・PR の材料は GraphQL でまとめて読む（harness/lib/fleet-reads.ts。#249）
 *                                                           requireAssignee が true なら、Assignee が自分1人でない Issue を理由付きで待つにする。
 *                                                           --json なら、表と同じ中身（行・段階・選択と理由・重なり・メモ・着手宣言・選んだ数・進め方）を JSON で出す（harness/lib/fleet.ts の fleetStatusData）
 *   node harness/scripts/agent.ts step <番号> [--plan <file> | --critique <file>] [--proceed]
 *                                                           今やってよいノードを1つだけ返す（JSON。harness/lib/step.ts、書式は docs/formats.md の「agent.ts step の出力」。#306）。
 *                                                           段階は fleet-status と同じ事実と判断（fleet.ts の issueNode）で決め、セッションの ID・担当・着手宣言・ループの上限
 *                                                           （sync は harness.config.json の syncLoop.limit、批評は 3 回）・同じ指摘の繰り返しを確かめる。node なら宣言を出し
 *                                                           （同じ段階の自分の宣言があれば出さない）、stop ならこのセッションの宣言を解除する（批評の止まり方と claimed は解除しない）。
 *                                                           結果を段階のファイル（git の共通ディレクトリの下の agent-harness/stage/<セッションの ID>.json）に書く。
 *                                                           --plan は計画を書いた後（書式を検査して plan-critique へ）、--critique は plan-critic の出力を渡すとき、
 *                                                           --proceed は人が agent:plan-review の計画を進めると決めたとき。終了コードは node・wait が 0、stop が 2
 */

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

  // 材料はまとめた GraphQL の問い合わせで先に読む（harness/lib/fleet-reads.ts。#249）
  const snap = await readFleetSnapshot(gh, config, items.map((i) => i.number));
  const { issues } = await collectFleetIssues(prefetchedGitHub(gh, config, snap), config, items, snap);

  const facts = { issues, prConflicts: prConflicts(issues) };
  const rows = fleetStatus(facts);
  // Assignee を確かめる設定のときだけ、今の GitHub のユーザーを読む（Issue #172）
  const me = requireAssignee(config) ? (await gh.get<{ login: string }>('/user')).login : null;
  const session = currentSession();
  const sel = selectFleet(config, facts, rows, max, session, me);
  return json ? JSON.stringify(fleetStatusData(facts, rows, sel, max, session, mode), null, 2) : renderFleetStatus(rows, sel, max, mode);
}

/** step --critique の plan-critic の出力（verdict と必須の fixes の文）。読めなければ止める */
function readCritique(file: string): CritiqueRound {
  const v = readJson(file) as { verdict?: unknown; fixes?: unknown } | null;
  const verdict = v?.verdict;
  if (verdict !== 'go' && verdict !== 'revise' && verdict !== 'split' && verdict !== 'drop') fail([`${file}: verdict は go / revise / split / drop のどれか`]);
  const fixes: unknown[] = Array.isArray(v?.fixes) ? v.fixes : [];
  const must = fixes.flatMap((x) => {
    const f = x as { severity?: unknown; text?: unknown } | null;
    return f !== null && typeof f === 'object' && f.severity === 'must' && typeof f.text === 'string' ? [f.text] : [];
  });
  return { verdict, must };
}

/** 計画のファイルの書式の誤り（step --plan。agent.ts check と同じ検査。計画のファイルでなければ誤り） */
function planFileErrors(file: string): string[] {
  const c = checkFile(file);
  return c.kind === 'plan' ? c.errors : ['計画（agent-plan）のファイルではありません', ...c.errors];
}

/**
 * step <番号> [--plan <file> | --critique <file>] [--proceed]（Issue #306）。GitHub の事実を読み、harness/lib/step.ts で今やってよいノードを1つだけ決め、
 * 宣言の投稿・解除をして、段階のファイル（harness/lib/stage-file.ts）に書き、結果の JSON を出す。stop なら終了コード 2
 */
async function stepCommand(gh: GitHub, args: string[]): Promise<void> {
  const usage = 'step <Issue 番号> [--plan <計画のファイル> | --critique <批評のファイル>] [--proceed]';
  const proceed = args.includes('--proceed');
  const a = splitArgs(args.filter((x) => x !== '--proceed'), ['--plan', '--critique']);
  if (!a.ok) fail([...a.errors, usage]);
  const [num, ...rest] = a.value.positional;
  if (!num || !/^\d+$/.test(num) || rest.length > 0) fail([usage]);
  const planFile = a.value.options['--plan'];
  const critiqueFile = a.value.options['--critique'];
  if (planFile !== undefined && critiqueFile !== undefined) fail(['--plan と --critique は同時に渡さない', usage]);
  // 設定の誤りは GitHub を読む前に止める
  let syncLimit: number;
  try {
    syncLimit = syncLoopConfig(config).limit;
  } catch (e) {
    fail([`harness.config.json: ${(e as Error).message}`]);
  }
  const local: StepLocal = planFile !== undefined
    ? { kind: 'plan', errors: planFileErrors(planFile) }
    : critiqueFile !== undefined ? { kind: 'critique', round: readCritique(critiqueFile) } : { kind: 'none' };

  const n = Number(num);
  const session = currentSession();
  const item = await gh.get<FleetIssueItem>(`/issues/${n}`);
  if (item.pull_request) fail([`#${n} は PR です。Issue 番号を渡してください`]);
  // 読み取りは先読みの GitHub（#249）。宣言の投稿・読み直し（applyStepClaims）と担当の確かめ（assigneeIo）は、先読みを通さない gh で行う
  const snap = await readStepSnapshot(gh, config, n);
  const reads = prefetchedGitHub(gh, config, snap);
  const { issues, openPrs, openPrLabels } = await collectFleetIssues(reads, config, [item], snap);
  const issue = issues[0]!;
  const open = issue.prs.find((p) => !p.merged && p.facts !== null) ?? null;

  let fixRequests: ReturnType<typeof fixRequestFindings>[] = [];
  let mergeCommits = 0;
  let prBranch: string | null = null;
  let reasonComments = await reads.listComments(n);
  if (open) {
    const [reviews, commits, prComments, pr] = await Promise.all([
      reads.paginate<{ body: string | null; user: { login: string; type: string } | null }>(`/pulls/${open.number}/reviews`),
      reads.paginate<{ parents: unknown[] }>(`/pulls/${open.number}/commits`),
      reads.listComments(open.number),
      openPrs.find((p) => p.number === open.number) ?? reads.get<PullRequest>(`/pulls/${open.number}`),
    ]);
    fixRequests = reviews.filter((r) => isAppComment(config, r) && appMarkKind(r.body) === 'fix-request').map((r) => fixRequestFindings(r.body ?? ''));
    mergeCommits = commits.filter((c) => Array.isArray(c.parents) && c.parents.length > 1).length;
    prBranch = pr.head.ref;
    reasonComments = prComments;
  }
  // agent:blocked の理由：App か Claude の目印のあるコメントの最新の reasonMark
  const blockedReason = reasonComments.filter((c) => isAppComment(config, c) || hasClaudeMark(c.body)).map((c) => reasonOf(c.body)).filter((r): r is ReasonCode => r !== null).at(-1) ?? null;

  const commonDir = spawnGit(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const path = commonDir ? stageFilePath(commonDir, session) : null;
  const gateAt = issue.facts.gate?.at ?? null;
  const full = issue.planFiles !== null ? fullAreas(config, issue.planFiles, openPrLabels) : [];
  const decision = decideStep({
    issue,
    session,
    assignee: await checkAssignee(assigneeIo(gh), config, n),
    areaFull: full.length > 0 ? describeFullAreas(full) : null,
    fixRequests,
    mergeCommits,
    blockedReason,
    prBranch,
    syncLimit,
    critique: carriedCritique(path ? readStageFile(path) : null, n, gateAt),
    local,
    proceed,
    now: new Date(),
    humanClaimStaleHours: config.routine.humanClaimStaleHours,
  });

  // no-session の stop は宣言も解除もしない（decideStep が claim・release を空にする）
  const result: StepResult = session
    ? await applyStepClaims(gh, decision, { session, now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours, render: renderClaim })
    : decision.result;

  if (path && session) {
    writeStageFile(path, {
      version: 1,
      session,
      at: new Date().toISOString(),
      issue: n,
      pr: result.pr,
      node: result.node,
      kind: result.kind,
      branch: result.kind === 'node' ? result.branch : prBranch,
      branchPrefix: `claude/issue-${n}-`,
      files: issue.planFiles,
      critique: { issue: n, gateAt, rounds: decision.critique },
    });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'stop') process.exit(2);
}

export const commands: AgentCommand[] = [
  { name: 'fleet-status', run: async (args, ctx) => void console.log(await fleetStatusText(ctx.gh(), args)) },
  { name: 'step', run: (args, ctx) => stepCommand(ctx.gh(), args) },
];
