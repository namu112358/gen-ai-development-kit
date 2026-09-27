import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { guardrailFiles } from '../lib/guardrail.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

const config = loadConfig();

/** 判定の連鎖（#103）：判定を組み立て・伝えるファイル */
const judgeChain = ['harness/scripts/agent.ts', '.claude/skills/judge/SKILL.md', '.claude/skills/plan/SKILL.md', '.claude/routine.md', '.claude/agents/plan-critic.md', '.claude/agents/test-designer.md'];
const stillExcluded = ['harness/lib/usage.ts', 'harness/lib/classify.ts', 'harness/lib/worktree.ts', 'harness/lib/issue-triage.ts', 'harness/lib/queue.ts', 'harness/lib/concurrency.ts'];

test('判定の連鎖のファイルはガードレールに当たる', () => {
  for (const f of judgeChain) assert.deepEqual(guardrailFiles(config, [f]), [f], f);
});

test('facts.ts は除外から外れてガードレールに当たり、残りの除外は当たらない', () => {
  assert.deepEqual(guardrailFiles(config, ['harness/lib/facts.ts']), ['harness/lib/facts.ts']);
  assert.ok(!(config.guardrailExclude ?? []).includes('harness/lib/facts.ts'));
  assert.deepEqual(guardrailFiles(config, stillExcluded), []);
});

/** 計画の files と変更ファイルを差し替えた受け付けの偽物 */
function fakeWith(planned: string[], files: { filename: string }[]): FakeGitHub {
  const gate = {
    id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
    body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: planned } })}`,
  };
  return acceptanceFake({ pr: pr(), dashboardLabels: [] })
    .on('GET', /\/issues\/3\/comments/, () => [gate])
    .on('GET', /\/pulls\/5\/files/, () => files.map((f) => ({ ...f, additions: 1, deletions: 1 })));
}

const acceptanceBody = (fake: FakeGitHub): string =>
  String(fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/issues/5/comments') && /kind=acceptance/.test(c.body.body))!.body.body);

test('判定の連鎖に触れる PR は、low の判定でも自動 Merge の対象外になる', async () => {
  for (const f of [...judgeChain, 'harness/lib/facts.ts']) {
    const fake = fakeWith([f], [{ filename: f }]);
    await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
    assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), f);
    assert.ok(acceptanceBody(fake).includes(`ガードレールに触れます（人が Merge する）: ${f}`), f);
  }
});
