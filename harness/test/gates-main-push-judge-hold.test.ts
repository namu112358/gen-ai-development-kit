// Issue #216：main への push で、判定中（着手宣言の段階が judge）の Agent PR は追従させず、判定の後に追従させる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onMainPush } from '../gates/on-main-push.ts';
import { acceptanceFake, claimComment, ctxFor, hoursAgo, pr, verdictComment, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment, countCalls } from './support/stack-fixtures.ts';

const OTHER_SHA = 'e'.repeat(40);
const pr6 = (patch: Record<string, unknown> = {}) => pr({ number: 6, node_id: 'PR_6', head: { ref: 'claude/issue-9', sha: OTHER_SHA, repo: { full_name: 'o/r' } }, ...patch });

/** PR #5 だけが開いていて遅れている push。logs に ctx.log の出力を集める */
async function pushWith(state: { prComments: unknown[]; patch?: Record<string, unknown>; behindBy?: number }) {
  const fake = acceptanceFake({ pr: pr({ draft: false, ...state.patch }), dashboardLabels: [], behindBy: state.behindBy ?? 2, prComments: state.prComments });
  fake.on('GET', /\/pulls\?state=open/, () => [pr(state.patch)]);
  const logs: string[] = [];
  await onMainPush(ctxFor(fake, 'push', { commits: [{ id: 'x', message: 'docs: 何か' }] }, { log: (m: string) => logs.push(m) }));
  return { fake, logs };
}
const updated = (fake: FakeGitHub, n = 5) => fake.calls.some((c) => c.method === 'PUT' && c.path.endsWith(`/pulls/${n}/update-branch`));

test('main への push：段階 judge の有効な宣言がある遅れた Agent PR は update-branch しない（ログに飛ばした理由を残す）', async () => {
  const { fake, logs } = await pushWith({ prComments: [claimComment({ stage: 'judge' })] });
  assert.equal(updated(fake), false);
  assert.ok(logs.some((l) => l.includes('#5') && l.includes('追従を飛ばしました')), logs.join('\n'));
});

test('main への push：段階 judge の Routine の宣言（期限内）でも update-branch しない', async () => {
  const { fake } = await pushWith({ prComments: [claimComment({ stage: 'judge', by: 'routine' })] });
  assert.equal(updated(fake), false);
});

test('main への push：judge の宣言の後に判定コメントがあれば（判定の後）update-branch する', async () => {
  const { fake } = await pushWith({ prComments: [claimComment({ stage: 'judge' }), verdictComment()] });
  assert.equal(updated(fake), true);
});

test('main への push：解除された宣言・段階 fix・期限切れ・信頼できない作成者の宣言なら update-branch する', async () => {
  const cases: [string, unknown[]][] = [
    ['解除', [claimComment({ stage: 'judge' }), claimComment({ stage: 'judge', released: true })]],
    ['段階 fix', [claimComment({ stage: 'fix' })]],
    ['手動の期限切れ（7 時間前）', [claimComment({ stage: 'judge', at: hoursAgo(7) })]],
    ['Routine の期限切れ（2 時間前）', [claimComment({ stage: 'judge', by: 'routine', at: hoursAgo(2) })]],
    ['信頼できない作成者', [claimComment({ stage: 'judge', association: 'NONE' })]],
    ['宣言なし', []],
  ];
  for (const [name, prComments] of cases) {
    const { fake } = await pushWith({ prComments });
    assert.equal(updated(fake), true, name);
  }
});

test('main への push：auto-merge が付いた PR は、段階 judge の宣言があっても update-branch する', async () => {
  const { fake } = await pushWith({ prComments: [claimComment({ stage: 'judge' })], patch: { auto_merge: { enabled: true } } });
  assert.equal(updated(fake), true);
});

test('main への push：遅れていなければ PR のコメントを読まない', async () => {
  const { fake } = await pushWith({ prComments: [claimComment({ stage: 'judge' })], behindBy: 0 });
  assert.equal(updated(fake), false);
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/5/comments'), 0);
});

/** PR #5（判定中の宣言つき）と PR #6（宣言なし）が開いている push。compareFails の sha の compare は失敗させる */
function twoPrFake(opts: { compareFails?: string } = {}): FakeGitHub {
  const fake = acceptanceFake({ pr: pr({ draft: false }), dashboardLabels: [], behindBy: 1, prComments: [claimComment({ stage: 'judge' })] });
  return fake
    .on('GET', /\/pulls\?state=open/, () => [pr(), pr6()])
    .on('GET', /\/pulls\/6$/, () => pr6())
    .on('GET', /\/issues\/6\/comments/, () => [])
    .on('GET', /\/compare\/([^?]+)/, (m) => {
      if (opts.compareFails && m[1]!.includes(opts.compareFails)) throw new Error('compare boom');
      return { behind_by: 1 };
    })
    .on('PUT', /\/pulls\/\d+\/update-branch/, () => ({}));
}

test('main への push：同じ push で、判定中の PR は飛ばし、ほかの Agent PR は追従させる', async () => {
  const fake = twoPrFake();
  await onMainPush(ctxFor(fake, 'push', { commits: [] }));
  assert.equal(updated(fake, 5), false, '判定中の #5 は飛ばす');
  assert.equal(updated(fake, 6), true, '#6 は追従する');
});

test('main への push：1本目の PR の compare が失敗しても、2本目の PR の追従と Stacked PR の Issue の Close は行う', async () => {
  const MERGED = pr({ number: 7, state: 'closed', merged_at: '2026-09-27T10:00:00Z', body: 'Refs #3' });
  const fake = twoPrFake({ compareFails: 'a'.repeat(40) })
    .on('GET', /\/commits\/x\/pulls/, () => [MERGED])
    .on('GET', /\/issues\/7\/comments/, () => [appRecordComment(95, 'stack-link', 'Issue に紐付けました。', { version: 1, issues: [3], stack: 1 })])
    .on('GET', /\/issues\/3$/, () => ({ number: 3, state: 'open' }))
    .on('PATCH', /\/issues\/3$/, () => ({}));
  const logs: string[] = [];
  await onMainPush(ctxFor(fake, 'push', { commits: [{ id: 'x', message: 'feat: 層 (#7)' }] }, { log: (m: string) => logs.push(m) }));
  assert.equal(updated(fake, 5), false);
  assert.equal(updated(fake, 6), true, '2本目の追従は止めない');
  assert.ok(fake.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/3')), 'Stacked PR の Issue の Close は止めない');
  assert.ok(logs.some((l) => l.includes('compare boom')), `失敗はログに残す: ${logs.join('\n')}`);
});
