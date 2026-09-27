import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { guardrailFiles } from '../lib/guardrail.ts';
import { evaluatePlanGate, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

const config = loadConfig();

/** 判定の連鎖の残り（#110）：修正・取り込み・通しの手順、有人セッションの規則、Jev の切り替えの集計 */
const judgeChainRest = ['.claude/skills/sync/SKILL.md', '.claude/skills/fix/SKILL.md', '.claude/skills/ship/SKILL.md', 'CLAUDE.md', 'harness/scripts/report.ts'];

test('判定の連鎖の残りのファイルはガードレールに当たる', () => {
  for (const f of judgeChainRest) assert.deepEqual(guardrailFiles(config, [f]), [f], f);
});

test('queue.ts は除外に残り、ガードレールに当たらない', () => {
  assert.ok((config.guardrailExclude ?? []).includes('harness/lib/queue.ts'));
  assert.deepEqual(guardrailFiles(config, ['harness/lib/queue.ts']), []);
});

const plan: Plan = { version: 1, issue: 7, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['docs/plan.md'] };

test('計画ゲート：files に判定の連鎖の残りのファイルがあると、想定 Risk が low でも止める', () => {
  for (const f of judgeChainRest) {
    const r = evaluatePlanGate({ ...plan, files: ['docs/plan.md', f] }, 7, config);
    assert.equal(r.pass, false, f);
    assert.deepEqual(r.guardrail, [f], f);
  }
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

test('判定の連鎖の残りに触れる PR は、low の判定でも自動 Merge の対象外になる', async () => {
  for (const f of judgeChainRest) {
    const fake = fakeWith([f], [{ filename: f }]);
    await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict()))));
    assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), f);
    assert.ok(acceptanceBody(fake).includes(`ガードレールに触れます（人が Merge する）: ${f}`), f);
  }
});

test('決定ログに queue.ts を除外に残す理由がある', () => {
  const log = readFileSync(new URL('../../docs/plan.md', import.meta.url), 'utf8');
  const row = log.split('\n').find((l) => l.startsWith('| Q') && l.includes('queue.ts') && l.includes('Merge の条件は App'));
  assert.ok(row, 'docs/plan.md の決定ログに queue.ts を除外に残す理由の行がありません');
});
