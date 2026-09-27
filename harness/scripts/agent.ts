import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appMarkKind, CLAUDE_MARK, extractBlock, renderBlock } from '../lib/blocks.ts';
import { describeFullAreas, fullAreas } from '../lib/concurrency.ts';
import { LABELS, loadConfig, reasonMark, REASON_CODES, riskLabel, type ReasonCode } from '../lib/config.ts';
import { computeQueue, issueFacts, prFacts } from '../lib/facts.ts';
import { fleetStatus, renderFleetStatus, selectFleet, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { issueRow, labelAuditRows, prRow, renderAuditLines, type AuditIssue, type LabelAuditRow } from '../lib/label-rules.ts';
import { evaluatePlanGate, parsePlan, plannerRequestsHuman, type Plan } from '../lib/plan.ts';
import type { Claim } from '../lib/queue.ts';
import { parseChildMarker } from '../lib/epic.ts';
import {
  checkJudgeInput, composeVerdict, epicChildrenFromRecords, parseComposeArgs, parsePreviousCritique, renderCriticInput, renderJudgeInput, splitArgs,
  type CheckRun, type JudgeFacts, type ParentEpic, type PrCommit,
} from '../lib/session-inputs.ts';
import { closingIssues, isAppComment, isSameRepoPr, latestPlanGate, type PlanGateRecord, type PullRequest } from '../lib/state.ts';
import { estimateCost, findSessionTranscripts, summarizeUsage, totalTokens } from '../lib/usage.ts';
import { parseVerdict } from '../lib/verdict.ts';
import { addWorktree, mainRepoRoot, removeWorktree } from '../lib/worktree.ts';

/**
 * Routine と人のセッションが使う CLI。書式は投稿前に検査する。
 *
 * ■ Routine 用（GitHub API を呼ばない。投稿・ラベル操作は Routine が GitHub の MCP ツールで行う）
 *   node harness/scripts/agent.ts render-claim [--manual] [--release]     着手宣言（または解除）コメントの本文
 *   node harness/scripts/agent.ts render-block <reason-code> <text>       人に返すとき（agent:blocked）のコメント本文。理由コードは必須
 *   node harness/scripts/agent.ts render-plan <issue> <file>              計画コメントを検査し {body, addLabels, removeLabels}
 *   node harness/scripts/agent.ts render-verdict <pr> <headSha> <file>    判定コメントを検査し本文を出力
 *   node harness/scripts/agent.ts render-metrics <stage> <model> <minutes> [tokens]  PR に残すメトリクスのコメント本文（トークン数と推定料金はセッション記録から自動で記入。読めなければ tokens か unknown）
 *   node harness/scripts/agent.ts usage [transcriptPath]                  このセッション（サブエージェントを含む）のモデル別トークン数と推定料金（JSON）
 *   node harness/scripts/agent.ts check <file>                            plan / verdict ブロックの書式検査のみ
 *   node harness/scripts/agent.ts worktree <ブランチ|SHA> [--detach]           作業用の worktree を作り、パスを出力（既にあればそのパス）
 *   node harness/scripts/agent.ts worktree-remove <ブランチ|SHA>           worktree を削除
 *   node harness/scripts/agent.ts session-url                             この実行のセッション URL
 *
 * ■ 人のセッション用（gh の認証で GitHub API を呼ぶ）
 *   node harness/scripts/agent.ts queue                     次にやること（JSON）
 *   node harness/scripts/agent.ts claim <n> [--manual] [--force]  着手宣言のコメント。--manual は、計画の触るファイルの領域の開いた PR が上限（areaConcurrency）に達していれば止まる（--force で着手）
 *   node harness/scripts/agent.ts release <n>               着手宣言の解除コメント
 *   node harness/scripts/agent.ts show-plan <issue>         計画ゲートを通過した計画（App の記録）
 *   node harness/scripts/agent.ts post-plan <issue> <file>  計画コメントを検査して投稿
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿
 *   node harness/scripts/agent.ts judge-input <pr>          Reviewer に渡す入力（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの agent-plan ブロックは省く〕、
 *                                                           Epic の子課題なら親 Epic〔子課題の一覧と Validation Requirements〕、計画ゲートの記録の計画、PR 本文、
 *                                                           PR のコラボレーターのコメント〔判定コメントを除く〕、agent/scope の結果、前回の判定の head とブロッキング指摘、
 *                                                           前回の head の後の main の取り込みの有無）をファイルに書き、パスを出力
 *   node harness/scripts/agent.ts compose-verdict <pr> <reviewer.json> <risk.json> --judge-input <file> [--model <m>]
 *                                                           サブエージェントの出力から判定コメントを作って検査し、ファイルのパスを出力（投稿は post-verdict）。
 *                                                           オプションの位置は問わない。judge-input のファイルの PR 番号が <pr> と違えば止まる。
 *                                                           判定した head は judge-input のファイルの headSha。現在の head と違えば止まる。
 *                                                           metrics.judgedBy はセッション URL（無ければ「付き添いのセッション」）
 *   node harness/scripts/agent.ts critic-input <issue> <plan-file> [--previous <critique.json>]
 *                                                           plan-critic に渡す入力（Issue 本文、コラボレーターのコメント、計画。
 *                                                           --previous は前回の plan-critic の出力で、必須の fixes を「前回の批評」に入れる）をファイルに書き、パスを出力
 *   node harness/scripts/agent.ts label-audit [番号..]      必須ラベルの不足と違反の一覧（ダッシュボードの「ラベルが足りない Issue・PR」と同じ検査）。
 *                                                           番号を渡せばその Issue・PR だけ、渡さなければダッシュボードと同じ範囲（agent:* か epic の開いた Issue と Agent PR）
 *   node harness/scripts/agent.ts fleet-status [--max <n>] [<Issue 番号>...]
 *                                                           fleet で並行して進める Issue・PR ごとの段階・次にやること・選ぶか（待つ理由）・触るファイルの重なり・
 *                                                           領域の上限の表（読むだけ）。番号を渡さなければ agent:ready・agent:plan-ok・agent:plan-review の開いた Issue。
 *                                                           --max は人が1回にさばける数（既定 3）
 *   node harness/scripts/agent.ts wait <issue> <blockers..> 依存待ち（agent:waiting）
 *   node harness/scripts/agent.ts block <n> <reason-code> <text>  agent:blocked＋理由コード
 *   node harness/scripts/agent.ts check <file>              plan / verdict ブロックの書式検査のみ
 *   node harness/scripts/agent.ts footer <pr> <stage> <model> <minutes> <tokens>  PR 本文のメトリクス表に1行追記
 *   node harness/scripts/agent.ts worktree <ブランチ|SHA> [--detach]           作業用の worktree を作り、パスを出力（既にあればそのパス）
 *   node harness/scripts/agent.ts worktree-remove <ブランチ|SHA>           worktree を削除
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


function claimBody(manual: boolean, release = false): string {
  const url = sessionUrl();
  const base: Claim = manual || !url ? { by: 'manual', at: new Date().toISOString() } : { by: 'routine', session: url, at: new Date().toISOString() };
  const value: Claim = release ? { ...base, released: true } : base;
  const who = value.by === 'routine' ? `Routine: ${value.session}` : '手動';
  return [CLAUDE_MARK, release ? `着手を解除しました（${who}）。` : `着手しました（${who}）。`, '', renderBlock('agent-claim', value)].join('\n');
}

function blockBody(code: string, text: string): string {
  if (!(code in REASON_CODES)) fail([`理由コードは ${Object.keys(REASON_CODES).join(' / ')} のいずれか`]);
  return [CLAUDE_MARK, reasonMark(code as ReasonCode), `\`agent:blocked\` にしました（${REASON_CODES[code as ReasonCode]}）。人の対応が必要です。`, '', text].join('\n');
}

async function claim(gh: GitHub, n: number, manual: boolean, force: boolean): Promise<void> {
  if (manual && !force) {
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    const repository = `${gh.owner}/${gh.repo}`;
    const labels: string[][] = [];
    for (const p of await gh.paginate<PullRequest>('/pulls?state=open')) {
      // この Issue を閉じる PR（続きの作業）は数えない
      if (!isSameRepoPr(p, repository) || (await closingIssues(gh, p.number)).includes(n)) continue;
      labels.push(p.labels.map((l) => l.name));
    }
    const full = fullAreas(config, gate?.value.plan?.files ?? [], labels);
    if (full.length > 0) fail([`${describeFullAreas(full)}。どれかが Merge されてから着手してください（急ぐなら --force）`]);
  }
  await gh.comment(n, claimBody(manual));
}

/** 計画コメントを検査し、投稿する本文と付け外しするラベルを返す（表示用の risk:* と、必要なら plan-review） */
function renderPlan(n: number, file: string): { body: string; addLabels: string[]; removeLabels: string[]; expectedGate: { pass: boolean; reasons: string[] } } {
  const checked = checkFile(file);
  if (checked.kind !== 'plan' || checked.errors.length > 0) fail(checked.errors);
  const plan = checked.value as Plan;
  const gate = evaluatePlanGate(plan, n, config);
  const risks = (['low', 'medium', 'high', 'critical'] as const).map(riskLabel);
  return {
    body: readBlockFile(file),
    addLabels: [riskLabel(plan.risk), ...(plannerRequestsHuman(plan) ? [LABELS.planReview] : [])],
    removeLabels: risks.filter((r) => r !== riskLabel(plan.risk)),
    expectedGate: gate,
  };
}

/** 判定コメントを検査し、投稿する本文を返す。headSha は投稿直前に確かめた PR の head */
function renderVerdict(n: number, headSha: string, file: string): string {
  const checked = checkFile(file);
  if (checked.kind !== 'verdict' || checked.errors.length > 0) fail(checked.errors);
  const v = checked.value as { pr: number; headSha: string };
  if (v.pr !== n) fail([`verdict.pr（${v.pr}）が #${n} と一致しません`]);
  if (v.headSha !== headSha) fail([`verdict.headSha が現在の head（${headSha}）と一致しません。判定し直してください`]);
  return readBlockFile(file);
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
  const r = renderPlan(n, file);
  for (const l of r.removeLabels) await gh.removeLabel(n, l);
  await gh.addLabels(n, r.addLabels);
  const posted = await gh.comment(n, r.body);
  console.log(JSON.stringify({ posted: posted.html_url, expectedGate: r.expectedGate }, null, 2));
}

async function postVerdict(gh: GitHub, n: number, file: string): Promise<void> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const posted = await gh.comment(n, renderVerdict(n, pr.head.sha, file));
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

async function showPlan(gh: GitHub, n: number): Promise<void> {
  const comments = await gh.listComments(n);
  const gate = latestPlanGate(config, comments) as { value: PlanGateRecord & { plan?: unknown; planBodySha256?: string } } | null;
  if (!gate?.value.pass) fail([`#${n} に計画ゲートを通過した計画がありません`]);
  const planComment = comments.find((c) => c.id === gate!.value.planCommentId);
  // ゲート通過後に計画コメントが編集されていたら本文は渡さない（実装の入力は App が写した計画だけ）
  const intact = planComment !== undefined && gate!.value.planBodySha256 === createHash('sha256').update(planComment.body).digest('hex');
  console.log(JSON.stringify({
    gate: gate!.value,
    planCommentUrl: planComment?.html_url,
    planCommentBody: intact ? planComment!.body : null,
    note: intact ? undefined : '計画コメントはゲート通過後に編集されたか見つかりません。gate.plan（App の写し）だけに従ってください',
  }, null, 2));
}

/** 一時ディレクトリにファイルを書き、パスを返す */
function writeTemp(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-harness-')), name);
  writeFileSync(path, text);
  return path;
}

type IssueItem = { number: number; title: string; body: string | null };

/** Epic の子課題なら親を読む。子課題の一覧は App の epic-split の記録から、無ければ Sub-issues の API から */
async function parentEpic(gh: GitHub, body: string | null): Promise<ParentEpic | undefined> {
  const mark = parseChildMarker(body);
  if (!mark) return undefined;
  const parent = await gh.get<IssueItem>(`/issues/${mark.parent}`);
  const recorded = epicChildrenFromRecords(config, await gh.listComments(mark.parent));
  if (recorded === null) {
    const subs = await gh.paginate<IssueItem>(`/issues/${mark.parent}/sub_issues`);
    return { number: mark.parent, title: parent.title, body: parent.body, children: subs.map((c) => ({ number: c.number, title: c.title })), childrenSource: 'sub-issues' };
  }
  const children: ParentEpic['children'] = [];
  for (const c of recorded) children.push({ number: c, title: (await gh.get<IssueItem>(`/issues/${c}`)).title });
  return { number: mark.parent, title: parent.title, body: parent.body, children, childrenSource: 'record' };
}

async function judgeInput(gh: GitHub, n: number): Promise<string> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const issues: JudgeFacts['issues'] = [];
  for (const i of await closingIssues(gh, n)) {
    const issue = await gh.get<IssueItem>(`/issues/${i}`);
    const epic = await parentEpic(gh, issue.body);
    issues.push({ number: i, title: issue.title, body: issue.body, comments: await gh.listComments(i), ...(epic ? { epic } : {}) });
  }
  const text = renderJudgeInput(config, {
    pr: { number: n, headSha: pr.head.sha, body: pr.body },
    issues,
    prComments: await gh.listComments(n),
    checkRuns: await gh.paginate<CheckRun>(`/commits/${pr.head.sha}/check-runs`),
    commits: await gh.paginate<PrCommit>(`/pulls/${n}/commits`),
  });
  return writeTemp(`judge-input-${n}.txt`, text);
}

async function criticInput(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'critic-input <issue> <plan-file> [--previous <critique.json>]';
  const a = splitArgs(args, ['--previous']);
  if (!a.ok) fail([...a.errors, usage]);
  const [issueArg, planFile] = a.value.positional;
  if (a.value.positional.length !== 2 || !issueArg || !planFile || !/^\d+$/.test(issueArg)) fail([usage]);
  const n = Number(issueArg);
  const previousFile = a.value.options['--previous'];
  let previous;
  if (previousFile) {
    const p = parsePreviousCritique(readFileSync(previousFile, 'utf8'));
    if (!p.ok) fail(p.errors.map((e) => `${previousFile}: ${e}`));
    previous = p.value;
  }
  const issue = await gh.get<IssueItem>(`/issues/${n}`);
  return writeTemp(`critic-input-${n}.txt`, renderCriticInput(issue, await gh.listComments(n), readFileSync(planFile, 'utf8'), previous));
}

/** 必須ラベルの不足と違反を、ダッシュボードと同じ関数（harness/lib/label-rules.ts）で検査する */
async function labelAudit(gh: GitHub, args: string[]): Promise<string> {
  if (args.some((a) => !/^\d+$/.test(a))) fail(['label-audit [番号..]']);
  let rows: LabelAuditRow[];
  if (args.length === 0) {
    const issues = await gh.paginate<AuditIssue>('/issues?state=open', 10);
    const prs = await gh.paginate<PullRequest>('/pulls?state=open', 5);
    rows = labelAuditRows(config, `${gh.owner}/${gh.repo}`, issues, prs);
  } else {
    rows = [];
    for (const n of args.map(Number)) {
      const issue = await gh.get<AuditIssue>(`/issues/${n}`);
      rows.push(issue.pull_request ? prRow(config, await gh.get<PullRequest>(`/pulls/${n}`)) : issueRow(config, issue));
    }
  }
  const lines = renderAuditLines(rows);
  return lines.length > 0 ? lines.join('\n') : `ラベルの不足・違反はありません（${rows.length} 件を検査）`;
}

type FleetIssueItem = { number: number; title: string; state: string; labels: { name: string }[]; pull_request?: unknown };

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

/** fleet の事実を GitHub から読み（書き込みはしない）、段階・選び方の表を返す。判断は harness/lib/fleet.ts の純粋関数 */
async function fleetStatusText(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'fleet-status [--max <n>] [<Issue 番号>...]';
  const a = splitArgs(args, ['--max']);
  if (!a.ok) fail([...a.errors, usage]);
  const maxArg = a.value.options['--max'];
  if ((maxArg !== undefined && !/^[1-9]\d*$/.test(maxArg)) || a.value.positional.some((p) => !/^\d+$/.test(p))) fail([usage]);
  const max = maxArg === undefined ? 3 : Number(maxArg);
  const targets = [LABELS.ready, LABELS.planOk, LABELS.planReview] as string[];
  const items: FleetIssueItem[] = a.value.positional.length > 0
    ? await Promise.all(a.value.positional.map((n) => gh.get<FleetIssueItem>(`/issues/${n}`)))
    : (await gh.paginate<FleetIssueItem>('/issues?state=open', 10)).filter((i) => !i.pull_request && i.labels.some((l) => targets.includes(l.name)));
  const nonIssue = items.find((i) => i.pull_request);
  if (nonIssue) fail([`#${nonIssue.number} は PR です。Issue 番号を渡してください`]);

  const repository = `${gh.owner}/${gh.repo}`;
  const openPrs = (await gh.paginate<PullRequest>('/pulls?state=open')).filter((p) => isSameRepoPr(p, repository));
  const openPrLabels = openPrs.map((p) => p.labels.map((l) => l.name));
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
    issues.push({ facts: iFacts[idx]!, closed: item.state === 'closed', planFiles: gate?.value.plan?.files ?? null, prs });
  }

  const facts = { issues, openPrLabels };
  const rows = fleetStatus(facts);
  return renderFleetStatus(rows, selectFleet(config, facts, rows, max), max);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail([`${file}: JSON として読めません: ${(e as Error).message}`]);
  }
}

async function composeVerdictFile(gh: GitHub, args: string[]): Promise<string> {
  const a = parseComposeArgs(args);
  if (!a.ok) fail(a.errors);
  const { pr: n, reviewerFile, riskFile, judgeInput: inputFile, model } = a.value;
  const judged = checkJudgeInput(readFileSync(inputFile, 'utf8'), n);
  if (!judged.ok) fail(judged.errors.map((e) => `${inputFile}: ${e}`));
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const r = composeVerdict({
    pr: n,
    judgedHead: judged.value,
    currentHead: pr.head.sha,
    reviewer: readJson(reviewerFile),
    risk: readJson(riskFile),
    meta: { model, judgedBy: sessionUrl() ?? '付き添いのセッション' },
  });
  if (!r.ok) fail(r.errors);
  return writeTemp(`verdict-${n}.md`, r.value);
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

/** セッション記録の集計。記録が無ければ null（処理は止めない） */
function usageReport(explicit?: string) {
  const files = findSessionTranscripts(process.cwd(), explicit);
  const lines: string[] = [];
  for (const f of files) {
    try {
      lines.push(...readFileSync(f, 'utf8').split('\n'));
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  const summary = summarizeUsage(lines);
  if (Object.keys(summary).length === 0) return null;
  const cost = estimateCost(summary, config.pricing ?? {});
  return {
    files,
    perModel: Object.fromEntries(Object.entries(summary).map(([m, tokens]) => [m, { tokens, estimatedUsd: cost.perModel[m] ?? null }])),
    total: totalTokens(summary),
    estimatedUsd: cost.totalUsd,
    note: 'API で動かした場合の推定料金（USD）。サブスク利用ではトークン単位の請求はない',
  };
}

function renderMetrics(stage: string, model: string, minutes: string, tokensArg?: string): string {
  const u = usageReport();
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const tokens = u ? [u.total.input, u.total.output, u.total.cacheWrite5m + u.total.cacheWrite1h, u.total.cacheRead].map(fmt).join(' / ') : (tokensArg ?? 'unknown');
  const usd = !u ? 'unknown' : u.estimatedUsd === null ? '不明' : `$${u.estimatedUsd.toFixed(2)}`;
  return [
    CLAUDE_MARK,
    '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン（入力/出力/キャッシュ書込/キャッシュ読込） | 推定料金（USD） | セッション |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${new Date().toISOString().slice(0, 16)} | ${stage} | ${model} | ${minutes} | ${tokens} | ${usd} | ${sessionUrl() ?? '手動'} |`,
    '',
    'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。',
  ].join('\n');
}

function fail(errors: string[]): never {
  console.error(['書式エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'session-url') return void console.log(sessionUrl() ?? '(none)');
  if (cmd === 'worktree' || cmd === 'worktree-remove') {
    try {
      const opts = { root: mainRepoRoot(), defaultBranch: config.defaultBranch };
      if (cmd === 'worktree') return void console.log(addWorktree(args[0]!, args.includes('--detach'), opts));
      return removeWorktree(args[0]!, opts);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
  if (cmd === 'render-claim') return void console.log(claimBody(args.includes('--manual'), args.includes('--release')));
  if (cmd === 'render-block') return void console.log(blockBody(args[0]!, args.slice(1).join(' ')));
  if (cmd === 'render-plan') return void console.log(JSON.stringify(renderPlan(Number(args[0]), args[1]!), null, 2));
  if (cmd === 'render-verdict') return void console.log(renderVerdict(Number(args[0]), args[1]!, args[2]!));
  if (cmd === 'render-metrics') return void console.log(renderMetrics(args[0]!, args[1]!, args[2]!, args[3]));
  if (cmd === 'usage') return void console.log(JSON.stringify(usageReport(args[0]) ?? { error: 'セッション記録が見つからないか、usage がありません' }, null, 2));
  if (cmd === 'check') {
    const r = checkFile(args[0]!);
    if (r.errors.length) fail(r.errors);
    return void console.log(`OK (${r.kind})`);
  }
  const gh = new GitHub(transportFromEnv(), repository());
  const n = Number(args[0]);
  switch (cmd) {
    case 'queue': return void console.log(JSON.stringify(await computeQueue(gh, config, sessionUrl()), null, 2));
    case 'claim': return claim(gh, n, args.includes('--manual'), args.includes('--force'));
    case 'release': return void (await gh.comment(n, claimBody(true, true)));
    case 'show-plan': return showPlan(gh, n);
    case 'post-plan': return postPlan(gh, n, args[1]!);
    case 'post-verdict': return postVerdict(gh, n, args[1]!);
    case 'judge-input': return void console.log(await judgeInput(gh, n));
    case 'critic-input': return void console.log(await criticInput(gh, args));
    case 'compose-verdict': return void console.log(await composeVerdictFile(gh, args));
    case 'label-audit': return void console.log(await labelAudit(gh, args));
    case 'fleet-status': return void console.log(await fleetStatusText(gh, args));
    case 'footer': {
      const [, stage, model, minutes, tokens] = args;
      const pr = await gh.get<PullRequest>(`/pulls/${n}`);
      await gh.request('PATCH', `/pulls/${n}`, { body: { body: appendFooter(pr.body ?? '', { stage: stage!, model: model!, minutes: minutes!, tokens: tokens!, session: sessionUrl() ?? '手動' }) } });
      return;
    }
    case 'wait': {
      await gh.addLabels(n, [LABELS.waiting]);
      await gh.comment(n, `${CLAUDE_MARK}\n未解決の blocker（${args.slice(1).map((b) => `#${b}`).join(', ')}）があるため \`agent:waiting\` にしました。blocker が閉じると App が外します。`);
      return;
    }
    case 'block': {
      const body = blockBody(args[1]!, args.slice(2).join(' '));
      await gh.addLabels(n, [LABELS.blocked]);
      await gh.comment(n, body);
      return;
    }
    default:
      console.error('usage: see header of harness/scripts/agent.ts');
      process.exit(1);
  }
}

await main();
