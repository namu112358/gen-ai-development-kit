// bypass・委任承認（計画＋Merge）で自動の経路があるとき、計画ゲートの停止と判定の受け付けのコメントが「人が Merge する」でなく App の自動 Merge を書き、記録は変えないこと（Issue #717）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, LABELS } from '../lib/config.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, CRITIQUE, DELEGATE, acceptanceFake, config, critiqueClaim, ctxFor, delegateLabeled, delegateWorldFake, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { postedBodies, postedRecord } from './support/stack-fixtures.ts';

const BYPASS = bypassMergeConfig(config).label;
/** ガードレールに当たり、delegateMergeExclude に当たらない */
const GUARDED = 'harness/lib/epic.ts';
const on = (labels: string[]) => ({ dashboardLabels: labels, events: labels.map((l) => delegateLabeled(l, new Date(Date.now() - 300 * 60_000).toISOString())) });
/** コメントの本文（記録のブロックより前） */
const text = (fake: FakeGitHub, kind: string): string => postedBodies(fake, kind).at(-1)!.split('<details>')[0]!;
const autoNote = (body: string, name: string) => {
  for (const s of ['人が Merge する', '人が実装して Merge する', '人が手元でセッションを立てて']) assert.ok(!body.includes(s), `${name}: 「${s}」がある:\n${body}`);
  assert.ok(body.includes('App が自動 Merge'), `${name}: App の自動 Merge が無い:\n${body}`);
};

test('計画の停止：bypass が有効ならガードレールの停止に App の自動 Merge を書き、無効なら今の文のまま。記録の reasons は変わらない', async () => {
  const reasons: unknown[] = [];
  for (const bypass of [true, false]) {
    const { dashboardLabels, events } = on(bypass ? [BYPASS] : []);
    const plan = { version: 1, issue: 21, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: [], files: [GUARDED], critique: CRITIQUE };
    const comment = { id: 80, created_at: '2026-09-28T00:00:00Z', updated_at: '', html_url: 'p', author_association: 'OWNER', user: { login: 'me', type: 'User' }, body: `計画です。\n\n${renderBlock('agent-plan', plan)}` };
    const fake = delegateWorldFake({ prs: [], dashboardLabels, dashboardEvents: events, issues: { 21: [LABELS.ready] }, comments: { 21: [critiqueClaim()] } });
    await onComment(ctxFor(fake, 'issue_comment', { action: 'created', issue: { number: 21, labels: [{ name: LABELS.ready }], state: 'open' }, comment }));
    const body = text(fake, 'plan-gate');
    if (bypass) autoNote(body, 'bypass');
    else for (const s of [`ガードレールに触れます（人が実装して Merge する）: ${GUARDED}`, '人が手元でセッションを立てて実装してください。']) assert.ok(body.includes(s), `無効: 「${s}」が無い:\n${body}`);
    reasons.push(postedRecord(fake, 'plan-gate').reasons);
  }
  assert.deepEqual(reasons[0], reasons[1]);
});

test('受け付け：critical・ガードレールの PR は、bypass・委任で乗れば App の自動 Merge を書き、無効・agent:hold なら今の文のまま。記録の reasons は変わらない', async () => {
  const cases: [string, string[], ReturnType<typeof pr>, string | null][] = [
    ['bypass', [BYPASS], pr(), 'bypass モード'],
    ['無効', [], pr(), null],
    ['hold', [BYPASS], pr({ labels: [{ name: LABELS.hold }] }), null],
    ['委任', [DELEGATE.mergeLabel], pr(), '委任承認（計画＋Merge）で App が自動 Merge'],
  ];
  const reasons: Record<string, unknown> = {};
  for (const [name, labels, p, want] of cases) {
    const { dashboardLabels, events } = on(labels);
    const planGate = { id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' }, body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files: [GUARDED] } })}` };
    const fake = acceptanceFake({ pr: p, dashboardLabels, dashboardEvents: events, prComments: [] })
      .on('GET', /\/issues\/3\/comments/, () => [planGate])
      .on('GET', /\/pulls\/5\/files/, () => [{ filename: GUARDED, additions: 1, deletions: 1 }])
      .on('GET', /\/issues\/5\/events/, () => []);
    const v = verdict({ risk: { ...verdict().risk, level: 'critical' } });
    await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', v)), { config: { ...config, jev: { ...config.jev, mode: 'off' } } }));
    const body = text(fake, 'acceptance');
    if (want) {
      autoNote(body, name);
      assert.ok(!body.includes('触れる（Human Merge）') && body.includes(want), `${name}:\n${body}`);
    } else for (const s of [`ガードレールに触れます（人が Merge する）: ${GUARDED}`, `触れる（Human Merge）: ${GUARDED}`]) assert.ok(body.includes(s), `${name}: 「${s}」が無い:\n${body}`);
    reasons[name] = postedRecord(fake, 'acceptance').reasons;
  }
  assert.deepEqual(reasons.bypass, reasons['無効']);
});
