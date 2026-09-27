import { appLogin, CHECKS, LABELS } from '../lib/config.ts';
import { evaluateMergeRoute, type Acceptance } from '../lib/merge-route.ts';
import { patchId } from '../lib/patch-id.ts';
import { acceptanceForPatch, autoMergeMode, hasLabel, isAgentPr, isSameRepoPr, prDiff, type PullRequest, type Review } from '../lib/state.ts';
import { appComment, enableAutoMerge, getPr, markReady, writeCheck, type GateContext } from './context.ts';

/**
 * 受け付けた判定を PR に反映する。順序が安全性の要：
 * 1. Ready 化と auto-merge の設定
 * 2. merge-route（直前に PR を取り直し、auto-merge の有無を見て書く）
 * 3. agent/risk（常に success、結果はサマリー）
 * 4. agent/review（必須チェック。これが書かれるまで Merge されない）
 * 5. 書き込み中に auto-merge の状態が変わっていたら merge-route を書き直す（別のゲート実行との競合対策）
 * チェックはすべて、判定を検証した head（pr.head.sha）に書く。
 */
export async function applyAcceptance(ctx: GateContext, pr: PullRequest, acceptance: Acceptance, opts: { fresh: boolean }): Promise<void> {
  const hold = hasLabel(pr, LABELS.hold);
  const mode = await autoMergeMode(ctx.gh, ctx.config);
  const wantAuto = acceptance.reviewPass && acceptance.autoEligible && mode && !hold;
  let armed = false;
  if (acceptance.reviewPass) {
    await dismissFixRequests(ctx, pr.number);
    await markReady(ctx, pr);
    if (wantAuto) {
      armed = await enableAutoMerge(ctx, pr);
    } else if (opts.fresh) {
      const why = [...acceptance.reasons, ...(hold ? ['`agent:hold` が付いています'] : []), ...(!mode ? ['自動 Merge モードが無効です'] : [])];
      await appComment(ctx, pr.number, 'human-review', [`@${ctx.gh.owner} レビューをお願いします（Human Merge）。`, '', ...why.map((r) => `- ${r}`)].join('\n'));
    }
  }
  const before = await getPr(ctx, pr.number);
  if (before.head.sha !== pr.head.sha) {
    ctx.log(`head が ${before.head.sha.slice(0, 7)} に進んだため反映を中止します（synchronize のゲートが処理する）`);
    return;
  }
  await writeMergeRoute(ctx, before, acceptance, mode, pr.head.sha);
  await writeCheck(ctx, pr.head.sha, CHECKS.risk, {
    conclusion: 'success',
    title: `Risk: ${acceptance.riskLevel}${acceptance.riskOk ? '' : '（自動 Merge 不可）'}`,
    summary: [
      `Claude の判定: ${acceptance.riskLevel}`,
      `Jev: ${acceptance.jev?.status ?? '-'} ${acceptance.jev?.detail ?? ''}`,
      '',
      '```json',
      JSON.stringify(acceptance.jev?.answers ?? {}, null, 2),
      '```',
    ].join('\n'),
  });
  await writeCheck(ctx, pr.head.sha, CHECKS.review, acceptance.reviewPass
    ? { conclusion: 'success', title: 'Reviewer 合格', summary: `判定コメント ${acceptance.verdictCommentId} を patch-id ${acceptance.patchId} で受け付けました。` }
    : { conclusion: 'failure', title: 'ブロッキング指摘あり', summary: '変更要求レビューを参照してください。' });

  const after = await getPr(ctx, pr.number);
  if (after.head.sha === pr.head.sha && Boolean(after.auto_merge) !== Boolean(before.auto_merge)) {
    ctx.log('書き込み中に auto-merge の状態が変わったため merge-route を書き直します');
    await writeMergeRoute(ctx, after, acceptance, mode, pr.head.sha);
  }
  if (wantAuto && !armed) await mergeDirectly(ctx, after, pr.head.sha);
}

/**
 * auto-merge を付けられなかったとき（必須チェックがすでに揃っている PR など）。条件は確認済みなので、
 * 判定を検証した head を指定して App が直接 Merge する。失敗したら人に知らせる。
 */
async function mergeDirectly(ctx: GateContext, pr: PullRequest, headSha: string): Promise<void> {
  if (pr.state !== 'open' || pr.head.sha !== headSha) return;
  try {
    await ctx.gh.request('PUT', `/pulls/${pr.number}/merge`, { body: { sha: headSha, merge_method: ctx.config.mergeMethod.toLowerCase() } });
    ctx.log(`#${pr.number} を直接 Merge しました`);
  } catch (e) {
    await appComment(ctx, pr.number, 'human-review', `@${ctx.gh.owner} 自動 Merge の条件を満たしていますが、auto-merge の設定も直接の Merge もできませんでした。確認してください。\n\n\`${(e as Error).message.slice(0, 300)}\``);
  }
}

async function writeMergeRoute(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, mode: boolean, headSha: string = pr.head.sha): Promise<void> {
  const outcome = evaluateMergeRoute({
    autoMergeEnabled: pr.auto_merge !== null && pr.auto_merge !== undefined,
    isAgentPr: isAgentPr(ctx.config, pr, ctx.repository),
    hold: hasLabel(pr, LABELS.hold),
    autoMergeMode: mode,
    acceptance,
  });
  await writeCheck(ctx, headSha, CHECKS.mergeRoute, outcome);
}

/** 現在の差分に対する受け付け記録を探して merge-route を書き直す（PR は最新を取り直す） */
export async function refreshMergeRoute(ctx: GateContext, stale: PullRequest, known?: { patch: string }): Promise<Acceptance | null> {
  const pr = await getPr(ctx, stale.number);
  const judged = isSameRepoPr(pr, ctx.repository);
  let acceptance: Acceptance | null = null;
  if (judged) {
    const patch = known && pr.head.sha === stale.head.sha ? known.patch : patchId(await prDiff(ctx.gh, pr));
    acceptance = acceptanceForPatch(ctx.config, await ctx.gh.listComments(pr.number), patch);
  }
  await writeMergeRoute(ctx, pr, acceptance, await autoMergeMode(ctx.gh, ctx.config));
  return acceptance;
}

/** 合格した判定を受け付けたら、App が以前に出した変更要求レビューを解除する（回数は解除済みも数える） */
async function dismissFixRequests(ctx: GateContext, number: number): Promise<void> {
  const reviews = await ctx.gh.paginate<Review>(`/pulls/${number}/reviews`);
  for (const r of reviews) {
    if (r.state !== 'CHANGES_REQUESTED' || r.user?.login !== appLogin(ctx.config)) continue;
    await ctx.gh.request('PUT', `/pulls/${number}/reviews/${r.id}/dismissals`, {
      body: { message: '修正後の判定で Reviewer が合格としたため解除します。', event: 'DISMISS' },
    });
  }
}
