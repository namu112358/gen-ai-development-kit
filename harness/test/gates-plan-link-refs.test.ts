import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBlock } from '../lib/blocks.ts';
import { onComment } from '../gates/on-comment.ts';
import { onPullRequest } from '../gates/on-pr.ts';
import { writePlanLink } from '../gates/plan-link.ts';
import { ctxFor, pr, type FakeGitHub } from './support/gate-fixtures.ts';
import { FEATURE_BASE, STACK, appRecordComment, countCalls, postedRecord, stackFake, stackedPr } from './support/stack-fixtures.ts';

/**
 * 必須チェック agent/plan-link が Stacked PR の層の Refs #N・Closes #N を受け付けるか。
 * スタックでない PR の Refs #N は受け付けない。層を紐付けたら App が kind=stack-link の記録を PR に残す。
 */

/** 下の層（2層のスタックの1番目） */
const LOWER = { ...STACK, position: 1, size: 2 };
/** 一番上の層 */
const TOP = { ...STACK, position: 2, size: 2 };

/** GitHub が closingIssuesReferences に何も入れない（base が既定ブランチでない層の見込み）偽の GitHub */
function layerFake(state: { pr: ReturnType<typeof pr>; prComments?: unknown[] }): FakeGitHub {
  return stackFake({ pr: state.pr, prComments: state.prComments ?? [] })
    .on('GET', /\/issues\/4\/comments/, () => [])
    .on('POST', /\/graphql/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } };
      if (q.includes('closedByPullRequestsReferences')) return { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: [] } } } } };
      return { data: {} };
    });
}

const planLinkCheck = (fake: FakeGitHub) => {
  const c = fake.calls.filter((x) => x.method === 'POST' && x.path.endsWith('/check-runs') && x.body?.name === 'agent/plan-link').at(-1);
  assert.ok(c, 'agent/plan-link を書いていません');
  return c.body as { conclusion: string; output: { title: string; summary: string } };
};
const runLink = async (fake: FakeGitHub) => {
  await writePlanLink(ctxFor(fake, 'pull_request_target', {}), 5);
  return planLinkCheck(fake);
};
const stackLinkRecord = (issues: number[], stack = STACK.number, login?: string) => {
  const c = appRecordComment(95, 'stack-link', 'Issue に紐付けました。', { version: 1, issues, stack });
  return login ? { ...c, author_association: 'OWNER', user: { login, type: 'User' } } : c;
};

// ---- スタックの層 ----

test('plan-link：下の層の Refs #N を受け付けて success にし、stack-link の記録を PR に残す', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }) });
  const check = await runLink(fake);
  assert.equal(check.conclusion, 'success', JSON.stringify(check.output));
  assert.ok(check.output.title.includes('#3'));
  assert.deepEqual(postedRecord(fake, 'stack-link'), { version: 1, issues: [3], stack: STACK.number });
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments')), '記録は PR に残す');
});

test('plan-link：一番上の層の Closes #N も受け付ける（closingIssuesReferences が空でも本文から読む）', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Closes #3', stack: TOP }) });
  assert.equal((await runLink(fake)).conclusion, 'success');
  assert.deepEqual(postedRecord(fake, 'stack-link'), { version: 1, issues: [3], stack: STACK.number });
});

test('plan-link：層の位置に関わらず、一番上の層の Refs #N・下の層の Closes #N も受け付ける', async () => {
  assert.equal((await runLink(layerFake({ pr: stackedPr({ body: 'Refs #3', stack: TOP }) }))).conclusion, 'success');
  assert.equal((await runLink(layerFake({ pr: stackedPr({ body: 'Closes #3', stack: LOWER }) }))).conclusion, 'success');
});

test('plan-link：App の同じ stack-link の記録があれば書き直さない。Issue かスタックが違えば書く', async () => {
  const same = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }), prComments: [stackLinkRecord([3])] });
  assert.equal((await runLink(same)).conclusion, 'success');
  assert.ok(!same.writes().includes('comment:stack-link'), same.writes().join(' / '));

  const otherIssue = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }), prComments: [stackLinkRecord([8])] });
  await runLink(otherIssue);
  assert.ok(otherIssue.writes().includes('comment:stack-link'));

  const otherStack = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }), prComments: [stackLinkRecord([3], 99)] });
  await runLink(otherStack);
  assert.ok(otherStack.writes().includes('comment:stack-link'));
});

test('plan-link：App 以外が書いた stack-link の記録は、同じ中身でも記録済みとみなさない', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }), prComments: [stackLinkRecord([3], STACK.number, 'me')] });
  await runLink(fake);
  assert.ok(fake.writes().includes('comment:stack-link'), fake.writes().join(' / '));
});

test('plan-link：1つの層で Issue が2つ以上なら failure（1層＝1 Issue）で、記録を残さない', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #3\nRefs #4', stack: LOWER }) });
  const check = await runLink(fake);
  assert.equal(check.conclusion, 'failure');
  assert.match(`${check.output.title}\n${check.output.summary}`, /1つ/);
  assert.ok(!fake.writes().includes('comment:stack-link'));
});

test('plan-link：層の Issue に計画が無ければ failure で、文言は「紐付けた Issue」', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #4', stack: LOWER }) });
  const check = await runLink(fake);
  assert.equal(check.conclusion, 'failure');
  assert.ok(check.output.summary.includes('紐付けた Issue') && check.output.summary.includes('#4'), check.output.summary);
  assert.ok(!check.output.summary.includes('Closes している Issue'), '層では Closes しているとは限らない');
  assert.ok(!fake.writes().includes('comment:stack-link'));
});

test('plan-link：層の本文に紐付けが無ければ failure で、Refs #番号 か Closes #番号 を求める', async () => {
  const fake = layerFake({ pr: stackedPr({ body: '説明だけ', stack: LOWER }) });
  const check = await runLink(fake);
  assert.equal(check.conclusion, 'failure');
  assert.ok(check.output.summary.includes('Refs #番号') && check.output.summary.includes('Closes #番号'), check.output.summary);
});

test('plan-link：一番下が既定ブランチ宛てでない層（orphan-base）の Refs #N は受け付けない', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: { ...LOWER, base: { ref: 'develop', sha: 'c'.repeat(40) } } }) });
  assert.equal((await runLink(fake)).conclusion, 'failure');
  assert.ok(!fake.writes().includes('comment:stack-link'));
});

// ---- スタックでない PR ----

test('plan-link：スタックでない PR の Refs #N は受け付けず、Refs は Stacked PR の層だけだと説明する', async () => {
  const fake = layerFake({ pr: pr({ body: 'Refs #3' }) });
  const check = await runLink(fake);
  assert.equal(check.conclusion, 'failure');
  assert.ok(check.output.summary.includes('Refs #番号') && check.output.summary.includes('Stacked PR'), check.output.summary);
  assert.ok(check.output.summary.includes('Closes #番号'));
  assert.ok(!fake.writes().includes('comment:stack-link'));
});

test('plan-link：スタックでない別ブランチ宛ての PR の Refs #N も受け付けない', async () => {
  const fake = layerFake({ pr: pr({ base: FEATURE_BASE, body: 'Refs #3' }) });
  assert.equal((await runLink(fake)).conclusion, 'failure');
});

test('plan-link：スタックでない PR の Closes #N は今までどおりで、PR のコメントを読まず記録も残さない', async () => {
  const fake = stackFake({ pr: pr({ body: 'Closes #3' }) });
  assert.equal((await runLink(fake)).conclusion, 'success');
  assert.equal(countCalls(fake, 'GET', '/repos/o/r/issues/5/comments'), 0, 'スタックでない PR の API の呼び出しは増やさない');
  assert.ok(!fake.writes().includes('comment:stack-link'));
});

test('plan-link：スタックでない PR として作って failure の後、stacked のイベントで書き直すと success になる', async () => {
  const before = layerFake({ pr: pr({ base: FEATURE_BASE, body: 'Refs #3' }) });
  await onPullRequest(ctxFor(before, 'pull_request_target', { action: 'opened', pull_request: { number: 5 }, sender: { login: 'me' } }));
  assert.equal(planLinkCheck(before).conclusion, 'failure');

  const after = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }) });
  await onPullRequest(ctxFor(after, 'pull_request_target', { action: 'stacked', pull_request: { number: 5 }, sender: { login: 'me' } }));
  assert.equal(planLinkCheck(after).conclusion, 'success');
  assert.ok(after.writes().includes('comment:stack-link'));
});

// ---- 計画が投稿されたときの書き直し ----

const planEvent = () => {
  const plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/a.md'] };
  return {
    action: 'created',
    issue: { number: 3, labels: [{ name: 'agent:ready' }], state: 'open' },
    comment: { id: 80, body: renderBlock('agent-plan', plan), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  };
};

test('計画の投稿：その Issue を Refs するスタックの層の plan-link を書き直す（一覧の要素に stack がある）', async () => {
  const layer = stackedPr({ body: 'Refs #3', stack: LOWER });
  const fake = layerFake({ pr: layer }).on('GET', /\/pulls\?state=open/, () => [layer]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent()));
  assert.ok(fake.writes().includes('check:agent/plan-link=success'), fake.writes().join(' / '));
});

test('計画の投稿：一覧の要素に stack が無くても、取り直した PR が層なら書き直す', async () => {
  const fake = layerFake({ pr: stackedPr({ body: 'Refs #3', stack: LOWER }) })
    .on('GET', /\/pulls\?state=open/, () => [pr({ base: FEATURE_BASE, body: 'Refs #3' })]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent()));
  assert.ok(fake.writes().includes('check:agent/plan-link=success'), fake.writes().join(' / '));
});

test('計画の投稿：スタックでない PR の Refs #N は書き直しの相手にしない', async () => {
  const plain = pr({ body: 'Refs #3' });
  const fake = layerFake({ pr: plain }).on('GET', /\/pulls\?state=open/, () => [plain]);
  await onComment(ctxFor(fake, 'issue_comment', planEvent()));
  assert.ok(!fake.writes().some((w) => w.startsWith('check:agent/plan-link')), fake.writes().join(' / '));
});
