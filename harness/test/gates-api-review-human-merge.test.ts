// API のレビューの記録で判定した PR は、判定の受け付けで自動 Merge・委任承認・auto mode・bypass のどれにも乗せず Human Merge にすること
// （harness/gates/on-comment.ts の buildAcceptance と harness/lib/api-review.ts の verdictUsesApiRecord。Issue #1080）を、偽の GitHub への書き込みで確かめる。
// ローカルの判定（記録と review が違う）は今までどおり、reviewSource が local なら PR のコメントを新たに読まない、設定が壊れていれば安全側に倒すことも見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig, type HarnessConfig } from '../lib/config.ts';
import type { Verdict } from '../lib/verdict.ts';
import { onComment } from '../gates/on-comment.ts';
import { acceptanceFake, config, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { APP as REVIEW_APP, comment, postedBody } from './support/judge-api-review.ts';
import { countCalls, postedRecord } from './support/stack-fixtures.ts';

const LABELS_ON = [delegateConfig(config).mergeLabel, bypassMergeConfig(config).label, autoModeConfig(config).label];
const on = (name: string) => ({ event: 'labeled', created_at: new Date(Date.now() - 5 * 3600_000).toISOString(), actor: { login: 'me' }, label: { name } });
const withSource = (reviewSource: unknown) => ({ ...config, jev: { ...config.jev, mode: 'off' }, reviewSource }) as unknown as HarnessConfig;
const API = withSource({ mode: 'api', waitMinutes: 0, appLogin: REVIEW_APP });
const PASS = { pass: true, blocking: [], nonBlocking: [] };
/** 判定する head の posted の記録（review は渡したもの） */
const record = (review: typeof PASS) => comment(7, postedBody(undefined, undefined, { reviewer: review }));
const REASON = 'API のレビューの記録';

async function accept(cfg: HarnessConfig, v: Verdict, prComments: unknown[] = []): Promise<FakeGitHub> {
  const fake = acceptanceFake({ pr: pr(), dashboardLabels: LABELS_ON, dashboardEvents: LABELS_ON.map(on), prComments }).on('GET', /\/issues\/5\/events/, () => []);
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), { config: cfg }));
  return fake;
}

test('受け付け：API の記録で判定した PR は自動 Merge・委任・auto mode・bypass に乗せず human-review、review の違う記録なら今までどおり', async () => {
  const apiMetrics = { metrics: { reviewSource: 'api', apiReviewRecord: 'https://example.test/c7' } };
  const cases: [string, HarnessConfig, Verdict, unknown[], boolean][] = [
    ['metrics が api', API, verdict(apiMetrics), [], true],
    ['metrics なしで同じ head・同じ review の posted の記録', API, verdict(), [record(PASS)], true],
    ['設定が壊れている（安全側）', withSource({ mode: 'bogus' }), verdict(apiMetrics), [], true],
    ['同じ head でも review の違う記録（ローカルの判定）', API, verdict(), [record({ ...PASS, nonBlocking: ['命名'] } as typeof PASS)], false],
  ];
  for (const [name, cfg, v, prComments, human] of cases) {
    const fake = await accept(cfg, v, prComments);
    const rec = postedRecord(fake, 'acceptance');
    const w = fake.writes();
    if (!human) {
      assert.equal(rec.autoEligible, true, `${name}: ${JSON.stringify(rec.reasons)}`);
      continue;
    }
    assert.deepEqual([rec.autoEligible, rec.delegate.eligible, rec.bypass.eligible, rec.autoMode.eligible], [false, false, false, false], name);
    assert.ok(String(rec.reasons[0]).includes(REASON), `${name}: ${JSON.stringify(rec.reasons)}`);
    for (const key of ['delegate', 'bypass', 'autoMode']) assert.ok(rec[key].reasons.some((r: string) => r.includes(REASON)), `${name}: ${key} ${JSON.stringify(rec[key].reasons)}`);
    assert.ok(w.includes('comment:human-review'), `${name}: ${w.join(' ')}`);
    assert.ok(!w.includes('enablePullRequestAutoMerge'), `${name}: ${w.join(' ')}`);
  }
});

test('受け付け：reviewSource が local（既定）なら、PR のコメントを api のときより多く読まない', async () => {
  const comments = async (cfg: HarnessConfig) => countCalls(await accept(cfg, verdict(), [record(PASS)]), 'GET', '/repos/o/r/issues/5/comments');
  const local = await comments(withSource(undefined));
  assert.ok(local < (await comments(API)), 'local でも PR のコメントを読んでいる');
});
