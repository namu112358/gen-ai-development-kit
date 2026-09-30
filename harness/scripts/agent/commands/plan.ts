import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Decision, decisionTargets, uncoveredTargets } from '../../../lib/decision.ts';
import { critiqueClaimedBefore } from '../../../lib/facts.ts';
import { GitHub } from '../../../lib/github.ts';
import { type Plan } from '../../../lib/plan.ts';
import { claimValueAfterPlan } from '../../../lib/queue.ts';
import { localChangedFiles, scopeCheck } from '../../../lib/scope-check.ts';
import { parsePreviousCritique, renderCriticInput, splitArgs } from '../../../lib/session-inputs.ts';
import { latestPlanGate, type PlanGateRecord } from '../../../lib/state.ts';
import { type AgentCommand, checkFile, config, ensureOwnClaim, fail, type IssueItem, manualClaim, readBlockFile, renderClaim, renderPlan, writeTemp } from '../cli.ts';

/**
 * 計画の段階（計画の投稿・決定の記録・通過した計画・範囲の確かめ・批評の入力）。
 *
 *   node harness/scripts/agent.ts show-plan <issue>         計画ゲートを通過した計画（App の記録）
 *   node harness/scripts/agent.ts scope-check <issue> [--base <ref>]
 *                                                           PR を出す前に、今のディレクトリ（worktree）の変更が計画の files に収まるかを、App の範囲照合と同じ関数で確かめる（読むだけ。#290）。
 *                                                           先に git fetch origin <既定ブランチ> をし、base（既定は origin/<既定ブランチ>）との merge-base から作業ツリーまでの変更
 *                                                           （リネームは旧・新の両方）と未追跡のファイル（untracked に分けて示す）を照らす。サブディレクトリから走らせても、git はルートで走らせてルートからのパスで照らす。
 *                                                           出力は JSON：scope（agent/scope と同じ、ゲートを通った計画）、delegate（委任・bypass の範囲照合に使える計画か。使えなければ reason と、
 *                                                           最新の計画と照らした latestPlanOutside）、problems（どちらの照合で outside（範囲の外）か no-plan（使える計画が無い）か。#300）。
 *                                                           終了コード：0＝両方の照合に計画があり範囲の外が無い、1＝どちらかで範囲の外がある、3＝範囲の外は無いがどちらかの照合に計画が無い。
 *                                                           2 は引数・git のエラー（JSON を出さない。照合できていない）
 *   node harness/scripts/agent.ts post-plan <issue> <file>  計画コメントを検査して投稿（このセッションの着手宣言が要る）。投稿の後、ゲートを通る見込みなら段階 plan-gate の宣言を出し直し、通らない見込み（人の判断待ち）なら解除する（出力の claim）。
 *                                                           見込みは批評の関所を含む（critique が無い、またはこの Issue に段階 plan-critique の宣言が無ければ止まる見込み）
 *   node harness/scripts/agent.ts post-decision <issue> <file>  決定の記録（agent-decision）を検査して投稿（App の最新の計画ゲートの記録の計画コメントと、答えの無い項目が無いことを確かめる。ラベルは変えない）。
 *                                                           proceed の記録（人が止まった計画で進めると決めた）は、最新の記録が止まった記録で、agent:plan-review が付いていて、acChangeProposed が無いことを確かめる
 *   node harness/scripts/agent.ts critic-input <issue> <plan-file> [--previous <critique.json>]  （このセッションの着手宣言が要る）
 *                                                           plan-critic に渡す入力（Issue 本文、コラボレーターのコメント、計画。
 *                                                           --previous は前回の plan-critic の出力で、必須の fixes を「前回の批評」に入れる）をファイルに書き、パスを出力
 */

async function postPlan(gh: GitHub, n: number, file: string): Promise<void> {
  renderPlan(n, file);
  const comments = await gh.listComments(n);
  await ensureOwnClaim(gh, n);
  // 投稿する計画より前（今あるコメントすべて）に段階 plan-critique の宣言があるかで、ゲートの見込みを出す
  const r = renderPlan(n, file, critiqueClaimedBefore(comments, Number.MAX_SAFE_INTEGER));
  for (const l of r.removeLabels) await gh.removeLabel(n, l);
  await gh.addLabels(n, r.addLabels);
  const posted = await gh.comment(n, r.body);
  // 計画の投稿で宣言は終わったとみなされる。ゲートを通る見込みなら結果を待つ間の宣言を出し直し（空白を作らない）、
  // 通らない見込み（人の判断待ち）なら解除する（harness/lib/queue.ts の claimAfterPlan）
  const claim = claimValueAfterPlan(r.expectedGate, manualClaim());
  await gh.comment(n, renderClaim(claim));
  console.log(JSON.stringify({ posted: posted.html_url, expectedGate: r.expectedGate, claim: claim.released ? 'released' : 'plan-gate' }, null, 2));
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
  if (decision.proceed) {
    // 進める記録：App の proceedEligibility で対象外になるものを投稿の前に避ける（印の窓・編集の有無は App が見る）
    const issue = await gh.get<{ labels: { name: string }[] }>(`/issues/${n}`);
    const errors: string[] = [];
    if (gate!.value.pass !== false) errors.push(`#${n} の最新の計画ゲートの記録は止まった記録ではありません（進める記録は要りません）`);
    if (!issue.labels.some((l) => l.name === 'agent:plan-review')) errors.push(`#${n} に agent:plan-review が付いていません`);
    if (gate!.value.plan!.acChangeProposed) errors.push('計画に要件・AC の変更提案があります（Issue 本文の変更は人の役割のため、進める記録では使えません）');
    if (errors.length > 0) fail(errors);
    const posted = await gh.comment(n, readBlockFile(file));
    console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
    return;
  }
  const { missing, unknown } = uncoveredTargets(decisionTargets(gate!.value.plan!), decision);
  if (missing.length > 0 || unknown.length > 0) fail([...missing.map((t) => `答えがありません: ${t.id}（${t.text}）`), ...unknown.map((u) => `計画に無い項目への答えです: ${u}`)]);
  const posted = await gh.comment(n, readBlockFile(file));
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

/** scope-check：ローカルの変更を計画の files と照らし、JSON を出して終了コードで終わる（読むだけ） */
async function scopeCheckCommand(gh: GitHub, n: number, args: string[]): Promise<void> {
  if (!Number.isInteger(n) || n <= 0) fail(['scope-check <issue> [--base <ref>]']);
  const i = args.indexOf('--base');
  const base = i >= 0 ? args[i + 1] : `origin/${config.defaultBranch}`;
  if (!base) fail(['--base の後に ref がありません']);
  const cwd = process.cwd();
  // base が古いと main 側の変更が混ざるので、既定の base のときは先に取り込む
  const fetched = i >= 0 ? null : spawnSync('git', ['fetch', '-q', 'origin', config.defaultBranch], { cwd, encoding: 'utf8' });
  const note = fetched && fetched.status !== 0 ? `git fetch origin ${config.defaultBranch} に失敗しました（base が古いおそれ）: ${(fetched.stderr ?? '').trim()}` : undefined;
  let files;
  try {
    files = localChangedFiles(cwd, base);
  } catch (e) {
    fail([(e as Error).message]);
  }
  // GitHub の読み取りの失敗も fail()（終了コード 2、JSON を出さない）にし、範囲の外（1）と取り違えないようにする
  let report;
  try {
    report = await scopeCheck(gh, config, n, files);
  } catch (e) {
    fail([(e as Error).message]);
  }
  console.log(JSON.stringify({ base, ...report, note }, null, 2));
  process.exitCode = report.exitCode;
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

export const commands: AgentCommand[] = [
  { name: 'show-plan', run: (args, ctx) => showPlan(ctx.gh(), Number(args[0])) },
  { name: 'scope-check', run: (args, ctx) => scopeCheckCommand(ctx.gh(), Number(args[0]), args) },
  { name: 'post-plan', run: (args, ctx) => postPlan(ctx.gh(), Number(args[0]), args[1]!) },
  { name: 'post-decision', run: (args, ctx) => postDecision(ctx.gh(), Number(args[0]), args[1]!) },
  { name: 'critic-input', run: async (args, ctx) => void console.log(await criticInput(ctx.gh(), args)) },
];
