import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CLAUDE_MARK, extractBlock, hasClaudeMark, renderBlock } from '../lib/blocks.ts';
import { appLogin, LABELS, loadConfig, riskLabel, type HarnessConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv, type IssueComment } from '../lib/github.ts';
import { patchId } from '../lib/patch-id.ts';
import { evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';
import { buildQueue, type Claim, type IssueFacts, type PrFacts } from '../lib/queue.ts';
import {
  acceptanceForPatch,
  appRecords,
  closingIssues,
  isAgentPr,
  isAppComment,
  isTrustedComment,
  lastLabeled,
  latestPlanGate,
  prDiff,
  timeline,
  type PlanGateRecord,
  type PullRequest,
  type Review,
} from '../lib/state.ts';
import { parseVerdict } from '../lib/verdict.ts';

/**
 * Routine と人のセッションが使う CLI。GitHub の操作はここを通し、書式は投稿前に検査する。
 *
 *   node harness/scripts/agent.ts queue                     次にやること（JSON）
 *   node harness/scripts/agent.ts claim <n> [--manual]      着手宣言（agent:working＋コメント）
 *   node harness/scripts/agent.ts release <n>               着手宣言の解除
 *   node harness/scripts/agent.ts show-plan <issue>         計画ゲートを通過した計画（App の記録）
 *   node harness/scripts/agent.ts post-plan <issue> <file>  計画コメントを検査して投稿
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿
 *   node harness/scripts/agent.ts wait <issue> <blockers..> 依存待ち（agent:waiting）
 *   node harness/scripts/agent.ts block <n> <reason>        agent:blocked＋理由
 *   node harness/scripts/agent.ts check <file>              plan / verdict ブロックの書式検査のみ
 *   node harness/scripts/agent.ts footer <pr> <stage> <model> <minutes> <tokens>  PR 本文のメトリクス表に1行追記
 *   node harness/scripts/agent.ts session-url               この実行のセッション URL
 *
 * リポジトリは GITHUB_REPOSITORY か git remote から決める。
 */

const config = loadConfig();

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = spawnGit(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
}

function spawnGit(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

export function sessionUrl(): string | null {
  const id = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return id ? `https://claude.ai/code/${id.replace(/^cse_/, 'session_')}` : null;
}

function claimOf(comments: IssueComment[]): Claim | null {
  for (const c of [...comments].reverse()) {
    if (!hasClaudeMark(c.body) || !isTrustedComment(c)) continue;
    const b = extractBlock(c.body, 'agent-claim');
    if (b.found && b.ok) return b.value as Claim;
  }
  return null;
}

function latestClaudeBlockAt(comments: IssueComment[], kind: 'agent-plan' | 'agent-verdict'): IssueComment | null {
  return [...comments].reverse().find((c) => isTrustedComment(c) && hasClaudeMark(c.body) && extractBlock(c.body, kind).found) ?? null;
}

async function openBlockers(gh: GitHub, n: number): Promise<number[]> {
  const data = await gh.graphql<{ repository: { issue: { blockedBy: { nodes: { number: number; state: string }[] } } } }>(
    `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){blockedBy(first:50){nodes{number state}}}}}`,
    { owner: gh.owner, repo: gh.repo, n },
  );
  return data.repository.issue.blockedBy.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number);
}

async function issueFacts(gh: GitHub, cfg: HarnessConfig, issue: { number: number; title: string; labels: { name: string }[] }, prByIssue: Map<number, number>): Promise<IssueFacts> {
  const [events, comments] = await Promise.all([timeline(gh, issue.number), gh.listComments(issue.number)]);
  const gate = latestPlanGate(cfg, comments);
  const plan = latestClaudeBlockAt(comments, 'agent-plan');
  const planOk = lastLabeled(events, LABELS.planOk);
  return {
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    readyAt: lastLabeled(events, LABELS.ready)?.created_at ?? null,
    claim: claimOf(comments),
    openBlockers: await openBlockers(gh, issue.number),
    gate: gate ? { pass: gate.value.pass, planCommentId: gate.value.planCommentId, at: gate.comment.created_at } : null,
    latestPlanAt: plan?.created_at ?? null,
    planOkByApp: planOk?.actor?.login === appLogin(cfg),
    openPr: prByIssue.get(issue.number) ?? null,
  };
}

async function prFacts(gh: GitHub, cfg: HarnessConfig, pr: PullRequest, readyAt: Map<number, string | null>): Promise<PrFacts> {
  const [comments, reviews, commit, issues] = await Promise.all([
    gh.listComments(pr.number),
    gh.paginate<Review>(`/pulls/${pr.number}/reviews`),
    gh.get<{ commit: { committer: { date: string } } }>(`/commits/${pr.head.sha}`),
    closingIssues(gh, pr.number),
  ]);
  const pushedAt = commit.commit.committer.date;
  const patch = patchId(await prDiff(gh, pr));
  const acc = acceptanceForPatch(cfg, comments, patch);
  const accRecord = appRecords<{ patchId: string }>(cfg, comments, 'acceptance').filter((r) => r.value.patchId === patch).at(-1);
  const verdict = latestClaudeBlockAt(comments, 'agent-verdict');
  const lastGateReply = comments.filter((c) => isAppComment(cfg, c) && /kind=(acceptance|verdict-rejected)/.test(c.body)).at(-1);
  const verdictBlock = verdict ? extractBlock(verdict.body, 'agent-verdict') : null;
  const verdictForHead = verdictBlock?.found && verdictBlock.ok && (verdictBlock.value as { headSha?: string }).headSha === pr.head.sha;
  const human = reviews.filter(
    (r) => r.user?.login !== appLogin(cfg) && isTrustedComment(r) && !hasClaudeMark(r.body) && ['COMMENTED', 'CHANGES_REQUESTED'].includes(r.state) && r.submitted_at > pushedAt,
  );
  const issue = issues[0] ?? null;
  return {
    number: pr.number,
    issue,
    readyAt: issue ? (readyAt.get(issue) ?? null) : null,
    labels: pr.labels.map((l) => l.name),
    headSha: pr.head.sha,
    headPushedAt: pushedAt,
    acceptance: acc && accRecord ? { reviewPass: acc.reviewPass, at: accRecord.comment.created_at } : null,
    verdictAwaitingGate: Boolean(verdictForHead && (!lastGateReply || lastGateReply.created_at < verdict!.created_at)),
    humanFeedbackSincePush: human.length,
  };
}

async function queue(gh: GitHub): Promise<void> {
  const issues = (await gh.paginate<{ number: number; title: string; labels: { name: string }[]; pull_request?: unknown }>(`/issues?state=open&labels=${encodeURIComponent(LABELS.ready)}`)).filter((i) => !i.pull_request);
  const prs = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isAgentPr(config, p, `${gh.owner}/${gh.repo}`));
  const prByIssue = new Map<number, number>();
  for (const pr of prs) for (const n of await closingIssues(gh, pr.number)) prByIssue.set(n, pr.number);
  const iFacts = await Promise.all(issues.map((i) => issueFacts(gh, config, i, prByIssue)));
  const readyAt = new Map(iFacts.map((f) => [f.number, f.readyAt]));
  const pFacts = await Promise.all(prs.map((p) => prFacts(gh, config, p, readyAt)));
  const result = buildQueue(iFacts, pFacts, { currentSession: sessionUrl(), now: new Date(), routineClaimTakeoverMinutes: config.routine.routineClaimTakeoverMinutes }, config.routine.maxItemsPerRun);
  console.log(JSON.stringify(result, null, 2));
}

async function claim(gh: GitHub, n: number, manual: boolean): Promise<void> {
  const url = sessionUrl();
  const value: Claim = manual || !url ? { by: 'manual', at: new Date().toISOString() } : { by: 'routine', session: url, at: new Date().toISOString() };
  await gh.addLabels(n, [LABELS.working]);
  await gh.comment(n, [CLAUDE_MARK, `着手しました（${value.by === 'routine' ? `Routine: ${value.session}` : '手動'}）。`, '', renderBlock('agent-claim', value)].join('\n'));
}

function readBlockFile(file: string): string {
  const body = readFileSync(file, 'utf8');
  return body.includes(CLAUDE_MARK) ? body : `${CLAUDE_MARK}\n${body}`;
}

function checkFile(file: string): { kind: 'plan' | 'verdict'; errors: string[]; value?: unknown } {
  const body = readFileSync(file, 'utf8');
  for (const kind of ['plan', 'verdict'] as const) {
    const b = extractBlock(body, `agent-${kind}`);
    if (!b.found) continue;
    if (!b.ok) return { kind, errors: [b.error] };
    const parsed = kind === 'plan' ? parsePlan(b.value) : parseVerdict(b.value);
    return parsed.ok ? { kind, errors: [], value: parsed.value } : { kind, errors: parsed.errors };
  }
  throw new Error('agent-plan / agent-verdict ブロックがありません');
}

async function postPlan(gh: GitHub, n: number, file: string): Promise<void> {
  const checked = checkFile(file);
  if (checked.kind !== 'plan' || checked.errors.length > 0) fail(checked.errors);
  const plan = { value: checked.value as Plan };
  const gate = evaluatePlanGate(plan.value, n);
  // 表示用の想定 Risk と、人の判断が要る場合の plan-review は Routine が付ける（ゲートも独立に判断する）
  const risks = (['low', 'medium', 'high', 'critical'] as const).map(riskLabel);
  for (const r of risks) if (r !== riskLabel(plan.value.risk)) await gh.removeLabel(n, r);
  await gh.addLabels(n, [riskLabel(plan.value.risk), ...(gate.pass ? [] : [LABELS.planReview])]);
  const posted = await gh.comment(n, readBlockFile(file));
  await gh.removeLabel(n, LABELS.working);
  console.log(JSON.stringify({ posted: posted.html_url, expectedGate: gate }, null, 2));
}

async function postVerdict(gh: GitHub, n: number, file: string): Promise<void> {
  const checked = checkFile(file);
  if (checked.kind !== 'verdict' || checked.errors.length > 0) fail(checked.errors);
  const v = checked.value as { pr: number; headSha: string };
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  if (v.pr !== n) fail([`verdict.pr（${v.pr}）が #${n} と一致しません`]);
  if (v.headSha !== pr.head.sha) fail([`verdict.headSha が現在の head（${pr.head.sha}）と一致しません。判定し直してください`]);
  const posted = await gh.comment(n, readBlockFile(file));
  await gh.removeLabel(n, LABELS.working);
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

async function showPlan(gh: GitHub, n: number): Promise<void> {
  const comments = await gh.listComments(n);
  const gate = latestPlanGate(config, comments) as { value: PlanGateRecord & { plan?: unknown } } | null;
  if (!gate?.value.pass) fail([`#${n} に計画ゲートを通過した計画がありません`]);
  const planComment = comments.find((c) => c.id === gate!.value.planCommentId);
  console.log(JSON.stringify({ gate: gate!.value, planCommentUrl: planComment?.html_url, planCommentBody: planComment?.body }, null, 2));
}

const FOOTER_START = '<!-- agent-harness:metrics -->';

/** PR 本文末尾のメトリクス表（段階・モデル・所要時間・トークン使用量）に1行追記する */
export function appendFooter(body: string, row: { stage: string; model: string; minutes: string; tokens: string; session: string }): string {
  const line = `| ${new Date().toISOString().slice(0, 16)} | ${row.stage} | ${row.model} | ${row.minutes} | ${row.tokens} | ${row.session} |`;
  if (!body.includes(FOOTER_START)) {
    return [body.trimEnd(), '', FOOTER_START, '### 実行メトリクス', '', '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン | セッション |', '| --- | --- | --- | --- | --- | --- |', line].join('\n');
  }
  return `${body.trimEnd()}\n${line}`;
}

function fail(errors: string[]): never {
  console.error(['書式エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'session-url') return void console.log(sessionUrl() ?? '(none)');
  if (cmd === 'check') {
    const r = checkFile(args[0]!);
    if (r.errors.length) fail(r.errors);
    return void console.log(`OK (${r.kind})`);
  }
  const gh = new GitHub(transportFromEnv(), repository());
  const n = Number(args[0]);
  switch (cmd) {
    case 'queue': return queue(gh);
    case 'claim': return claim(gh, n, args.includes('--manual'));
    case 'release': return gh.removeLabel(n, LABELS.working);
    case 'show-plan': return showPlan(gh, n);
    case 'post-plan': return postPlan(gh, n, args[1]!);
    case 'post-verdict': return postVerdict(gh, n, args[1]!);
    case 'footer': {
      const [, stage, model, minutes, tokens] = args;
      const pr = await gh.get<PullRequest>(`/pulls/${n}`);
      await gh.request('PATCH', `/pulls/${n}`, { body: { body: appendFooter(pr.body ?? '', { stage: stage!, model: model!, minutes: minutes!, tokens: tokens!, session: sessionUrl() ?? '手動' }) } });
      return;
    }
    case 'wait': {
      await gh.addLabels(n, [LABELS.waiting]);
      await gh.removeLabel(n, LABELS.working);
      await gh.comment(n, `${CLAUDE_MARK}\n未解決の blocker（${args.slice(1).map((b) => `#${b}`).join(', ')}）があるため \`agent:waiting\` にしました。blocker が閉じると App が外します。`);
      return;
    }
    case 'block': {
      await gh.addLabels(n, [LABELS.blocked]);
      await gh.removeLabel(n, LABELS.working);
      await gh.comment(n, `${CLAUDE_MARK}\n\`agent:blocked\` にしました。人の対応が必要です。\n\n${args.slice(1).join(' ')}`);
      return;
    }
    default:
      console.error('usage: see header of harness/scripts/agent.ts');
      process.exit(1);
  }
}

await main();
