/**
 * Merge 後の main の CI の失敗（Issue #802）の判断：既定ブランチの先頭の必須チェックの結果の見分け、revert の PR を出すか・停止だけか・何もしないかの分かれ目、
 * revert の commit のメッセージ・PR の題と本文・ダッシュボードの理由の本文。GitHub は呼ばない（呼ぶのは harness/gates/post-merge-revert.ts）。
 */

export type ChecksState = 'success' | 'failure' | 'pending';

const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
const FAILED_STATUSES = new Set(['failure', 'error']);

/**
 * 必須チェックの結果。どれかが失敗なら failure（failed にその context）、全部が終わって成功（neutral・skipped を含む）なら success、
 * それ以外（まだ終わっていない・無い・別の App の同名の check-run だけ）は pending
 */
export function requiredChecksState(
  required: { context: string; integrationId: number }[],
  checkRuns: { name: string; status: string; conclusion: string | null; app: { id: number } | null }[],
  statuses: { context: string; state: string }[],
): { state: ChecksState; failed: string[] } {
  const failed: string[] = [];
  let pending = false;
  for (const { context, integrationId } of required) {
    const runs = checkRuns.filter((r) => r.name === context && r.app?.id === integrationId);
    const sts = statuses.filter((s) => s.context === context);
    const runFailed = runs.some((r) => r.status === 'completed' && r.conclusion !== null && FAILED_CONCLUSIONS.has(r.conclusion));
    const statusFailed = sts.some((s) => FAILED_STATUSES.has(s.state));
    if (runFailed || statusFailed) {
      failed.push(context);
      continue;
    }
    const known = runs.length + sts.length;
    const unfinished = runs.some((r) => r.status !== 'completed') || sts.some((s) => s.state !== 'success');
    if (known === 0 || unfinished) pending = true;
  }
  if (failed.length > 0) return { state: 'failure', failed };
  return { state: pending ? 'pending' : 'success', failed: [] };
}

/** 先頭の commit を Merge の commit に持つ PR の事実 */
export interface MergedPrFacts {
  number: number;
  title: string;
  /** merged_by が App */
  mergedByApp: boolean;
  /** ブランチが agentBranchPrefix で始まる */
  agentPr: boolean;
  /** Stacked PR（stackOf が null でない、または App の記録 stack-link がある） */
  stacked: boolean;
}

export type RevertDecision =
  | { action: 'none'; reason: string }
  | { action: 'stop-only'; reason: string }
  | { action: 'revert'; pr: number; reason: string };

/**
 * 先頭が失敗したときの扱い。revert するのは、App が自動 Merge した Agent PR（Stacked PR でない）で、
 * Merge の方法が SQUASH・MERGE で、第1親の必須チェックが成功していたときだけ。ほかの失敗は停止だけ
 */
export function decidePostMergeRevert(input: {
  head: ChecksState;
  parent: ChecksState | null;
  pr: MergedPrFacts | null;
  handled: boolean;
  mergeMethod: 'SQUASH' | 'MERGE' | 'REBASE';
}): RevertDecision {
  if (input.head !== 'failure') return { action: 'none', reason: input.head === 'success' ? '先頭の必須チェックは成功しています' : '先頭の必須チェックはまだ終わっていません' };
  if (input.handled) return { action: 'none', reason: 'この commit は扱い済みです' };
  const { pr } = input;
  if (!pr) return { action: 'stop-only', reason: '先頭の commit を Merge の commit に持つ PR を特定できませんでした' };
  if (!pr.mergedByApp) return { action: 'stop-only', reason: `#${pr.number} は App が自動 Merge した PR ではありません（人の Merge は戻しません）` };
  if (!pr.agentPr) return { action: 'stop-only', reason: `#${pr.number} は Agent PR ではありません` };
  if (pr.stacked) return { action: 'stop-only', reason: `#${pr.number} は Stacked PR です（層の revert は人が決めます）` };
  if (input.mergeMethod === 'REBASE') return { action: 'stop-only', reason: 'Merge の方法が REBASE のため、PR 全体を1つの commit で戻せません' };
  if (input.parent === null) return { action: 'stop-only', reason: '先頭の親の commit の必須チェックを読めませんでした（原因が #' + pr.number + ' か言えません）' };
  if (input.parent !== 'success') return { action: 'stop-only', reason: '先頭の親の commit でも必須チェックが成功していません（原因が #' + pr.number + ' か言えません）' };
  return { action: 'revert', pr: pr.number, reason: `自動 Merge した #${pr.number} の後に、必須チェックが失敗しました` };
}

/** revert のブランチ。agentBranchPrefix（claude/）で始まらないので Agent PR にならない */
export function revertBranchName(pr: number): string {
  return `agent-revert/pr-${pr}`;
}

/** revert の commit のメッセージ。on-main-push.ts の revertedPrNumbers・revertedShas が読める形 */
export function revertCommitMessage(repository: string, pr: { number: number; title: string }, sha: string): string {
  return [`Revert "${pr.title}"`, '', `Reverts ${repository}#${pr.number}`, '', `This reverts commit ${sha}.`].join('\n');
}

export function renderRevertPr(input: { repository: string; pr: { number: number; title: string }; sha: string; failed: string[]; stopLabel: string }): { title: string; body: string } {
  const { pr } = input;
  return {
    title: `revert: #${pr.number} を戻す（main の CI の失敗）`,
    body: [
      `自動 Merge した #${pr.number}（${pr.title}）の後、main の先頭 ${input.sha.slice(0, 7)} で必須チェック（${input.failed.join(', ') || '不明'}）が失敗したため、App が戻す PR を Draft で出しました。`,
      '',
      `- 元の PR: #${pr.number}`,
      `- 停止スイッチ（ダッシュボードの \`${input.stopLabel}\` ラベル）を入れました。自動 Merge は止まっています。`,
      '- この PR は Agent PR ではなく、自動 Merge の経路に乗りません。原因を確かめて、人が Ready にして Merge するか、閉じてください。',
      '',
      `Reverts ${input.repository}#${pr.number}`,
    ].join('\n'),
  };
}

/** ダッシュボードの停止の理由（kind=auto-merge-stopped のコメント本文） */
export function renderStopReason(input: { sha: string; failed: string[]; pr: number | null; decision: RevertDecision; revertPr: number | null; revertNote: string | null; stopLabel: string }): string {
  const lines = [
    `main の先頭 ${input.sha.slice(0, 7)} で必須チェック（${input.failed.join(', ') || '不明'}）が失敗したため、自動 Merge モードを切りました。`,
    '',
    `- 特定した PR: ${input.pr === null ? 'なし' : `#${input.pr}`}（${input.decision.reason}）`,
    input.revertPr !== null ? `- revert の PR: #${input.revertPr}（Draft。人が確かめて Merge します）` : `- revert の PR: 出していません${input.revertNote ? `（${input.revertNote}）` : ''}`,
    '',
    `原因を確認したら、このダッシュボードの \`${input.stopLabel}\` ラベルを外して再開してください（harness/docs/operations.md）。`,
  ];
  return lines.join('\n');
}

/** ダッシュボードの記録 auto-merge-stopped（main の CI の失敗の経路）。同じ sha は1回しか扱わない */
export interface PostMergeStopRecord {
  version: 1;
  cause: 'main-ci-failed';
  sha: string;
  pr: number | null;
  revertPr: number | null;
  reason: string;
}
