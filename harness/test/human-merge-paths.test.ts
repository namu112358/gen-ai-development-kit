import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { humanMergeFiles } from '../lib/guardrail.ts';
import { eligibility } from '../lib/merge-route.ts';
import { evaluatePlanGate, type Plan } from '../lib/plan.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config, CRITIQUE, critiqueClaim, ctxFor, planGateComment, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';

/** 導入先の製品を守る humanMergePaths（#105） */

const withHumanMerge = (paths: string[]): HarnessConfig => ({ ...config, humanMergePaths: paths });

// ---- humanMergeFiles ----

test('humanMergeFiles：設定が無い・空のときは何も当たらない', () => {
  assert.deepEqual(humanMergeFiles({}, ['src/auth/login.ts', 'db/migrations/1.sql']), []);
  assert.deepEqual(humanMergeFiles({ humanMergePaths: [] }, ['src/auth/login.ts']), []);
});

test('humanMergeFiles：パターンに当たるファイルだけを、重複なくソートして返す', () => {
  const c = { humanMergePaths: ['src/auth/**', '**/migrations/**'] };
  assert.deepEqual(
    humanMergeFiles(c, ['src/auth/login.ts', 'src/app/page.ts', 'db/migrations/001.sql', 'docs/a.md', 'src/auth/deep/token.ts']),
    ['db/migrations/001.sql', 'src/auth/deep/token.ts', 'src/auth/login.ts'],
  );
  assert.deepEqual(humanMergeFiles(c, ['src/app/page.ts', 'docs/a.md', 'src/authz.ts']), [], '当たらないファイル');
  assert.deepEqual(humanMergeFiles(c, ['src/auth/login.ts', 'src/auth/login.ts']), ['src/auth/login.ts'], '重複しない');
});

test('humanMergeFiles：リネームの旧パス（files に含めて渡したもの）でも当たる', () => {
  const c = { humanMergePaths: ['src/auth/**'] };
  // PR の変更ファイル src/lib/login.ts は src/auth/login.ts からのリネーム
  assert.deepEqual(humanMergeFiles(c, ['src/lib/login.ts', 'src/auth/login.ts']), ['src/auth/login.ts']);
});

test('humanMergeFiles：guardrailExclude は見ない', () => {
  const c = { humanMergePaths: ['src/auth/**'], guardrailExclude: ['src/auth/**'] } as Pick<HarnessConfig, 'humanMergePaths'>;
  assert.deepEqual(humanMergeFiles(c, ['src/auth/login.ts']), ['src/auth/login.ts']);
});

// ---- eligibility ----

const riskOk = { ok: true, reasons: [] };

test('eligibility：humanMerge に当たりがあれば、low・Reviewer 合格・範囲 OK でも自動 Merge しない', () => {
  const base = { reviewPass: true, risk: riskOk, scopeOk: true, outside: [], guardrail: [] };
  assert.equal(eligibility({ ...base, humanMerge: [] }).autoEligible, true, '当たりが無ければ今までどおり');
  const r = eligibility({ ...base, humanMerge: ['src/auth/login.ts', 'src/auth/token.ts'] });
  assert.equal(r.autoEligible, false);
  assert.deepEqual(r.reasons, ['人が Merge するパスに触れます（humanMergePaths）: src/auth/login.ts, src/auth/token.ts']);
  assert.ok(!r.reasons.some((x) => x.includes('ガードレール')), 'ガードレールの理由とは別の文言');
});

test('eligibility：ガードレールと humanMerge の両方に当たれば、理由はガードレールの直後に並ぶ', () => {
  const r = eligibility({ reviewPass: true, risk: riskOk, scopeOk: false, outside: ['x.ts'], guardrail: ['harness/gates/run.ts'], humanMerge: ['harness/gates/run.ts'] });
  assert.equal(r.autoEligible, false);
  assert.deepEqual(r.reasons, [
    'ガードレールに触れます（人が Merge する）: harness/gates/run.ts',
    '人が Merge するパスに触れます（humanMergePaths）: harness/gates/run.ts',
    '計画の範囲外のファイルがあります: x.ts',
  ]);
});

// ---- 受け付け（onComment） ----

/** 計画の files と変更ファイルを差し替えた受け付けの偽物 */
function fakeWith(planned: string[], files: { filename: string; previous_filename?: string }[]): FakeGitHub {
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

test('受け付け：humanMergePaths に触れる PR は、low の判定でも auto-merge を付けず Human Merge にし、理由・表・記録に残す', async () => {
  const fake = fakeWith(['src/auth/**'], [{ filename: 'src/auth/login.ts' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), { config: withHumanMerge(['src/auth/**']) }));
  const w = fake.writes();
  assert.ok(!w.includes('enablePullRequestAutoMerge'));
  assert.ok(w.includes('comment:human-review'));
  assert.deepEqual(w.slice(-2), ['check:agent/review=success', 'label+risk:low'], 'Human Merge は通す');
  const body = acceptanceBody(fake);
  assert.match(body, /Human Merge/);
  assert.match(body, /人が Merge するパスに触れます（humanMergePaths）: src\/auth\/login\.ts/);
  assert.doesNotMatch(body, /ガードレールに触れます/, 'ガードレールの外なのでガードレールの理由は出ない');
  assert.match(body, /\| ガードレール \| 触れない \|\n\| 人が Merge するパス \| 触れる（Human Merge）: src\/auth\/login\.ts \|/, 'ガードレールの行の直後');
  assert.match(body, /"humanMerge": \[\s*"src\/auth\/login\.ts"/);
});

test('受け付け：リネームの旧パスが humanMergePaths に当たっても Human Merge にする', async () => {
  const fake = fakeWith(['src/auth/**', 'src/lib/**'], [{ filename: 'src/lib/login.ts', previous_filename: 'src/auth/login.ts' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), { config: withHumanMerge(['src/auth/**']) }));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
  assert.match(acceptanceBody(fake), /人が Merge するパスに触れます（humanMergePaths）: src\/auth\/login\.ts/);
});

test('受け付け：ガードレールと humanMergePaths の両方に当たるファイルは、理由が2行とも出る', async () => {
  const fake = fakeWith(['harness/gates/**'], [{ filename: 'harness/gates/run.ts' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), { config: withHumanMerge(['harness/gates/**']) }));
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'));
  const body = acceptanceBody(fake);
  assert.match(body, /- ガードレールに触れます（人が Merge する）: harness\/gates\/run\.ts\n- 人が Merge するパスに触れます（humanMergePaths）: harness\/gates\/run\.ts/);
  assert.match(body, /\| 人が Merge するパス \| 触れる（Human Merge）: harness\/gates\/run\.ts \|/);
});

test('受け付け：humanMergePaths が無い設定では、同じ PR・同じ判定で今までどおり自動 Merge になる', async () => {
  const fake = fakeWith(['src/auth/**'], [{ filename: 'src/auth/login.ts' }]);
  const { humanMergePaths: _, ...without } = withHumanMerge([]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), { config: without }));
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'));
  const body = acceptanceBody(fake);
  assert.match(body, /\| 人が Merge するパス \| 触れない \|/);
  assert.doesNotMatch(body, /人が Merge するパスに触れます/);
});

test('受け付け：humanMergePaths に当たらない PR は自動 Merge のまま', async () => {
  const fake = fakeWith(['src/app/**'], [{ filename: 'src/app/page.ts' }]);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', verdict())), { config: withHumanMerge(['src/auth/**']) }));
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'));
  assert.match(acceptanceBody(fake), /\| 人が Merge するパス \| 触れない \|/);
});

// ---- 計画ゲートには効かない ----

const plan: Plan = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: ['src/auth/**'], critique: CRITIQUE };

test('計画ゲート：humanMergePaths に触れる計画でも止めない（evaluatePlanGate）', () => {
  const c = withHumanMerge(['src/auth/**']);
  const r = evaluatePlanGate(plan, 3, c);
  assert.equal(r.pass, true);
  assert.equal(r.guardrail, undefined);
  assert.deepEqual(r.reasons, []);
});

test('計画ゲート（App）：humanMergePaths に触れる計画のイベントでも agent:plan-ok になる', async () => {
  const event = {
    action: 'created',
    issue: { number: 3, labels: [{ name: 'agent:ready' }], state: 'open' },
    comment: { id: 80, body: renderBlock('agent-plan', plan), html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
  };
  const fake = acceptanceFake({ pr: pr(), issueComments: [critiqueClaim(), planGateComment] });
  await onComment(ctxFor(fake, 'issue_comment', event, { config: withHumanMerge(['src/auth/**']) }));
  const w = fake.writes();
  assert.equal(w[0], 'label+agent:plan-ok');
  assert.ok(!w.includes('label+agent:plan-review'));
});
