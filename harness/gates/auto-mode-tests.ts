/**
 * auto mode の経路に乗る PR で、agent/tests が見つけたテストを弱める変更が妥当かを Jev に問い、App の記録（kind=auto-mode-tests）に残す（Issue #349）。
 * かけるのは auto mode で自動経路に乗る PR（auto-mode.ts の autoModeRoute が ok で、委任（delegatedRoute）では乗らない）だけ。
 * 1つの差分（patch-id）に1回だけ問う。同じ patch-id・同じ問いの版の記録があれば問い直さず、記録の確率と今の下限で通すかを決め直す（push で差分が変わると問い直す）。
 * Jev の error は記録しない（次のイベントで問い直す）。on-pr.ts と apply.ts の両方から使うので、apply.ts を import しない。
 * 判断を harness/gates/ に置くのは、委任承認の除外（delegateMergeExclude の harness/gates/**）に入れ、委任で緩められないようにするため。
 */
import type { AutoModeState } from '../lib/auto-mode.ts';
import {
  AUTO_MODE_TESTS_KIND,
  AUTO_MODE_TESTS_QUESTION_SET,
  autoModeTestsFindings,
  autoModeTestsRequest,
  renderAutoModeTests,
  resummarize,
  summarizeAutoModeTests,
  type AutoModeTestsOutcome,
  type AutoModeTestsRecord,
} from '../lib/auto-mode-tests.ts';
import type { DelegateState } from '../lib/delegate.ts';
import type { IssueComment } from '../lib/github.ts';
import { askJev } from '../lib/jev.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { LABELS } from '../lib/config.ts';
import { appRecords, delegatePlanBody, hasLabel, isAgentPr, isSameRepoPr, linkedIssues, type PullRequest } from '../lib/state.ts';
import type { TamperFinding } from '../lib/test-tamper.ts';
import { autoModeFor, autoModeRoute } from './auto-mode.ts';
import { appComment, type GateContext } from './context.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';

type Lazy<T> = T | (() => Promise<T>);
const resolve = <T>(v: Lazy<T>): Promise<T> => (typeof v === 'function' ? (v as () => Promise<T>)() : Promise.resolve(v));

/**
 * auto mode の経路に乗るか（乗らなければこの仕組みをかけない）。tests-check.ts の testsHumanMerge と同じく、
 * 状態を渡されなければ、委任・auto mode で乗りうる受け付けのときだけ今の状態を読む。agent:hold の付いた PR にはかけない。
 */
export async function onAutoModeRoute(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, state: { delegation?: DelegateState; autoMode?: AutoModeState } = {}): Promise<boolean> {
  if (!isAgentPr(ctx.config, pr, ctx.repository)) return false;
  // agent:hold の間は自動経路に乗らない（人が Merge する）ので問わない。外すと受け付けを当て直すので、そのときに問う
  if (hasLabel(pr, LABELS.hold)) return false;
  if (!acceptance?.reviewPass || acceptance.autoEligible || !acceptance.autoMode?.eligible) return false;
  if (acceptance.delegate?.eligible && delegatedRoute(state.delegation ?? (await delegationFor(ctx, new Date())), acceptance).ok) return false;
  return autoModeRoute(state.autoMode ?? (await autoModeFor(ctx)), acceptance).ok;
}

/** Issue の本文と使える計画の本文（Jev の材料）。PR が Issue を1つだけ Closes し、使える計画があるときだけ */
async function materials(ctx: GateContext, pr: PullRequest): Promise<{ issue: { number: number; title: string; body: string }; plan: string } | { missing: string }> {
  const issues = await linkedIssues(ctx.gh, ctx.config, pr);
  if (issues.length !== 1) return { missing: issues.length === 0 ? 'PR が Closes する Issue がありません' : `PR が Closes する Issue が1つではありません（${issues.map((n) => `#${n}`).join('・')}）` };
  const n = issues[0]!;
  const issue = await ctx.gh.get<{ number: number; title: string; body: string | null }>(`/issues/${n}`);
  const plan = delegatePlanBody(ctx.config, await ctx.gh.listComments(n));
  if (plan === null) return { missing: `#${n} に使える計画がありません（ゲートを通った・ゲートの停止で止まった・人が進めると決めた計画で、その後に編集されていないものだけを使う）` };
  return { issue: { number: n, title: issue.title, body: issue.body ?? '' }, plan };
}

/**
 * agent/tests の検出を、auto mode の経路の PR なら Jev に問う。乗らないときは { applies: false }。
 * diff・patch・comments は、読みを使い回す関数でもよい（問わないときは呼ばない）。state は委任・auto mode の状態（渡せば読み直さない）。
 */
export async function autoModeTestsFor(
  ctx: GateContext,
  pr: PullRequest,
  findings: TamperFinding[],
  acceptance: Acceptance | null,
  diff: Lazy<string>,
  patch: Lazy<string>,
  comments: Lazy<IssueComment[]>,
  state: { delegation?: DelegateState; autoMode?: AutoModeState } = {},
): Promise<AutoModeTestsOutcome> {
  if (findings.length === 0) return { applies: false };
  if (!(await onAutoModeRoute(ctx, pr, acceptance, state))) return { applies: false };
  const no = (reason: string): AutoModeTestsOutcome => ({ applies: true, asked: false, reason });
  if (!isSameRepoPr(pr, ctx.repository)) return no('fork の PR は Jev に問いません');
  const apiKey = ctx.secrets.jevApiKey;
  if (!apiKey) return no('`JEV_API_KEY` が未設定です');

  const patchId = await resolve(patch);
  const recorded = appRecords<AutoModeTestsRecord>(ctx.config, await resolve(comments), AUTO_MODE_TESTS_KIND)
    .filter((r) => r.value.patchId === patchId && r.value.questionSet === AUTO_MODE_TESTS_QUESTION_SET)
    .at(-1)?.value;
  if (recorded) return { applies: true, asked: true, reused: true, model: recorded.model, ...resummarize(ctx.config, recorded.findings ?? []) };

  let input: Awaited<ReturnType<typeof materials>>;
  try {
    input = await materials(ctx, pr);
  } catch (e) {
    ctx.log(`#${pr.number} の auto mode のテストの判定の材料を読めませんでした: ${(e as Error).message}`);
    return no('Issue・計画を読めませんでした。判定をやり直すか push すると問い直します');
  }
  if ('missing' in input) return no(input.missing);
  const material = autoModeTestsFindings(await resolve(diff), findings);
  const built = autoModeTestsRequest(ctx.config, { ...input, findings: material });
  if (!built.ask) return no(built.reason);

  const r = await (ctx.askJev ?? askJev)(apiKey, built.request);
  if (r.status !== 'ok') {
    ctx.log(`#${pr.number} のテストを弱める変更を Jev に問えませんでした: ${r.detail}`);
    return no(`Jev に問えませんでした（error: ${r.detail}）。判定をやり直すか push すると問い直します`);
  }
  const summary = summarizeAutoModeTests(ctx.config, r.answers, material);
  const outcome: AutoModeTestsOutcome = { applies: true, asked: true, reused: false, model: r.model, ...summary };
  const record: AutoModeTestsRecord = { version: 1, patchId, headSha: pr.head.sha, model: r.model, questionSet: AUTO_MODE_TESTS_QUESTION_SET, ...summary };
  await appComment(
    ctx,
    pr.number,
    AUTO_MODE_TESTS_KIND,
    [`auto mode の経路の PR で、テストを弱める変更（${material.length} 件）が妥当かを Jev に問いました（記録）。この記録は今の差分にだけ効きます。`, '', renderAutoModeTests(outcome)].join('\n'),
    record,
  );
  return outcome;
}
