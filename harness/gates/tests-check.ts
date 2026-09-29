import { TEST_EXEMPT_LABEL } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import { guardrailFiles, humanMergeFiles } from '../lib/guardrail.ts';
import { testsHumanMergeReasons, type Acceptance } from '../lib/merge-route.ts';
import { renderTamperForHumanMerge, renderTamperSummary, type TamperFinding } from '../lib/test-tamper.ts';
import { changedFiles, isAgentPr, type PullRequest } from '../lib/state.ts';
import { bypassFor, bypassRoute, type BypassState } from './bypass.ts';
import type { GateContext } from './context.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';

/**
 * 必須チェック agent/tests の書き方（on-pr.ts と apply.ts の両方から使う）。
 * 人が Merge する PR（Human Merge）では検出があっても止めずに neutral にし、人の Merge の判断にまとめる。
 * 自動 Merge の対象の PR と、委任 Merge・bypass モードで自動経路に乗る PR は failure で止める。
 */

export interface TestsOutcome {
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
}

/**
 * Human Merge とみなす理由（空なら止める）。Agent PR でない PR（人の PR・fork）は判定や Human Merge の依頼の流れに乗らないので対象外。
 * acceptance は現在の差分に対する最新の受け付けの記録。委任 Merge で自動経路に乗る（delegation.ts の delegatedRoute）なら空。
 * delegation を渡さなければ、委任で乗りうる受け付け（合格・自動 Merge の対象外・delegate.eligible）のときだけ今の状態を読む。
 * bypass モードで自動経路に乗る（bypass.ts の bypassRoute）なら空。bypass も、渡さなければ bypass.eligible の受け付けのときだけ今の状態を読む。
 */
export async function testsHumanMerge(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, delegation?: DelegateState, bypass?: BypassState): Promise<string[]> {
  if (!isAgentPr(ctx.config, pr, ctx.repository)) return [];
  if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.delegate?.eligible) {
    const now = new Date();
    if (delegatedRoute(delegation ?? (await delegationFor(ctx, now)), acceptance, ctx.config, now).ok) return [];
  }
  if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.bypass?.eligible) {
    if (bypassRoute(bypass ?? (await bypassFor(ctx)), acceptance).ok) return [];
  }
  const files = await changedFiles(ctx.gh, pr.number);
  return testsHumanMergeReasons({ guardrail: guardrailFiles(ctx.config, files), humanMerge: humanMergeFiles(ctx.config, files), acceptance });
}

export function testsOutcome(findings: TamperFinding[], humanMergeReasons: string[]): TestsOutcome {
  if (findings.length === 0) return { conclusion: 'success', title: 'テストを弱める変更はありません', summary: '' };
  if (humanMergeReasons.length === 0) {
    return { conclusion: 'failure', title: `テストを弱める変更が ${findings.length} 件`, summary: renderTamperSummary(findings, 100, TEST_EXEMPT_LABEL) };
  }
  return {
    conclusion: 'neutral',
    title: `人の確認が要るテストの変更が ${findings.length} 件（Human Merge）`,
    summary: [
      `人の確認が要る変更あり。この PR は人が Merge するので止めていません（理由：${humanMergeReasons.join('／')}）。自動 Merge の経路に変わると止めます。`,
      '',
      renderTamperForHumanMerge(findings),
    ].join('\n'),
  };
}
