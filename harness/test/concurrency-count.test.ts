// 領域の同時 PR の上限が、判定前の Agent PR（Draft）だけを数え、人の Merge 待ち（Ready）の PR では上限に達しないかを確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { areaLimitLabels, countsTowardAreaLimit, describeFullAreas, fullAreas } from '../lib/concurrency.ts';
import { computeQueue } from '../lib/facts.ts';
import { GitHub } from '../lib/github.ts';
import type { PullRequest } from '../lib/state.ts';
import { APP, DIFF, FakeGitHub, HEAD, config as baseConfig, pr } from './support/gate-fixtures.ts';

const config = { ...baseConfig, areaConcurrency: { harness: 3 } };
const repository = 'o/r';
const now = new Date('2026-09-27T12:00:00Z');

let nextNumber = 10;
/** area:harness の開いた PR。kind で Agent PR（Draft／Ready）・人のブランチ・fork を作り分ける */
function openPr(kind: 'agent-draft' | 'agent-ready' | 'agent-ready-auto' | 'human' | 'fork', labels: string[] = ['area:harness']): PullRequest {
  const number = nextNumber++;
  const agentHead = { ref: `claude/issue-${number}-x`, sha: HEAD, repo: { full_name: repository } };
  const base = { number, node_id: `PR_${number}`, body: '', labels: labels.map((name) => ({ name })) };
  switch (kind) {
    case 'agent-draft':
      return pr({ ...base, draft: true, head: agentHead }) as unknown as PullRequest;
    case 'agent-ready':
      return pr({ ...base, draft: false, auto_merge: null, head: agentHead }) as unknown as PullRequest;
    case 'agent-ready-auto':
      return pr({ ...base, draft: false, auto_merge: { enabled_by: { login: APP }, merge_method: 'squash' }, head: agentHead }) as unknown as PullRequest;
    case 'human':
      return pr({ ...base, draft: true, head: { ref: `feature/${number}`, sha: HEAD, repo: { full_name: repository } } }) as unknown as PullRequest;
    case 'fork':
      return pr({ ...base, draft: true, head: { ref: `claude/issue-${number}-x`, sha: HEAD, repo: { full_name: 'someone/r' } } }) as unknown as PullRequest;
  }
}
const many = (kind: Parameters<typeof openPr>[0], n: number) => Array.from({ length: n }, () => openPr(kind));

test('countsTowardAreaLimit：同じリポジトリの Agent PR で Draft（判定前）のものだけを数える', () => {
  assert.equal(countsTowardAreaLimit(config, openPr('agent-draft'), repository), true);
});

test('countsTowardAreaLimit：Ready の Agent PR は auto-merge の有無を問わず数えない（人の Merge 待ち・自動 Merge 待ち）', () => {
  assert.equal(countsTowardAreaLimit(config, openPr('agent-ready'), repository), false);
  assert.equal(countsTowardAreaLimit(config, openPr('agent-ready-auto'), repository), false);
});

test('countsTowardAreaLimit：人のブランチの PR と fork の PR は Draft でも数えない', () => {
  assert.equal(countsTowardAreaLimit(config, openPr('human'), repository), false);
  assert.equal(countsTowardAreaLimit(config, openPr('fork'), repository), false);
});

test('areaLimitLabels：数える PR（Draft の Agent PR）のラベル名だけを返す', () => {
  const draft = openPr('agent-draft', ['area:harness', 'area:docs']);
  const prs = [openPr('agent-ready'), draft, openPr('human'), openPr('fork'), openPr('agent-ready-auto')];
  assert.deepEqual(areaLimitLabels(config, prs, repository), [['area:harness', 'area:docs']]);
});

test('上限 3：Ready の Agent PR が5本と Draft の Agent PR が2本なら、上限に達しない', () => {
  const prs = [...many('agent-ready', 3), ...many('agent-ready-auto', 2), ...many('agent-draft', 2), ...many('human', 2), ...many('fork', 2)];
  assert.deepEqual(fullAreas(config, ['harness/lib/queue.ts'], areaLimitLabels(config, prs, repository)), []);
});

test('上限 3：Draft の Agent PR が3本なら上限に達し、説明に「判定前」と「3/3」が入る', () => {
  const prs = [...many('agent-ready', 5), ...many('agent-draft', 3)];
  const full = fullAreas(config, ['harness/lib/queue.ts'], areaLimitLabels(config, prs, repository));
  assert.deepEqual(full, [{ area: 'harness', open: 3, limit: 3 }]);
  const text = describeFullAreas(full);
  assert.match(text, /area:harness/);
  assert.match(text, /判定前/);
  assert.match(text, /3\/3/);
});

/** 計画ゲートを harness/** の計画で通った Issue #3 と、開いた PR の一覧を返す偽の GitHub */
function queueFake(list: PullRequest[]): FakeGitHub {
  const gateComment = {
    id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: ['harness/**'] } })}`,
  };
  const labeled = (name: string) => ({ event: 'labeled', created_at: '2026-09-26T00:00:00Z', label: { name }, actor: { login: APP } });
  const byNumber = new Map(list.map((p) => [p.number, p]));
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&labels=/, () => [{ number: 3, title: 't', labels: [{ name: 'agent:ready' }, { name: 'agent:plan-ok' }] }])
    .on('GET', /\/pulls\?state=open/, () => list)
    .on('GET', /\/pulls\/(\d+)$/, (m) => byNumber.get(Number(m[1])))
    .on('GET', /\/pulls\/\d+\/reviews/, () => [])
    // 後に登録したルートが優先する（#3 の応答を、ほかの番号の既定より後に書く）
    .on('GET', /\/issues\/\d+\/comments/, () => [])
    .on('GET', /\/issues\/\d+\/timeline/, () => [])
    .on('GET', /\/issues\/3\/timeline/, () => [labeled('agent:ready'), labeled('agent:plan-ok')])
    .on('GET', /\/issues\/3\/comments/, () => [gateComment])
    .on('GET', /\/commits\/a+$/, () => ({ commit: { committer: { date: '2026-09-27T00:00:00Z' } } }))
    .on('GET', /\/commits\/a+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /\/compare\//, () => DIFF)
    .on('POST', /\/graphql/, (_m, body) => {
      const q = String(body.query);
      if (q.includes('closingIssuesReferences')) return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } };
      if (q.includes('blockedBy')) return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
      return { data: {} };
    });
}

const run = (list: PullRequest[]) => computeQueue(new GitHub(queueFake(list), repository), { ...config, routine: { ...config.routine, maxItemsPerRun: 50 } }, null, now);

test('computeQueue：area:harness の開いた PR が Ready の Agent PR だけなら（3本以上でも）、harness を触る Issue を implement する', async () => {
  const q = await run([...many('agent-ready', 3), ...many('agent-ready-auto', 2)]);
  const implement = q.actions.find((a) => a.kind === 'implement' && a.issue === 3);
  assert.ok(implement, JSON.stringify(q));
  assert.equal(q.skipped.find((a) => a.kind === 'skip' && a.target === '#3'), undefined, JSON.stringify(q));
});

test('computeQueue：Draft の Agent PR が上限に達していれば、harness を触る Issue を理由付きで skip する', async () => {
  const q = await run([...many('agent-ready', 2), ...many('agent-draft', 3)]);
  assert.equal(q.actions.find((a) => a.kind === 'implement' && a.issue === 3), undefined, JSON.stringify(q));
  const skip = q.skipped.find((a) => a.kind === 'skip' && a.target === '#3');
  assert.ok(skip && skip.kind === 'skip', JSON.stringify(q));
  assert.match(skip.reason, /area:harness/);
  assert.match(skip.reason, /判定前/);
  assert.match(skip.reason, /3\/3/);
});
