import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archReviewRange, checkArchReviewRecord, checkIssueDrafts, renderArchReviewRecord } from '../lib/arch-review.ts';
import { appMarkKind, claudeMark, extractBlock, renderBlock, withClaudeMark } from '../lib/blocks.ts';
import { areaLimitLabels, countsTowardAreaLimit, describeFullAreas, fullAreas } from '../lib/concurrency.ts';
import { decisionTargets, parseDecision, uncoveredTargets, type Decision } from '../lib/decision.ts';
import { LABELS, loadConfig, reasonMark, REASON_CODES, riskLabel, type ReasonCode } from '../lib/config.ts';
import { claimOf, computeQueue, issueFacts, prFacts } from '../lib/facts.ts';
import { fleetStatus, fleetTargets, mergeTreeResult, renderFleetStatus, selectFleet, type FleetIssue, type FleetPr, type PrConflict } from '../lib/fleet.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { issueRow, labelAuditRows, prRow, renderAuditLines, type AuditIssue, type LabelAuditRow } from '../lib/label-rules.ts';
import { evaluatePlanGate, parsePlan, plannerRequestsHuman, type Plan } from '../lib/plan.ts';
import { CLAIM_STAGES, claimBlocker, claimValueAfterPlan, requireOwnClaim, worktreeClaimIssue, type Claim, type ClaimStage } from '../lib/queue.ts';
import { parseChildMarker } from '../lib/epic.ts';
import { judgedHeadError, samePrPatch } from '../lib/patch-id.ts';
import {
  checkJudgeInput, composeVerdict, epicChildrenFromRecords, parseComposeArgs, parsePreviousCritique, renderCriticInput, renderJudgeInput, selectPastPrs, splitArgs,
  lowerLayers, PAST_PR_FILE_LIMIT, type CheckRun, type JudgeFacts, type ParentEpic, type PastPrReview, type PastPrReviewComment, type PastPrs, type PrCommit, type StackFacts,
} from '../lib/session-inputs.ts';
import { transcriptSessionId } from '../lib/session.ts';
import { classifyBase, stackOf } from '../lib/stack.ts';
import { changedFiles, findDashboard, isAppComment, isSameRepoPr, latestPlanGate, linkedIssues, withStack, type PlanGateRecord, type PullRequest } from '../lib/state.ts';
import { estimateCost, findSessionTranscriptsWithNote, summarizeUsage, totalTokens } from '../lib/usage.ts';
import { parseVerdict } from '../lib/verdict.ts';
import { addWorktree, ensureNodeModules, mainRepoRoot, removeWorktree } from '../lib/worktree.ts';

/**
 * Routine と人のセッションが使う CLI。書式は投稿前に検査する。
 *
 * ■ Routine 用（GitHub API を呼ばない。投稿・ラベル操作は Routine が GitHub の MCP ツールで行う）
 *   node harness/scripts/agent.ts render-claim [--manual] [--release] [--stage <段階>]  着手宣言（または解除）コメントの本文
 *   node harness/scripts/agent.ts render-block <reason-code> <text>       人に返すとき（agent:blocked）のコメント本文。理由コードは必須
 *   node harness/scripts/agent.ts render-plan <issue> <file>              計画コメントを検査し {body, addLabels, removeLabels}
 *   node harness/scripts/agent.ts render-verdict <pr> <headSha> <file>    判定コメントを検査し本文を出力
 *   node harness/scripts/agent.ts render-metrics <stage> <model> <minutes> [tokens]  PR に残すメトリクスのコメント本文（トークン数と推定料金は usage と同じ記録から自動で記入。読めなければ tokens か unknown。最も新しい記録に戻ったときは本文にそう書く）
 *   node harness/scripts/agent.ts usage [transcriptPath]                  このセッション（サブエージェントを含む）のモデル別トークン数と推定料金（JSON）。
 *                                                           パスが無ければ AGENT_HARNESS_SESSION の <ID>.jsonl を選び、無ければ最も新しい記録（そのことを note に書く）
 *   node harness/scripts/agent.ts check <file>                            plan / verdict / decision ブロックの書式検査のみ
 *   node harness/scripts/agent.ts worktree <ブランチ|SHA> [--detach]           作業用の worktree を作り、パスを出力（既にあればそのパス）。
 *                                                           node_modules が無ければ npm ci も行う（npm の出力は標準エラー。標準出力の最終行がパス）。
 *                                                           付き添いのセッションで claude/issue-<番号>- のブランチなら、先にこのセッションの着手宣言
 *                                                           （そのブランチの開いた PR があれば PR の宣言、無ければ Issue の宣言）を確かめる
 *   node harness/scripts/agent.ts worktree-remove <ブランチ|SHA>           worktree を削除
 *   node harness/scripts/agent.ts session-url                             この実行のセッション URL
 *
 * ■ 人のセッション用（gh の認証で GitHub API を呼ぶ）
 *   node harness/scripts/agent.ts queue                     次にやること（JSON）
 *   node harness/scripts/agent.ts claim <n> [--manual] [--stage <段階>] [--force] [--takeover]
 *                                                           着手宣言のコメント（段階とこのセッションの ID を書く。同じセッションなら段階の更新）。
 *                                                           --manual は、計画の触るファイルの領域の判定前の Agent PR（Draft）が上限（areaConcurrency）に達していれば止まる（--force で着手）。
 *                                                           ほかのセッションの着手宣言があれば止まる（期限切れでも。引き継ぐのは人が決めて --takeover）
 *   node harness/scripts/agent.ts release <n>               着手宣言の解除コメント
 *   node harness/scripts/agent.ts show-plan <issue>         計画ゲートを通過した計画（App の記録）
 *   node harness/scripts/agent.ts post-plan <issue> <file>  計画コメントを検査して投稿（このセッションの着手宣言が要る）。投稿の後、ゲートを通る見込みなら段階 plan-gate の宣言を出し直し、通らない見込み（人の判断待ち）なら解除する（出力の claim）
 *   node harness/scripts/agent.ts post-decision <issue> <file>  決定の記録（agent-decision）を検査して投稿（App の最新の計画ゲートの記録の計画コメントと、答えの無い項目が無いことを確かめる。ラベルは変えない）
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿。headSha が現在の head と違っても PR 自身の差分（patch-id）が同じなら
 *                                                           判定した head のまま投稿する。違えば止まる
 *   node harness/scripts/agent.ts judge-input <pr>          Reviewer に渡す入力（head、Closes する Issue の本文とコラボレーターのコメント〔計画コメントの agent-plan ブロックは省く〕、
 *                                                           Epic の子課題なら親 Epic〔子課題の一覧と Validation Requirements〕、計画ゲートの記録の計画、PR 本文、
 *                                                           PR のコラボレーターのコメント〔判定コメントを除く〕、agent/scope の結果、前回の判定の head とブロッキング指摘、
 *                                                           前回の head の後の main の取り込みの有無、PR の状態、変更ファイル（先頭 30 件）を触った Merge 済みの過去の PR
 *                                                           〔Merge の新しい順に最大 10 件〕のコラボレーターのコメント〔App・Claude の目印・空の本文を除き、
 *                                                           1件 1500 字・節全体 20000 字で切る〕）をファイルに書き、パスを出力
 *   node harness/scripts/agent.ts compose-verdict <pr> <reviewer.json> <risk.json> --judge-input <file> [--model <m>]
 *                                                           サブエージェントの出力から判定コメントを作って検査し、ファイルのパスを出力（投稿は post-verdict）。
 *                                                           オプションの位置は問わない。judge-input のファイルの PR 番号が <pr> と違えば止まる。
 *                                                           判定した head は judge-input のファイルの headSha。現在の head と違っても PR 自身の差分（patch-id）が
 *                                                           同じなら判定した head のまま。違えば止まる。
 *                                                           metrics.judgedBy はセッション URL（無ければ「付き添いのセッション」）
 *   node harness/scripts/agent.ts critic-input <issue> <plan-file> [--previous <critique.json>]  （このセッションの着手宣言が要る）
 *                                                           plan-critic に渡す入力（Issue 本文、コラボレーターのコメント、計画。
 *                                                           --previous は前回の plan-critic の出力で、必須の fixes を「前回の批評」に入れる）をファイルに書き、パスを出力
 *   node harness/scripts/agent.ts label-audit [番号..]      必須ラベルの不足と違反の一覧（ダッシュボードの「ラベルが足りない Issue・PR」と同じ検査）。
 *                                                           番号を渡せばその Issue・PR だけ、渡さなければダッシュボードと同じ範囲（agent:* か epic の開いた Issue と Agent PR）
 *   node harness/scripts/agent.ts fleet-status [--max <n>] [<Issue 番号>...]
 *                                                           fleet で並行して進める Issue・PR ごとの段階・次にやること・選ぶか（待つ理由）・触るファイルの重なり・
 *                                                           PR 同士の衝突の表（読むだけ）。番号を渡さなければ agent:ready・agent:plan-ok・agent:plan-review の開いた Issue と、agent:* の無い、コラボレーターか App が立てた開いた Issue（harness/lib/fleet.ts の fleetTargets）。
 *                                                           開いた PR 同士は head を fetch して git merge-tree で試し、衝突する組だけ後の側が待つ。
 *                                                           本数は --max を渡したときだけ制限する（既定は制限しない）
 *   node harness/scripts/agent.ts arch-review-range [--since <sha>] [--until <sha>] [--last <n>]
 *                                                           arch-review が見る Merge 済みの PR の範囲（JSON。読むだけ）。--since（40桁の SHA）か、無ければダッシュボード Issue の
 *                                                           前回の arch-review の記録の headSha から、--until（既定は既定ブランチの先頭）までの compare のコミットを PR に対応させる。
 *                                                           前回の記録も --since も無いか --last なら、既定ブランチ宛ての Merge 済みの PR の新しい順に N 本（既定 10）
 *   node harness/scripts/agent.ts arch-review-drafts <file> arch-review の Issue の下書き（[{title, body, duplicateOf?}] の JSON）を検査し、人に示す一覧を出力
 *                                                           （GitHub は読まない。タイトル・Issue Form の必須の見出し・agent:ready を含む labels を誤りにする）
 *   node harness/scripts/agent.ts arch-review-record <file> [--dry-run]
 *                                                           arch-review の記録（見た範囲と要約の JSON）を検査し、ダッシュボード Issue にコメントする（次の実行の前回になる）。
 *                                                           --dry-run は本文を出すだけ。ダッシュボードが無ければ止まる
 *   node harness/scripts/agent.ts wait <issue> <blockers..> 依存待ち（agent:waiting）
 *   node harness/scripts/agent.ts block <n> <reason-code> <text>  agent:blocked＋理由コード
 *   node harness/scripts/agent.ts check <file>              plan / verdict / decision ブロックの書式検査のみ
 *   node harness/scripts/agent.ts footer <pr> <stage> <model> <minutes> <tokens>  PR 本文のメトリクス表に1行追記
 *   node harness/scripts/agent.ts worktree <ブランチ|SHA> [--detach]           作業用の worktree を作り、パスを出力（既にあればそのパス）。
 *                                                           node_modules が無ければ npm ci も行う（npm の出力は標準エラー。標準出力の最終行がパス）
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

/**
 * 今のセッションの ID。Routine（CLAUDE_CODE_REMOTE_SESSION_ID）ならセッションの URL、
 * 付き添いのセッションなら SessionStart の hook（.claude/hooks/session-env.ts）が書いた AGENT_HARNESS_SESSION。どちらも無ければ null
 */
export function currentSession(): string | null {
  return sessionUrl() ?? (process.env.AGENT_HARNESS_SESSION || null);
}

const isRoutine = (): boolean => Boolean(process.env.CLAUDE_CODE_REMOTE_SESSION_ID);

function parseStage(args: string[]): ClaimStage | undefined {
  const i = args.indexOf('--stage');
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || !(CLAIM_STAGES as readonly string[]).includes(v)) fail([`--stage は ${CLAIM_STAGES.join(' / ')} のいずれか`]);
  return v as ClaimStage;
}

export function sessionUrl(): string | null {
  const id = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return id ? `https://claude.ai/code/${id.replace(/^cse_/, 'session_')}` : null;
}


/** このセッションの手動の宣言の値 */
function manualClaim(stage?: ClaimStage): Extract<Claim, { by: 'manual' }> {
  const session = currentSession();
  return { by: 'manual', at: new Date().toISOString(), ...(session ? { session } : {}), ...(stage ? { stage } : {}) };
}

function claimBody(manual: boolean, release = false, stage?: ClaimStage): string {
  const url = sessionUrl();
  const base: Claim = manual || !url ? manualClaim(stage) : { by: 'routine', session: url, at: new Date().toISOString() };
  return renderClaim(release ? { ...base, released: true } : base);
}

function renderClaim(value: Claim): string {
  const who = value.by === 'routine' ? `Routine: ${value.session}` : '手動';
  const what = value.released ? `着手を解除しました（${who}）。` : `着手しました（${who}${value.stage ? `、段階 ${value.stage}` : ''}）。`;
  return [claudeMark(currentSession()), what, '', renderBlock('agent-claim', value)].join('\n');
}

function blockBody(code: string, text: string): string {
  if (!(code in REASON_CODES)) fail([`理由コードは ${Object.keys(REASON_CODES).join(' / ')} のいずれか`]);
  return [claudeMark(currentSession()), reasonMark(code as ReasonCode), `\`agent:blocked\` にしました（${REASON_CODES[code as ReasonCode]}）。人の対応が必要です。`, '', text].join('\n');
}

async function claim(gh: GitHub, n: number, manual: boolean, force: boolean, takeover: boolean, stage?: ClaimStage): Promise<void> {
  if (manual) {
    const blocker = claimBlocker(claimOf(await gh.listComments(n)), currentSession(), { takeover, now: new Date(), humanClaimStaleHours: config.routine.humanClaimStaleHours });
    if (blocker) fail([blocker]);
  }
  if (manual && !force) {
    const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    const repository = `${gh.owner}/${gh.repo}`;
    const labels: string[][] = [];
    for (const p of await gh.paginate<PullRequest>('/pulls?state=open')) {
      // 数えるのは判定前の Agent PR（Draft）だけ。この Issue に紐付く PR（続きの作業。スタックの層は本文の Refs／Closes）は数えない
      if (!countsTowardAreaLimit(config, p, repository) || (await linkedIssues(gh, config, await withStack(gh, config, p))).includes(n)) continue;
      labels.push(p.labels.map((l) => l.name));
    }
    const full = fullAreas(config, gate?.value.plan?.files ?? [], labels);
    if (full.length > 0) fail([`${describeFullAreas(full)}。どれかが Merge されてから着手してください（急ぐなら --force）`]);
  }
  await gh.comment(n, claimBody(manual, false, stage));
}

/** critic-input・post-plan・worktree の前に、このセッションの着手宣言を確かめる（Routine では確かめない） */
async function ensureOwnClaim(gh: GitHub, n: number): Promise<void> {
  if (isRoutine()) return;
  const r = requireOwnClaim(claimOf(await gh.listComments(n)), currentSession());
  if (r.error) fail([`#${n}: ${r.error}`]);
  if (r.warning) console.error(`注意: #${n}: ${r.warning}`);
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

/**
 * 判定コメントを検査し、投稿する本文を返す。headSha は投稿直前に確かめた PR の head。
 * samePatch を渡すと、head が違っても samePatch(判定した head) が true（PR 自身の差分の patch-id が同じ）なら通す。
 * 渡さなければ完全一致を求める（render-verdict）
 */
function renderVerdict(n: number, headSha: string, file: string, samePatch?: (judgedHead: string) => boolean): string {
  const checked = checkFile(file);
  if (checked.kind !== 'verdict' || checked.errors.length > 0) fail(checked.errors);
  const v = checked.value as { pr: number; headSha: string };
  if (v.pr !== n) fail([`verdict.pr（${v.pr}）が #${n} と一致しません`]);
  if (samePatch === undefined) {
    if (v.headSha !== headSha) fail([`verdict.headSha が現在の head（${headSha}）と一致しません。判定し直してください`]);
  } else {
    const error = judgedHeadError(v.headSha, headSha, () => samePatch(v.headSha));
    if (error !== null) fail([error]);
  }
  return readBlockFile(file);
}

/** 判定した head と今の head で PR 自身の差分（origin/<base>...<head>）の patch-id が同じか。git fetch の後に比べる */
function samePatchAsCurrent(pr: PullRequest, judgedHead: string): boolean {
  spawnSync('git', ['fetch', '-q', 'origin'], { encoding: 'utf8' });
  return samePrPatch(`origin/${pr.base.ref}`, judgedHead, pr.head.sha);
}

function readBlockFile(file: string): string {
  const body = readFileSync(file, 'utf8');
  return withClaudeMark(body, currentSession());
}

function checkFile(file: string): { kind: 'plan' | 'verdict' | 'decision'; errors: string[]; value?: unknown } {
  const body = readFileSync(file, 'utf8');
  for (const kind of ['plan', 'verdict', 'decision'] as const) {
    const b = extractBlock(body, `agent-${kind}`);
    if (!b.found) continue;
    if (!b.ok) return { kind, errors: [b.error] };
    const parsed = kind === 'plan' ? parsePlan(b.value) : kind === 'verdict' ? parseVerdict(b.value) : parseDecision(b.value);
    return parsed.ok ? { kind, errors: [], value: parsed.value } : { kind, errors: parsed.errors };
  }
  throw new Error('agent-plan / agent-verdict / agent-decision ブロックがありません');
}

async function postPlan(gh: GitHub, n: number, file: string): Promise<void> {
  const r = renderPlan(n, file);
  await ensureOwnClaim(gh, n);
  for (const l of r.removeLabels) await gh.removeLabel(n, l);
  await gh.addLabels(n, r.addLabels);
  const posted = await gh.comment(n, r.body);
  // 計画の投稿で宣言は終わったとみなされる。ゲートを通る見込みなら結果を待つ間の宣言を出し直し（空白を作らない）、
  // 通らない見込み（人の判断待ち）なら解除する（harness/lib/queue.ts の claimAfterPlan）
  const claim = isRoutine() ? null : claimValueAfterPlan(r.expectedGate, manualClaim());
  if (claim) await gh.comment(n, renderClaim(claim));
  console.log(JSON.stringify({ posted: posted.html_url, expectedGate: r.expectedGate, ...(claim ? { claim: claim.released ? 'released' : 'plan-gate' } : {}) }, null, 2));
}

/** 決定の記録を検査して投稿する（人のセッション用。Routine は書かない）。ラベルは変えない（App が確かめて外す） */
async function postDecision(gh: GitHub, n: number, file: string): Promise<void> {
  const checked = checkFile(file);
  if (checked.kind !== 'decision' || checked.errors.length > 0) fail(checked.kind !== 'decision' ? ['agent-decision ブロックがありません'] : checked.errors);
  const decision = checked.value as Decision;
  if (decision.issue !== n) fail([`decision.issue（${decision.issue}）が #${n} と一致しません`]);
  const gate = latestPlanGate(config, await gh.listComments(n)) as { value: PlanGateRecord & { plan?: Plan } } | null;
  if (!gate?.value.plan) fail([`#${n} に App の計画ゲートの記録（計画の写し）がありません`]);
  if (gate!.value.planCommentId !== decision.planCommentId) fail([`decision.planCommentId（${decision.planCommentId}）が最新の計画ゲートの記録の計画コメント（${gate!.value.planCommentId}）と一致しません`]);
  const { missing, unknown } = uncoveredTargets(decisionTargets(gate!.value.plan!), decision);
  if (missing.length > 0 || unknown.length > 0) fail([...missing.map((t) => `答えがありません: ${t.id}（${t.text}）`), ...unknown.map((u) => `計画に無い項目への答えです: ${u}`)]);
  const posted = await gh.comment(n, readBlockFile(file));
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

async function postVerdict(gh: GitHub, n: number, file: string): Promise<void> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const posted = await gh.comment(n, renderVerdict(n, pr.head.sha, file, (judged) => samePatchAsCurrent(pr, judged)));
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

type HistoryNode = { associatedPullRequests: { nodes: { number: number; title: string; merged: boolean; mergedAt: string | null; baseRefName: string }[] } };

const FILE_HISTORY_QUERY = `query($owner: String!, $name: String!, $branch: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $branch) {
      ... on Commit {
        history(first: 5, path: $path) { nodes { associatedPullRequests(first: 5) { nodes { number title merged mergedAt baseRefName } } } }
      }
    }
  }
}`;

/** 変更ファイル（先頭 30 件）を触った Merge 済みの過去の PR と、そのコメント・レビュー・レビューコメント。API のエラーはそのまま投げる */
async function pastPrsFor(gh: GitHub, n: number): Promise<PastPrs> {
  const changed = (await gh.paginate<{ filename: string }>(`/pulls/${n}/files`)).map((f) => f.filename);
  const considered = changed.slice(0, PAST_PR_FILE_LIMIT);
  const histories: Parameters<typeof selectPastPrs>[0] = [];
  // ファイル名をクエリに埋め込まず変数で渡すため、ファイルごとに順に呼ぶ
  for (const path of considered) {
    const data = await gh.graphql<{ repository: { object: { history?: { nodes: HistoryNode[] } } | null } }>(
      FILE_HISTORY_QUERY, { owner: gh.owner, name: gh.repo, branch: config.defaultBranch, path },
    );
    // 既定のブランチに無い新しいファイルは履歴が空
    const nodes = data.repository.object?.history?.nodes ?? [];
    histories.push({ path, prs: nodes.flatMap((c) => c.associatedPullRequests.nodes) });
  }
  const prs: PastPrs['prs'] = [];
  for (const p of selectPastPrs(histories, n, config.defaultBranch)) {
    prs.push({
      number: p.number, title: p.title, mergedAt: p.mergedAt, files: p.files,
      comments: await gh.listComments(p.number),
      reviews: await gh.paginate<PastPrReview>(`/pulls/${p.number}/reviews`),
      reviewComments: await gh.paginate<PastPrReviewComment>(`/pulls/${p.number}/comments`),
    });
  }
  return { changedFiles: changed.length, filesConsidered: considered.length, prs };
}

/** Stacked PR の層なら、base・位置と、下の層（PR 番号・base・変更ファイル）。層でなければ null */
async function stackFactsFor(gh: GitHub, pr: PullRequest): Promise<StackFacts | null> {
  const stack = stackOf(pr);
  if (classifyBase(pr, config.defaultBranch) !== 'stacked' || stack === null || stack === 'malformed') return null;
  const open = await gh.paginate<PullRequest>('/pulls?state=open');
  const lower: StackFacts['lower'] = [];
  for (const l of lowerLayers(open, pr, config.defaultBranch, `${gh.owner}/${gh.repo}`, stack.size)) {
    lower.push({ ...l, files: await changedFiles(gh, l.number) });
  }
  return { base: pr.base.ref, number: stack.number, position: stack.position, size: stack.size, lower };
}

async function judgeInput(gh: GitHub, n: number): Promise<string> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const issues: JudgeFacts['issues'] = [];
  for (const i of await linkedIssues(gh, config, pr)) {
    const issue = await gh.get<IssueItem>(`/issues/${i}`);
    const epic = await parentEpic(gh, issue.body);
    issues.push({ number: i, title: issue.title, body: issue.body, comments: await gh.listComments(i), ...(epic ? { epic } : {}) });
  }
  const text = renderJudgeInput(config, {
    pr: { number: n, headSha: pr.head.sha, body: pr.body, baseRef: pr.base.ref },
    issues,
    prComments: await gh.listComments(n),
    checkRuns: await gh.paginate<CheckRun>(`/commits/${pr.head.sha}/check-runs`),
    commits: await gh.paginate<PrCommit>(`/pulls/${n}/commits`),
    prState: { state: pr.state, draft: pr.draft, merged: pr.merged },
    pastPrs: await pastPrsFor(gh, n),
    stack: await stackFactsFor(gh, pr),
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
  await ensureOwnClaim(gh, n);
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

type FleetIssueItem = { number: number; title: string; state: string; labels: { name: string }[]; pull_request?: unknown; user?: { login: string } | null; author_association?: string };

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
  const usage = 'fleet-status [--max <n>] [<Issue 番号>...]';
  const a = splitArgs(args, ['--max']);
  if (!a.ok) fail([...a.errors, usage]);
  const maxArg = a.value.options['--max'];
  if ((maxArg !== undefined && !/^[1-9]\d*$/.test(maxArg)) || a.value.positional.some((p) => !/^\d+$/.test(p))) fail([usage]);
  const max = maxArg === undefined ? null : Number(maxArg);
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
    issues.push({ facts: iFacts[idx]!, closed: item.state === 'closed', planFiles: gate?.value.plan?.files ?? null, prs });
  }

  const facts = { issues, prConflicts: prConflicts(issues) };
  const rows = fleetStatus(facts);
  return renderFleetStatus(rows, selectFleet(config, facts, rows, max, currentSession()), max);
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
  // head が違うときだけ、PR 自身の差分（patch-id）を比べる（main の取り込みだけなら判定した head のまま組み立てる）
  const samePatch = judged.value === pr.head.sha ? undefined : samePatchAsCurrent(pr, judged.value);
  const r = composeVerdict({
    pr: n,
    judgedHead: judged.value,
    currentHead: pr.head.sha,
    ...(samePatch === undefined ? {} : { samePatch }),
    reviewer: readJson(reviewerFile),
    risk: readJson(riskFile),
    meta: { model, judgedBy: sessionUrl() ?? '付き添いのセッション' },
  }, currentSession());
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
  const { files, bySession } = findSessionTranscriptsWithNote(process.cwd(), explicit, transcriptSessionId(process.env));
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
    bySession,
    perModel: Object.fromEntries(Object.entries(summary).map(([m, tokens]) => [m, { tokens, estimatedUsd: cost.perModel[m] ?? null }])),
    total: totalTokens(summary),
    estimatedUsd: cost.totalUsd,
    note: [
      'API で動かした場合の推定料金（USD）。サブスク利用ではトークン単位の請求はない',
      ...(bySession ? [] : ['今のセッションの記録が見つからないため、最も新しい記録を集計した（ほかのセッションのものかもしれない）']),
    ].join('。'),
  };
}

function renderMetrics(stage: string, model: string, minutes: string, tokensArg?: string): string {
  const u = usageReport();
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const tokens = u ? [u.total.input, u.total.output, u.total.cacheWrite5m + u.total.cacheWrite1h, u.total.cacheRead].map(fmt).join(' / ') : (tokensArg ?? 'unknown');
  const usd = !u ? 'unknown' : u.estimatedUsd === null ? '不明' : `$${u.estimatedUsd.toFixed(2)}`;
  return [
    claudeMark(currentSession()),
    '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン（入力/出力/キャッシュ書込/キャッシュ読込） | 推定料金（USD） | セッション |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${new Date().toISOString().slice(0, 16)} | ${stage} | ${model} | ${minutes} | ${tokens} | ${usd} | ${sessionUrl() ?? '手動'} |`,
    '',
    u && !u.bySession
      ? 'トークン数と推定料金は、今のセッションの記録が見つからないため、最も新しい記録（ほかのセッションのものかもしれない）の累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。'
      : 'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。',
  ].join('\n');
}

const SHA_ARG = /^[0-9a-f]{40}$/;

/** arch-review-range：前回の記録か --since からの範囲（読むだけ） */
async function archReviewRangeText(gh: GitHub, args: string[]): Promise<string> {
  const usage = 'arch-review-range [--since <sha>] [--until <sha>] [--last <n>]';
  const a = splitArgs(args, ['--since', '--until', '--last']);
  if (!a.ok) fail([...a.errors, usage]);
  const { '--since': since, '--until': until, '--last': last } = a.value.options;
  const errors = [
    ...(a.value.positional.length > 0 ? [`余分な引数：${a.value.positional.join(' ')}`] : []),
    ...(since !== undefined && !SHA_ARG.test(since) ? ['--since は40桁の SHA'] : []),
    ...(until !== undefined && !SHA_ARG.test(until) ? ['--until は40桁の SHA'] : []),
    ...(last !== undefined && !/^[1-9]d*$/.test(last) ? ['--last は1以上の整数'] : []),
  ];
  if (errors.length > 0) fail([...errors, usage]);
  const range = await archReviewRange(gh, config, { since, until, last: last === undefined ? undefined : Number(last) });
  return JSON.stringify(range, null, 2);
}

/** arch-review-record：記録を検査して本文を作る（--dry-run でなければダッシュボード Issue にコメントする） */
async function archReviewRecord(args: string[]): Promise<void> {
  const file = args.find((x) => !x.startsWith('--'));
  if (!file) fail(['arch-review-record <file> [--dry-run]']);
  const r = checkArchReviewRecord(JSON.parse(readFileSync(file, 'utf8')));
  if (!r.ok) fail(r.errors);
  const body = renderArchReviewRecord(r.record, currentSession());
  if (args.includes('--dry-run')) return void console.log(body);
  const gh = new GitHub(transportFromEnv(), repository());
  const dashboard = await findDashboard(gh, config);
  if (!dashboard) fail([`ダッシュボード Issue（${config.dashboardIssueTitle}）がありません。App の publish-queue が作るまで記録できません`]);
  const posted = await gh.comment(dashboard.number, body);
  console.log(posted.html_url);
}

function fail(errors: string[]): never {
  console.error(['書式エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'session-url') return void console.log(sessionUrl() ?? '(none)');
  if (cmd === 'worktree') {
    const target = worktreeClaimIssue(args[0] ?? '', args.includes('--detach'), isRoutine());
    if (target !== null) {
      const gh = new GitHub(transportFromEnv(), repository());
      // fix・sync は PR 番号に宣言するので、そのブランチの開いた PR があれば PR の宣言を見る
      const open = await gh.get<PullRequest[]>(`/pulls?state=open&head=${encodeURIComponent(`${gh.owner}:${args[0]}`)}`);
      await ensureOwnClaim(gh, open[0]?.number ?? target);
    }
  }
  if (cmd === 'worktree' || cmd === 'worktree-remove') {
    try {
      const opts = { root: mainRepoRoot(), defaultBranch: config.defaultBranch };
      if (cmd === 'worktree') {
        const path = addWorktree(args[0]!, args.includes('--detach'), opts);
        ensureNodeModules(path);
        return void console.log(path);
      }
      return removeWorktree(args[0]!, opts);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
  if (cmd === 'render-claim') return void console.log(claimBody(args.includes('--manual'), args.includes('--release'), parseStage(args)));
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
  if (cmd === 'arch-review-drafts') {
    if (!args[0]) fail(['arch-review-drafts <file>']);
    const r = checkIssueDrafts(JSON.parse(readFileSync(args[0], 'utf8')));
    if (!r.ok) fail(r.errors);
    return void console.log(r.markdown);
  }
  if (cmd === 'arch-review-record') return archReviewRecord(args);
  const gh = new GitHub(transportFromEnv(), repository());
  const n = Number(args[0]);
  switch (cmd) {
    case 'queue': return void console.log(JSON.stringify(await computeQueue(gh, config, currentSession()), null, 2));
    case 'claim': return claim(gh, n, args.includes('--manual'), args.includes('--force'), args.includes('--takeover'), parseStage(args));
    case 'release': return void (await gh.comment(n, claimBody(true, true)));
    case 'show-plan': return showPlan(gh, n);
    case 'post-plan': return postPlan(gh, n, args[1]!);
    case 'post-decision': return postDecision(gh, n, args[1]!);
    case 'post-verdict': return postVerdict(gh, n, args[1]!);
    case 'judge-input': return void console.log(await judgeInput(gh, n));
    case 'critic-input': return void console.log(await criticInput(gh, args));
    case 'compose-verdict': return void console.log(await composeVerdictFile(gh, args));
    case 'label-audit': return void console.log(await labelAudit(gh, args));
    case 'fleet-status': return void console.log(await fleetStatusText(gh, args));
    case 'arch-review-range': return void console.log(await archReviewRangeText(gh, args));
    case 'footer': {
      const [, stage, model, minutes, tokens] = args;
      const pr = await gh.get<PullRequest>(`/pulls/${n}`);
      await gh.request('PATCH', `/pulls/${n}`, { body: { body: appendFooter(pr.body ?? '', { stage: stage!, model: model!, minutes: minutes!, tokens: tokens!, session: sessionUrl() ?? '手動' }) } });
      return;
    }
    case 'wait': {
      await gh.addLabels(n, [LABELS.waiting]);
      await gh.comment(n, `${claudeMark(currentSession())}\n未解決の blocker（${args.slice(1).map((b) => `#${b}`).join(', ')}）があるため \`agent:waiting\` にしました。blocker が閉じると App が外します。`);
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
