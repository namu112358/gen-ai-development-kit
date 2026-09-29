import { TEST_EXEMPT_LABEL } from '../lib/config.ts';
import type { DelegateState } from '../lib/delegate.ts';
import { guardrailFiles, humanMergeFiles } from '../lib/guardrail.ts';
import { testsHumanMergeReasons, type Acceptance } from '../lib/merge-route.ts';
import { renderTamperForHumanMerge, renderTamperSummary, type TamperFinding } from '../lib/test-tamper.ts';
import { renderTamperJev, type TamperJevOutcome } from '../lib/test-tamper-jev.ts';
import { changedFiles, isAgentPr, type PullRequest } from '../lib/state.ts';
import { bypassFor, bypassRoute, type BypassState } from './bypass.ts';
import type { GateContext } from './context.ts';
import { delegatedRoute, delegationFor } from './delegation.ts';

/**
 * 必須チェック agent/tests の書き方（on-pr.ts と apply.ts の両方から使う）。
 * 人が Merge する PR（Human Merge）では検出があっても止めずに neutral にし、人の Merge の判断にまとめる。
 * 自動 Merge の対象の PR と、委任承認（計画＋Merge）・bypass モードで自動経路に乗る PR は failure で止める。
 * ただし jev.testTamper が enforce で、Jev がアサーションの書き換えを弱めていないと判定すれば success にする（Q95）。
 */

export interface TestsOutcome {
  conclusion: 'success' | 'failure' | 'neutral';
  title: string;
  summary: string;
}

/**
 * Human Merge とみなす理由（空なら止める）。Agent PR でない PR（人の PR・fork）は判定や Human Merge の依頼の流れに乗らないので対象外。
 * acceptance は現在の差分に対する最新の受け付けの記録。委任承認（計画＋Merge）で自動経路に乗る（delegation.ts の delegatedRoute）なら空。
 * delegation を渡さなければ、委任で乗りうる受け付け（合格・自動 Merge の対象外・delegate.eligible）のときだけ今の状態を読む。
 * bypass モードで自動経路に乗る（bypass.ts の bypassRoute）なら空。bypass も、渡さなければ bypass.eligible の受け付けのときだけ今の状態を読む。
 */
export async function testsHumanMerge(ctx: GateContext, pr: PullRequest, acceptance: Acceptance | null, delegation?: DelegateState, bypass?: BypassState): Promise<string[]> {
  if (!isAgentPr(ctx.config, pr, ctx.repository)) return [];
  if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.delegate?.eligible) {
    const now = new Date();
    if (delegatedRoute(delegation ?? (await delegationFor(ctx, now)), acceptance).ok) return [];
  }
  if (acceptance?.reviewPass && !acceptance.autoEligible && acceptance.bypass?.eligible) {
    if (bypassRoute(bypass ?? (await bypassFor(ctx)), acceptance).ok) return [];
  }
  const files = await changedFiles(ctx.gh, pr.number);
  return testsHumanMergeReasons({ guardrail: guardrailFiles(ctx.config, files), humanMerge: humanMergeFiles(ctx.config, files), acceptance });
}

/**
 * agent/tests の結論を決める（書き手は on-pr.ts の writeTestsCheck と apply.ts の rewriteTestsCheck・auto-merge の後の書き直し）。
 * 優先順：検出0件 → success／Human Merge の理由あり → neutral／jev.testTamper が enforce で、問えて Jev が通す → success／それ以外 → failure。
 * jev（harness/gates/tests-jev.ts の tamperJevFor の結果）があれば、どの結論でも要約の末尾に Jev の節を足す。渡さなければ今までと同じ出力。
 * test:exempt は書き手の側で先に扱う（ここには来ない）。
 */
export function testsOutcome(findings: TamperFinding[], humanMergeReasons: string[], jev?: TamperJevOutcome): TestsOutcome {
  if (findings.length === 0) return { conclusion: 'success', title: 'テストを弱める変更はありません', summary: '' };
  const section = jev ? renderTamperJev(jev, jev.mode) : '';
  const withJev = (summary: string) => (section ? `${summary}\n\n${section}` : summary);
  if (humanMergeReasons.length > 0) {
    return {
      conclusion: 'neutral',
      title: `人の確認が要るテストの変更が ${findings.length} 件（Human Merge）`,
      summary: withJev([
        `人の確認が要る変更あり。この PR は人が Merge するので止めていません（理由：${humanMergeReasons.join('／')}）。自動 Merge の経路に変わると止めます。`,
        '',
        renderTamperForHumanMerge(findings),
      ].join('\n')),
    };
  }
  if (jev?.mode === 'enforce' && jev.asked && jev.allows) {
    return {
      conclusion: 'success',
      title: `テストの行の変更を Jev が弱めていないと判定（P=${jev.probability.toFixed(2)}）`,
      summary: withJev([
        `アサーションの書き換え ${findings.length} 件を、Jev が弱めていないと判定しました（\`jev.testTamper\` が enforce で、確率の最小値が下限以上）。`,
        '',
        ...findings.map((f) => `- \`${f.file}${f.line === undefined ? '' : `:${f.line}`}\`${f.after ? ` → \`:${f.after.line}\`` : ''}`),
      ].join('\n')),
    };
  }
  return { conclusion: 'failure', title: `テストを弱める変更が ${findings.length} 件`, summary: withJev(renderTamperSummary(findings, 100, TEST_EXEMPT_LABEL)) };
}
