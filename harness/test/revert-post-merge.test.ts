// Merge 後の main の CI の失敗で revert するかの判断（harness/lib/post-merge-revert.ts。Issue #802）：必須チェックの見分け、revert・停止だけ・何もしないの分かれ目、revert の commit のメッセージ
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_ACTIONS_APP_ID, loadConfig } from '../lib/config.ts';
import { decidePostMergeRevert, requiredChecksState, revertBranchName, revertCommitMessage, type MergedPrFacts } from '../lib/post-merge-revert.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

const required = [{ context: 'ci', integrationId: GITHUB_ACTIONS_APP_ID }];
const run = (status: string, conclusion: string | null, appId = GITHUB_ACTIONS_APP_ID, name = 'ci') => ({ name, status, conclusion, app: { id: appId } });

test('必須チェックの結果を、失敗・待つ・成功に見分ける', () => {
  const cases: { name: string; runs: ReturnType<typeof run>[]; statuses: { context: string; state: string }[]; want: 'success' | 'failure' | 'pending'; failed?: string[] }[] = [
    { name: 'check-run が成功', runs: [run('completed', 'success')], statuses: [], want: 'success' },
    { name: 'neutral・skipped は成功とみなす', runs: [run('completed', 'neutral')], statuses: [], want: 'success' },
    { name: 'check-run が失敗', runs: [run('completed', 'failure')], statuses: [], want: 'failure', failed: ['ci'] },
    { name: 'timed_out は失敗', runs: [run('completed', 'timed_out')], statuses: [], want: 'failure', failed: ['ci'] },
    { name: 'startup_failure は失敗', runs: [run('completed', 'startup_failure')], statuses: [], want: 'failure', failed: ['ci'] },
    { name: 'status の error は失敗', runs: [], statuses: [{ context: 'ci', state: 'error' }], want: 'failure', failed: ['ci'] },
    { name: 'status の failure は失敗', runs: [], statuses: [{ context: 'ci', state: 'failure' }], want: 'failure', failed: ['ci'] },
    { name: 'status の success は成功', runs: [], statuses: [{ context: 'ci', state: 'success' }], want: 'success' },
    { name: 'check-run と status の片方が失敗なら失敗', runs: [run('completed', 'success')], statuses: [{ context: 'ci', state: 'failure' }], want: 'failure', failed: ['ci'] },
    { name: 'まだ終わっていない', runs: [run('in_progress', null)], statuses: [], want: 'pending' },
    { name: 'チェックが無い', runs: [], statuses: [], want: 'pending' },
    { name: 'ほかの App の同じ名前の check-run は数えない', runs: [run('completed', 'failure', 999)], statuses: [], want: 'pending' },
    { name: '必須でないチェックの失敗は数えない', runs: [run('completed', 'success'), run('completed', 'failure', GITHUB_ACTIONS_APP_ID, 'mutation')], statuses: [], want: 'success' },
  ];
  for (const c of cases) {
    const got = requiredChecksState(required, c.runs, c.statuses);
    assert.equal(got.state, c.want, c.name);
    if (c.failed) assert.deepEqual(got.failed, c.failed, c.name);
  }
});

const autoMerged: MergedPrFacts = { number: 7, title: 'feat: x', mergedByApp: true, agentPr: true, stacked: false };

test('revert するのは、App が自動 Merge した Agent PR（Stacked PR でない）が先頭を落とし、親は成功していたときだけ。ほかの失敗は停止だけ', () => {
  type Input = Parameters<typeof decidePostMergeRevert>[0];
  const base: Input = { head: 'failure', parent: 'success', pr: autoMerged, handled: false, mergeMethod: 'SQUASH' };
  const cases: { name: string; input: Input; want: 'none' | 'stop-only' | 'revert' }[] = [
    { name: '自動 Merge・SQUASH', input: base, want: 'revert' },
    { name: '自動 Merge・MERGE', input: { ...base, mergeMethod: 'MERGE' }, want: 'revert' },
    { name: '人が Merge した PR', input: { ...base, pr: { ...autoMerged, mergedByApp: false } }, want: 'stop-only' },
    { name: 'Agent PR でない', input: { ...base, pr: { ...autoMerged, agentPr: false } }, want: 'stop-only' },
    { name: 'Stacked PR', input: { ...base, pr: { ...autoMerged, stacked: true } }, want: 'stop-only' },
    { name: 'PR が引けない', input: { ...base, pr: null }, want: 'stop-only' },
    { name: '親も失敗', input: { ...base, parent: 'failure' }, want: 'stop-only' },
    { name: '親が終わっていない', input: { ...base, parent: 'pending' }, want: 'stop-only' },
    { name: '親の結果が無い', input: { ...base, parent: null }, want: 'stop-only' },
    { name: 'REBASE は PR 全体を戻せない', input: { ...base, mergeMethod: 'REBASE' }, want: 'stop-only' },
    { name: '同じ sha を扱い済み', input: { ...base, handled: true }, want: 'none' },
    { name: '先頭が成功', input: { ...base, head: 'success' }, want: 'none' },
    { name: '先頭が終わっていない', input: { ...base, head: 'pending' }, want: 'none' },
  ];
  for (const c of cases) {
    const got = decidePostMergeRevert(c.input);
    assert.equal(got.action, c.want, c.name);
    if (got.action === 'revert') assert.equal(got.pr, 7, c.name);
  }
});

test('revert の commit のメッセージは、main の push の revert の検知（revertedPrNumbers・revertedShas）が読める', () => {
  const sha = 'd'.repeat(40);
  const message = revertCommitMessage('o/r', { number: 7, title: 'feat: x' }, sha);
  assert.deepEqual(revertedPrNumbers(message), [7]);
  assert.deepEqual(revertedShas(message), [sha]);
});

test('revert のブランチは Agent PR のブランチ（agentBranchPrefix）で始まらない（自動 Merge の経路に乗らない）', () => {
  assert.ok(!revertBranchName(7).startsWith(loadConfig().agentBranchPrefix), revertBranchName(7));
});
